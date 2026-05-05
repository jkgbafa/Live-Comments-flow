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
app.use(express.static(path.join(__dirname, "public")));

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
  const token = req.header("x-admin-token") || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

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
