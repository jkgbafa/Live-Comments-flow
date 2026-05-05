// Live Chat Aggregator — Express + WebSocket server.
// Manages multiple YouTube live-chat sources and broadcasts unified
// messages to all connected viewers in real time.
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { YouTubeSource } = require("./lib/youtube-source");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me";
const MAX_BUFFER = 200; // ring buffer of recent messages for late-joining viewers

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sources = new Map(); // key: input string -> YouTubeSource
const recent = []; // ring buffer of recent messages

function rememberMessage(msg) {
  recent.push(msg);
  if (recent.length > MAX_BUFFER) recent.shift();
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function attachSource(src) {
  src.on("message", (msg) => {
    rememberMessage(msg);
    broadcast({ type: "message", message: msg });
  });
  src.on("status", (snap) => {
    broadcast({ type: "status", source: snap });
  });
}

function listSources() {
  return Array.from(sources.values()).map((s) => s.snapshot());
}

function requireAdmin(req, res, next) {
  const token = req.header("x-admin-token") || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// --- API ---
app.get("/api/state", (_req, res) => {
  res.json({ sources: listSources(), recent });
});

app.get("/api/sources", requireAdmin, (_req, res) => {
  res.json({ sources: listSources() });
});

app.post("/api/sources", requireAdmin, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "missing url" });
  }
  if (sources.has(url)) {
    return res.status(409).json({ error: "already added", source: sources.get(url).snapshot() });
  }
  const src = new YouTubeSource(url);
  sources.set(url, src);
  attachSource(src);
  src.start();
  res.json({ source: src.snapshot() });
});

app.delete("/api/sources", requireAdmin, (req, res) => {
  const { url } = req.body || {};
  if (!url || !sources.has(url)) {
    return res.status(404).json({ error: "not found" });
  }
  const src = sources.get(url);
  src.stop();
  sources.delete(url);
  broadcast({ type: "removed", input: url });
  res.json({ ok: true });
});

app.post("/api/clear-recent", requireAdmin, (_req, res) => {
  recent.length = 0;
  broadcast({ type: "cleared" });
  res.json({ ok: true });
});

// --- HTTP + WS ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  // Send current state on connect so late joiners see context.
  ws.send(
    JSON.stringify({
      type: "init",
      sources: listSources(),
      recent,
    })
  );
});

server.listen(PORT, () => {
  console.log(`Live Chat Aggregator listening on http://localhost:${PORT}`);
  console.log(`  Viewer:  http://localhost:${PORT}/`);
  console.log(`  Admin:   http://localhost:${PORT}/admin.html?token=${ADMIN_TOKEN}`);
  if (ADMIN_TOKEN === "change-me") {
    console.log(
      "  WARNING: using default admin token. Set ADMIN_TOKEN env var before exposing publicly."
    );
  }
});
