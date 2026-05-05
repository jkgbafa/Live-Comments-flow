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
    this.mc = null;
    this.stopped = false;
    this.status = "connecting"; // connecting | live | reconnecting | error | stopped
    this.lastError = null;
  }

  async start() {
    this.stopped = false;
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
      status: this.status,
      lastError: this.lastError,
    };
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
            this.emit("message", {
              id: `yt:${this.videoId}:${action.id}`,
              source: "youtube",
              videoId: this.videoId,
              streamTitle: this.title,
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
