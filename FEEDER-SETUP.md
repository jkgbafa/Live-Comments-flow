# FLOW Live Comments — Reader setup (the broadcast computer)

This is the little program that **reads** the live comments off YouTube and
sends them to your Fly hub. You run it on the **broadcast computer** (the HP, or
a Mac) because a normal computer doesn't get blocked by YouTube the way the Fly
server does. You keep **watching** the comments on your usual Fly link — this
just feeds it.

It watches all four channels by itself. **You never open YouTube tabs or paste
links.** It auto-detects when each channel goes live.

---

## One-time setup (do this once on the HP)

1. **Install Node.js** (only if it's not already installed):
   - Go to <https://nodejs.org>
   - Download the **LTS** version and install it (Next → Next → Finish).

2. **Put this folder on the computer.** Copy the whole `live-chat-aggregator`
   folder onto the HP (USB stick, or download the repo). Keep it together —
   don't pull out single files.

That's it for setup.

---

## Every broadcast (the only thing you do)

1. **Before the service**, open the folder and **double-click:**
   - On Windows (HP): **`start-feeder.bat`**
   - On Mac: **`start-feeder.command`**

2. The first time ever, it will:
   - install its components automatically (takes about a minute), and
   - ask you for the **admin password** — type the same one you use for the
     admin page and press Enter. It remembers it after that.

3. A black window opens and says **"Running."** That means it's working.
   - **Leave that window open** for the whole service.
   - Watch the comments on your **normal Fly link**, like always.

4. **After the service**, close the window. Done.

> You do **not** have to keep the computer on between services. As long as the
> window is open while you're live, comments flow. When it's closed, nothing is
> lost — there's no broadcast then anyway.

---

## Mac note (first run only)

macOS may say the file is "from an unidentified developer." If so:
**right-click** `start-feeder.command` → **Open** → **Open**. You only do this
once.

---

## How do I know it's actually working?

- The window shows `● LIVE  <channel name>` for each channel that's live.
- Comments appear on your Fly link with the channel name on each one.
- If it can't reach the hub or the password is wrong, it tells you in the window
  in plain English and stops — it won't fail silently.
