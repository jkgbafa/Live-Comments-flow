const DEFAULT_SERVER = "https://live-comments-flow.fly.dev";

async function load() {
  const stored = await chrome.storage.sync.get(["serverUrl", "token"]);
  document.getElementById("server").value = stored.serverUrl || DEFAULT_SERVER;
  document.getElementById("token").value = stored.token || "";
}

async function save() {
  const serverUrl = document.getElementById("server").value.trim() || DEFAULT_SERVER;
  const token = document.getElementById("token").value.trim();
  await chrome.storage.sync.set({ serverUrl, token });
  const statusEl = document.getElementById("status");
  statusEl.textContent = "Saved. Testing…";
  statusEl.className = "status";
  // Allow background script to pick up the change before pinging.
  setTimeout(async () => {
    const ping = await chrome.runtime.sendMessage({ type: "ping-server" });
    if (ping?.ok) {
      statusEl.textContent = "Connected to " + serverUrl;
      statusEl.className = "status ok";
    } else {
      statusEl.textContent =
        "Could not reach server: " + (ping?.error || "unknown error");
      statusEl.className = "status bad";
    }
  }, 200);
}

document.getElementById("save").addEventListener("click", save);
load();
