/**
 * Recordings: the fixes the phone reported, kept in the groups you asked for.
 *
 * This is not the five-minute instrument buffer in gps.js -- that one is a ring
 * the charts read and nothing else. This is the log: whole tracks, in the order
 * they arrived, so that after a race there is something to open in a plotter or
 * a spreadsheet instead of a memory of what the numbers were doing.
 *
 * Recording is a switch, not a background service. Each time it goes on a new
 * recording starts; when it goes off that one is closed and the next will be a
 * separate file. A recording left open when the app is closed is still open
 * when it is reopened -- the switch is stored, not the session, so a phone that
 * locks itself mid-race comes back recording the same track.
 *
 * Three things shape the storage.
 *
 * A phone gives around one fix a second, and localStorage is a synchronous
 * string store of a few megabytes. So points are written as CSV lines, not
 * objects, and each recording is cut into chunks: only the last chunk is
 * rewritten when a point arrives, so the cost of recording does not grow with
 * the length of the race. Six decimal places of latitude is about 0.11 m, well
 * under what any phone knows about where it is.
 *
 * Storage runs out. The log is capped across all recordings and the OLDEST
 * chunk goes first, because on a boat the last hour is the one you are about to
 * need; a recording that loses every chunk leaves the list, and the count of
 * what went is kept and shown, since a log that quietly loses its start is
 * worse than one that says it did.
 *
 * A fix the phone does not believe in is not data. Anything reported worse than
 * `maxAccuracy` metres is refused -- 50 m is a boat length or ten, and a track
 * drawn through multipath off a cliff is a track that never happened. A phone
 * that reports no accuracy at all is taken at its word instead: that is an
 * unknown, not a bad fix, and dropping those would empty the log on any device
 * that does not fill the field in.
 */

export const LOG_KEY = "rarnav.log.v2";
export const LEGACY_KEY = "rarnav.log.v1";
export const MAX_ACCURACY_M = 50;
export const CSV_HEADER = "time_utc,lat,lon,sog_kn,cog_true,accuracy_m";

const DEFAULTS = {
  chunkPoints: 500,   // ~20 kB a chunk: one write per fix, and a cheap one
  maxPoints: 80000,   // ~3.2 MB, leaving room in a 5 MB store for everything else
  minGapMs: 1000,     // iOS fires bursts; one point a second is the whole track
  maxAccuracy: MAX_ACCURACY_M,
};

export class TrackLog {
  constructor(store, opts = {}) {
    Object.assign(this, DEFAULTS, opts);
    this.store = store ?? null;
    this.failed = false;
    this.index = [];
    this.tail = [];
    this.lastT = null;
    this.load();
  }

  load() {
    if (!this.store) return;
    try {
      const raw = JSON.parse(this.store.getItem(`${LOG_KEY}.index`) ?? "null");
      this.index = Array.isArray(raw) ? raw.filter(valid) : [];
    } catch {
      this.index = []; // unreadable: the chunks are orphaned, but the app runs
    }
    if (!this.index.length) this.adoptLegacy();
    const open = this.open;
    if (open) {
      this.tail = lines(this.store.getItem(`${open.prefix}${open.to}`));
      this.lastT = this.tail.length ? Number(this.tail[this.tail.length - 1].split(",")[0]) : null;
    }
  }

  /**
   * The one log this app kept before recordings had a switch, listed as a
   * recording of its own. Its chunks stay where they are -- every entry carries
   * its own key prefix for exactly this reason -- so nothing is rewritten and
   * nothing is thrown away to gain a feature.
   */
  adoptLegacy() {
    try {
      const m = JSON.parse(this.store.getItem(`${LEGACY_KEY}.meta`) ?? "null");
      if (!m || !m.count) return;
      this.index = [{
        id: "legacy", prefix: `${LEGACY_KEY}.`,
        startedAt: m.firstT, endedAt: m.lastT,
        from: m.from, to: m.to, count: m.count, dropped: m.dropped ?? 0,
      }];
      this.writeIndex();
    } catch { /* nothing usable there */ }
  }

  /** The recording being written to, if any. Its absence IS "not recording". */
  get open() {
    const last = this.index[this.index.length - 1];
    return last && last.endedAt == null ? last : null;
  }

  get recording() {
    return this.open != null;
  }

