// Facebook live-comments scraper — runs as a content script on facebook.com.
//
// 2026 layout (verified live): each comment is a
//   <div aria-label="Comment by <Name> <n> <unit> ago" role="article">
// The commenter's REAL name is in the aria-label itself (so we sidestep the
// "Facebook User" anonymization the Graph API suffers from), the body is the
// longest dir="auto" text block inside, and the avatar is an fbcdn/scontent
// <img>. The OLD approach keyed on div[role="article"] + "nearest common
// parent", which broke because FB moved comments out of plain articles and the
// article role only appears once the comment list renders — so it captured 0.
//
// Strategy now: every ~2s, grab all `div[aria-label^="Comment by"]`, parse
// author from the label and text/avatar from inside, dedupe by a stable
// author+text hash, and forward new ones to the background script. The first
// scan only indexes what's already there (no backlog dump); comments that
// arrive after we start watching get forwarded.
(function () {
  const log = (...a) => console.log("[bridge-fb]", ...a);
  log("content script loaded on", location.href);

  const SCAN_INTERVAL_MS = 2000;
  const seen = new Set();
  const SEEN_CAP = 5000;
  let primed = false; // first populated scan indexes existing comments only
  let lastUrl = location.href;
  let context = inferContext();
  log("context:", context);

  function inferContext() {
    const path = location.pathname;
    const url = location.href;
    const out = { channelName: null, channelId: null, videoId: null };
    // /<page>/videos/<id>/...
    let m = path.match(/^\/([^\/]+)\/videos\/(\d+)/);
    if (m) {
      out.channelName = decodeURIComponent(m[1]);
      out.videoId = m[2];
    }
    // /watch/live/?v=<id> and other ?v= forms
    m = url.match(/[?&]v=(\d+)/);
    if (m && !out.videoId) out.videoId = m[1];
    // og:title gives a friendlier page name when the handle isn't in the path.
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content && !out.channelName) out.channelName = og.content;
    return out;
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return ("" + (h >>> 0)).padStart(10, "0");
  }

  function rememberId(id) {
    seen.add(id);
    if (seen.size > SEEN_CAP) {
      const it = seen.values();
      for (let i = 0; i < 1000; i++) seen.delete(it.next().value);
    }
  }

  function extractComment(el) {
    const aria = el.getAttribute("aria-label") || "";
    // Author from the aria-label: "Comment by <NAME> <n> <unit> ago".
    let author = null;
    const m = aria.match(
      /^Comment by\s+(.+?)\s+\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago/i
    );
    author = m ? m[1].trim() : aria.replace(/^Comment by\s+/i, "").trim() || null;
    if (!author) return null;

    // Body: the longest dir="auto" block that isn't the author or a timestamp.
    let text = "";
    for (const d of el.querySelectorAll('[dir="auto"]')) {
      let t = (d.textContent || "").trim();
      if (!t || t === author) continue;
      if (/^\d+\s*[smhdw]$/i.test(t) || /^(just now|now)$/i.test(t)) continue;
      t = t.replace(/\s*See more$/i, "").replace(/…$/, "").trim();
      if (t.length > text.length) text = t;
    }
    if (!text) return null; // sticker/photo-only comment — skip

    // Avatar: first fbcdn/scontent image inside the comment (often lazy-loaded;
    // don't gate on dimensions).
    let avatar = null;
    for (const img of el.querySelectorAll("img")) {
      const s = img.currentSrc || img.src || "";
      if (/fbcdn|scontent/i.test(s)) {
        avatar = s;
        break;
      }
    }

    // Stable id from author+text (NOT the relative time, which changes each
    // render). videoId scopes it to the broadcast.
    const id = "ext:fb:" + (context.videoId || "noVideo") + ":" + hash(author + "|" + text);
    return {
      id,
      platform: "facebook",
      videoId: context.videoId,
      streamTitle: null,
      channelName: context.channelName,
      channelId: context.channelId,
      author,
      avatar,
      text,
      timestamp: new Date().toISOString(),
    };
  }

  function commentNodes() {
    // Skip "Leave a comment" / "Hide comments" buttons that share the prefix.
    return [...document.querySelectorAll('div[aria-label^="Comment by" i]')].filter(
      (el) => el.getAttribute("role") !== "button"
    );
  }

  function forwardBatch(batch) {
    try {
      chrome.runtime.sendMessage({ type: "comments-batch", payload: batch });
      void chrome.runtime.lastError; // keep MV3 console clean
    } catch (e) {
      log("sendMessage threw:", e.message);
    }
  }

  function scan() {
    // SPA navigation to a different video → re-prime for the new stream.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      context = inferContext();
      seen.clear();
      primed = false;
      log("url changed → re-priming for", context.videoId);
    }
    if (!context.videoId) context = inferContext();

    const nodes = commentNodes();
    const batch = [];
    for (const el of nodes) {
      let c;
      try {
        c = extractComment(el);
      } catch (_) {
        continue;
      }
      if (!c || seen.has(c.id)) continue;
      rememberId(c.id);
      if (primed) batch.push(c);
    }

    if (!primed) {
      // Wait until comments actually exist, then index them as backlog.
      if (nodes.length > 0) {
        primed = true;
        log(`primed: indexed ${nodes.length} existing comment(s); forwarding new ones from here`);
      }
      return;
    }
    if (batch.length > 0) {
      log(`forwarding ${batch.length} new comment(s)`);
      forwardBatch(batch);
    }
  }

  setInterval(scan, SCAN_INTERVAL_MS);
  scan();
})();
