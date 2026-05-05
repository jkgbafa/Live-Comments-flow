# Live Chat Aggregator

Pulls live chat from one or more **YouTube live streams** in real-time and shows them all together in a single dark, Restream-style viewer page.

- Multi-stream: paste 1 or 10 YouTube live URLs, all chats merge into one feed
- Real-time: WebSocket push, no polling delay
- Dark UI: avatar, handle, timestamp, message, source icon, owner/mod/member badges
- No YouTube API key required (uses the public live-chat continuation endpoint)
- Run on your laptop, share via Cloudflare Tunnel — same URL every time, free
- Add/remove streams at runtime through the admin page (no restart, no code edits)

## What's included

```
live-chat-aggregator/
├── server.js              Express + WebSocket server
├── lib/youtube-source.js  YouTube live-chat scraper (auto-reconnect)
├── public/
│   ├── index.html         Viewer page (the public one you share)
│   ├── viewer.css         Dark theme
│   ├── viewer.js          Client-side WebSocket + rendering
│   └── admin.html         Admin page — paste/remove URLs while running
└── package.json
```

## First-time setup

```bash
cd ~/Claude/live-chat-aggregator
npm install
```

You also need `cloudflared` installed (already installed on this Mac at `~/.local/bin/cloudflared`).

## Running it for an event

You'll need two terminal windows.

### Terminal 1 — start the app

```bash
cd ~/Claude/live-chat-aggregator
ADMIN_TOKEN=pick-something-secret npm start
```

Replace `pick-something-secret` with any random string. This is the password for the admin page; viewers don't need it.

You'll see:
```
Live Chat Aggregator listening on http://localhost:3000
  Viewer:  http://localhost:3000/
  Admin:   http://localhost:3000/admin.html?token=pick-something-secret
```

### Terminal 2 — start the public tunnel

**Quick mode (random URL each time, zero setup):**

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a URL like `https://random-words-1234.trycloudflare.com`. That's the public viewer link — share it with anyone.

**Permanent URL (recommended for "Tuesday + Friday + every event after"):**

Set up a named tunnel once, then it has the same URL forever. From a Cloudflare account you log into yourself:

```bash
# One-time setup — you do this once, ever:
cloudflared tunnel login                       # opens browser, you log into Cloudflare
cloudflared tunnel create live-chat            # creates a named tunnel
cloudflared tunnel route dns live-chat chat.yourdomain.com   # if you have a domain on CF
# OR skip the dns step and use the auto-assigned *.cfargotunnel.com URL it printed

# Each event — one command:
cloudflared tunnel run --url http://localhost:3000 live-chat
```

After the one-time setup, `npm run tunnel` (configured to the quick mode in this repo) or your named-tunnel command will give you the same URL every time.

### Step 3 — add YouTube URLs

Open the admin link from terminal 1 in your browser. Paste a YouTube live URL, click **Add**. Repeat for as many streams as you want. The viewer page will start showing chat in real time.

To swap streams between events: open admin, click **Remove** on the old ones, paste new ones. No restart needed.

## Pages

| Page | URL | Who sees it |
|------|-----|-------------|
| Viewer | `/` | Anyone with the public Cloudflare URL — show this on stream, in OBS browser source, etc. |
| Admin | `/admin.html?token=YOUR_TOKEN` | You only. The token is required. |

## OBS browser source

Add a Browser Source pointing at your public Cloudflare URL with width 480, height 720 (or whatever fits your overlay). It's transparent-friendly if you customize the CSS background to `transparent` for that use.

## Environment variables

- `PORT` — default `3000`
- `ADMIN_TOKEN` — required for the admin page. **Set this to something random.** If you leave it as the default `change-me`, the server prints a warning.

Example:

```bash
PORT=3000 ADMIN_TOKEN=$(openssl rand -hex 16) npm start
```

## How the YouTube scraping works

Uses [`masterchat`](https://www.npmjs.com/package/masterchat) which calls YouTube's internal live-chat continuation endpoint — the same one the official live-chat iframe uses. No API key, no quota, but:

- It's an unofficial endpoint. YouTube can change it. If chat stops working, `npm update masterchat` usually fixes it.
- If a stream goes offline mid-event, the source auto-reconnects with exponential backoff (capped at 30s) so reconnecting after a brief glitch is automatic.

## Roadmap (not built yet)

- Facebook Live comments — requires the Graph API (Page admin token + app review). Not feasible without official API.
- TikTok Live — possible via `tiktok-live-connector`, deferred for v2.
- Custom CSS / per-event branding.
- Server-side message persistence across restarts.

## Troubleshooting

**Admin page says "unauthorized"** — your URL is missing `?token=...` or the token doesn't match `ADMIN_TOKEN` in terminal 1.

**Source stuck on "connecting" or "reconnecting"** — the YouTube URL might not be a live stream, or the stream just ended. Check the URL opens to a live broadcast in your own browser.

**Cloudflare URL works locally but not for others** — make sure terminal 1 (the app) is still running. If the app process died, the tunnel will return a 502.
