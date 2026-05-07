// Apify-based fallback source for Facebook live comments.
//
// Use case: when the browser extension isn't available (your laptop is off,
// crashed, or you forgot to keep the FB tab open), Apify's
// "Facebook Comments Scraper" actor can be run on-demand to fetch comments
// (including commenter name + profile photo) for a live broadcast post.
//
// How it works:
//   1. We trigger Apify actor `apify/facebook-comments-scraper` with the
//      live video's URL.
//   2. Apify runs the actor (server-side) and returns a dataset of comments.
//   3. We poll Apify's dataset endpoint for new entries every ~10s and emit
//      them as messages.
//
// Triggering criteria:
//   - Only when env var APIFY_TOKEN is set
//   - Only when extension is not actively pushing for the same page (we
//     check this via lastMessageAt on the running source)
//
// Cost estimate: Apify charges ~$1.40 per 1,000 comments. A typical 1-hour
// live broadcast with 500 comments costs about $0.70.

const EventEmitter = require("events");

const APIFY_BASE = "https://api.apify.com/v2";
const ACTOR_ID = "apify~facebook-comments-scraper";
const POLL_INTERVAL_MS = 10_000;

class ApifyFacebookSource extends EventEmitter {
  /**
   * @param {{
   *   token: string,
   *   pageId: string,
   *   pageName: string,
   *   videoUrl: string,
   *   videoId: string,
   * }} cfg
   */
  constructor(cfg) {
    super();
    if (!cfg || !cfg.token || !cfg.videoUrl) {
      throw new Error("ApifyFacebookSource: token and videoUrl required");
    }
    this.token = cfg.token;
    this.pageId = cfg.pageId;
    this.pageName = cfg.pageName || "Facebook";
    this.videoUrl = cfg.videoUrl;
    this.videoId = cfg.videoId || null;

    this.runId = null;
    this.datasetId = null;
    this.cursor = 0;
    this.stopped = false;
    this.status = "starting";
    this.lastError = null;
    this.lastMessageAt = null;
    this.startedAt = null;
    this._pollTimer = null;
    this._seenIds = new Set();
  }

  snapshot() {
    return {
      input: `apify-fb:${this.videoUrl}`,
      videoId: this.videoId,
      title: null,
      status: this.status,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      startedAt: this.startedAt,
      pageName: this.pageName,
      pageId: this.pageId,
      platform: "facebook",
      via: "apify",
    };
  }

  async start() {
    this.stopped = false;
    this.startedAt = Date.now();
    try {
      // Kick off the actor. Run options pulled from Apify's docs:
      //   - startUrls: [{ url: videoUrl }]
      //   - resultsLimit: high cap (we'll stop on .stop())
      //   - reactionsLimit: 0 (we don't need reactions)
      const startRes = await fetch(
        `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${encodeURIComponent(this.token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startUrls: [{ url: this.videoUrl }],
            resultsLimit: 5000,
            includeNestedComments: false,
            // Sort newest first so we see live comments quickly. Some actor
            // versions accept "recent" or "newest" — defaults are fine if
            // not respected.
            commentsMode: "RECENT",
          }),
        }
      );
      const startJson = await startRes.json();
      if (!startRes.ok || !startJson.data) {
        throw new Error(
          startJson?.error?.message || `actor start failed: HTTP ${startRes.status}`
        );
      }
      this.runId = startJson.data.id;
      this.datasetId = startJson.data.defaultDatasetId;
      this.status = "running";
      this.emit("status", this.snapshot());
      this._pollLoop();
    } catch (err) {
      this.status = "error";
      this.lastError = err.message;
      this.emit("status", this.snapshot());
    }
  }

  async stop() {
    this.stopped = true;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
    // Try to abort the Apify actor run so we don't keep paying for it.
    if (this.runId) {
      try {
        await fetch(
          `${APIFY_BASE}/actor-runs/${this.runId}/abort?token=${encodeURIComponent(
            this.token
          )}`,
          { method: "POST" }
        );
      } catch (_) {
        // best-effort
      }
    }
    this.status = "stopped";
    this.emit("status", this.snapshot());
  }

  async _pollLoop() {
    if (this.stopped) return;
    try {
      const url =
        `${APIFY_BASE}/datasets/${this.datasetId}/items` +
        `?token=${encodeURIComponent(this.token)}` +
        `&offset=${this.cursor}` +
        `&limit=100&clean=true`;
      const res = await fetch(url);
      if (!res.ok) {
        this.lastError = `dataset read HTTP ${res.status}`;
      } else {
        const items = await res.json();
        for (const c of items) {
          // Apify's facebook-comments-scraper schema:
          //   { id, text, date, profileName, profileUrl, profilePicture, ... }
          const id = c.id || c.commentId;
          if (!id || this._seenIds.has(id)) continue;
          this._seenIds.add(id);
          if (!c.text) continue;
          this.lastMessageAt = Date.now();
          this.emit("message", {
            id: `apify:fb:${this.videoId || "v"}:${id}`,
            source: "facebook",
            platform: "facebook",
            via: "apify",
            videoId: this.videoId,
            channelName: this.pageName,
            channelId: this.pageId,
            author: c.profileName || c.from?.name || "Facebook",
            authorChannelId: c.profileId || null,
            avatar: c.profilePicture || c.profileImage || null,
            text: c.text,
            timestamp: c.date
              ? new Date(c.date).toISOString()
              : new Date().toISOString(),
          });
        }
        this.cursor += items.length;
      }
    } catch (err) {
      this.lastError = err.message;
    }
    if (!this.stopped) {
      this._pollTimer = setTimeout(() => this._pollLoop(), POLL_INTERVAL_MS);
    }
  }
}

module.exports = { ApifyFacebookSource };
