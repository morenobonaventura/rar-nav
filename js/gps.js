/**
 * GPS: position, speed and course over ground, plus a five-minute history.
 *
 * Two things about iOS shape this file.
 *
 * First, `coords.speed` and `coords.heading` come from the GPS chip's own
 * doppler solution and are null when the phone is not moving — and sometimes
 * while it is. So SOG and COG are also derived from successive fixes, and
 * whichever source is actually live gets used.
 *
 * Second, iOS suspends a web app the moment it is backgrounded or the screen
 * locks, so the history buffer can contain real gaps. Samples are therefore
 * timestamped and persisted on every tick, and the charts are told the buffer's
 * true span and staleness rather than being left to draw a smooth line across a
 * hole that was never sampled.
 */

import { haversineNm, initialBearing, KN_PER_MS } from "./nav.js";

export const SAMPLE_MS = 5000;
export const WINDOW_MS = 5 * 60 * 1000;
const MAX_SAMPLES = WINDOW_MS / SAMPLE_MS;
const STORE_KEY = "rarnav.track.v1";

/** Below this the doppler heading is noise, so hold the last good one. */
const COG_MIN_KN = 0.5;
/** Fixes closer together than this are too noisy to difference for speed. */
const DERIVE_MIN_MS = 1500;

export class Gps extends EventTarget {
  constructor() {
    super();
    this.fix = null;
    this.samples = load();
    this.watchId = null;
    this.lastRaw = null;
    this.lastSampleAt = 0;
    this.lastGoodCog = null;
    this.error = null;
  }

  start() {
    if (!("geolocation" in navigator)) {
      this.error = "This browser has no geolocation.";
      this.emit();
      return;
    }
    if (this.watchId != null) return;
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onFix(p),
      (e) => {
        this.error =
          e.code === e.PERMISSION_DENIED
            ? "Location is blocked. Allow it in Settings to see the boat."
            : e.code === e.POSITION_UNAVAILABLE
            ? "No GPS fix yet."
            : "Waiting for a GPS fix.";
        this.emit();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  onFix(pos) {
    const now = pos.timestamp || Date.now();
    const c = pos.coords;
    const here = { lat: c.latitude, lon: c.longitude };

    // Prefer the chip's own solution; fall back to differencing fixes.
    let sog = c.speed != null && c.speed >= 0 ? c.speed * KN_PER_MS : null;
    let cog = c.heading != null && !Number.isNaN(c.heading) ? c.heading : null;
    let derived = false;

    if ((sog == null || cog == null) && this.lastRaw) {
      const dt = now - this.lastRaw.t;
      if (dt >= DERIVE_MIN_MS) {
        const nm = haversineNm(this.lastRaw, here);
        const dSog = nm / (dt / 3600e3);
        if (sog == null) {
          sog = dSog;
          derived = true;
        }
        if (cog == null && dSog > COG_MIN_KN) {
          cog = initialBearing(this.lastRaw, here);
          derived = true;
        }
      }
    }

    // A heading is meaningless when stopped; keep showing the last real one.
    if (sog != null && sog < COG_MIN_KN) cog = this.lastGoodCog;
    else if (cog != null) this.lastGoodCog = cog;

    if (!this.lastRaw || now - this.lastRaw.t >= DERIVE_MIN_MS)
      this.lastRaw = { ...here, t: now };

    this.error = null;
    this.fix = {
      ...here,
      accuracy: c.accuracy,
      sog,
      cog,
      derived,
      t: now,
    };

    if (now - this.lastSampleAt >= SAMPLE_MS) {
      this.lastSampleAt = now;
      this.samples.push({ t: now, sog: sog ?? 0, cog });
      while (this.samples.length > MAX_SAMPLES) this.samples.shift();
      save(this.samples);
    }
    this.emit();
  }

  emit() {
    this.dispatchEvent(new Event("change"));
  }

  /**
   * The samples still inside the window, plus what the app needs to be honest
   * about them: how much wall-clock they actually span, how old the newest one
   * is, and whether the app was suspended mid-window.
   */
  history(now = Date.now()) {
    const kept = this.samples.filter((s) => now - s.t <= WINDOW_MS);
    if (!kept.length) return { samples: [], spanMs: 0, staleMs: null, gapMs: 0, expected: MAX_SAMPLES };
    let gapMs = 0;
    for (let i = 1; i < kept.length; i++) {
      const d = kept[i].t - kept[i - 1].t;
      if (d > SAMPLE_MS * 2.5) gapMs += d;
    }
    return {
      samples: kept,
      spanMs: kept[kept.length - 1].t - kept[0].t,
      staleMs: now - kept[kept.length - 1].t,
      gapMs,
      expected: MAX_SAMPLES,
    };
  }

  clearHistory() {
    this.samples = [];
    save(this.samples);
    this.emit();
  }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    const cutoff = Date.now() - WINDOW_MS;
    return Array.isArray(raw) ? raw.filter((s) => s && s.t > cutoff) : [];
  } catch {
    return [];
  }
}

function save(samples) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(samples));
  } catch {
    /* private browsing, or storage full: the buffer just won't survive a reload */
  }
}

/** Screen wake lock, offered as a toggle so it never fights the auto-lock. */
export class Wake {
  constructor() {
    this.sentinel = null;
    this.wanted = false;
    document.addEventListener("visibilitychange", () => {
      if (this.wanted && document.visibilityState === "visible") this.request();
    });
  }

  get supported() {
    return "wakeLock" in navigator;
  }

  async set(on) {
    this.wanted = on;
    if (on) await this.request();
    else {
      await this.sentinel?.release().catch(() => {});
      this.sentinel = null;
    }
    return this.active;
  }

  async request() {
    if (!this.supported) return false;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.sentinel.addEventListener("release", () => (this.sentinel = null));
      return true;
    } catch {
      return false;
    }
  }

  get active() {
    return this.sentinel != null;
  }
}
