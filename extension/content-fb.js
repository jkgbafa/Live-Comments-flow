// Facebook live-comments scraper — runs as a content script on facebook.com.
//
// Strategy:
//   1. Find the comments container on a Live Video page. FB obfuscates class
//      names so we use semantic / role-based selectors that have been stable.
//   2. Index existing comments (so the first scan doesn't dump the entire
//      backlog).
//   3. MutationObserver watches the container. New comment nodes get parsed
//      and forwarded to the background script.
//
// What we extract from each comment:
//   - author (name as text content of the author link)
//   - avatar (img src on the author photo element)
//   - text (the comment body)
//   - timestamp (relative — FB shows "1m" etc., so we use Date.now())
//   - a stable unique id we synthesize (since FB doesn't expose comment IDs
//     in DOM attributes reliably)
(function () {
  // Don't run on FB sub-frames that aren't the main live-video page (FB has
  // many iframes for ads, video player, etc.).
  if (window.top !== window) {
    // Allow if the URL clearly looks like a live-comments-only iframe.
    if (!/comments/i.test(location.pathname) && !/live/i.test(location.pathname)) {
      return;
    }
  }

  const SCAN_INTERVAL_MS = 2500;
  const seen = new Set();
  const SEEN_CAP = 4000;
  let context = inferContext();

  function inferContext() {
    // Try to extract the page name and live-video id from the URL.
    // Common patterns:
    //   /<page-handle>/videos/<numeric-id>/...
    //   /<page-handle>/live/...
    //   /watch?v=<numeric-id>
    //   /<page-handle>?... (fb live homepage)
    const path = location.pathname;
    const url = location.href;
    const out = { channelName: null, channelId: null, videoId: null };
    const m1 = path.match(/^\/([^\/]+)\/videos\/(\d+)/);
    if (m1) {
      out.channelName = decodeURIComponent(m1[1]);
      out.videoId = m1[2];
    }
    const m2 = url.match(/[?&]v=(\d+)/);
    if (m2 && !out.videoId) out.videoId = m2[1];
    // Try og:title for a friendlier channel name.
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && !out.channelName) out.channelName = ogTitle.content;
    return out;
  }

  function rememberId(id) {
    seen.add(id);
    if (seen.size > SEEN_CAP) {
      const it = seen.values();
      for (let i = 0; i < 1000; i++) seen.delete(it.next().value);
    }
  }

  // Hash a string into a short stable id, for synthesizing comment ids when
  // FB doesn't give us one.
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return ("" + (h >>> 0)).padStart(10, "0");
  }

  function findCommentsContainer() {
    // FB renders comments in a list under various roles. Look for the most
    // common ancestor of comment-shaped articles.
    const articles = document.querySelectorAll('div[role="article"]');
    if (articles.length === 0) return null;
    // Pick a reasonable parent that actually contains multiple articles.
    const parents = new Map();
    for (const a of articles) {
      const p = a.parentElement;
      if (!p) continue;
      parents.set(p, (parents.get(p) || 0) + 1);
    }
    let best = null;
    let bestCount = 0;
    for (const [p, c] of parents) {
      if (c > bestCount) {
        best = p;
        bestCount = c;
      }
    }
    return best;
  }

  function extractComment(article) {
    // Skip articles that aren't live comments — exclude posts, ads, etc.
    // Heuristic: a live comment has 1 author link and short-ish content.
    const links = article.querySelectorAll('a[role="link"]');
    if (links.length === 0) return null;

    // Author: first link with a non-empty text (the commenter name).
    let authorEl = null;
    for (const l of links) {
      const t = (l.textContent || "").trim();
      if (t && t.length < 80) {
        authorEl = l;
        break;
      }
    }
    if (!authorEl) return null;
    const author = authorEl.textContent.trim();

    // Avatar: the first <img> inside the article that's not a tiny reaction icon.
    let avatar = null;
    for (const img of article.querySelectorAll("img")) {
      const w = img.naturalWidth || img.width || 0;
      // Profile pictures are typically >= 32px square.
      if (img.src && (w >= 24 || /scontent.*\.fb/.test(img.src))) {
        avatar = img.src;
        break;
      }
    }

    // Comment text: try common containers. FB puts comment body in dir="auto".
    let text = "";
    const dirAuto = article.querySelectorAll('div[dir="auto"]');
    for (const d of dirAuto) {
      const t = (d.textContent || "").trim();
      // Skip the author node itself, timestamps ("1m", "Just now"), and reactions.
      if (!t || t === author || /^\d+[smhd]$/.test(t) || /^Just now$/i.test(t))
        continue;
      // Take the longest dir=auto block — that's almost always the comment body.
      if (t.length > text.length) text = t;
    }
    if (!text) return null;

    // Synthesize a stable id from author+text content. FB sometimes assigns
    // numeric ids on data-comment-id attributes — prefer those when present.
    let externalId = null;
    const dc = article.getAttribute("data-comment-id");
    if (dc) externalId = dc;
    else {
      // Look for any descendant carrying a comment id.
      const idEl = article.querySelector("[data-commentid], [data-comment-id]");
      if (idEl) externalId = idEl.getAttribute("data-commentid") || idEl.getAttribute("data-comment-id");
    }
    const id = "ext:fb:" + (context.videoId || "noVideo") + ":" + (externalId || hash(author + "|" + text));

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

  function scan(container) {
    if (!container) return;
    const articles = container.querySelectorAll('div[role="article"]');
    const batch = [];
    for (const a of articles) {
      try {
        const c = extractComment(a);
        if (!c) continue;
        if (seen.has(c.id)) continue;
        rememberId(c.id);
        batch.push(c);
      } catch (_) {}
    }
    if (batch.length > 0) {
      try {
        chrome.runtime.sendMessage({ type: "comments-batch", payload: batch });
      } catch (_) {}
    }
  }

  let observer = null;
  function attach() {
    const c = findCommentsContainer();
    if (!c) return false;
    if (observer) observer.disconnect();
    // Initial: index existing without forwarding (so we don't dump backlog).
    for (const a of c.querySelectorAll('div[role="article"]')) {
      const m = extractComment(a);
      if (m) rememberId(m.id);
    }
    observer = new MutationObserver(() => scan(c));
    observer.observe(c, { childList: true, subtree: true });
    return true;
  }

  let attached = false;
  function tryAttach() {
    if (!attached) attached = attach();
    // Even after attach, run a full scan periodically in case mutations got
    // missed (e.g. virtualized list re-renders).
    if (attached) {
      const c = findCommentsContainer();
      scan(c);
    } else {
      // Re-update context — URL might change without a full page navigate
      // (FB is a single-page app).
      context = inferContext();
    }
  }

  setInterval(tryAttach, SCAN_INTERVAL_MS);
  tryAttach();
})();
