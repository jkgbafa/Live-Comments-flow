// Live Chat Aggregator — Express + WebSocket server.
//
// Two ways to feed chat into the aggregator:
//   1. Channels (recommended). Add a YouTube channel URL or @handle in admin.
//      The server polls /@channel/live every minute. When live → spawns a chat
//      source automatically. When stream ends → cleans up. The channel stays
//      in "watching" mode so future broadcasts auto-resume. Set once, forever.
//   2. Direct video URLs (legacy). Paste a specific live URL — for one-off
//      events where you don't want to add a permanent channel.
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { YouTubeSource } = require("./lib/youtube-source");
const { ChannelWatcher } = require("./lib/channel-watcher");
const { FacebookSource } = require("./lib/facebook-source");
const { ApifyFacebookSource } = require("./lib/apify-facebook-source");
const {
  loadChannels,
  saveChannels,
  loadFbState,
  saveFbState,
} = require("./lib/store");
const {
  Scheduler,
  DEFAULT_WINDOWS,
  describeWindow,
} = require("./lib/scheduler");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me";
const MAX_BUFFER = 200;
// Cookie session lifetime. Browsers cap real persistence at ~400 days, but
// we set far higher AND refresh the cookie on every authenticated request
// (rolling session) so the user effectively stays logged in forever.
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 365 * 10; // 10 years (browser caps)

const app = express();
// Larger body limit for batched extension uploads (could be 50 comments
// each with avatar URLs — well under 100 KB but allow some headroom).
app.use(express.json({ limit: "200kb" }));

// CORS for the Chrome extension. Extension origins look like
// `chrome-extension://<id>` and we don't know the id ahead of time. We
// only allow specific endpoints + only when an x-admin-token is present,
// so reflecting the origin is safe enough for this self-hosted use.
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const isExtension =
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://");
  if (isExtension && req.path.startsWith("/api/extension")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});

// Clean URL for admin: /admin → admin.html. Must be registered BEFORE the
// static middleware so it wins over any default file matching.
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

app.use(express.static(path.join(__dirname, "public")));

// --- Auth helpers ---
// Tiny inline cookie parser (avoids pulling in cookie-parser as a dep).
function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function getAdminToken(req) {
  // Three sources, in priority order:
  //   1. Cookie set by /api/admin/login (the new clean flow)
  //   2. x-admin-token header (for API tools / curl)
  //   3. ?token= query (legacy fallback for old bookmarks)
  return (
    parseCookies(req.headers.cookie || "").lca_admin ||
    req.header("x-admin-token") ||
    req.query.token ||
    null
  );
}

// State
const channels = new Map(); // id -> ChannelWatcher (YouTube, channel-based)
const directSources = new Map(); // input -> YouTubeSource (legacy direct video URLs)
const fbPages = new Map(); // pageId -> FacebookSource
const recent = []; // ring buffer of recent messages

// Scheduler — fires extra polls during configured windows. Default schedule
// covers the broadcast slots (see lib/scheduler.js for details).
const scheduler = new Scheduler();
scheduler.setWindows(DEFAULT_WINDOWS);
scheduler.on("tick", (window) => {
  // During a scheduled window, poll every enabled channel right away.
  for (const ch of channels.values()) {
    if (ch.enabled) ch.pollNow().catch(() => {});
  }
  broadcast({ type: "scheduled_tick", window });
});
scheduler.on("window_start", (window) => {
  console.log(`[scheduler] window started: ${describeWindow(window)}`);
  broadcast({ type: "window_start", window });
});
scheduler.on("window_end", () => {
  broadcast({ type: "window_end" });
});

// --- helpers ---
function rememberMessage(msg) {
  recent.push(msg);
  if (recent.length > MAX_BUFFER) recent.shift();
}

