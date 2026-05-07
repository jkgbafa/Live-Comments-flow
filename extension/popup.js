// Popup UI: shows current config + connection health.
async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  document.getElementById("server").textContent = status?.serverUrl || "(none)";
  document.getElementById("token").textContent = status?.configured
    ? "set ✓"
    : "missing";
  document.getElementById("token").className =
    "val " + (status?.configured ? "ok" : "bad");
  document.getElementById("pending").textContent = status?.pending || 0;

  const ping = await chrome.runtime.sendMessage({ type: "ping-server" });
  const connEl = document.getElementById("conn");
  if (ping?.ok) {
    connEl.textContent = "connected ✓";
    connEl.className = "val ok";
  } else {
    connEl.textContent = ping?.error || "not connected";
    connEl.className = "val bad";
  }
}

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("open-viewer").addEventListener("click", async (e) => {
  e.preventDefault();
  const status = await chrome.runtime.sendMessage({ type: "status" });
  const url = (status?.serverUrl || "").replace(/\/$/, "") + "/";
  if (url) chrome.tabs.create({ url });
});

refresh();
