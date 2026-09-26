import test from "node:test";
import assert from "node:assert/strict";
import { TrackLog, LOG_KEY, CSV_HEADER } from "../js/tracklog.js";

/** A localStorage stand-in that can be told to run out of room. */
const store = (limitBytes = Infinity) => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      const size = [...map].reduce((n, [key, val]) => n + key.length + val.length, 0)
        - (map.has(k) ? k.length + map.get(k).length : 0);
      if (size + k.length + v.length > limitBytes) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()],
  };
};

const fix = (t, over = {}) => ({ t, lat: 38.5414, lon: 15.8412, sog: 6.25, cog: 310.4, accuracy: 8, ...over });

test("a fix goes in and comes back out as a CSV row", () => {
  const log = new TrackLog(store());
  assert.equal(log.record(fix(1700000000000)), null);
  const [header, row] = log.csv().trim().split("\n");
  assert.equal(header, CSV_HEADER);
  assert.equal(row, "2023-11-14T22:13:20.000Z,38.541400,15.841200,6.25,310,8");
  assert.equal(log.count, 1);
});

test("a fix the phone does not believe in is refused", () => {
  const log = new TrackLog(store());
  assert.equal(log.record(fix(1e12, { accuracy: 51 })), "accuracy", "worse than 50 m");
  assert.equal(log.record(fix(1e12, { accuracy: 50 })), null, "50 m itself is kept");
  assert.equal(log.count, 1);
});

test("a phone that reports no accuracy at all is taken at its word", () => {
  const log = new TrackLog(store());
  assert.equal(log.record(fix(1e12, { accuracy: null })), null);
  assert.equal(log.record(fix(1e12 + 2000, { accuracy: undefined })), null);
  assert.equal(log.count, 2, "an unknown accuracy is not a bad fix");
  assert.ok(log.csv().trim().endsWith(","), "and the column is left empty rather than invented");
});

test("a burst of fixes in the same second is one point", () => {
  const log = new TrackLog(store());
  log.record(fix(1e12));
  assert.equal(log.record(fix(1e12 + 200)), "too soon");
  assert.equal(log.record(fix(1e12 + 999)), "too soon");
  assert.equal(log.record(fix(1e12 + 1000)), null);
  assert.equal(log.count, 2);
});

test("a fix with no position or no time is not a fix", () => {
  const log = new TrackLog(store());
  assert.equal(log.record(fix(1e12, { lat: null })), "no position");
  assert.equal(log.record(fix(NaN)), "no time");
  assert.equal(log.record(null), "no position");
  assert.equal(log.count, 0);
});

test("the log survives a reload, and keeps counting where it left off", () => {
  const s = store();
  const first = new TrackLog(s, { chunkPoints: 4 });
  for (let i = 0; i < 10; i++) first.record(fix(1e12 + i * 1000));
  const again = new TrackLog(s, { chunkPoints: 4 });
  assert.equal(again.count, 10);
  assert.equal(again.rows().length, 10);
  assert.equal(again.record(fix(1e12 + 9 * 1000 + 200)), "too soon", "it knows the last point it wrote");
  again.record(fix(1e12 + 20000));
  assert.equal(again.count, 11);
  assert.equal(new TrackLog(s, { chunkPoints: 4 }).rows().length, 11);
});

test("when the log is full the oldest goes, and says so", () => {
  const log = new TrackLog(store(), { chunkPoints: 4, maxPoints: 8 });
  for (let i = 0; i < 20; i++) log.record(fix(1e12 + i * 1000));
  assert.ok(log.count <= 12, `kept ${log.count}`);
  assert.ok(log.dropped > 0, "and the count of what went is kept");
  assert.equal(log.count + log.dropped, 20);
  const times = log.rows().map((r) => Number(r.split(",")[0]));
  assert.equal(times[times.length - 1], 1e12 + 19000, "the newest point is always there");
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "and the order is the order it happened");
});

test("a nearly full store keeps recording by losing its oldest hour", () => {
  const log = new TrackLog(store(400), { chunkPoints: 2 });
  for (let i = 0; i < 50; i++) log.record(fix(1e12 + i * 1000));
  const times = log.rows().map((r) => Number(r.split(",")[0]));
  assert.equal(times[times.length - 1], 1e12 + 49000, "the newest fix is in");
  assert.ok(log.dropped > 0 && log.count < 50, `kept ${log.count}, dropped ${log.dropped}`);
  assert.equal(log.failed, false, "and it is still recording");
});

test("a store with no room for even one chunk stops the log, not the app", () => {
  const log = new TrackLog(store(60), { chunkPoints: 2 });
  let refusals = 0;
  for (let i = 0; i < 20; i++) if (log.record(fix(1e12 + i * 1000)) === "storage") refusals++;
  assert.ok(refusals > 0, "it reports the refusal");
  assert.equal(log.record(fix(2e12)), "off", "and stops trying");
  assert.doesNotThrow(() => log.csv(), "what was written is still readable");
});

test("with no store at all the log is simply off", () => {
  const log = new TrackLog(null);
  assert.equal(log.record(fix(1e12)), "off");
  assert.equal(log.count, 0);
  assert.equal(log.csv(), `${CSV_HEADER}\n`);
  assert.deepEqual(log.span(), null);
});

test("the span is the first and last point still in the log", () => {
  const log = new TrackLog(store(), { chunkPoints: 2, maxPoints: 4 });
  for (let i = 0; i < 12; i++) log.record(fix(1e12 + i * 1000));
  const rows = log.rows().map((r) => Number(r.split(",")[0]));
  assert.deepEqual(log.span(), { first: rows[0], last: rows[rows.length - 1] },
    "it matches the rows even after the oldest were dropped");
});

test("clearing takes the chunks with it", () => {
  const s = store();
  const log = new TrackLog(s, { chunkPoints: 2 });
  for (let i = 0; i < 7; i++) log.record(fix(1e12 + i * 1000));
  assert.deepEqual(log.span(), { first: 1e12, last: 1e12 + 6000 });
  log.clear();
  assert.equal(log.count, 0);
  assert.deepEqual(s.keys().filter((k) => k.startsWith(LOG_KEY)), []);
  assert.equal(new TrackLog(s).count, 0);
});