let wss; // assigned below
function broadcast(obj) {
  if (!wss) return;
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function attachChannel(ch) {
  ch.on("message", (msg) => {
    rememberMessage(msg);
    broadcast({ type: "message", message: msg });
  });
  ch.on("status", (snap) => {
    broadcast({ type: "channel_status", channel: snap });
  });
}

function attachDirectSource(src) {
  src.on("message", (msg) => {
    rememberMessage(msg);
    broadcast({ type: "message", message: msg });
  });
  src.on("status", (snap) => {
    broadcast({ type: "source_status", source: snap });
  });
}

function attachFbPage(src) {
  src.on("message", (msg) => {
    rememberMessage(msg);
    broadcast({ type: "message", message: msg });
  });
  src.on("status", (snap) => {
    broadcast({ type: "fb_status", source: snap });
  });
}

function listFbPages() {
  return Array.from(fbPages.values()).map((s) => s.snapshot());
}

function listChannels() {
  return Array.from(channels.values()).map((c) => c.snapshot());
}

function listDirectSources() {
  return Array.from(directSources.values()).map((s) => s.snapshot());
}

async function persistChannels() {
  const data = Array.from(channels.values()).map((c) => c.toJSON());
  await saveChannels(data).catch((err) =>
    console.warn("[server] saveChannels failed:", err.message)
  );
}

function requireAdmin(req, res, next) {
  const token = getAdminToken(req);
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  refreshSessionCookie(req, res);
  next();
}

// --- Auth API ---
// POST /api/admin/login — sets a session cookie if password matches.
// Cookie is httpOnly + sameSite=strict + secure (when behind https), so it
// can't be read by JS or sent cross-site.
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== "string" || password !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "wrong password" });
  }
  const onHttps =
    req.protocol === "https" ||
    req.header("x-forwarded-proto") === "https";
  res.cookie("lca_admin", ADMIN_TOKEN, {
    httpOnly: true,
    secure: onHttps,
    sameSite: "strict",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
  res.json({ ok: true });
});