  get count() {
    return this.index.reduce((n, r) => n + r.count, 0);
  }

  get dropped() {
    return this.index.reduce((n, r) => n + r.dropped, 0);
  }

  /** Start a new recording. Already recording is not an error, it is a no-op. */
  start(now) {
    if (!this.store || this.recording) return this.open;
    const id = `r${Math.round(now).toString(36)}`;
    const entry = {
      id, prefix: `${LOG_KEY}.${id}.`,
      startedAt: now, endedAt: null,
      from: 0, to: 0, count: 0, dropped: 0,
    };
    this.index.push(entry);
    this.tail = [];
    this.lastT = null;
    this.writeIndex();
    return entry;
  }

  /** Close the open recording. The next switch-on starts a separate track. */
  stop(now) {
    const open = this.open;
    if (!open) return null;
    open.endedAt = open.count ? Math.max(now, open.lastT ?? now) : now;
    this.tail = [];
    this.lastT = null;
    this.writeIndex();
    return open;
  }

  /**
   * Offer a fix to the open recording. Returns why it was refused, or null if
   * it went in. The reasons are for the caller to report, not to act on: a log
   * that is off, full, or being fed the same second twice is not an error, it
   * is a thing that happens on the water.
   */
  record(fix) {
    const open = this.open;
    if (!this.store || this.failed || !open) return "off";
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return "no position";
    if (Number.isFinite(fix.accuracy) && fix.accuracy > this.maxAccuracy) return "accuracy";
    const t = Number(fix.t);
    if (!Number.isFinite(t)) return "no time";
    if (this.lastT != null && t - this.lastT < this.minGapMs) return "too soon";

    this.tail.push(csvLine(t, fix));
    this.lastT = t;
    if (!open.count) open.firstT = t;
    open.lastT = t;
    open.count += 1;
    if (this.tail.length >= this.chunkPoints) {
      if (!this.flush()) return "storage";
      open.to += 1;
      this.tail = [];
    }
    return this.flush() ? null : "storage";
  }

