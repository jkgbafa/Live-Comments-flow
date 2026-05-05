// Viewer page logic: connects to /ws, renders incoming chat messages.
// Auto-scroll is always on. Removed the toggle button + counter at the
// user's request — keep the UI clean and just always pin to newest.
const chatEl = document.getElementById("chat");
const statusEl = document.getElementById("status");

const seen = new Set();

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.remove("live", "offline");
  if (kind) statusEl.classList.add(kind);
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

const SOURCE_ICONS = {
  youtube: `<svg viewBox="0 0 24 24" fill="#ff0033"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.6 3.6 12 3.6 12 3.6s-7.6 0-9.4.5A3 3 0 0 0 .5 6.2 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.8.5 9.4.5 9.4.5s7.6 0 9.4-.5a3 3 0 0 0 2.1-2.1A31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" fill="#1877f2"><path d="M22.7 0H1.3A1.3 1.3 0 0 0 0 1.3v21.4A1.3 1.3 0 0 0 1.3 24h11.5v-9.3H9.7v-3.6h3.1V8.4c0-3.1 1.9-4.8 4.7-4.8 1.3 0 2.5.1 2.8.1v3.3h-1.9c-1.5 0-1.8.7-1.8 1.8v2.3h3.6l-.5 3.6h-3.1V24h6.1a1.3 1.3 0 0 0 1.3-1.3V1.3A1.3 1.3 0 0 0 22.7 0z"/></svg>`,
  tiktok: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.6 6.7a5.5 5.5 0 0 1-3.4-1.2 5.5 5.5 0 0 1-2-3.6V1.6h-3.5v13.6a3.1 3.1 0 1 1-2.2-3v-3.5a6.6 6.6 0 1 0 5.7 6.5V8.7a8.9 8.9 0 0 0 5.4 1.8V7a5.5 5.5 0 0 1 0-.3z"/></svg>`,
};

function renderMessage(msg) {
  if (seen.has(msg.id)) return;
  seen.add(msg.id);
  // Cap memory of seen ids
  if (seen.size > 5000) {
    const it = seen.values();
    for (let i = 0; i < 1000; i++) seen.delete(it.next().value);
  }

  // Remove "empty" placeholder if present
  const empty = chatEl.querySelector(".empty");
  if (empty) empty.remove();

  const el = document.createElement("div");
  el.className = "msg";
  if (msg.isOwner) el.classList.add("owner");
  else if (msg.isModerator) el.classList.add("moderator");
  else if (msg.membership) el.classList.add("member");

  const avatarHtml = msg.avatar
    ? `<img class="avatar" src="${msg.avatar}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
    : `<div class="avatar"></div>`;

  const sourceIcon = SOURCE_ICONS[msg.source] || "";

  let roleBadge = "";
  if (msg.isOwner) roleBadge = `<span class="badge role">Owner</span>`;
  else if (msg.isModerator) roleBadge = `<span class="badge role">Mod</span>`;
  else if (msg.membership) roleBadge = `<span class="badge role">Member</span>`;

  el.innerHTML = `
    ${avatarHtml}
    <div class="body">
      <div class="head">
        <span class="source-icon">${sourceIcon}</span>
        <span class="author"></span>
        ${roleBadge}
        <span class="time">${fmtTime(msg.timestamp)}</span>
      </div>
      <div class="text"></div>
    </div>
  `;
  el.querySelector(".author").textContent = msg.author;
  el.querySelector(".text").textContent = msg.text;

  chatEl.appendChild(el);

  // Cap rendered nodes for memory.
  while (chatEl.children.length > 500) chatEl.firstChild.remove();

  scrollToBottom();
}

// Status is computed from both channels (auto-watched) and direct sources
// (one-off video URLs). The viewer doesn't care which produced a message;
// it just shows "X live" if anything is currently producing chat, or a
// neutral "watching" / "idle" otherwise.
function updateStatusFromState({ channels = [], sources = [] } = {}) {
  const totalConfigured = channels.length + sources.length;
  if (totalConfigured === 0) {
    setStatus("no platforms yet — add one in admin", "offline");
    return;
  }
  const liveChannels = channels.filter((c) => c.status === "live").length;
  const liveSources = sources.filter((s) => s.status === "live").length;
  const liveCount = liveChannels + liveSources;
  if (liveCount > 0) {
    setStatus(`${liveCount} platform${liveCount > 1 ? "s" : ""} live`, "live");
    return;
  }
  // Nothing live right now — but channels may be polling/watching, and
  // sources may be reconnecting. Show that we're awake and waiting.
  const watching = channels.filter((c) => c.status === "watching").length;
  if (watching > 0) {
    setStatus(`watching ${watching} platform${watching > 1 ? "s" : ""}`, "offline");
  } else {
    setStatus("idle", "offline");
  }
}

let ws;
let reconnectDelay = 1000;
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 1000;
  };

  ws.onmessage = (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch {
      return;
    }
    switch (data.type) {
      case "init":
        chatEl.innerHTML = "";
        seen.clear();
        if (!data.recent || data.recent.length === 0) {
          chatEl.innerHTML = `<div class="empty">Waiting for chat messages…</div>`;
        } else {
          for (const m of data.recent) renderMessage(m);
        }
        updateStatusFromState({ channels: data.channels, sources: data.sources });
        break;
      case "message":
        renderMessage(data.message);
        break;
      case "channel_status":
      case "channel_removed":
      case "source_status":
      case "source_removed":
      case "status":
        // Status changed somewhere — refetch authoritative state to update
        // the indicator. Cheap call, returns instantly.
        fetch("/api/state")
          .then((r) => r.json())
          .then((s) => updateStatusFromState(s))
          .catch(() => {});
        break;
      case "cleared":
        chatEl.innerHTML = `<div class="empty">Cleared.</div>`;
        seen.clear();
        break;
    }
  };

  ws.onclose = () => {
    setStatus("disconnected — reconnecting…", "offline");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

connect();
