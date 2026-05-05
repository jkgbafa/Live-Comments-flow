// Tiny JSON-file persistence for channels. Survives server restarts.
// On Fly.io, this file lives on a Fly Volume so it persists across deploys.
const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");

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

module.exports = { loadChannels, saveChannels, DATA_DIR, CHANNELS_FILE };
