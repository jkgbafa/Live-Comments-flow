// FacebookSource — watches one Facebook Page for live broadcasts and
// streams in their comments via the Graph API.
//
// Strategy:
//   1. Poll /{page_id}/live_videos every 60s to detect a current live video.
//   2. While live, poll /{live_video_id}/comments every 5s.
//   3. Track the timestamp of the most recent comment we've emitted, and
//      filter new comments by created_time > seenSince.
//   4. When the broadcast ends, return to detecting state.
//
// All requests use the Page Access Token (long-lived, never expires).
// One FacebookSource = one Page = one watcher.

const EventEmitter = require("events");

const GRAPH = "https://graph.facebook.com/v19.0";
const LIVE_DETECT_MS = 60_000; // poll for new live broadcasts every 60s
const COMMENT_POLL_MS = 5_000; // poll for new comments every 5s while live
const COMMENT_FETCH_LIMIT = 50;

class FacebookSource extends EventEmitter {
  /**
   * @param {{ id: string, name: string, token: string }} page
   */
  constructor(page) {
    super();
    if (!page || !page.id || !page.token) {
      throw new Error("FacebookSource: page must have id and token");
    }
    this.pageId = String(page.id);
    this.pageName = page.name || `page ${page.id}`;
    this.pageToken = page.token;

    this.stopped = false;
    this.status = "watching"; // watching | live | error | stopped
    this.lastError = null;
    this.lastCheckedAt = null;
    this.currentLiveId = null;
    this.currentLiveTitle = null;

    this._liveDetectTimer = null;
    this._commentPollTimer = null;
    this._seenCommentIds = new Set();
    // FB sometimes returns comments slightly out of order — track the last
    // created_time we've emitted and use that as a filter floor.
    this._latestEmittedTs = 0;
    this.lastMessageAt = null;
    this.startedAt = null;
  }

  start() {
    if (this.stopped === false && this._liveDetectTimer) return; // already running
    this.stopped = false;
    this.startedAt = Date.now();
    this._liveDetectLoop();
    this._liveDetectTimer = setInterval(
      () => this._liveDetectLoop().catch(() => {}),
      LIVE_DETECT_MS
    );
  }

  stop() {
    this.stopped = true;
    if (this._liveDetectTimer) clearInterval(this._liveDetectTimer);
    this._liveDetectTimer = null;
    this._stopCommentPolling();
    this.status = "stopped";
    this.emit("status", this.snapshot());
  }

  snapshot() {
    return {
      input: `fb:${this.pageId}`,
      videoId: this.currentLiveId,
      title: this.currentLiveTitle,
      status: this.status,
      lastError: this.lastError,
      lastCheckedAt: this.lastCheckedAt,
      lastMessageAt: this.lastMessageAt,
      startedAt: this.startedAt,
      // For UI consistency with channel watchers
      pageName: this.pageName,
      pageId: this.pageId,
      platform: "facebook",
    };
  }

  // ------- live detection -------

  async _liveDetectLoop() {
    if (this.stopped) return;
    try {
      // We use /videos?fields=live_status instead of /live_videos because
      // /live_videos is gated behind the Live Video API which requires App
      // Review. /videos with live_status filter is part of the Pages API
      // and only requires pages_read_engagement (which we have).
      const url = `${GRAPH}/${this.pageId}/videos?fields=id,title,live_status,created_time,permalink_url&limit=5&access_token=${encodeURIComponent(
        this.pageToken
      )}`;
      const res = await fetch(url);
      const data = await res.json();
      this.lastCheckedAt = new Date().toISOString();
      if (data.error) {
        this.status = "error";
        this.lastError = data.error.message;
        this.emit("status", this.snapshot());
        return;
      }
      const liveItems = (data.data || []).filter((v) => v.live_status === "LIVE");
      const current = liveItems[0]; // most recent live, if any

      if (current && current.id !== this.currentLiveId) {
        // New live broadcast started (or switched)
        this._stopCommentPolling();
        this.currentLiveId = current.id;
        this.currentLiveTitle = current.title || null;
        this.status = "live";
        this.lastError = null;
        // Seed _latestEmittedTs to NOW so we don't dump the entire backlog.
        this._latestEmittedTs = Date.now();
        this._seenCommentIds.clear();
        this._startCommentPolling();
        this.emit("status", this.snapshot());
      } else if (!current && this.currentLiveId) {
        // Broadcast ended
        this._stopCommentPolling();
        this.currentLiveId = null;
        this.currentLiveTitle = null;
        this.status = "watching";
        this.emit("status", this.snapshot());
      } else {
        // No change
        if (!this.currentLiveId) this.status = "watching";
        this.emit("status", this.snapshot());
      }
    } catch (err) {
      this.lastError = err.message || String(err);
      this.status = this.currentLiveId ? "live" : "error";
      this.emit("status", this.snapshot());
    }
  }

  // ------- comment polling -------

  _startCommentPolling() {
    if (this._commentPollTimer) return;
    this._pollComments().catch(() => {});
    this._commentPollTimer = setInterval(
      () => this._pollComments().catch(() => {}),
      COMMENT_POLL_MS
    );
  }

  _stopCommentPolling() {
    if (this._commentPollTimer) clearInterval(this._commentPollTimer);
    this._commentPollTimer = null;
  }

  async _pollComments() {
    if (this.stopped || !this.currentLiveId) return;
    try {
      // /comments?filter=stream returns live comments; reverse_chronological
      // gives newest first. We re-sort ascending before emitting.
      const url =
        `${GRAPH}/${this.currentLiveId}/comments` +
        `?fields=from{name,id,picture.type(square)},message,created_time,id` +
        `&filter=stream` +
        `&order=reverse_chronological` +
        `&limit=${COMMENT_FETCH_LIMIT}` +
        `&access_token=${encodeURIComponent(this.pageToken)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        // If comment access fails, surface error but don't stop polling.
        this.lastError = data.error.message;
        return;
      }
      const items = (data.data || []).slice().reverse(); // chronological
      for (const c of items) {
        if (this._seenCommentIds.has(c.id)) continue;
        if (!c.message) continue; // skip empty / sticker-only
        const ts = c.created_time ? Date.parse(c.created_time) : Date.now();
        if (ts <= this._latestEmittedTs - 1000) continue; // old
        this._seenCommentIds.add(c.id);
        // Cap the seen set so we don't grow unbounded
        if (this._seenCommentIds.size > 5000) {
          const it = this._seenCommentIds.values();
          for (let i = 0; i < 1000; i++) this._seenCommentIds.delete(it.next().value);
        }
        this._latestEmittedTs = Math.max(this._latestEmittedTs, ts);
        this.lastMessageAt = Date.now();
        // FB strips `from` info for public live-video comments unless the
        // commenter has explicitly authorized our app. Most won't have, so
        // we fall back to a generic label rather than showing nothing.
        const author = c.from?.name || "Facebook viewer";
        const avatar = c.from?.picture?.data?.url || null;
        this.emit("message", {
          id: `fb:${this.currentLiveId}:${c.id}`,
          source: "facebook",
          platform: "facebook",
          videoId: this.currentLiveId,
          streamTitle: this.currentLiveTitle,
          channelName: this.pageName,
          channelId: this.pageId,
          author,
          authorChannelId: c.from?.id || null,
          avatar,
          text: c.message,
          timestamp: c.created_time
            ? new Date(c.created_time).toISOString()
            : new Date().toISOString(),
          isOwner: false,
          isModerator: false,
          isVerified: false,
          membership: false,
        });
      }
    } catch (err) {
      this.lastError = err.message || String(err);
    }
  }
}

module.exports = { FacebookSource };
