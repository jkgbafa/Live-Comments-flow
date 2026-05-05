// Helpers for YouTube channels: URL parsing and live-stream detection.
// Detection works by fetching the channel's /live page and looking for
// the live videoId in either the redirected URL or the page HTML.
// No API key required.

/**
 * Normalize any user-pasted channel reference into a canonical
 * https://www.youtube.com/<...> URL.
 *
 * Accepts:
 *   "@flowchurch"
 *   "flowchurch"
 *   "https://www.youtube.com/@flowchurch"
 *   "https://youtube.com/channel/UCxxxxx"
 *   "https://www.youtube.com/c/SomeName"
 *   "https://www.youtube.com/@flowchurch/live"   (already a /live URL — fine)
 */
function normalizeChannelUrl(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("empty channel input");

  // Bare handle like "flowchurch" or "@flowchurch"
  if (!s.includes("/") && !s.startsWith("http")) {
    if (!s.startsWith("@")) s = "@" + s;
    s = "https://www.youtube.com/" + s;
  } else if (s.startsWith("@")) {
    s = "https://www.youtube.com/" + s;
  } else if (!s.startsWith("http")) {
    s = "https://" + s;
  }

  // Strip query/fragment, ensure www host
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("invalid URL: " + input);
  }
  if (u.hostname === "youtube.com") u.hostname = "www.youtube.com";
  if (u.hostname === "m.youtube.com") u.hostname = "www.youtube.com";
  if (
    u.hostname !== "www.youtube.com" &&
    u.hostname !== "youtu.be"
  ) {
    throw new Error("not a youtube URL: " + input);
  }
  // Drop trailing /live so we control where it goes
  u.pathname = u.pathname.replace(/\/live\/?$/, "");
  // Drop trailing slash
  u.pathname = u.pathname.replace(/\/$/, "");
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * Build the /live URL for a channel — the page that redirects to the
 * currently-live video, or shows "no live now" if not.
 */
function liveUrlFor(channelUrl) {
  const u = new URL(channelUrl);
  return `${u.origin}${u.pathname}/live`;
}

/**
 * Fetch the channel's /live page and try to detect a currently-live videoId.
 * Returns { videoId, title } if live, or null otherwise.
 *
 * Strategy:
 *  1. Follow redirects. If the final URL is /watch?v=XXXX → that's the live video.
 *  2. Otherwise, check the page HTML for a "live" indicator paired with a videoId.
 *     YouTube embeds JSON in the page that includes `"isLiveNow":true` near
 *     a videoId when a stream is live.
 */
async function detectLiveVideo(channelUrl) {
  const url = liveUrlFor(channelUrl);
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: {
        // Use a real-looking user agent — YouTube serves a different page
        // (and different metadata) to bots.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    throw new Error(`fetch failed: ${err.message}`);
  }
  const finalUrl = res.url || url;
  const finalUrlMatch = finalUrl.match(/[?&]v=([A-Za-z0-9_-]{11})/);

  // Read the body once.
  const html = await res.text();

  // Path 1: Redirect went straight to a /watch?v=... page → almost certainly live.
  // Confirm it really is live by looking at the page HTML (sometimes /live
  // redirects to the most recent past stream/upcoming stream — so we still
  // verify with the HTML markers below).
  let candidateId = finalUrlMatch ? finalUrlMatch[1] : null;

  // Path 2: HTML contains JSON markers. Look for "isLiveNow":true alongside
  // a videoId. We accept the match only if isLiveNow is true.
  const isLiveMatch = /"isLive(?:Now|Broadcast)?"\s*:\s*true/.test(html);

  let title = null;
  // Try to pull a title from the page for nicer display.
  const titleMatch =
    html.match(/<meta\s+name="title"\s+content="([^"]+)"/) ||
    html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch) {
    title = titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, "").trim() || null;
  }

  if (candidateId && isLiveMatch) {
    return { videoId: candidateId, title };
  }
  // If redirect didn't produce a videoId but the HTML contains both isLive
  // and a videoId, use that. This handles edge cases where the /live URL
  // serves the page without an HTTP-level redirect.
  if (!candidateId && isLiveMatch) {
    const idMatch = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
    if (idMatch) return { videoId: idMatch[1], title };
  }
  return null;
}

/**
 * Fetch the channel page (without /live) and extract its display name —
 * e.g. "Dag Heward-Mills" — so admin can show "YouTube - Dag Heward-Mills"
 * instead of the raw URL.
 *
 * Returns { name } or { name: null } if it couldn't be parsed.
 */
async function fetchChannelMetadata(channelUrl) {
  let res;
  try {
    res = await fetch(channelUrl, {
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    return { name: null, error: err.message };
  }
  const html = await res.text();

  // YouTube's page embeds JSON. The most reliable signal for the channel
  // display name is the channelMetadataRenderer block.
  let m;
  if ((m = html.match(/"channelMetadataRenderer":\s*{[^}]*"title":"([^"]+)"/))) {
    return { name: cleanName(m[1]) };
  }
  // Fall back to the og:title meta tag, which is also the channel name.
  if ((m = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/))) {
    return { name: cleanName(m[1]) };
  }
  // Last-ditch: <title>Channel Name - YouTube</title>
  if ((m = html.match(/<title>([^<]+?)\s*-\s*YouTube<\/title>/i))) {
    return { name: cleanName(m[1]) };
  }
  return { name: null };
}

function cleanName(s) {
  if (!s) return null;
  // Decode HTML and JSON-string escapes commonly seen in extracted metadata.
  return s
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim() || null;
}

module.exports = {
  normalizeChannelUrl,
  liveUrlFor,
  detectLiveVideo,
  fetchChannelMetadata,
};
