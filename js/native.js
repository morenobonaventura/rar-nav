/**
 * The seam between the web app and the iOS app it is wrapped in.
 *
 * In a browser this file does nothing: `plugin()` finds no Capacitor, the
 * bridge is never built, and the app runs on `navigator.geolocation` exactly as
 * it always has. Inside the native app it is the whole reason for going native:
 * CoreLocation keeps reporting with the screen off, and the fixes it reports
 * while the WebView was asleep are collected on the way back up.
 *
 * Everything here takes its plugin as an argument rather than reaching for the
 * global, so the awkward parts -- a drain that spans several calls, fixes that
 * arrive out of order, a phone that refused permission -- can be tested in node
 * against a plugin that is a plain object.
 */

import { KN_PER_MS } from "./nav.js";

export const SEQ_KEY = "rarnav.native.seq.v1";

/** The native plugin, or null in a browser. */
export function plugin(scope = globalThis) {
  const cap = scope.Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap.registerPlugin?.("BackgroundTrack") ?? cap.Plugins?.BackgroundTrack ?? null;
}

/** True when this is the iOS app rather than a page in Safari. */
export const isNative = (scope = globalThis) => plugin(scope) != null;

/**
 * A native fix in the shape the log stores.
 *
 * Speed comes off the chip in metres a second and the log keeps knots. Nothing
 * is derived from successive fixes here: the live path does that in gps.js with
 * the previous fix in hand, and a fix drained an hour later has no such
 * neighbour it can trust. An empty speed column is the honest answer.
 */
export const toLogFix = (f) => ({
  t: f.timestamp,
  lat: f.coords?.latitude,
  lon: f.coords?.longitude,
  sog: f.coords?.speed == null ? null : f.coords.speed * KN_PER_MS,
  cog: f.coords?.heading ?? null,
  accuracy: f.coords?.accuracy ?? null,
});

export class NativeBridge {
  /**
   * @param {object} plugin the BackgroundTrack plugin
   * @param {object} deps `gps` takes live fixes, `trackLog` takes drained ones,
   *   `store` remembers how far the drain got, `onError` is told when the phone
   *   says no -- this file never writes to the screen itself.
   */
  constructor(plugin, { gps, trackLog, store = null, onError = null } = {}) {
    this.plugin = plugin;
    this.gps = gps;
    this.trackLog = trackLog;
    this.store = store;
    this.onError = onError;
    this.listener = null;
    this.running = false;
  }

  get lastSeq() {
    try {
      return Number(this.store?.getItem(SEQ_KEY)) || 0;
    } catch {
      return 0; // no store: every drain starts from the beginning, which is safe
    }
  }

  set lastSeq(n) {
    try {
      this.store?.setItem(SEQ_KEY, String(n));
    } catch { /* the drain still works, it just repeats itself after a restart */ }
  }

  /**
   * Ask for location and start reporting.
   *
   * Refusal is not an error here -- a phone with location off is a phone that
   * shows a chart and no boat, which the app already knows how to be.
   */
  async start() {
    try {
      this.listener = await this.plugin.addListener("fix", (fix) => this.onFix(fix));
      const res = await this.plugin.start();
      this.running = true;
      return res;
    } catch (e) {
      this.onError?.(e?.message ?? String(e));
      return null;
    }
  }

  async stop() {
    this.running = false;
    try {
      await this.listener?.remove?.();
      this.listener = null;
      return await this.plugin.stop();
    } catch {
      return null;
    }
  }

  /** A live fix: straight into the GPS, in the shape a browser would give it. */
  onFix(fix) {
    if (!Number.isFinite(fix?.coords?.latitude)) return;
    if (Number.isFinite(fix.seq)) this.lastSeq = Math.max(this.lastSeq, fix.seq);
    this.gps?.onFix(fix);
  }

  /**
   * Collect everything CoreLocation recorded while the WebView was not
   * listening, and put it in the open recording.
   *
   * Drained in pages, because a night at anchor with recording on is tens of
   * thousands of fixes and one call carrying all of them is a message the
   * bridge has to copy whole. Nothing is recorded when nothing is recording:
   * the log drops them, which is what "I switched it off" means.
   */
  async drain({ maxPages = 20 } = {}) {
    let stored = 0;
    let pages = 0;
    try {
      while (pages < maxPages) {
        pages += 1;
        const res = await this.plugin.drain({ sinceSeq: this.lastSeq });
        const fixes = res?.fixes ?? [];
        if (!fixes.length) break;
        stored += this.trackLog?.recordMany?.(fixes.map(toLogFix))?.stored ?? 0;
        this.lastSeq = Math.max(this.lastSeq, res.nextSeq ?? this.lastSeq);
        if (!res.more) break;
      }
    } catch (e) {
      this.onError?.(e?.message ?? String(e));
    }
    return { stored, pages };
  }

  /** The screen stays on because the app says so, not because a browser agreed. */
  async keepAwake(on) {
    try {
      await this.plugin.keepAwake({ on });
      return true;
    } catch {
      return false;
    }
  }

  /** A file, handed to the share sheet. The browser's download does not exist here. */
  async share(name, text) {
    try {
      await this.plugin.share({ name, text });
      return true;
    } catch (e) {
      this.onError?.(e?.message ?? String(e));
      return false;
    }
  }
}
