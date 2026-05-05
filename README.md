# Live Chat Aggregator

Pulls live chat from one or more **YouTube live streams** in real-time and shows them all together in a single dark, Restream-style viewer page.

**Channel-based watching** — paste a YouTube channel URL once. The system polls it forever and auto-pulls chat whenever the channel goes live. You configure once, never touch admin again.

## Highlights

- Multi-channel: watch as many YouTube channels as you want
- Auto-detect: poll each channel's `/live` endpoint every 60s; spawn chat scraper when live, tear down when stream ends
- Persistent: channel list saved to disk, survives restarts/deploys
- Real-time: WebSocket push, no polling delay on the viewer side
- Dark UI: avatar, handle, timestamp, message, source icon, owner/mod/member badges
- No YouTube API key required (uses the public live-chat continuation endpoint)
- One-click Fly.io deploy: free, always-on, stable URL

## What's included

```
live-chat-aggregator/
├── server.js                    Express + WebSocket server
├── lib/
│   ├── youtube-source.js        Live-chat scraper for one video (auto-reconnect)
│   ├── youtube-channel.js       Channel URL parser + live-stream detector
│   ├── channel-watcher.js       Polls a channel, spawns/tears down sources
│   └── store.js                 channels.json persistence
├── public/
│   ├── index.html               Public viewer page
│   ├── viewer.css               Dark theme
│   ├── viewer.js                Client-side WebSocket + rendering
│   └── admin.html               Admin page — manage channels + direct sources
├── Dockerfile                   Production container
├── fly.toml                     Fly.io deployment config
└── package.json
```

## How channel watching works

```
You paste a channel URL once → click Add & Start watching
   ↓
Server polls youtube.com/@channel/live every 60s in the background
   ↓
Channel goes live  →  spawns chat source  →  messages flow into viewer
   ↓
Stream ends        →  source cleans up    →  channel returns to "watching"
   ↓
Channel goes live again next time → auto-detected → page lights up
```

You only ever touch admin to **add a new channel** or **remove an old one**.

## Local development

```bash
cd ~/Claude/live-chat-aggregator
npm install
ADMIN_TOKEN=any-random-string npm start
```

Open:
- Viewer: http://localhost:3000/
- Admin:  http://localhost:3000/admin.html?token=any-random-string

To expose on a public URL while running locally (event hosted from your laptop):

```bash
cloudflared tunnel --url http://localhost:3000
```

## Deploying to Fly.io (recommended for "always-on, never touch a terminal again")

### One-time setup (10 minutes)

1. **Sign up at https://fly.io/app/sign-up** (free; CC required for verification, but the small VM this app uses fits inside Fly's monthly free credit).

2. **Install the Fly CLI** on your Mac:
   ```bash
   brew install flyctl
   ```

3. **Log in:**
   ```bash
   fly auth login
   ```

4. **Edit `fly.toml`** — change the `app = "live-chat-aggregator"` line to a unique name (e.g. `dhmm-live-chat`, `flow-live-chat`). Names are global on Fly.

5. **Launch the app** from this directory:
   ```bash
   cd ~/Claude/live-chat-aggregator
   fly launch --copy-config --no-deploy
   ```
   When prompted: choose your closest region, say "no" to Postgres/Redis/Tigris.

6. **Create the persistent volume** for `channels.json`:
   ```bash
   fly volumes create lca_data --size 1 --region iad
   ```
   (Use the same region you picked above. `iad` = US East. Other options: `lhr` London, `fra` Frankfurt, `sjc` San Jose, `gru` São Paulo.)

7. **Set your admin token as a secret:**
   ```bash
   fly secrets set ADMIN_TOKEN=$(openssl rand -hex 16)
   fly secrets list   # save the token shown — you'll use it in the admin URL
   ```

8. **Deploy:**
   ```bash
   fly deploy
   ```

   When it finishes, Fly prints your public URL — something like `https://dhmm-live-chat.fly.dev`. **Bookmark it.**

### Each event after that

You do nothing.

- Public viewer URL: `https://your-app.fly.dev/`
- Admin URL (only you): `https://your-app.fly.dev/admin.html?token=YOUR_ADMIN_TOKEN`

When you go live on YouTube, the watcher detects it within ~60s and chat starts flowing on the public viewer URL.

### Updating the app later

```bash
cd ~/Claude/live-chat-aggregator
git pull   # if you've pulled changes from GitHub
fly deploy
```

`channels.json` survives deploys (it's on the volume).

## Pages

| Page | URL | Who sees it |
|------|-----|-------------|
| Viewer | `/` | Anyone with the URL — show this in OBS browser source, or share with team |
| Admin | `/admin.html?token=YOUR_TOKEN` | You only |

## Admin page sections

**Add a YouTube channel** — primary feature. Paste channel URL or `@handle`, click Add. Channel starts in "watching" mode immediately.

**Watching** — list of all channels with their current status:
- `live` — channel is live right now, chat is flowing
- `watching` — channel is being polled, not currently live
- `error` — last poll failed (network blip, etc.) — auto-retries
- `stopped` — paused via the Pause button

**Direct video URL (advanced, collapsed)** — for one-off events when you want to monitor a specific live URL without permanently watching the channel. Doesn't persist across server restarts.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_TOKEN` | `change-me` | **Required.** Token for admin endpoints. Set this. |
| `DATA_DIR` | `./data` (local) / `/data` (Docker) | Where `channels.json` lives |

## OBS browser source

Add a Browser Source pointing at your public viewer URL. Suggested width 480, height 720.

## Troubleshooting

**"Admin says unauthorized"** — your URL is missing `?token=...` or the token doesn't match `ADMIN_TOKEN`.

**Channel stuck on "error" status** — usually a transient network/redirect quirk on YouTube's end; the watcher auto-retries every 60s. Click "Check now" to force an immediate retry.

**Chat shows live but viewer is empty** — masterchat occasionally takes a few seconds to receive the first message after connecting; wait 10-20s.

**Fly.io deploy says "billing not set up"** — you need to add a payment method (CC) at https://fly.io/dashboard/personal/billing — Fly verifies identity but won't charge if usage stays under the monthly free credit (~$5).

## Roadmap

- Facebook Live (requires Graph API; deferred until Page admin token + app review)
- TikTok Live (via tiktok-live-connector)
- Per-channel custom name override (already in API, UI button later)
- Optional transparent background mode for OBS overlays
