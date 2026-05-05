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
const { loadChannels, saveChannels } = require("./lib/store");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me";
const MAX_BUFFER = 200;

const app = express();
app.use(express.json());

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
const channels = new Map(); // id -> ChannelWatcher
const directSources = new Map(); // input -> YouTubeSource (legacy direct video URLs)
const recent = []; // ring buffer of recent messages

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
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/",
  });
  res.json({ ok: true });
});

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
  const { url, name, autostart } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "missing url" });
  }
  let ch;
  try {
    ch = new ChannelWatcher({ input: url, name: name || null, enabled: false });
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

// --- Public state (read-only, used by viewer) ---
app.get("/api/state", (_req, res) => {
  res.json({
    channels: listChannels(),
    sources: listDirectSources(),
    recent,
  });
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
      recent,
    })
  );
});

// --- Startup: load persisted channels ---
async function startup() {
  const saved = await loadChannels();
  for (const entry of saved) {
    try {
      const ch = new ChannelWatcher({
        id: entry.id,
        input: entry.input,
        name: entry.name,
        enabled: !!entry.enabled,
        pollIntervalMs: entry.pollIntervalMs,
      });
      channels.set(ch.id, ch);
      attachChannel(ch);
      if (entry.enabled) ch.start();
    } catch (err) {
      console.warn(
        `[server] failed to load channel ${entry.input}: ${err.message}`
      );
    }
  }
  console.log(`[server] loaded ${channels.size} persisted channel(s)`);
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
