// ChannelWatcher: polls a YouTube channel's /live page on an interval.
// When the channel is live, it spawns a YouTubeSource and forwards its
// chat messages and status events. When the stream ends, it tears down
// the source. The channel itself stays in "watching" mode forever — set
// it once, and it auto-resumes on every future live broadcast.

const EventEmitter = require("events");
const { randomUUID } = require("crypto");
const { YouTubeSource } = require("./youtube-source");
const {
  normalizeChannelUrl,
  detectLiveVideo,
  fetchChannelMetadata,
} = require("./youtube-channel");

const DEFAULT_POLL_MS = 60_000;
// If a source has been running but hasn't received a message in this long,
// while the channel /live page still says the broadcast is live, assume the
// chat iterator silently stalled (common behaviour from data-center IPs that
// YouTube soft-throttles). Tear down and respawn.
const STALL_THRESHOLD_MS = 4 * 60_000; // 4 minutes
// Even when a source looks healthy, force a fresh masterchat session every
// this often. Prevents long-lived continuation tokens from getting throttled.
// 25 min is well below typical timeouts but long enough to avoid churn.
const PREVENTIVE_REFRESH_MS = 25 * 60_000;
// If the source has just been spawned and hasn't produced ANY message yet,
// give it this long before deciding it's broken (the broadcast may genuinely
// have no traffic for a moment).
const INITIAL_GRACE_MS = 90_000;

class ChannelWatcher extends EventEmitter {
  constructor({
    id,
    input,
    name,
    displayName,
    platform,
    enabled,
    pollIntervalMs,
  }) {
    super();
    this.id = id || `ch_${randomUUID().slice(0, 8)}`;
    this.input = input; // raw user input
    this.canonical = normalizeChannelUrl(input);
    this.platform = platform || "youtube"; // future: "facebook", "tiktok"
    // Friendly name override set by user via PATCH. Distinct from displayName
    // (which is fetched from the channel itself).
    this.name = name || null;
    this.displayName = displayName || null; // e.g. "Dag Heward-Mills"
    this.enabled = !!enabled;
    this.pollIntervalMs = pollIntervalMs || DEFAULT_POLL_MS;

    this.status = "stopped"; // stopped | watching | live | error
    this.lastError = null;
    this.lastCheckedAt = null;
    this.currentVideoId = null;
    this.currentTitle = null;

    this._timer = null;
    this._source = null;
    this._inFlight = false;
    this._metadataFetched = !!displayName;
  }

