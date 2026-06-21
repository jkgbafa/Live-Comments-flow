// YouTube live-chat scraper — runs as a content script on youtube.com.
//
// YT live chat lives in an iframe at /live_chat?v=<videoId>... or is
// embedded directly when the user visits /watch?v=...&...
// Strategy:
//   - Detect the live chat root (yt-live-chat-app or the renderer container)
//   - Identify each new chat message via its yt-live-chat-text-message-renderer
//   - Extract: author handle, avatar src, message text, timestamp
//   - Forward as platform:"youtube" with a stable id from YT's own
//     elements.id attribute (each renderer has a unique id).
(function () {
  // Extract videoId. The live-chat iframe URL (embedded on a watch page) has
  // NO ?v=, so we must also look at the parent watch page. YouTube's watch page
  // and its live_chat iframe are both on www.youtube.com — same origin — so the
  // iframe content script can read window.top.location safely.
  function inferVideoId() {
    // 1) This frame's own URL (covers the live_chat popout and the watch page).
    let m = location.href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    // 2) The parent/top watch page URL (covers the embedded chat iframe).
    try {
      if (window.top && window.top !== window) {
        m = (window.top.location.href || "").match(/[?&]v=([A-Za-z0-9_-]{11})/);
        if (m) return m[1];
      }
    } catch (_) {
      // cross-origin (shouldn't happen on youtube.com) — ignore
    }
    return null;
  }

  function inferChannelName() {
    // Prefer the channel name from the watch page DOM (top frame, same origin).
    // This is the channel the live stream belongs to — exactly what we want on
    // the pill. The server also backfills from videoId, so this is a hint.
    try {
      const doc =
        window.top && window.top !== window ? window.top.document : document;
      const el = doc.querySelector(
        "ytd-channel-name#channel-name a, #owner #channel-name a, " +
          "ytd-video-owner-renderer #channel-name a, #upload-info #channel-name a"
      );
      if (el && el.textContent.trim()) return el.textContent.trim();
    } catch (_) {
      // cross-origin or DOM not ready — ignore
    }
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle?.content) return ogTitle.content;
    return null;
  }

  const log = (...args) => console.log("[bridge-yt]", ...args);
  log("content script loaded on", location.href);

  let videoId = inferVideoId();
  let channelName = inferChannelName();

  const seen = new Set();
  const SEEN_CAP = 4000;

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

  // Each text-message renderer has structure roughly:
  //   <yt-live-chat-text-message-renderer id="..." author-name="...">
  //     <yt-img-shadow id="author-photo"><img src="..."></yt-img-shadow>
  //     <span id="author-name">@handle</span>
  //     <span id="timestamp">10:32 AM</span>
  //     <span id="message">...comment text...</span>
  //   </yt-live-chat-text-message-renderer>
  //
  // Custom YT emojis embed as <img> inside #message — we read textContent
  // (which includes emoji shortcodes via alt) and clean it up.
  function extractText(messageEl) {
    if (!messageEl) return "";
    let out = "";
    for (const node of messageEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent || "";
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === "IMG") {
          // YouTube custom emoji — alt is the shortcode like ":hearts:". Skip.
          // (Standard emojis are unicode in TEXT_NODE so they pass through.)
          continue;
        }
        out += extractText(node);
      }
    }
    return out.trim();
  }

  function extractMessage(renderer) {
    // Renderers can be: text-message, paid-message, membership, sticker, etc.
    // We only forward text messages and treat owner/mod the same as anyone.
    if (
      renderer.tagName !== "YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER" &&
      renderer.tagName !== "YT-LIVE-CHAT-PAID-MESSAGE-RENDERER"
    ) {
      return null;
    }
    const authorEl = renderer.querySelector("#author-name");
    const photoImg = renderer.querySelector("#author-photo img");
    const messageEl = renderer.querySelector("#message");

    const author = authorEl ? authorEl.textContent.trim() : null;
    const text = messageEl ? extractText(messageEl) : "";
    if (!author || !text) return null;

    // Prefer YT's own renderer id; fall back to a content hash so we never
    // silently drop a message just because the id attribute was missing.
    const rawId = renderer.id || renderer.getAttribute("id") || hash(author + "|" + text);
    const externalId = "ext:yt:" + (videoId || "noVideo") + ":" + rawId;
    if (seen.has(externalId)) return null;

    return {
      id: externalId,
      platform: "youtube",
      videoId,
      streamTitle: null,
      channelName,
      author,
      avatar: photoImg?.src || null,
      text,
      timestamp: new Date().toISOString(),
    };
  }

  // Find the live chat list container.
  function findChatContainer() {
    return (
      document.querySelector("yt-live-chat-item-list-renderer #items") ||
      document.querySelector("#chat #items") ||
      document.querySelector("#item-list #items") ||
      null
    );
  }

  function scanAndForward(container) {
    if (!container) return;
    const renderers = container.querySelectorAll(
      "yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer"
    );
    const batch = [];
    for (const r of renderers) {
      const msg = extractMessage(r);
      if (!msg) continue;
      rememberId(msg.id);
      batch.push(msg);
    }
    if (batch.length > 0) {
      log(`forwarding ${batch.length} new message(s)`);
      // Fire-and-forget (no callback) so the MV3 service worker tearing down
      // can't produce "message port closed" errors.
      try {
        chrome.runtime.sendMessage({ type: "comments-batch", payload: batch });
        void chrome.runtime.lastError;
      } catch (e) {
        log("sendMessage threw:", e.message);
      }
    }
  }

  let observer = null;
  let attached = false;
  function attach() {
    const c = findChatContainer();
    if (!c) return false;
    // Pre-index existing without forwarding so we don't ship backlog.
    for (const r of c.querySelectorAll(
      "yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer"
    )) {
      const msg = extractMessage(r);
      if (msg) rememberId(msg.id);
    }
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => scanAndForward(c));
    observer.observe(c, { childList: true, subtree: true });
    return true;
  }

  function tick() {
    // YT navigates SPA-style — videoId can change within a page session.
    const newVid = inferVideoId();
    if (newVid !== videoId) {
      videoId = newVid;
      seen.clear();
      attached = false;
    }
    // The watch page DOM (where the channel name lives) often isn't ready when
    // the iframe script first runs. Keep re-resolving until we have a name.
    if (!channelName) channelName = inferChannelName();
    if (!attached) attached = attach();
    else scanAndForward(findChatContainer());
  }

  setInterval(tick, 2000);
  tick();
})();