// Rolling session: any authenticated request refreshes the cookie. Combined
// with the long maxAge, this means the user stays logged in indefinitely
// as long as they touch the admin at least once a year.
function refreshSessionCookie(req, res) {
  const token = parseCookies(req.headers.cookie || "").lca_admin;
  if (token !== ADMIN_TOKEN) return;
  const onHttps =
    req.protocol === "https" || req.header("x-forwarded-proto") === "https";
  res.cookie("lca_admin", ADMIN_TOKEN, {
    httpOnly: true,
    secure: onHttps,
    sameSite: "strict",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

app.post("/api/admin/logout", (_req, res) => {
  res.clearCookie("lca_admin", { path: "/" });
  res.json({ ok: true });
});

// Quick check used by the admin page on load to know if the cookie is valid.
app.get("/api/admin/me", (req, res) => {
  const token = getAdminToken(req);
  res.json({ loggedIn: token === ADMIN_TOKEN });
});

// --- Channels API (primary) ---
app.get("/api/channels", requireAdmin, (_req, res) => {
  res.json({ channels: listChannels() });
});

app.post("/api/channels", requireAdmin, async (req, res) => {
  const { url, name, platform, autostart } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "missing url" });
  }
  let ch;
  try {
    ch = new ChannelWatcher({
      input: url,
      name: name || null,
      platform: platform || "youtube",
      enabled: false,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // Reject duplicates by canonical URL
  for (const existing of channels.values()) {
    if (existing.canonical === ch.canonical) {
      return res.status(409).json({ error: "channel already added", channel: existing.snapshot() });
    }
  }
  channels.set(ch.id, ch);
  attachChannel(ch);
  // Kick off a metadata fetch right away so the admin sees a real name
  // instead of just the URL.
  ch._ensureMetadata().catch(() => {});
  if (autostart !== false) ch.start();
  await persistChannels();
  res.json({ channel: ch.snapshot() });
});

app.post("/api/channels/:id/start", requireAdmin, async (req, res) => {
  const ch = channels.get(req.params.id);
  if (!ch) return res.status(404).json({ error: "not found" });
  ch.start();
  await persistChannels();
  res.json({ channel: ch.snapshot() });
});

app.post("/api/channels/:id/stop", requireAdmin, async (req, res) => {
  const ch = channels.get(req.params.id);
  if (!ch) return res.status(404).json({ error: "not found" });
  ch.stop();
  await persistChannels();
  res.json({ channel: ch.snapshot() });
});

app.post("/api/channels/:id/poll", requireAdmin, async (req, res) => {
  const ch = channels.get(req.params.id);
  if (!ch) return res.status(404).json({ error: "not found" });
  await ch.pollNow();
  res.json({ channel: ch.snapshot() });
});

app.patch("/api/channels/:id", requireAdmin, async (req, res) => {
  const ch = channels.get(req.params.id);
  if (!ch) return res.status(404).json({ error: "not found" });
  const { name } = req.body || {};
  if (typeof name === "string") ch.name = name.trim() || null;
  await persistChannels();
  res.json({ channel: ch.snapshot() });
});

app.delete("/api/channels/:id", requireAdmin, async (req, res) => {
  const ch = channels.get(req.params.id);
  if (!ch) return res.status(404).json({ error: "not found" });
  ch.stop();
  channels.delete(ch.id);
  broadcast({ type: "channel_removed", id: ch.id });
  await persistChannels();
  res.json({ ok: true });
});

// --- Direct sources API (legacy / one-off) ---
app.get("/api/sources", requireAdmin, (_req, res) => {
  res.json({ sources: listDirectSources() });
});

app.post("/api/sources", requireAdmin, (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "missing url" });
  if (directSources.has(url)) {
    return res.status(409).json({ error: "already added", source: directSources.get(url).snapshot() });
  }
  const src = new YouTubeSource(url);
  directSources.set(url, src);
  attachDirectSource(src);
  src.start();
  res.json({ source: src.snapshot() });
});

app.delete("/api/sources", requireAdmin, (req, res) => {
  const { url } = req.body || {};
  if (!url || !directSources.has(url)) return res.status(404).json({ error: "not found" });
  const src = directSources.get(url);
  src.stop();
  directSources.delete(url);
  broadcast({ type: "source_removed", input: url });
  res.json({ ok: true });
});

app.post("/api/clear-recent", requireAdmin, (_req, res) => {
  recent.length = 0;
  broadcast({ type: "cleared" });
  res.json({ ok: true });
});

// --- Browser extension push endpoint ---
// The Chrome extension running on Joshua's laptop scrapes FB Live + YT live
// chat from the logged-in browser session and POSTs each new comment here.
// This bypasses:
//   * FB privacy: API hides commenter name/photo on public live videos.
//     Browser sees the real names because it's the rendered page.
//   * YouTube data-center IP throttling: extension runs on residential IP.
//
// Auth: same admin token. We treat extension-pushed comments the same as
// scraped ones — broadcast to viewers, dedupe via the message id.

// The FB extension reads the channel name from the live-video URL path, which
// is a numeric profile id ("100084941564133") or a vanity slug
// ("daghewardmills.org") — neither is human-friendly. Map known identifiers to
// the proper page name. Keys are lowercased URL segments / slugs / page ids.
const FB_NAME_ALIASES = {
  "100084941564133": "The Flow Church",
  "theflowchurch": "The Flow Church",
  "108294972006462": "The Flow Church",
  "daghewardmills.org": "Dag Heward-Mills",
  "daghewardmills": "Dag Heward-Mills",
  "112564093622": "Dag Heward-Mills",
  "daghewardmillsfr": "Dag Heward-Mills en Français",
  "193810450659841": "Dag Heward-Mills en Français",
};

function friendlyChannelName(raw) {
  if (!raw) return raw;
  const key = String(raw).trim().toLowerCase();
  return FB_NAME_ALIASES[key] || raw;
}

// Extension-scraped YouTube comments arrive without a channel name — the
// live-chat iframe can't see which channel it belongs to. But the server is
// already watching these channels and knows each one's current live videoId,
// so we backfill the friendly channel name by matching the comment's videoId
// against the watchers. Returns null if no watched channel is on that video.
function channelNameForVideoId(videoId) {
  if (!videoId) return null;
  for (const ch of channels.values()) {
    if (ch.currentVideoId && ch.currentVideoId === videoId) {
      return ch.name || ch.displayName || null;
    }
  }
  return null;
}

function ingestExtensionComment(m) {
  if (!m || typeof m !== "object") return null;
  if (typeof m.text !== "string" || !m.text.trim()) return null;
  const platform = (m.platform === "youtube" ? "youtube" : "facebook");
  const id =
    m.id ||
    `ext:${platform}:${m.videoId || "unknown"}:${m.externalId || Date.now() + ":" + Math.random()}`;
  const msg = {
    id,
    source: platform,
    platform,
    via: "extension",
    videoId: m.videoId || null,
    streamTitle: m.streamTitle || null,
    channelName:
      friendlyChannelName(m.channelName) ||
      channelNameForVideoId(m.videoId) ||
      null,
    channelId: m.channelId || null,
    author: m.author || (platform === "facebook" ? "Facebook" : "YouTube viewer"),
    authorChannelId: m.authorChannelId || null,
    avatar: m.avatar || null,
    text: m.text,
    timestamp: m.timestamp || new Date().toISOString(),
    isOwner: false,
    isModerator: false,
    isVerified: false,
    membership: false,
  };
  rememberMessage(msg);
  broadcast({ type: "message", message: msg });
  return msg;
}

app.post("/api/extension/comment", requireAdmin, (req, res) => {
  const out = ingestExtensionComment(req.body);
  if (!out) return res.status(400).json({ error: "invalid comment" });
  res.json({ ok: true, id: out.id });
});

// Batched variant: extension can buffer + send 10–50 at a time when traffic
// is heavy. Avoids hitting Cloudflare/Fly with hundreds of small POSTs/sec.
app.post("/api/extension/comments", requireAdmin, (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : req.body?.comments;
  if (!Array.isArray(arr)) return res.status(400).json({ error: "expected array" });
  let accepted = 0;
  for (const c of arr) {
    if (ingestExtensionComment(c)) accepted++;
  }
  res.json({ ok: true, accepted, total: arr.length });
});

// Health check the extension uses to verify auth before sending comments.
app.get("/api/extension/ping", requireAdmin, (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Schedule API ---
app.get("/api/schedule", requireAdmin, (_req, res) => {
  res.json({
    windows: scheduler.windows.map((w) => ({ ...w, label: describeWindow(w) })),
    nextRun: scheduler.nextRun(),
    currentlyInWindow: scheduler.currentWindow() || null,
  });
});

app.put("/api/schedule", requireAdmin, (req, res) => {
  const { windows } = req.body || {};
  if (!Array.isArray(windows)) {
    return res.status(400).json({ error: "windows must be an array" });
  }
  for (const w of windows) {
    if (
      typeof w.day !== "number" ||
      w.day < 0 ||
      w.day > 6 ||
      typeof w.startMinute !== "number" ||
      typeof w.endMinute !== "number" ||
      w.startMinute < 0 ||
      w.endMinute > 1439 ||
      w.startMinute > w.endMinute
    ) {
      return res.status(400).json({ error: "invalid window: " + JSON.stringify(w) });
    }
  }
  scheduler.setWindows(windows);
  res.json({ windows: scheduler.windows, nextRun: scheduler.nextRun() });
});

// --- Public state (read-only, used by viewer) ---
app.get("/api/state", (_req, res) => {
  res.json({
    channels: listChannels(),
    sources: listDirectSources(),
    fbPages: listFbPages(),
    recent,
    schedule: {
      windows: scheduler.windows.map((w) => ({ ...w, label: describeWindow(w) })),
      nextRun: scheduler.nextRun(),
      currentlyInWindow: scheduler.currentWindow() || null,
    },
  });
});

// In-memory mirror of FB enabled/disabled state, mapped to page IDs.
// Persisted to fb-state.json so removals/pauses survive restarts.
let fbState = {};

async function persistFbState() {
  await saveFbState(fbState).catch((err) =>
    console.warn("[server] saveFbState failed:", err.message)
  );
}

app.get("/api/fb-pages", requireAdmin, (_req, res) => {
  res.json({ fbPages: listFbPages() });
});

app.post("/api/fb-pages/:id/poll", requireAdmin, async (req, res) => {
  const src = fbPages.get(req.params.id);
  if (!src) return res.status(404).json({ error: "not found" });
  await src._liveDetectLoop().catch(() => {});
  res.json({ source: src.snapshot() });
});

app.post("/api/fb-pages/:id/start", requireAdmin, async (req, res) => {
  const src = fbPages.get(req.params.id);
  if (!src) return res.status(404).json({ error: "not found" });
  src.start();
  fbState[req.params.id] = { ...(fbState[req.params.id] || {}), enabled: true };
  await persistFbState();
  res.json({ source: src.snapshot() });
});

app.post("/api/fb-pages/:id/stop", requireAdmin, async (req, res) => {
  const src = fbPages.get(req.params.id);
  if (!src) return res.status(404).json({ error: "not found" });
  src.stop();
  fbState[req.params.id] = { ...(fbState[req.params.id] || {}), enabled: false };
  await persistFbState();
  res.json({ source: src.snapshot() });
});

// --- Apify fallback: trigger Apify Facebook Comments Scraper on demand ---
// Maps page id -> active ApifyFacebookSource. Only one per page at a time.
const apifyFbSources = new Map();

app.post("/api/fb-pages/:id/apify-start", requireAdmin, async (req, res) => {
  const fb = fbPages.get(req.params.id);
  if (!fb) return res.status(404).json({ error: "page not found" });
  if (!process.env.APIFY_TOKEN) {
    return res.status(400).json({
      error: "APIFY_TOKEN env not set — add it via fly secrets first",
    });
  }
  if (!fb.currentLiveId) {
    return res.status(400).json({
      error: "no live video detected for this page yet",
    });
  }
  if (apifyFbSources.has(req.params.id)) {
    return res.status(409).json({
      error: "Apify source already running for this page",
    });
  }
  const videoUrl = `https://www.facebook.com/${req.params.id}/videos/${fb.currentLiveId}`;
  const src = new ApifyFacebookSource({
    token: process.env.APIFY_TOKEN,
    pageId: req.params.id,
    pageName: fb.pageName,
    videoId: fb.currentLiveId,
    videoUrl,
  });
  apifyFbSources.set(req.params.id, src);
  src.on("message", (msg) => {
    rememberMessage(msg);
    broadcast({ type: "message", message: msg });
  });
  src.on("status", (snap) => {
    broadcast({ type: "apify_fb_status", source: snap });
  });
  await src.start();
  res.json({ ok: true, source: src.snapshot() });
});

app.post("/api/fb-pages/:id/apify-stop", requireAdmin, async (req, res) => {
  const src = apifyFbSources.get(req.params.id);
  if (!src) return res.status(404).json({ error: "no Apify source running" });
  await src.stop();
  apifyFbSources.delete(req.params.id);
  res.json({ ok: true });
});

app.delete("/api/fb-pages/:id", requireAdmin, async (req, res) => {
  const src = fbPages.get(req.params.id);
  if (!src) return res.status(404).json({ error: "not found" });
  src.stop();
  fbPages.delete(req.params.id);
  fbState[req.params.id] = { enabled: false, removed: true };
  await persistFbState();
  broadcast({ type: "fb_removed", id: req.params.id });
  res.json({ ok: true });
});

// --- HTTP + WS ---
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "init",
      channels: listChannels(),
      sources: listDirectSources(),
      fbPages: listFbPages(),
      recent,
    })
  );
});

