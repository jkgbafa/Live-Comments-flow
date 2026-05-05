// Scheduler — fires "tick" events during configured weekly windows.
//
// Default schedule: Tuesday 04:01–04:07 UTC and Friday 04:01–04:07 UTC.
// During each scheduled window, all enabled channels get polled every
// minute (regardless of their normal cadence). This guarantees we catch
// the start of a broadcast at the exact scheduled time.
//
// Outside of windows the scheduler is silent — channels still poll on
// their own normal cadence (~every 60s) as a safety net for off-schedule
// live streams. The scheduler is purely an additive aggressive-check.
//
// All times are UTC. Ghana = UTC+0, so 4:01 AM Ghana == 4:01 UTC.

const EventEmitter = require("events");

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

class Scheduler extends EventEmitter {
  constructor() {
    super();
    /** @type {Array<{day:number, startMinute:number, endMinute:number}>} */
    this.windows = [];
    this._tickTimer = null;
    this._activeWindowKey = null;
  }

  setWindows(windows) {
    this.windows = (windows || []).map((w) => ({
      day: Number(w.day),
      startMinute: Number(w.startMinute),
      endMinute: Number(w.endMinute),
    }));
  }

  start() {
    // Tick at the top of every minute (close enough). We resync to the
    // wall-clock minute so windows fire on real minute boundaries.
    const now = new Date();
    const msUntilNextMinute =
      (60 - now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds();
    setTimeout(() => {
      this._loop();
      this._tickTimer = setInterval(() => this._loop(), 60_000);
    }, Math.max(100, msUntilNextMinute));
    // Run an immediate check too, in case we boot mid-window.
    this._loop();
  }

  stop() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = null;
  }

  /**
   * @returns {{day:number, startMinute:number, endMinute:number}|null}
   *   The window we're currently inside, or null.
   */
  currentWindow() {
    const now = new Date();
    const day = now.getUTCDay();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    return (
      this.windows.find(
        (w) => w.day === day && minute >= w.startMinute && minute <= w.endMinute
      ) || null
    );
  }

  /**
   * @returns {{day:number, startMinute:number, endMinute:number, at:Date}|null}
   *   The next upcoming window start time, looking forward up to 7 days.
   */
  nextRun() {
    if (this.windows.length === 0) return null;
    const now = new Date();
    let best = null;
    for (let offsetDay = 0; offsetDay < 8; offsetDay++) {
      const probe = new Date(now);
      probe.setUTCDate(probe.getUTCDate() + offsetDay);
      const probeDay = probe.getUTCDay();
      for (const w of this.windows) {
        if (w.day !== probeDay) continue;
        const candidate = new Date(probe);
        candidate.setUTCHours(0, 0, 0, 0);
        candidate.setUTCMinutes(w.startMinute);
        if (candidate.getTime() <= now.getTime()) continue;
        if (!best || candidate < best.at) {
          best = { ...w, at: candidate };
        }
      }
    }
    return best;
  }

  _loop() {
    const w = this.currentWindow();
    if (w) {
      const key = `${w.day}-${w.startMinute}`;
      if (this._activeWindowKey !== key) {
        this._activeWindowKey = key;
        this.emit("window_start", w);
      }
      this.emit("tick", w);
    } else if (this._activeWindowKey) {
      const key = this._activeWindowKey;
      this._activeWindowKey = null;
      this.emit("window_end", { key });
    }
  }
}

/** Default schedule: Tue & Fri, 04:01–04:07 UTC. */
const DEFAULT_WINDOWS = [
  { day: 2, startMinute: 4 * 60 + 1, endMinute: 4 * 60 + 7 }, // Tuesday
  { day: 5, startMinute: 4 * 60 + 1, endMinute: 4 * 60 + 7 }, // Friday
];

function describeWindow(w) {
  const hh = String(Math.floor(w.startMinute / 60)).padStart(2, "0");
  const mm = String(w.startMinute % 60).padStart(2, "0");
  const eh = String(Math.floor(w.endMinute / 60)).padStart(2, "0");
  const em = String(w.endMinute % 60).padStart(2, "0");
  return `${DAY_NAMES[w.day]} ${hh}:${mm}–${eh}:${em} UTC`;
}

module.exports = { Scheduler, DEFAULT_WINDOWS, DAY_NAMES, describeWindow };
