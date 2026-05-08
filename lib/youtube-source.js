// YouTube live-chat source. Wraps masterchat for one stream and
// emits unified "message" events. Auto-reconnects on transient errors.
const EventEmitter = require("events");
const { Masterchat, stringify } = require("masterchat");

// Custom emoji handler for masterchat. By default, masterchat converts
// YouTube emojis (both standard and channel-custom) to colon shortcodes
// like `:person-turqouise-waving:`. That's ugly in our viewer because
// we render plain text, not images.
//
// Strategy:
//   - Standard YouTube emojis carry their unicode character in `emojiId`
//     (e.g. "🎉"). Use it directly.
//   - Custom channel emojis don't have unicode equivalents — strip them
//     so the text stays clean. (Future: render the image inline.)
function emojiHandler(emoji) {
  if (!emoji) return "";
  // Standard emoji: emojiId is the unicode character (1–4 chars).
  if (
    emoji.emojiId &&
    typeof emoji.emojiId === "string" &&
    emoji.emojiId.length <= 4 &&
    !emoji.isCustomEmoji
  ) {
    return emoji.emojiId;
  }
  // Custom emoji we can't render: strip silently. Returning "" means the
  // surrounding text just flows past where the emoji was.
  return "";
}

function renderRuns(runs) {
  return stringify(runs || [], { emojiHandler }).trim();
}

class YouTubeSource extends EventEmitter {
  constructor(videoIdOrUrl) {
    super();
    this.input = videoIdOrUrl;
    this.videoId = null;
    this.title = null;
    // Channel name auto-fetched from the video page (e.g. "Dag Heward-Mills").
    // Channel-watcher messages also include this; direct legacy URLs benefit
    // from it because otherwise the viewer has no idea which channel a
    // direct-URL message came from.
    this.channelName = null;
    this.channelId = null;
    this.mc = null;
    this.stopped = false;
    this.status = "connecting"; // connecting | live | reconnecting | error | stopped
    this.lastError = null;
    // Heartbeat — set every time we emit a message. Used by the channel
    // watchdog to detect a silently-stalled chat iterator.
    this.lastMessageAt = null;
    this.startedAt = null;
  }

  async start() {
    this.stopped = false;
    this.startedAt = Date.now();
    this._loop().catch((err) => {
      this.status = "error";
      this.lastError = err.message;
      this.emit("status", this.snapshot());
    });
  }

  stop() {
    this.stopped = true;
    this.status = "stopped";
    if (this.mc) {
      try { this.mc.stop(); } catch (_) {}
    }
    this.emit("status", this.snapshot());
  }

  snapshot() {
    return {
      input: this.input,
      videoId: this.videoId,
      title: this.title,
      channelName: this.channelName,
      channelId: this.channelId,
      status: this.status,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      startedAt: this.startedAt,
    };
  }

  // Pulls "ownerChannelName" / "author" out of the YouTube watch page HTML.
  // Same trick we use in youtube-channel.js, just for individual videos so
  // the legacy direct-URL flow can show a channel pill on each comment.
  async _fetchChannelName(videoId) {
    try {
      const r = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "accept-language": "en-US,en;q=0.9",
        },
      });
      const html = await r.text();
      const m =
        html.match(/"ownerChannelName":"([^"]+)"/) ||
        html.match(/"author":"([^"]+)"/);
      if (m) {
        this.channelName = m[1]
          .replace(/\\u0026/g, "&")
          .replace(/\\"/g, '"')
          .trim() || null;
        const cm = html.match(/"channelId":"([^"]+)"/);
        if (cm) this.channelId = cm[1];
        this.emit("status", this.snapshot());
      }
    } catch (_) {
      // Non-fatal — chat still works, just no channel pill on messages.
    }
  }

  async _loop() {
    let backoffMs = 2000;
    while (!this.stopped) {
      try {
        this.status = "connecting";
        this.emit("status", this.snapshot());
        this.mc = await Masterchat.init(this.input);
        this.videoId = this.mc.videoId;
        this.title = this.mc.title || null;
        this.channelId = this.mc.channelId || this.channelId;
        // Fire-and-forget: look up the human-readable channel name from
        // the video page so direct legacy sources also get a channel
        // pill in the viewer.
        if (!this.channelName && this.videoId) {
          this._fetchChannelName(this.videoId).catch(() => {});
        }
        this.status = "live";
        this.lastError = null;
        backoffMs = 2000;
        this.emit("status", this.snapshot());

        for await (const res of this.mc.iterate({ ignoreFirstResponse: true })) {
          if (this.stopped) break;
          for (const action of res.actions) {
            if (action.type !== "addChatItemAction") continue;
            const text = renderRuns(action.message || []);
            if (!text) continue;
            this.lastMessageAt = Date.now();
            this.emit("message", {
              id: `yt:${this.videoId}:${action.id}`,
              source: "youtube",
              platform: "youtube",
              videoId: this.videoId,
              streamTitle: this.title,
              channelName: this.channelName,
              channelId: this.channelId,
              author: action.authorName || "Unknown",
              authorChannelId: action.authorChannelId,
              avatar: action.authorPhoto,
              text,
              timestamp: action.timestamp
                ? new Date(action.timestamp).toISOString()
                : new Date().toISOString(),
              isOwner: !!action.isOwner,
              isModerator: !!action.isModerator,
              isVerified: !!action.isVerified,
              membership: !!action.membership,
            });
          }
        }
        if (this.stopped) break;
        // iterate ended (stream over). Try to reconnect after a delay.
        this.status = "reconnecting";
        this.lastError = "chat ended; retrying";
        this.emit("status", this.snapshot());
      } catch (err) {
        if (this.stopped) break;
        this.status = "reconnecting";
        this.lastError = err.message || String(err);
        this.emit("status", this.snapshot());
      }
      // Wait then retry, capped at 30s.
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

module.exports = { YouTubeSource };
