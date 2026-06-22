// YouTube live-chat source using the OFFICIAL YouTube Data API v3.
//
// Why this exists: the masterchat-based YouTubeSource scrapes YouTube's
// internal innertube endpoints, which YouTube soft-throttles (HTTP 429) from
// data-center IPs (Fly, any VPS). The official Data API does not IP-throttle
// the same way — it's gated by a daily quota instead. Reading PUBLIC live chat
// needs only an API key (no OAuth, no channel ownership).
//
// This class mirrors YouTubeSource's interface (start/stop/snapshot + the
// "message" and "status" events, plus the startedAt/lastMessageAt heartbeat
// fields the channel watchdog reads) so ChannelWatcher can use either one
// interchangeably.
//
// Flow:
//   1. videos.list (part=snippet,liveStreamingDetails) → activeLiveChatId  (1 unit)
//   2. liveChatMessages.list, paged via pageToken, honouring the
//      pollingIntervalMillis the API returns                              (1 unit/call)
//
// Quota note: a read costs 1 unit. Honour pollingIntervalMillis and request
// maxResults=2000 so we make as few calls as possible.

const EventEmitter = require("events");

const API = "https://www.googleapis.com/youtube/v3";
const MIN_POLL_MS = 2500; // floor — never hammer faster than this
const MAX_POLL_MS = 30_000;

class YouTubeApiSource extends EventEmitter {
  constructor(videoId, apiKey) {
    super();
    this.input = videoId;
    this.videoId = videoId;
    this.apiKey = apiKey;
    this.title = null;
    this.channelName = null;
    this.channelId = null;
    this.liveChatId = null;
    this.pageToken = null;
    this.stopped = false;
    this.status = "connecting"; // connecting | live | reconnecting | error | stopped
    this.lastError = null;
    // Consecutive failures before we give up and let the watcher fall back to
    // the masterchat scraper. IMPORTANT: an API *key* cannot read live chat you
    // don't own (returns 404) — only OAuth-as-owner/manager can. So if this
    // source is ever run with just a key, it will fail fast and fall back.
    this._fails = 0;
    this.MAX_FAILS = 3;
    // Heartbeat fields read by ChannelWatcher's stall watchdog.
    this.lastMessageAt = null;
    this.startedAt = null;
  }

  async start() {
    this.stopped = false;
    this.startedAt = Date.now();
    this._loop().catch((err) => {
      this.status = "error";
      this.lastError = err.message || String(err);
      this.emit("status", this.snapshot());
    });
  }

