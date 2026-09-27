import test from "node:test";
import assert from "node:assert/strict";
import { TrackLog, LOG_KEY, LEGACY_KEY, CSV_HEADER, thin } from "../js/tracklog.js";

/** A localStorage stand-in that can be told to run out of room. */
const store = (limitBytes = Infinity) => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      const used = [...map].reduce((n, [key, val]) => n + key.length + val.length, 0)
        - (map.has(k) ? k.length + map.get(k).length : 0);
      if (used + k.length + v.length > limitBytes) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()],
  };
};

const fix = (t, over = {}) => ({ t, lat: 38.5414, lon: 15.8412, sog: 6.25, cog: 310.4, accuracy: 8, ...over });
const feed = (log, from, n, step = 1000) => {
  for (let i = 0; i < n; i++) log.record(fix(from + i * step));
};

test("nothing is recorded until the switch goes on", () => {
  const log = new TrackLog(store());
  assert.equal(log.recording, false);
  assert.equal(log.record(fix(1e12)), "off");
  log.start(1e12);
  assert.equal(log.recording, true);
  assert.equal(log.record(fix(1e12)), null);
  assert.equal(log.count, 1);
});

test("a fix goes in and comes back out as a CSV row", () => {
  const log = new TrackLog(store());
  const r = log.start(1700000000000);
  log.record(fix(1700000000000));
  const [header, row] = log.csv(r.id).trim().split("\n");
  assert.equal(header, CSV_HEADER);
  assert.equal(row, "2023-11-14T22:13:20.000Z,38.541400,15.841200,6.25,310,8");
});

test("each switch-on is a recording of its own", () => {
  const log = new TrackLog(store());
  const a = log.start(1e12);
  feed(log, 1e12, 3);
  log.stop(1e12 + 3000);
  assert.equal(log.recording, false);
  assert.equal(log.record(fix(1e12 + 9000)), "off", "the gap between recordings is not recorded");

  const b = log.start(1e12 + 10000);
  feed(log, 1e12 + 10000, 2);
  assert.notEqual(a.id, b.id);
  assert.equal(log.rows(a.id).length, 3);
  assert.equal(log.rows(b.id).length, 2);
  assert.equal(log.count, 5);

  const list = log.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id, "newest first, because that is the one being looked for");
  assert.equal(list[0].recording, true);
  assert.equal(list[1].recording, false);
  assert.equal(list[1].endedAt, 1e12 + 3000);
});

test("a recording left open is still open when the app comes back", () => {
  const s = store();
  const first = new TrackLog(s, { chunkPoints: 4 });
  const r = first.start(1e12);
  feed(first, 1e12, 10);

  const again = new TrackLog(s, { chunkPoints: 4 });
  assert.equal(again.recording, true, "the switch is stored, not the session");
  assert.equal(again.list()[0].id, r.id);
  assert.equal(again.count, 10);
  assert.equal(again.record(fix(1e12 + 9200)), "too soon", "it knows the last point it wrote");
  again.record(fix(1e12 + 20000));
  assert.equal(again.rows(r.id).length, 11, "and the same track carries on");
});

test("a recording switched off stays off across a reload", () => {
  const s = store();
  const first = new TrackLog(s);
  first.start(1e12);
  feed(first, 1e12, 3);
  first.stop(1e12 + 3000);

  const again = new TrackLog(s);
  assert.equal(again.recording, false);
  assert.equal(again.record(fix(2e12)), "off");
  assert.equal(again.count, 3, "and what it recorded is still there");
});

test("a fix the phone does not believe in is refused", () => {
  const log = new TrackLog(store());
  log.start(1e12);
  assert.equal(log.record(fix(1e12, { accuracy: 51 })), "accuracy", "worse than 50 m");
  assert.equal(log.record(fix(1e12, { accuracy: 50 })), null, "50 m itself is kept");
  assert.equal(log.record(fix(1e12 + 1000, { accuracy: null })), null, "an unknown accuracy is not a bad fix");
  assert.equal(log.count, 2);
});

test("a burst of fixes in the same second is one point", () => {
  const log = new TrackLog(store());
  log.start(1e12);
  log.record(fix(1e12));
  assert.equal(log.record(fix(1e12 + 200)), "too soon");
  assert.equal(log.record(fix(1e12 + 1000)), null);
  assert.equal(log.count, 2);
});

test("a fix with no position or no time is not a fix", () => {
  const log = new TrackLog(store());
  log.start(1e12);
  assert.equal(log.record(fix(1e12, { lat: null })), "no position");
  assert.equal(log.record(fix(NaN)), "no time");
  assert.equal(log.record(null), "no position");
  assert.equal(log.count, 0);
});

