// Tiny JSON-file persistence for channels. Survives server restarts.
// On Fly.io, this file lives on a Fly Volume so it persists across deploys.
const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");
const FB_STATE_FILE = path.join(DATA_DIR, "fb-state.json");

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadChannels() {
  try {
    await ensureDir();
    const raw = await fs.readFile(CHANNELS_FILE, "utf8");
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    return [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.warn("[store] failed to read channels.json:", err.message);
    return [];
  }
}

let saveQueued = false;
let saveInFlight = null;
async function saveChannels(channels) {
  // Coalesce rapid back-to-back saves.
  if (saveInFlight) {
    saveQueued = true;
    await saveInFlight;
    if (!saveQueued) return;
    saveQueued = false;
  }
  saveInFlight = (async () => {
    await ensureDir();
    const tmp = CHANNELS_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(channels, null, 2), "utf8");
    await fs.rename(tmp, CHANNELS_FILE);
  })();
  try {
    await saveInFlight;
  } finally {
    saveInFlight = null;
  }
}

// Per-page state for FB (which env-configured pages are paused or removed).
// Shape: { "page_id": { enabled: boolean, removed: boolean } }
async function loadFbState() {
  try {
    await ensureDir();
    const raw = await fs.readFile(FB_STATE_FILE, "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.warn("[store] failed to read fb-state.json:", err.message);
    return {};
  }
}

async function saveFbState(state) {
  await ensureDir();
  const tmp = FB_STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, FB_STATE_FILE);
}

module.exports = {
  loadChannels,
  saveChannels,
  loadFbState,
  saveFbState,
  DATA_DIR,
  CHANNELS_FILE,
  FB_STATE_FILE,
};
