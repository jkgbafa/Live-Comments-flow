// Background service worker. Centralizes:
//   - storage of admin token + server URL
//   - sending comments from content scripts to the server
//   - retry / backoff on transient failures
//   - dedup so the same comment isn't shipped twice
//
// Content scripts call: chrome.runtime.sendMessage({type:'comment', payload:{...}})
// We respond { ok: true } once the server has accepted (or buffered the retry).

const DEFAULT_SERVER = "https://live-comments-flow.fly.dev";

let cfg = { serverUrl: DEFAULT_SERVER, token: "" };
let pending = []; // { msg, attempts }
let flushTimer = null;
const recentlySentIds = new Set(); // simple in-memory dedup
const RECENT_CAP = 4000;

async function loadConfig() {
  const stored = await chrome.storage.sync.get(["serverUrl", "token"]);
  cfg.serverUrl = stored.serverUrl || DEFAULT_SERVER;
  cfg.token = stored.token || "";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.serverUrl) cfg.serverUrl = changes.serverUrl.newValue || DEFAULT_SERVER;
  if (changes.token) cfg.token = changes.token.newValue || "";
});

loadConfig();

function rememberId(id) {
  recentlySentIds.add(id);
  if (recentlySentIds.size > RECENT_CAP) {
    const it = recentlySentIds.values();
    for (let i = 0; i < 1000; i++) recentlySentIds.delete(it.next().value);
  }
}

async function flushPending() {
  if (!cfg.token || pending.length === 0) {
    flushTimer = null;
    return;
  }
  // Take up to 50 at a time, batched.
  const batch = pending.splice(0, 50);
  const url = cfg.serverUrl.replace(/\/$/, "") + "/api/extension/comments";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": cfg.token,
      },
      body: JSON.stringify(batch.map((p) => p.msg)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
  } catch (err) {
    // Re-queue for retry, with backoff via incremented attempts.
    for (const p of batch) {
      p.attempts = (p.attempts || 0) + 1;
      if (p.attempts < 6) pending.unshift(p);
    }
  }
  if (pending.length > 0) {
    flushTimer = setTimeout(flushPending, 1500);
  } else {
    flushTimer = null;
  }
}

function enqueue(msg) {
  if (!msg || !msg.text) return;
  if (msg.id && recentlySentIds.has(msg.id)) return;
  if (msg.id) rememberId(msg.id);
  pending.push({ msg, attempts: 0 });
  if (!flushTimer) flushTimer = setTimeout(flushPending, 250);
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req && req.type === "comment") {
    enqueue(req.payload);
    sendResponse({ ok: true, queued: pending.length });
    return false;
  }
  if (req && req.type === "comments-batch") {
    if (Array.isArray(req.payload)) {
      for (const m of req.payload) enqueue(m);
    }
    sendResponse({ ok: true, queued: pending.length });
    return false;
  }
  if (req && req.type === "ping-server") {
    pingServer().then(sendResponse);
    return true; // async
  }
  if (req && req.type === "status") {
    sendResponse({
      configured: !!cfg.token,
      serverUrl: cfg.serverUrl,
      pending: pending.length,
    });
    return false;
  }
});

async function pingServer() {
  if (!cfg.token) return { ok: false, error: "no token configured" };
  try {
    const res = await fetch(
      cfg.serverUrl.replace(/\/$/, "") + "/api/extension/ping",
      { headers: { "X-Admin-Token": cfg.token } }
    );
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: j };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Wake the service worker periodically so it doesn't get killed mid-flush.
chrome.alarms?.create?.("keepAlive", { periodInMinutes: 1 });
chrome.alarms?.onAlarm?.addListener(() => {
  if (pending.length > 0 && !flushTimer) flushTimer = setTimeout(flushPending, 100);
});
