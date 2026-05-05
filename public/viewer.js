// Viewer page logic: connects to /ws, renders incoming chat messages.
// Auto-scroll is always on. The viewer is intentionally minimal: just the
// logo, "Live Chat" title, and the message stream — no status indicators
// (those live in admin where they're useful for the operator).
const chatEl = document.getElementById("chat");

const seen = new Set();

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
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
  // Deliberately NOT exposing isOwner / isModerator / membership in the UI —
  // we don't want to out moderators to the public chat audience.

  // Facebook strips commenter `from` info from public live videos (privacy
  // policy), so FB messages have no avatar. Use a styled Facebook badge
  // as a placeholder so the row doesn't look broken.
  let avatarHtml;
  if (msg.avatar) {
    avatarHtml = `<img class="avatar" src="${msg.avatar}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`;
  } else if ((msg.platform || msg.source) === "facebook") {
    avatarHtml = `<div class="avatar avatar-fb" aria-label="Facebook viewer">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="white"><path d="M22.7 0H1.3A1.3 1.3 0 0 0 0 1.3v21.4A1.3 1.3 0 0 0 1.3 24h11.5v-9.3H9.7v-3.6h3.1V8.4c0-3.1 1.9-4.8 4.7-4.8 1.3 0 2.5.1 2.8.1v3.3h-1.9c-1.5 0-1.8.7-1.8 1.8v2.3h3.6l-.5 3.6h-3.1V24h6.1a1.3 1.3 0 0 0 1.3-1.3V1.3A1.3 1.3 0 0 0 22.7 0z"/></svg>
    </div>`;
  } else {
    avatarHtml = `<div class="avatar"></div>`;
  }

  // Prefer the explicit `platform` (set by ChannelWatcher) over the older
  // `source` field that older direct sources still use. Both resolve to the
  // same icon mapping.
  const platform = msg.platform || msg.source || "";
  const sourceIcon = SOURCE_ICONS[platform] || "";

  // Channel/page subtext shown next to the platform icon, e.g.
  // "Dag Heward-Mills" or "Flow Church". For direct sources without a
  // channel, this is empty.
  const channelLabel = msg.channelName || "";

  el.innerHTML = `
    ${avatarHtml}
    <div class="body">
      <div class="head">
        <span class="source-icon" title="${platform}">${sourceIcon}</span>
        <span class="author"></span>
        ${
          channelLabel
            ? `<span class="channel-tag"></span>`
            : ""
        }
        <span class="time">${fmtTime(msg.timestamp)}</span>
      </div>
      <div class="text"></div>
    </div>
  `;
  el.querySelector(".author").textContent = msg.author;
  el.querySelector(".text").textContent = msg.text;
  if (channelLabel) {
    el.querySelector(".channel-tag").textContent = channelLabel;
  }

  chatEl.appendChild(el);

  // Cap rendered nodes for memory.
  while (chatEl.children.length > 500) chatEl.firstChild.remove();

  scrollToBottom();
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
        break;
      case "message":
        renderMessage(data.message);
        break;
      case "cleared":
        chatEl.innerHTML = `<div class="empty">Cleared.</div>`;
        seen.clear();
        break;
    }
  };

  ws.onclose = () => {
    // Silently reconnect — no status indicator on the viewer.
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

connect();
