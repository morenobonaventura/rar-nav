import test from "node:test";
import assert from "node:assert/strict";

// gps.js persists the ring buffer, so give it somewhere to persist to before
// the module is evaluated.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = { addEventListener() {} };

const { Gps, SAMPLE_MS, WINDOW_MS } = await import("../js/gps.js");

/** A geolocation callback payload, with whatever the chip did or did not supply. */
const pos = (lat, lon, t, { speed = null, heading = null, accuracy = 8 } = {}) => ({
  timestamp: t,
  coords: { latitude: lat, longitude: lon, accuracy, speed, heading },
});

const fresh = () => {
  store.clear();
  return new Gps();
};

test("uses the chip's own speed and course when it supplies them", () => {
  const g = fresh();
  // 5 kn is 2.572 m/s; geolocation reports speed in m/s.
  g.onFix(pos(38.4, 14.9, 1000, { speed: 2.5722, heading: 250 }));
  assert.ok(Math.abs(g.fix.sog - 5) < 0.01, `expected 5 kn, got ${g.fix.sog}`);
  assert.equal(g.fix.cog, 250);
  assert.equal(g.fix.derived, false);
});

test("derives speed and course from successive fixes when the chip gives null", () => {
  const g = fresh();
  const t0 = 100000;
  g.onFix(pos(38.4, 14.9, t0));
  // One minute later, 0.1 degrees of latitude north: 6 nm in 60 s = 360 kn.
  g.onFix(pos(38.5, 14.9, t0 + 60000));
  assert.ok(g.fix.derived, "should be flagged as derived");
  assert.ok(Math.abs(g.fix.sog - 360) < 1, `expected ~360 kn, got ${g.fix.sog}`);
  assert.ok(Math.abs(g.fix.cog - 0) < 0.5, `due north, got ${g.fix.cog}`);
});

test("ignores fixes too close together to difference", () => {
  const g = fresh();
  g.onFix(pos(38.4, 14.9, 1000));
  g.onFix(pos(38.4001, 14.9, 1200)); // 200 ms apart: noise, not motion
  assert.equal(g.fix.sog, null, "no speed invented from a 200 ms gap");
});

test("holds the last real course when the boat stops", () => {
  const g = fresh();
  const t0 = 100000;
  g.onFix(pos(38.4, 14.9, t0, { speed: 3, heading: 137 }));
  assert.equal(g.fix.cog, 137);
  // Now stopped: a heading from a stationary GPS is meaningless.
  g.onFix(pos(38.4, 14.9, t0 + 6000, { speed: 0.05, heading: 42 }));
  assert.equal(g.fix.cog, 137, "keeps showing the last course actually sailed");
});

test("samples the buffer at the sampling interval, not on every fix", () => {
  const g = fresh();
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) g.onFix(pos(38.4, 14.9, t0 + i * 1000, { speed: 3, heading: 90 }));
  // 10 fixes one second apart spans 9 s, which is two 5 s sample slots.
  assert.equal(g.samples.length, 2, `got ${g.samples.length} samples from 10 fixes`);
});

test("the buffer holds five minutes and then discards the oldest", () => {
  const g = fresh();
  const t0 = 1_000_000;
  const n = WINDOW_MS / SAMPLE_MS;
  for (let i = 0; i < n + 25; i++)
    g.onFix(pos(38.4, 14.9, t0 + i * SAMPLE_MS, { speed: 3, heading: 90 }));
  assert.equal(g.samples.length, n, `buffer should cap at ${n}`);
  assert.equal(g.samples[g.samples.length - 1].t, t0 + (n + 24) * SAMPLE_MS, "newest kept");
});

test("history reports its true span and how stale it is", () => {
  const g = fresh();
  const now = 2_000_000;
  for (let i = 0; i < 10; i++)
    g.onFix(pos(38.4, 14.9, now - 90000 + i * SAMPLE_MS, { speed: 3, heading: 90 }));
  const h = g.history(now);
  assert.equal(h.samples.length, 10);
  assert.equal(h.spanMs, 9 * SAMPLE_MS, "span is first to last, not the window length");
  assert.equal(h.staleMs, 90000 - 9 * SAMPLE_MS, "staleness measured from the newest sample");
  assert.equal(h.gapMs, 0);
});

test("history reports the gap left by iOS suspending the app", () => {
  const g = fresh();
  const now = 2_000_000;
  // A minute of samples, then the app is backgrounded for 100 s, then more.
  for (let i = 0; i < 6; i++)
    g.onFix(pos(38.4, 14.9, now - 250000 + i * SAMPLE_MS, { speed: 3, heading: 90 }));
  for (let i = 0; i < 6; i++)
    g.onFix(pos(38.4, 14.9, now - 120000 + i * SAMPLE_MS, { speed: 3, heading: 90 }));
  const h = g.history(now);
  assert.ok(h.gapMs > 90000, `expected a ~100 s gap, got ${h.gapMs} ms`);
  assert.equal(h.samples.length, 12, "samples either side of the gap are all kept");
});

test("history drops samples that have aged out of the window", () => {
  const g = fresh();
  const now = 2_000_000;
  g.onFix(pos(38.4, 14.9, now - WINDOW_MS - 60000, { speed: 3, heading: 90 }));
  g.onFix(pos(38.4, 14.9, now - 30000, { speed: 3, heading: 90 }));
  assert.equal(g.samples.length, 2, "both are in the raw buffer");
  assert.equal(g.history(now).samples.length, 1, "only one is inside the window");
});

test("the buffer survives a reload", () => {
  const g = fresh();
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++)
    g.onFix(pos(38.4, 14.9, t0 + i * SAMPLE_MS, { speed: 3, heading: 90 }));
  const revived = new Gps(); // same backing store, as after a page reload
  assert.equal(revived.samples.length, 0, "samples older than the window are dropped on load");

  // Now with timestamps that are actually recent.
  store.clear();
  const g2 = new Gps();
  const now = Date.now();
  for (let i = 0; i < 4; i++)
    g2.onFix(pos(38.4, 14.9, now - 30000 + i * SAMPLE_MS, { speed: 3, heading: 90 }));
  assert.equal(new Gps().samples.length, g2.samples.length, "recent samples come back");
});

test("a storage failure does not stop the GPS working", () => {
  store.clear();
  const g = new Gps();
  const original = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  try {
    g.onFix(pos(38.4, 14.9, Date.now(), { speed: 3, heading: 90 }));
    assert.ok(g.fix, "still produced a fix with storage broken");
  } finally {
    globalThis.localStorage.setItem = original;
  }
});