// --- Facebook pages from env ---
async function startFbPagesFromEnv() {
  const raw = process.env.FB_PAGES;
  if (!raw) {
    console.log("[fb] FB_PAGES env not set — skipping Facebook integration");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[fb] FB_PAGES is not valid JSON: ${err.message}`);
    return;
  }
  if (!Array.isArray(parsed)) {
    console.warn("[fb] FB_PAGES must be an array of {name, id, token}");
    return;
  }
  fbState = await loadFbState();
  for (const p of parsed) {
    if (!p || !p.id || !p.token) {
      console.warn("[fb] skipping invalid page entry:", p);
      continue;
    }
    const persisted = fbState[String(p.id)] || {};
    if (persisted.removed) {
      console.log(`[fb] page removed by admin (skipping): ${p.name || p.id}`);
      continue;
    }
    try {
      const src = new FacebookSource(p);
      fbPages.set(src.pageId, src);
      attachFbPage(src);
      // If the admin previously paused this page, keep it paused.
      if (persisted.enabled === false) {
        src.enabled = false;
        src.status = "stopped";
        console.log(`[fb] page paused (not starting): ${p.name || p.id}`);
        // Don't call src.start() — leave it idle but in the list.
      } else {
        src.start();
        console.log(`[fb] watching page: ${p.name || p.id}`);
      }
    } catch (err) {
      console.warn(`[fb] failed to start page ${p.id}: ${err.message}`);
    }
  }
}

// --- Startup: load persisted channels ---
async function startup() {
  const saved = await loadChannels();
  for (const entry of saved) {
    try {
      const ch = new ChannelWatcher({
        id: entry.id,
        input: entry.input,
        name: entry.name,
        displayName: entry.displayName,
        platform: entry.platform || "youtube",
        enabled: !!entry.enabled,
        pollIntervalMs: entry.pollIntervalMs,
      });
      channels.set(ch.id, ch);
      attachChannel(ch);
      // Refresh display name in the background — channel names can change.
      ch._ensureMetadata().catch(() => {});
      if (entry.enabled) ch.start();
    } catch (err) {
      console.warn(
        `[server] failed to load channel ${entry.input}: ${err.message}`
      );
    }
  }
  console.log(`[server] loaded ${channels.size} persisted channel(s)`);
  await startFbPagesFromEnv();
  scheduler.start();
  console.log(
    `[server] scheduler started — windows: ${scheduler.windows
      .map(describeWindow)
      .join(", ")}`
  );
  const next = scheduler.nextRun();
  if (next) console.log(`[server] next scheduled run: ${next.at.toISOString()}`);
}

server.listen(PORT, async () => {
  console.log(`Live Chat Aggregator listening on http://localhost:${PORT}`);
  console.log(`  Viewer:  http://localhost:${PORT}/`);
  console.log(`  Admin:   http://localhost:${PORT}/admin.html?token=${ADMIN_TOKEN}`);
  if (ADMIN_TOKEN === "change-me") {
    console.log(
      "  WARNING: using default admin token. Set ADMIN_TOKEN env var before exposing publicly."
    );
  }
  await startup();
});
