import test from "node:test";
import assert from "node:assert/strict";
import { NativeBridge, plugin, isNative, toLogFix, SEQ_KEY } from "../js/native.js";
import { TrackLog } from "../js/tracklog.js";

/** A stand-in for the Swift plugin: the same five methods, none of the phone. */
const fakePlugin = (fixes = []) => ({
  buffer: [...fixes],
  started: false,
  awake: null,
  shared: null,
  listeners: {},
  addListener(event, cb) {
    this.listeners[event] = cb;
    return Promise.resolve({ remove: () => { delete this.listeners[event]; return Promise.resolve(); } });
  },
  start() { this.started = true; return Promise.resolve({ running: true, authorization: "always" }); },
  stop() { this.started = false; return Promise.resolve({ running: false }); },
  keepAwake({ on }) { this.awake = on; return Promise.resolve({ awake: on }); },
  share({ name, text }) { this.shared = { name, text }; return Promise.resolve({ shared: true }); },
  drain({ sinceSeq = 0, limit = 3 } = {}) {
    const rest = this.buffer.filter((f) => f.seq > sinceSeq);
    const page = rest.slice(0, limit);
    return Promise.resolve({
      fixes: page,
      nextSeq: page.length ? page[page.length - 1].seq : sinceSeq,
      more: rest.length > page.length,
    });
  },
  /** What CoreLocation would have delivered while the WebView was asleep. */
  collect(n, { from = 1e12, step = 1000, accuracy = 8 } = {}) {
    for (let i = 0; i < n; i++) {
      this.buffer.push({
        seq: this.buffer.length + 1,
        timestamp: from + i * step,
        coords: { latitude: 38.5 + i * 1e-4, longitude: 15.8, accuracy, speed: 3.2, heading: 310 },
      });
    }
    return this;
  },
});

const memStore = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
};

const fakeGps = () => ({ fixes: [], onFix(f) { this.fixes.push(f); } });

test("in a browser there is no native anything", () => {
  assert.equal(plugin({}), null);
  assert.equal(isNative({}), false);
  assert.equal(plugin({ Capacitor: { isNativePlatform: () => false, Plugins: { BackgroundTrack: {} } } }), null);
});

test("inside the app the plugin is found however Capacitor offers it", () => {
  const registered = {};
  assert.equal(plugin({ Capacitor: { isNativePlatform: () => true, registerPlugin: () => registered } }), registered);
  const legacy = {};
  assert.equal(plugin({ Capacitor: { isNativePlatform: () => true, Plugins: { BackgroundTrack: legacy } } }), legacy);
});

test("a native fix becomes a log row, knots and all", () => {
  const row = toLogFix({ timestamp: 1e12, coords: { latitude: 38.5, longitude: 15.8, accuracy: 7, speed: 3.2, heading: 310 } });
  assert.equal(row.t, 1e12);
  assert.ok(Math.abs(row.sog - 6.22) < 0.01, `3.2 m/s is ${row.sog} kn`);
  assert.equal(row.cog, 310);
});

test("a fix from a chip that knows no speed keeps the column empty", () => {
  // The live path derives speed from the previous fix; a fix drained an hour
  // later has no neighbour it can honestly use.
  const row = toLogFix({ timestamp: 1e12, coords: { latitude: 38.5, longitude: 15.8, accuracy: null, speed: null, heading: null } });
  assert.equal(row.sog, null);
  assert.equal(row.cog, null);
  assert.equal(row.accuracy, null);
});

test("live fixes go straight to the instruments", async () => {
  const p = fakePlugin();
  const gps = fakeGps();
  const bridge = new NativeBridge(p, { gps, trackLog: new TrackLog(memStore()), store: memStore() });
  await bridge.start();
  assert.equal(p.started, true);

  p.listeners.fix({ seq: 4, timestamp: 1e12, coords: { latitude: 38.5, longitude: 15.8, accuracy: 8, speed: 3, heading: 300 } });
  assert.equal(gps.fixes.length, 1, "the GPS is fed in the shape it already understands");
  assert.equal(bridge.lastSeq, 4, "and the drain knows not to fetch that one again");

  p.listeners.fix({ seq: 5, coords: {} }); // a fix with no position is not a fix
  assert.equal(gps.fixes.length, 1);
});