test("when the log is full the oldest goes, and says so", () => {
  const log = new TrackLog(store(), { chunkPoints: 4, maxPoints: 8 });
  const r = log.start(1e12);
  feed(log, 1e12, 20);
  assert.ok(log.count <= 12, `kept ${log.count}`);
  assert.equal(log.count + log.dropped, 20);
  const times = log.rows(r.id).map((x) => Number(x.split(",")[0]));
  assert.equal(times[times.length - 1], 1e12 + 19000, "the newest fix is always there");
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("the oldest recording is emptied before the newest loses anything", () => {
  const log = new TrackLog(store(), { chunkPoints: 2, maxPoints: 6 });
  const old = log.start(1e12);
  feed(log, 1e12, 6);
  log.stop(1e12 + 6000);
  const now = log.start(1e12 + 10000);
  feed(log, 1e12 + 10000, 6);
  assert.equal(log.rows(now.id).length, 6, "the recording in progress is untouched");
  assert.ok(log.rows(old.id).length < 6, "the old one paid for it");
});

test("a closed recording with nothing left in it leaves the list", () => {
  const log = new TrackLog(store(), { chunkPoints: 2, maxPoints: 4 });
  log.start(1e12);
  feed(log, 1e12, 4);
  log.stop(1e12 + 4000);
  log.start(1e12 + 10000);
  feed(log, 1e12 + 10000, 10);
  assert.equal(log.list().length, 1, "an empty recording is not one you can open");
  assert.ok(log.dropped >= 4);
});

test("a nearly full store keeps recording by losing its oldest hour", () => {
  const log = new TrackLog(store(500), { chunkPoints: 2 });
  const r = log.start(1e12);
  feed(log, 1e12, 50);
  const times = log.rows(r.id).map((x) => Number(x.split(",")[0]));
  assert.equal(times[times.length - 1], 1e12 + 49000, "the newest fix is in");
  assert.ok(log.dropped > 0 && log.count < 50, `kept ${log.count}, dropped ${log.dropped}`);
  assert.equal(log.failed, false, "and it is still recording");
});

test("a store with no room for even one chunk stops the log, not the app", () => {
  const log = new TrackLog(store(90), { chunkPoints: 2 });
  log.start(1e12);
  let refusals = 0;
  for (let i = 0; i < 20; i++) if (log.record(fix(1e12 + i * 1000)) === "storage") refusals++;
  assert.ok(refusals > 0, "it reports the refusal");
  assert.equal(log.record(fix(2e12)), "off", "and stops trying");
  assert.doesNotThrow(() => log.list());
});

test("with no store at all recording is simply off", () => {
  const log = new TrackLog(null);
  assert.equal(log.start(1e12), null, "nowhere to record to");
  assert.equal(log.recording, false);
  assert.equal(log.record(fix(1e12)), "off");
  assert.deepEqual(log.list(), []);
  assert.equal(log.csv("nope"), `${CSV_HEADER}\n`);
});

test("deleting one recording leaves the others alone", () => {
  const s = store();
  const log = new TrackLog(s, { chunkPoints: 2 });
  const a = log.start(1e12);
  feed(log, 1e12, 5);
  log.stop(1e12 + 5000);
  const b = log.start(1e12 + 10000);
  feed(log, 1e12 + 10000, 5);

  assert.equal(log.remove(a.id), true);
  assert.equal(log.remove("not-a-recording"), false);
  assert.deepEqual(log.list().map((r) => r.id), [b.id]);
  assert.equal(log.rows(b.id).length, 5);
  assert.equal(log.recording, true, "the one in progress is still going");
  assert.deepEqual(s.keys().filter((k) => k.includes(a.id)), []);
});

test("deleting the recording in progress stops it", () => {
  const log = new TrackLog(store());
  const r = log.start(1e12);
  feed(log, 1e12, 3);
  log.remove(r.id);
  assert.equal(log.recording, false);
  assert.equal(log.count, 0);
});

test("clearing takes every chunk with it", () => {
  const s = store();
  const log = new TrackLog(s, { chunkPoints: 2 });
  log.start(1e12);
  feed(log, 1e12, 7);
  log.stop(1e12 + 7000);
  log.start(1e12 + 20000);
  feed(log, 1e12 + 20000, 3);
  log.clear();
  assert.equal(log.count, 0);
  assert.equal(log.recording, false);
  assert.deepEqual(s.keys().filter((k) => k.startsWith(LOG_KEY) && !k.endsWith(".index")), []);
  assert.equal(new TrackLog(s).list().length, 0);
});

test("the log kept before recordings had a switch is listed as one", () => {
  const s = store();
  s.setItem(`${LEGACY_KEY}.0`, "1000000000000,38.541400,15.841200,6.25,310,8\n1000000001000,38.541500,15.841300,6.25,310,8");
  s.setItem(`${LEGACY_KEY}.meta`, JSON.stringify(
    { from: 0, to: 0, count: 2, dropped: 7, firstT: 1000000000000, lastT: 1000000001000 }));

  const log = new TrackLog(s);
  const [r] = log.list();
  assert.equal(log.list().length, 1);
  assert.equal(r.count, 2);
  assert.equal(r.dropped, 7, "including what it had already lost");
  assert.equal(r.recording, false, "an old log is never the one being written");
  assert.equal(log.csv(r.id).trim().split("\n").length, 3);
  assert.equal(log.recording, false);
});

test("a recording comes back as points for the chart", () => {
  const log = new TrackLog(store());
  const r = log.start(1e12);
  feed(log, 1e12, 3);
  assert.deepEqual(log.points(r.id), [
    { t: 1e12, lat: 38.5414, lon: 15.8412 },
    { t: 1e12 + 1000, lat: 38.5414, lon: 15.8412 },
    { t: 1e12 + 2000, lat: 38.5414, lon: 15.8412 },
  ]);
  assert.deepEqual(log.points("not-a-recording"), []);
});

test("thinning keeps the ends, the order and the count", () => {
  const points = Array.from({ length: 1000 }, (_, i) => ({ t: i, lat: 38 + i / 1e4, lon: 15 }));
  const few = thin(points, 100);
  assert.equal(few.length, 100);
  assert.deepEqual(few[0], points[0], "a track has to start where it started");
  assert.deepEqual(few[few.length - 1], points[999], "and stop where it stopped");
  assert.deepEqual(few.map((p) => p.t), [...few.map((p) => p.t)].sort((a, b) => a - b));
  assert.equal(thin(points, 5000), points, "a short track is left alone");
  assert.deepEqual(thin([], 100), []);
  assert.deepEqual(thin(null, 100), []);
});
