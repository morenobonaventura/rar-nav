/**
 * Play a generated track into the app as if it were the GPS.
 *
 * Step 5 of SIMULATION.md. `tools/make_track.js` writes the tracks; this reads
 * one back and feeds it to `Gps.onFix` in the same shape the browser's
 * geolocation would, so nothing downstream knows the difference. That is the
 * point -- an instrument you have tested through a special "test mode" is an
 * instrument you have not tested.
 *
 * Time is compressed, which is the only reason `js/clock.js` exists. The app's
 * buffers are measured in wall-clock minutes; play a twenty-hour race at 30x
 * against real time and every sample is stale before it arrives. So the sim
 * owns the clock, and `clock.now()` returns the time of the fix currently being
 * fed. Nothing here calls `Date.now()`; a test enforces that.
 *
 * ## This must never be mistaken for the real thing
 *
 * The codebase already draws this line for the hand-placed position: it is
 * "labelled everywhere so it can never be mistaken for a real fix", and is
 * deliberately not persisted, because a position set by hand yesterday must not
 * still be in force at the start gun. Simulation is the same hazard and worse,
 * because it looks alive. So:
 *
 *   - it starts only from an explicit `?sim=<name>` in the URL, never a setting
 *     and never a stored preference, so a reload without the flag is a real app;
 *   - it refuses outright if a real fix has already arrived this session;
 *   - the rail carries a permanent SIMULATION badge, not a toast that fades;
 *   - this file is NOT in the service worker's precache list, so it is not
 *     merely disabled on the boat, it is absent.
 */
import { clock } from "./clock.js";

const KN_PER_MS = 1.943844;

export class Sim {
  /**
   * @param {{meta: object, samples: Array}} track from tools/make_track.js
   * @param {number} rate wall-clock speed-up. Above about 60 the app's own
   *   five-second sampling starves the buffers, and the windows stop meaning
   *   anything -- so the ceiling is a real limit, not a guardrail.
   */
  constructor(track, { rate = 30 } = {}) {
    this.track = track;
    this.rate = Math.min(60, Math.max(1, rate));
    this.i = 0;
    this.timer = null;
    this.onEnd = null;
  }

  get name() {
    return this.track.meta?.name ?? "track";
  }

  /**
   * @param {Gps} gps the live instance, fed through its real entry point
   * @throws if a real fix has already arrived -- never overwrite a boat's own
   *   position with a made-up one, whatever the URL says
   */
  start(gps, { onTick } = {}) {
    if (gps.fix) throw new Error("refusing to simulate over a real GPS fix");
    this.gps = gps;
    gps.stop();          // no satellites while the simulation is in charge
    gps.clearHistory();  // and no real samples left in the buffer to blend with

    const step = this.track.meta?.stepSec ?? 5;
    this.timer = setInterval(() => this.tick(onTick), (step * 1000) / this.rate);
    this.tick(onTick);
    return this;
  }

  tick(onTick) {
    const s = this.track.samples[this.i++];
    if (!s) return this.stop();

    // The clock moves first: everything the fix touches -- the history window,
    // the sparklines, the shift detector's baseline -- is measured against it.
    clock.now = () => s.t;

    this.gps.onFix({
      timestamp: s.t,
      coords: {
        latitude: s.lat,
        longitude: s.lon,
        accuracy: s.accuracy ?? 8,
        // null is a real thing the chip does, and the app has a fallback for
        // it; passing it through is the only way that fallback is ever tested.
        speed: s.sog == null ? null : s.sog / KN_PER_MS,
        heading: s.cog ?? null,
      },
    });
    onTick?.(this.i, this.track.samples.length);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.onEnd?.();
    return this;
  }

  get done() {
    return this.i >= this.track.samples.length;
  }
}

/**
 * Wire a simulation up, if and only if the URL asked for one.
 *
 * Returns null in every other case, including every failure: a missing track
 * file or a real fix already in hand means the app carries on as an instrument.
 * A simulator that half-starts is worse than one that does not start.
 */
export async function maybeStart(gps, { search = location.search, onTick } = {}) {
  const name = new URLSearchParams(search).get("sim");
  if (!name) return null;
  if (!/^[a-z0-9-]+$/.test(name)) return null;

  // Never in the installed app. Once the tracks are deployed alongside the
  // real thing, a stale bookmark or a shared link is a genuine hazard, and
  // "refuses over a real fix" does not cover a cold start where no fix has
  // arrived yet. The home-screen icon is what goes to sea; a browser tab is
  // what tests. That line is worth more than any in-app warning.
  const installed =
    globalThis.matchMedia?.("(display-mode: standalone)")?.matches ||
    globalThis.navigator?.standalone === true;
  if (installed) return null;

  const res = await fetch(`data/tracks/${name}.json`).catch(() => null);
  if (!res?.ok) return null;

  try {
    return new Sim(await res.json()).start(gps, { onTick });
  } catch {
    return null; // a real fix beat us to it
  }
}
