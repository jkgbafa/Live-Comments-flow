// feeder.js — the "reader" you run ON THE BROADCAST COMPUTER (HP or Mac).
//
// Why this exists: the Fly server gets blocked by YouTube (HTTP 429) because
// it's a data-center IP. A normal computer on a normal internet connection
// does NOT get blocked. So this little program runs on the broadcast machine,
// reads the live chat of your channels from there, and forwards every comment
// up to your Fly hub. You keep watching comments on the same Fly link as
// always — this just supplies them from an address YouTube doesn't throttle.
//
// It auto-detects when each channel goes live. You do NOT open any links or
// tabs. Start it before the service, leave the window open, close it after.
//
// Run it through start-feeder.command (Mac) or start-feeder.bat (Windows),
// which set FEED_TOKEN for you. Never commit the token.

const fs = require("fs");
const path = require("path");
const { ChannelWatcher } = require("./lib/channel-watcher");

const HUB_URL = (process.env.FEED_URL || "https://live-comments-flow.fly.dev").replace(/\/+$/, "");
const TOKEN = (process.env.FEED_TOKEN || "").trim();

if (!TOKEN) {
  console.error("\n  Missing password. Please start this with the launcher\n  (start-feeder.command on Mac, start-feeder.bat on Windows).\n");
  process.exit(1);
}

// IMPORTANT: never use the (non-working) API key path in the feeder — force
// the masterchat reader, which works fine from a residential connection.
delete process.env.YT_API_KEY;

// Friendly channel names so the on-screen pill is correct immediately,
// keyed by a unique fragment of each channel's handle/URL (case-insensitive).
const NAME_BY_HANDLE = {
  firstlovecenter: "First Love Center",
  daghewardmillsvideos: "Dag Heward-Mills",
  therespowerhere: "The FLOW Church",
  lovefirstchurchofficial: "Love First Church",
};

function nameFor(input) {
  const low = String(input).toLowerCase();
  for (const [frag, name] of Object.entries(NAME_BY_HANDLE)) {
    if (low.includes(frag)) return name;
  }
  return null;
}

// Which channels to read. Default: the four configured in data/channels.json,
// falling back to the known handles. Override for testing with FEED_CHANNELS
// (comma-separated URLs/handles).
function loadChannelInputs() {
  if (process.env.FEED_CHANNELS) {
    return process.env.FEED_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  try {
    const defs = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "channels.json"), "utf8"));
    const inputs = (Array.isArray(defs) ? defs : []).map((d) => d.input || d.canonical || d.url).filter(Boolean);
    if (inputs.length) return inputs;
  } catch (_) {}
  return [
    "https://www.youtube.com/@firstlovecenter",
    "https://www.youtube.com/@DagHewardMillsvideos",
    "https://www.youtube.com/@TheresPowerHere",
    "https://www.youtube.com/@LoveFirstChurchOfficial",
  ];
}

// Batch outbound comments to the hub once a second.
let queue = [];
let sending = false;
async function flush() {
  if (sending || queue.length === 0) return;
  sending = true;
  const batch = queue.splice(0, 100);
  try {
    const r = await fetch(`${HUB_URL}/api/extension/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": TOKEN },
      body: JSON.stringify({ comments: batch }),
    });
    if (!r.ok) {
      console.warn(`  [hub responded ${r.status} — will retry]`);
      queue.unshift(...batch);
    }
  } catch (e) {
    console.warn(`  [hub unreachable: ${e.message} — will retry]`);
    queue.unshift(...batch);
  } finally {
    sending = false;
  }
}
setInterval(flush, 1000);

async function main() {
  // Verify we can reach the hub and the password is right, before starting.
  try {
    const r = await fetch(`${HUB_URL}/api/extension/ping`, { headers: { "x-admin-token": TOKEN } });
    if (r.status !== 200) {
      console.error(`\n  Could not log in to the hub (HTTP ${r.status}). Check the password.\n`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`\n  Could not reach the hub at ${HUB_URL}\n  (${e.message})\n`);
    process.exit(1);
  }
  console.log(`\n  Connected to hub: ${HUB_URL}  ✓`);

  const inputs = loadChannelInputs();
  for (const input of inputs) {
    const w = new ChannelWatcher({ input, name: nameFor(input) });
    w.on("message", (msg) => {
      queue.push({
        id: msg.id,
        platform: "youtube",
        videoId: msg.videoId,
        streamTitle: msg.streamTitle,
        channelName: msg.channelName,
        author: msg.author,
        avatar: msg.avatar,
        text: msg.text,
        timestamp: msg.timestamp,
      });
    });
    w.on("status", (s) => {
      if (s.status === "live" && s.currentVideoId) {
        console.log(`  ● LIVE  ${s.label}  (${s.currentVideoId})`);
      }
    });
    w.start();
    console.log(`  watching: ${nameFor(input) || input}`);
  }

  console.log("\n  Running. Leave this window open during the broadcast.");
  console.log("  Comments appear on your normal Fly link. Close this window when the service ends.\n");
}

main();