  stop() {
    this.stopped = true;
    this.status = "stopped";
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

  async _get(path, params) {
    const qs = new URLSearchParams({ ...params, key: this.apiKey });
    const res = await fetch(`${API}/${path}?${qs}`, {
      headers: { accept: "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason || `http_${res.status}`;
      const message = body?.error?.message || `HTTP ${res.status}`;
      const err = new Error(`${reason}: ${message}`);
      err.reason = reason;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // Resolve the active live chat id (and channel/title metadata) for the video.
  async _resolveLiveChatId() {
    const data = await this._get("videos", {
      part: "snippet,liveStreamingDetails",
      id: this.videoId,
    });
    const item = data.items && data.items[0];
    if (!item) throw new Error("video not found");
    const sn = item.snippet || {};
    this.title = sn.title || this.title;
    this.channelName = sn.channelTitle || this.channelName;
    this.channelId = sn.channelId || this.channelId;
    const chatId = item.liveStreamingDetails?.activeLiveChatId || null;
    return chatId;
  }

  _emitMessage(item) {
    const sn = item.snippet || {};
    // Only forward things that have human-readable display content
    // (text messages, super chats with a comment). Skip deletions/system.
    const text = sn.displayMessage;
    if (!sn.hasDisplayContent || !text) return;
    const ad = item.authorDetails || {};
    this.lastMessageAt = Date.now();
    this.emit("message", {
      id: `yt:${this.videoId}:${item.id}`,
      source: "youtube",
      platform: "youtube",
      videoId: this.videoId,
      streamTitle: this.title,
      channelName: this.channelName,
      channelId: this.channelId,
      author: ad.displayName || "Unknown",
      authorChannelId: ad.channelId,
      avatar: ad.profileImageUrl || null,
      text,
      timestamp: sn.publishedAt || new Date().toISOString(),
      isOwner: !!ad.isChatOwner,
      isModerator: !!ad.isChatModerator,
      isVerified: !!ad.isVerified,
      membership: !!ad.isChatSponsor,
    });
  }

  async _loop() {
    let backoffMs = 2000;
    let firstPage = true;
    while (!this.stopped) {
      try {
        if (!this.liveChatId) {
          this.status = "connecting";
          this.emit("status", this.snapshot());
          this.liveChatId = await this._resolveLiveChatId();
          if (!this.liveChatId) {
            // Not live yet, live chat disabled, or (most likely with a key
            // alone) the chat isn't readable without OAuth. Count it as a fail.
            this._fails++;
            if (this._fails >= this.MAX_FAILS) {
              this.status = "error";
              this.lastError = "live chat not readable (needs OAuth?)";
              this.emit("status", this.snapshot());
              this.emit("fallback", this.snapshot());
              return;
            }
            this.status = "reconnecting";
            this.lastError = "no active live chat";
            this.emit("status", this.snapshot());
            await this._sleep(5000);
            continue;
          }
          firstPage = true;
          this.pageToken = null;
        }

        const params = {
          part: "snippet,authorDetails",
          liveChatId: this.liveChatId,
          maxResults: "2000",
        };
        if (this.pageToken) params.pageToken = this.pageToken;

        const data = await this._get("liveChatMessages", params);
        this.status = "live";
        this.lastError = null;
        this._fails = 0;
        backoffMs = 2000;
        this.emit("status", this.snapshot());

        // Skip the very first page's backlog (matches masterchat's
        // ignoreFirstResponse) so a fresh spawn / watchdog respawn doesn't
        // re-dump old comments into the viewer.
        if (!firstPage) {
          for (const item of data.items || []) this._emitMessage(item);
        }
        firstPage = false;
        this.pageToken = data.nextPageToken || this.pageToken;

        // offlineAt present → broadcast ended. Let the loop wind down; the
        // ChannelWatcher will tear us down on its next live-detection poll.
        if (data.offlineAt) {
          this.status = "reconnecting";
          this.lastError = "chat ended";
          this.emit("status", this.snapshot());
        }

        const wait = Math.min(
          Math.max(Number(data.pollingIntervalMillis) || 0, MIN_POLL_MS),
          MAX_POLL_MS
        );
        await this._sleep(wait);
      } catch (err) {
        if (this.stopped) break;
        const reason = err.reason || "";
        // Quota exhausted, or repeated failures (e.g. 404 because a key alone
        // can't read this chat) — stop and signal the watcher to fall back to
        // the masterchat reader. No silent blank-out, no infinite 404 loop.
        this._fails++;
        if (
          reason === "quotaExceeded" ||
          reason === "dailyLimitExceeded" ||
          this._fails >= this.MAX_FAILS
        ) {
          this.status = "error";
          this.lastError =
            reason === "quotaExceeded" || reason === "dailyLimitExceeded"
              ? "YouTube API quota exceeded"
              : `live chat unreadable via API (${err.message || reason})`;
          this.emit("status", this.snapshot());
          this.emit("fallback", this.snapshot());
          return;
        }
        // Stale/invalid chat id — re-resolve from the video on next pass.
        if (reason === "liveChatNotFound" || reason === "liveChatEnded") {
          this.liveChatId = null;
        }
        this.status = "reconnecting";
        this.lastError = err.message || String(err);
        this.emit("status", this.snapshot());
        await this._sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_POLL_MS);
      }
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = { YouTubeApiSource };