  /**
   * A batch of fixes, written once.
   *
   * The native side hands over everything CoreLocation collected while the
   * WebView was asleep, which can be a whole night in one go. Offering them one
   * at a time would rewrite the open chunk and the index per fix; this applies
   * the same rules to all of them and flushes at the end of each chunk, so a
   * drain costs about what recording that stretch would have cost live.
   */
  recordMany(fixes) {
    const open = this.open;
    if (!this.store || this.failed || !open) return { stored: 0, skipped: fixes.length };
    let stored = 0;
    for (const fix of fixes) {
      if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) continue;
      if (Number.isFinite(fix.accuracy) && fix.accuracy > this.maxAccuracy) continue;
      const t = Number(fix.t);
      if (!Number.isFinite(t)) continue;
      if (this.lastT != null && t - this.lastT < this.minGapMs) continue;

      this.tail.push(csvLine(t, fix));
      this.lastT = t;
      if (!open.count) open.firstT = t;
      open.lastT = t;
      open.count += 1;
      stored += 1;
      if (this.tail.length >= this.chunkPoints) {
        if (!this.flush()) return { stored, skipped: fixes.length - stored };
        open.to += 1;
        this.tail = [];
      }
    }
    if (stored && !this.flush()) return { stored, skipped: fixes.length - stored };
    return { stored, skipped: fixes.length - stored };
  }

  /** Writes the open chunk and the index, making room first if there is none. */
  flush() {
    const open = this.open;
    if (!open) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.store.setItem(`${open.prefix}${open.to}`, this.tail.join("\n"));
        this.writeIndex();
        if (this.count > this.maxPoints) this.dropOldest();
        return true;
      } catch {
        // Full. The oldest hour is the one worth losing, so lose it and retry
        // once; if that does not help, the log stops rather than the app.
        if (attempt === 0 && this.dropOldest()) continue;
        this.failed = true;
      }
    }
    return false;
  }

  /**
   * Throw away the oldest chunk in the oldest recording that still has one.
   *
   * The open recording's last chunk is the one being written and is never a
   * candidate: losing it would lose the fix that is arriving. Returns whether
   * anything was actually freed, so a caller retrying a full store knows
   * whether there is any point.
   */
  dropOldest() {
    for (const r of this.index) {
      const last = r === this.open ? r.to - 1 : r.to; // newest chunk that may go
      if (r.from > last) continue;
      const key = `${r.prefix}${r.from}`;
      const n = lines(this.store.getItem(key)).length;
      try { this.store.removeItem(key); } catch { /* a store that will not delete will not write */ }
      r.from += 1;
      r.count = Math.max(0, r.count - n);
      r.dropped += n;
      const oldest = lines(this.store.getItem(`${r.prefix}${r.from}`));
      if (oldest.length) r.firstT = Number(oldest[0].split(",")[0]);
      // A closed recording with nothing left in it stops being one you can open.
      if (!r.count && r !== this.open) this.index = this.index.filter((x) => x !== r);
      this.writeIndex();
      return true;
    }
    return false;
  }

  /** Every recording, newest first, as plain data for the list in Setup. */
  list() {
    return this.index
      .map((r) => ({
        id: r.id, startedAt: r.startedAt, endedAt: r.endedAt,
        count: r.count, dropped: r.dropped,
        firstT: r.firstT ?? null, lastT: r.lastT ?? null,
        recording: r === this.open,
      }))
      .reverse();
  }

  /** The lines of one recording, oldest first. */
  rows(id) {
    const r = this.index.find((x) => x.id === id);
    if (!r || !this.store) return [];
    const out = [];
    for (let i = r.from; i <= r.to; i++) out.push(...lines(this.store.getItem(`${r.prefix}${i}`)));
    return out;
  }

  /** One recording as points, for drawing. Anything unparseable is dropped:
   *  a chart is no place to find out that one line of the log got cut short. */
  points(id) {
    return this.rows(id)
      .map((line) => {
        const [t, lat, lon] = line.split(",");
        return { t: Number(t), lat: Number(lat), lon: Number(lon) };
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }

  /** One recording as a CSV file, timestamps in UTC so it lands anywhere. */
  csv(id) {
    const body = this.rows(id).map((line) => {
      const [t, ...rest] = line.split(",");
      return [new Date(Number(t)).toISOString(), ...rest].join(",");
    });
    return [CSV_HEADER, ...body].join("\n") + "\n";
  }

  /** Delete one recording, chunks and all. Deleting the open one stops it. */
  remove(id) {
    const r = this.index.find((x) => x.id === id);
    if (!r) return false;
    if (r === this.open) {
      this.tail = [];
      this.lastT = null;
    }
    for (let i = r.from; i <= r.to; i++) {
      try { this.store?.removeItem(`${r.prefix}${i}`); } catch { /* nothing to do */ }
    }
    this.index = this.index.filter((x) => x !== r);
    this.writeIndex();
    return true;
  }

  /** Everything, including whatever is being recorded right now. */
  clear() {
    for (const r of [...this.index]) this.remove(r.id);
    this.index = [];
    this.tail = [];
    this.lastT = null;
    this.failed = false;
    this.writeIndex();
  }

  writeIndex() {
    try {
      this.store?.setItem(`${LOG_KEY}.index`, JSON.stringify(this.index));
    } catch { /* reported by the next flush */ }
  }
}

/**
 * At most `max` points, evenly spaced, with the first and last always kept.
 *
 * A day's recording is eighty thousand fixes and a phone will not draw that as
 * a polyline, but at chart scale it does not have to: a couple of thousand
 * points is already finer than the line is wide. The ends are kept whatever
 * the stride, because where a track starts and stops is the thing being looked
 * at.
 */
export function thin(points, max) {
  if (!Array.isArray(points) || points.length <= max || max < 2) return points ?? [];
  const stride = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * stride)]);
  out.push(points[points.length - 1]);
  return out;
}

const valid = (r) =>
  r != null && typeof r.id === "string" && typeof r.prefix === "string" &&
  Number.isFinite(r.from) && Number.isFinite(r.to) && Number.isFinite(r.count);

const csvLine = (t, fix) => [
  Math.round(t),
  fix.lat.toFixed(6),
  fix.lon.toFixed(6),
  Number.isFinite(fix.sog) ? fix.sog.toFixed(2) : "",
  Number.isFinite(fix.cog) ? Math.round(fix.cog) : "",
  Number.isFinite(fix.accuracy) ? Math.round(fix.accuracy) : "",
].join(",");

const lines = (text) => (text ? text.split("\n").filter(Boolean) : []);
