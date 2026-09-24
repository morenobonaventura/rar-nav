import test from "node:test";
import assert from "node:assert/strict";
import {
  WAYPOINTS_KEY, loadWaypoints, saveWaypoints, nextWaypointName, addWaypoint, removeWaypoint,
} from "../js/waypoints.js";

/** A localStorage stand-in, optionally one that refuses to store anything. */
const store = (initial = null, full = false) => {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_k, v) => { if (full) throw new Error("QuotaExceededError"); value = v; },
    read: () => value,
  };
};

test("a saved waypoint survives a round trip through the store", () => {
  const s = store();
  const list = addWaypoint([], { lat: 38.54, lon: 15.84 }, 1700000000000);
  assert.equal(saveWaypoints(list, s), true);
  const back = loadWaypoints(s);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, "WP 1");
  assert.equal(back[0].lat, 38.54);
});

test("a store that refuses to write says so rather than pretending", () => {
  assert.equal(saveWaypoints([{ id: "a", name: "WP 1", lat: 1, lon: 2 }], store(null, true)), false);
});

test("an unreadable store is an empty list, not a crash", () => {
  assert.deepEqual(loadWaypoints(store("{not json")), []);
  assert.deepEqual(loadWaypoints(store("null")), []);
  assert.deepEqual(loadWaypoints(store(JSON.stringify({ nope: 1 }))), []);
  assert.deepEqual(loadWaypoints(undefined), []);
});

test("one rotten record does not cost you the others", () => {
  const s = store(JSON.stringify([
    { id: "a", name: "WP 1", lat: 38.5, lon: 15.8 },
    { id: "b", name: "WP 2", lat: "38.5", lon: 15.8 },  // a string from an older version
    { id: "c", name: "WP 3", lat: 91, lon: 15.8 },      // off the planet
    null,
    { id: "d", name: "WP 4", lat: 38.6, lon: 15.9 },
  ]));
  assert.deepEqual(loadWaypoints(s).map((w) => w.id), ["a", "d"]);
});

test("names count off the highest in use, so a deleted number is not reissued", () => {
  let list = addWaypoint(addWaypoint(addWaypoint([], { lat: 1, lon: 1 }, 1), { lat: 2, lon: 2 }, 2), { lat: 3, lon: 3 }, 3);
  assert.deepEqual(list.map((w) => w.name), ["WP 1", "WP 2", "WP 3"]);
  list = removeWaypoint(list, list[1].id);
  assert.equal(nextWaypointName(list), "WP 4", "WP 2 is gone but its name is spent");
  assert.deepEqual(removeWaypoint(list, "not-a-waypoint").map((w) => w.name), ["WP 1", "WP 3"]);
});

test("a point with no position is not saved at all", () => {
  assert.deepEqual(addWaypoint([], { lat: null, lon: 15.8 }, 1), []);
  assert.deepEqual(addWaypoint([], undefined, 1), []);
  assert.deepEqual(addWaypoint([], { lat: NaN, lon: NaN }, 1), []);
});

test("every waypoint gets its own id", () => {
  const list = addWaypoint(addWaypoint([], { lat: 1, lon: 1 }, 7), { lat: 2, lon: 2 }, 7);
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(WAYPOINTS_KEY, "rarnav.waypoints.v1");
});
