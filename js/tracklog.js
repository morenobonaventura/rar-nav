/**
 * Every fix the phone reported, kept for afterwards.
 *
 * This is not the five-minute instrument buffer in gps.js -- that one is a
 * ring the charts read and nothing else. This is the log: the whole track, in
 * the order it arrived, so that after the race there is something to look at
 * in a chart plotter or a spreadsheet instead of a memory of what the numbers
 * were doing at the time.
 *
 * Three things shape the storage.
 *
 * A phone gives around one fix a second, and localStorage is a synchronous
 * string store of a few megabytes. So points are written as CSV lines, not
 * objects, and the log is cut into chunks: only the last chunk is rewritten
 * when a point arrives, so the cost of recording does not grow with the length
 * of the race. Six decimal places on latitude is about 0.11 m, which is well
 * under what any phone knows about where it is.
 *
 * Storage runs out. The log is capped and the OLDEST chunk goes first, because
 * on a boat the last hour is the one you are about to need; the count of what
 * was dropped is kept and shown, since a log that quietly loses its start is
 * worse than one that says it did.
 *
 * A fix the phone does not believe in is not data. Anything reported worse
 * than `maxAccuracy` metres is refused -- 50 m is a boat length or ten, and a
 * track drawn through multipath off a cliff is a track that never happened.
 * A phone that reports no accuracy at all is taken at its word instead: that
 * is an unknown, not a bad fix, and dropping those would empty the log on any
 * device that does not fill the field in.
 */

export const LOG_KEY = "rarnav.log.v1";
export const MAX_ACCURACY_M = 50;

const DEFAULTS = {
  chunkPoints: 500,   // ~20 kB a chunk: one write per fix, and a cheap one
  maxPoints: 80000,   // ~3.2 MB, leaving room in a 5 MB store for everything else
  minGapMs: 1000,     // iOS fires bursts; one point a second is the whole track
  maxAccuracy: MAX_ACCURACY_M,
};

export const CSV_HEADER = "time_utc,lat,lon,sog_kn,cog_true,accuracy_m";

export class TrackLog {
  constructor(store, opts = {}) {
    Object.assign(this, DEFAULTS, opts);
    this.store = store ?? null;
    this.failed = false;
    this.meta = empty();
    this.tail = [];
    this.lastT = null;
    this.load();
  }

  load() {
    if (!this.store) return;
    try {
      const m = JSON.parse(this.store.getItem(`${LOG_KEY}.meta`) ?? "null");
      if (m && Number.isFinite(m.from) && Number.isFinite(m.to)) {
        this.meta = { ...empty(), ...m };
        this.tail = lines(this.store.getItem(`${LOG_KEY}.${this.meta.to}`));
        this.lastT = this.tail.length ? Number(this.tail[this.tail.length - 1].split(",")[0]) : null;
      }
    } catch {
      this.meta = empty(); // unreadable: start again
      this.tail = [];
    }
  }

  get count() {
    return this.meta.count;
  }

  get dropped() {
    return this.meta.dropped;
  }

  /**
   * Offer a fix to the log. Returns why it was refused, or null if it went in.
   *
   * The reasons are for the caller to report, not to act on: a log that is
   * full, off, or being fed the same second twice is not an error, it is a
   * thing that happens on the water.
   */
  record(fix) {
    if (!this.store || this.failed) return "off";
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return "no position";
    if (Number.isFinite(fix.accuracy) && fix.accuracy > this.maxAccuracy) return "accuracy";
    const t = Number(fix.t);
    if (!Number.isFinite(t)) return "no time";
    if (this.lastT != null && t - this.lastT < this.minGapMs) return "too soon";

    this.tail.push(csvLine(t, fix));
    this.lastT = t;
    if (!this.meta.count) this.meta.firstT = t;
    this.meta.lastT = t;
    this.meta.count += 1;
    if (this.tail.length >= this.chunkPoints) {
      if (!this.flush()) return "storage";
      this.meta.to += 1;
      this.tail = [];
    }
    return this.flush() ? null : "storage";
  }

  /** Writes the open chunk and the meta, making room first if there is none. */
  flush() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.store.setItem(`${LOG_KEY}.${this.meta.to}`, this.tail.join("\n"));
        this.store.setItem(`${LOG_KEY}.meta`, JSON.stringify(this.meta));
        if (this.meta.count > this.maxPoints) this.dropOldest();
        return true;
      } catch {
        // Full. The oldest hour is the one worth losing, so lose it and retry
        // once; if that does not help, the log stops rather than the app.
        if (attempt === 0 && this.meta.to > this.meta.from) this.dropOldest();
        else this.failed = true;
      }
    }
    return false;
  }

  dropOldest() {
    if (this.meta.to <= this.meta.from) return; // never drop the chunk being written
    const key = `${LOG_KEY}.${this.meta.from}`;
    const n = lines(this.store.getItem(key)).length;
    try {
      this.store.removeItem(key);
    } catch { /* a store that will not delete will not write either */ }
    this.meta.from += 1;
    this.meta.count = Math.max(0, this.meta.count - n);
    this.meta.dropped += n;
    // The log now starts wherever the surviving oldest chunk starts, and the
    // panel reads that every second -- so it is kept here rather than found by
    // walking every chunk in the store.
    const oldest = this.meta.from < this.meta.to
      ? lines(this.store.getItem(`${LOG_KEY}.${this.meta.from}`))
      : this.tail;
    this.meta.firstT = oldest.length ? Number(oldest[0].split(",")[0]) : this.meta.lastT;
    try {
      this.store.setItem(`${LOG_KEY}.meta`, JSON.stringify(this.meta));
    } catch { /* reported by the next flush */ }
  }

  /** Every stored line, oldest first. */
  rows() {
    if (!this.store) return [];
    const out = [];
    for (let i = this.meta.from; i < this.meta.to; i++) out.push(...lines(this.store.getItem(`${LOG_KEY}.${i}`)));
    out.push(...this.tail);
    return out;
  }

  /** When the log starts and ends, in epoch ms, or null when it is empty.
   *  Read off the meta, because the setup panel asks for it once a second. */
  span() {
    if (!this.meta.count) return null;
    return { first: this.meta.firstT, last: this.meta.lastT };
  }

  /** The whole log as a CSV file, timestamps in UTC so it lands anywhere. */
  csv() {
    const body = this.rows().map((line) => {
      const [t, ...rest] = line.split(",");
      return [new Date(Number(t)).toISOString(), ...rest].join(",");
    });
    return [CSV_HEADER, ...body].join("\n") + "\n";
  }

  clear() {
    if (this.store) {
      for (let i = this.meta.from; i <= this.meta.to; i++) {
        try { this.store.removeItem(`${LOG_KEY}.${i}`); } catch { /* nothing to do */ }
      }
      try { this.store.removeItem(`${LOG_KEY}.meta`); } catch { /* nothing to do */ }
    }
    this.meta = empty();
    this.tail = [];
    this.lastT = null;
    this.failed = false;
  }
}

const empty = () => ({ from: 0, to: 0, count: 0, dropped: 0, firstT: null, lastT: null });

const csvLine = (t, fix) => [
  Math.round(t),
  fix.lat.toFixed(6),
  fix.lon.toFixed(6),
  Number.isFinite(fix.sog) ? fix.sog.toFixed(2) : "",
  Number.isFinite(fix.cog) ? Math.round(fix.cog) : "",
  Number.isFinite(fix.accuracy) ? Math.round(fix.accuracy) : "",
].join(",");

const lines = (text) => (text ? text.split("\n").filter(Boolean) : []);