  toJSON() {
    return {
      id: this.id,
      input: this.input,
      canonical: this.canonical,
      platform: this.platform,
      name: this.name,
      displayName: this.displayName,
      enabled: this.enabled,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  snapshot() {
    return {
      ...this.toJSON(),
      status: this.status,
      lastError: this.lastError,
      lastCheckedAt: this.lastCheckedAt,
      currentVideoId: this.currentVideoId,
      currentTitle: this.currentTitle,
      // Convenient pre-formatted label, e.g. "youtube - Dag Heward-Mills".
      label: this._label(),
    };
  }

  _label() {
    const name = this.name || this.displayName || this.canonical;
    // Display platforms in caps for readability ("YOUTUBE - Dag Heward-Mills").
    return `${this.platform.toUpperCase()} - ${name}`;
  }

  // Fetch and cache the channel's display name. Called on first add and
  // re-tried on poll if it failed previously.
  async _ensureMetadata() {
    if (this._metadataFetched && this.displayName) return;
    try {
      const meta = await fetchChannelMetadata(this.canonical);
      if (meta.name) {
        this.displayName = meta.name;
        this._metadataFetched = true;
        this.emit("status", this.snapshot());
      }
    } catch {
      // Swallow — non-fatal. Next poll will retry.
    }
  }

  start() {
    if (this.enabled && this._timer) return; // already running
    this.enabled = true;
    this.status = "watching";
    this.emit("status", this.snapshot());
    // Run a poll immediately, then on interval.
    this._poll().catch(() => {});
    this._timer = setInterval(() => this._poll().catch(() => {}), this.pollIntervalMs);
  }

  stop() {
    this.enabled = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._tearDownSource("stopped by user");
    this.status = "stopped";
    this.emit("status", this.snapshot());
  }

  async pollNow() {
    return this._poll();
  }

  async _poll() {
    if (!this.enabled) return;
    if (this._inFlight) return; // prevent overlapping polls
    this._inFlight = true;
    // Fire-and-forget metadata refresh — doesn't block live detection.
    this._ensureMetadata();
    try {
      const result = await detectLiveVideo(this.canonical);
      this.lastCheckedAt = new Date().toISOString();
      this.lastError = null;

      if (result && result.videoId) {
        if (this.currentVideoId !== result.videoId) {
          // Channel just went live, OR switched to a new live video.
          this._tearDownSource("switching to new live video");
          this.currentVideoId = result.videoId;
          this.currentTitle = result.title || null;
          this._spawnSource(result.videoId);
        } else if (result.title && !this.currentTitle) {
          this.currentTitle = result.title;
        }
        // ----- Stall watchdog -----
        // The channel page says we're live. If our source has been running
        // long enough but hasn't produced a message recently, the chat
        // iterator has silently stalled — common from data-center IPs that
        // YouTube soft-throttles. Force a respawn with a fresh session.
        if (this._source && this._source.startedAt) {
          const now = Date.now();
          const sourceAgeMs = now - this._source.startedAt;
          const lastMsgAgeMs = this._source.lastMessageAt
            ? now - this._source.lastMessageAt
            : sourceAgeMs;
          const stalled =
            lastMsgAgeMs > STALL_THRESHOLD_MS &&
            sourceAgeMs > INITIAL_GRACE_MS;
          const dueForPreventiveRefresh = sourceAgeMs > PREVENTIVE_REFRESH_MS;
          if (stalled || dueForPreventiveRefresh) {
            const reason = stalled
              ? `stalled (no message in ${Math.round(lastMsgAgeMs / 1000)}s)`
              : "preventive refresh";
            console.warn(
              `[watchdog] ${this.canonical} ${reason} — respawning source`
            );
            this._tearDownSource(reason);
            this._spawnSource(result.videoId);
          }
        }
        this.status = "live";
      } else {
        // Not live right now.
        if (this.currentVideoId) {
          // Stream just ended.
          this._tearDownSource("stream ended");
          this.currentVideoId = null;
          this.currentTitle = null;
        }
        this.status = "watching";
      }
      this.emit("status", this.snapshot());
    } catch (err) {
      this.lastError = err.message || String(err);
      this.status = this.currentVideoId ? "live" : "error";
      this.emit("status", this.snapshot());
    } finally {
      this._inFlight = false;
    }
  }

  _spawnSource(videoId) {
    const src = new YouTubeSource(videoId);
    this._source = src;
    src.on("message", (msg) => {
      // Tag with channel info so the viewer can show which channel this came
      // from. Prefer the user-supplied name, fall back to the fetched display
      // name (e.g. "Dag Heward-Mills"), then the canonical URL.
      this.emit("message", {
        ...msg,
        channelId: this.id,
        channelName: this.name || this.displayName || null,
        platform: this.platform,
      });
    });
    src.on("status", (snap) => {
      // Forward source status as part of the channel snapshot.
      // If the underlying source errored persistently, surface that.
      if (snap.status === "error" || snap.status === "stopped") {
        this.lastError = snap.lastError || this.lastError;
      }
      // Use source's title if richer than what we got from /live HTML.
      if (snap.title && (!this.currentTitle || this.currentTitle.length < snap.title.length)) {
        this.currentTitle = snap.title;
      }
      this.emit("status", this.snapshot());
    });
    src.start();
  }

  _tearDownSource(_reason) {
    if (this._source) {
      try { this._source.stop(); } catch (_) {}
      this._source = null;
    }
  }
}

module.exports = { ChannelWatcher };