test("what the phone recorded while the WebView slept lands in the recording", async () => {
  const p = fakePlugin().collect(10);
  const log = new TrackLog(memStore(), { chunkPoints: 4 });
  log.start(1e12 - 1000);
  const bridge = new NativeBridge(p, { gps: fakeGps(), trackLog: log, store: memStore() });

  const { stored, pages } = await bridge.drain();
  assert.equal(stored, 10, "every fix, across several pages of three");
  assert.ok(pages > 1, "paged rather than one message carrying the night");
  assert.equal(log.count, 10);
  assert.equal(bridge.lastSeq, 10);

  const again = await bridge.drain();
  assert.equal(again.stored, 0, "and a second drain is not a second copy");
});

test("a drain with recording switched off keeps nothing", async () => {
  const p = fakePlugin().collect(6);
  const log = new TrackLog(memStore());
  const bridge = new NativeBridge(p, { gps: fakeGps(), trackLog: log, store: memStore() });
  const { stored } = await bridge.drain();
  assert.equal(stored, 0, "off means off, however much the phone collected");
  assert.equal(log.count, 0);
});

test("the drain picks up where it left off after the app was killed", async () => {
  const p = fakePlugin().collect(6);
  const store = memStore();
  const log = new TrackLog(memStore(), { chunkPoints: 100 });
  log.start(1e12 - 1000);

  await new NativeBridge(p, { gps: fakeGps(), trackLog: log, store }).drain();
  assert.equal(Number(store.getItem(SEQ_KEY)), 6);

  p.collect(4, { from: 1e12 + 60000 });
  const reborn = new NativeBridge(p, { gps: fakeGps(), trackLog: log, store });
  assert.equal(reborn.lastSeq, 6, "the mark survives the app");
  const { stored } = await reborn.drain();
  assert.equal(stored, 4, "only what arrived since");
  assert.equal(log.count, 10);
});

test("a phone that says no is reported, not thrown", async () => {
  const p = fakePlugin();
  p.start = () => Promise.reject(new Error("Location is off for this app."));
  const errors = [];
  const bridge = new NativeBridge(p, { gps: fakeGps(), trackLog: new TrackLog(memStore()), onError: (m) => errors.push(m) });
  assert.equal(await bridge.start(), null);
  assert.deepEqual(errors, ["Location is off for this app."]);
});

test("the screen and the share sheet are asked of the app, not the browser", async () => {
  const p = fakePlugin();
  const bridge = new NativeBridge(p, { gps: fakeGps(), trackLog: new TrackLog(memStore()) });
  assert.equal(await bridge.keepAwake(true), true);
  assert.equal(p.awake, true);
  assert.equal(await bridge.share("rarnav-track.csv", "time_utc\n"), true);
  assert.equal(p.shared.name, "rarnav-track.csv");
});

test("a batch of fixes obeys the same rules as one at a time", () => {
  const log = new TrackLog(memStore(), { chunkPoints: 3 });
  log.start(1e12 - 1000);
  const fix = (t, over = {}) => ({ t, lat: 38.5, lon: 15.8, sog: 6, cog: 300, accuracy: 8, ...over });
  const { stored, skipped } = log.recordMany([
    fix(1e12),
    fix(1e12 + 200),                       // too soon
    fix(1e12 + 1000, { accuracy: 90 }),    // worse than the phone should be believed for
    fix(1e12 + 2000),
    fix(1e12 + 3000, { lat: null }),       // not a fix
    fix(1e12 + 4000),
  ]);
  assert.equal(stored, 3);
  assert.equal(skipped, 3);
  assert.equal(log.count, 3);
  assert.equal(log.rows(log.list()[0].id).length, 3, "including across a chunk boundary");
});

test("a batch with nothing recording is dropped whole", () => {
  const log = new TrackLog(memStore());
  const out = log.recordMany([{ t: 1e12, lat: 38.5, lon: 15.8, sog: 6, cog: 300, accuracy: 8 }]);
  assert.deepEqual(out, { stored: 0, skipped: 1 });
});
