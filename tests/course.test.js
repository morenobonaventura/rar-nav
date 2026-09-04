import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCourse, reverseAndMirror, gatePoint, totalDistanceNm, displayLegs, isOnLand } from "../js/course.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const config = read("../data/course.json");
const golden = read("./fixtures_course_python.json");

/**
 * The golden fixture is the routing project's own `rar.race.rar.Course.build()`
 * output with its nearest_water() nudge disabled (see
 * tools/build_course_fixture.sh), so it is the pure course GEOMETRY. That nudge
 * uses a 1-arcmin raster land mask which cannot see the 750 m Bocche di Vulcano
 * and shifts that gate ~550 m; this app carries precise OSM coastline instead,
 * so "is the mark on water" is asserted separately, against the better data.
 */
for (const direction of ["clockwise", "counterclockwise"]) {
  test(`${direction} course matches the Python router waypoint for waypoint`, () => {
    const mine = buildCourse(config, direction);
    const theirs = golden[direction];
    assert.equal(mine.length, theirs.length, "same number of waypoints");
    mine.forEach((w, i) => {
      const t = theirs[i];
      assert.equal(w.name, t.name, `waypoint ${i} name`);
      assert.ok(Math.abs(w.lat - t.lat) < 1e-6, `waypoint ${i} (${w.name}) lat: ${w.lat} vs ${t.lat}`);
      assert.ok(Math.abs(w.lon - t.lon) < 1e-6, `waypoint ${i} (${w.name}) lon: ${w.lon} vs ${t.lon}`);
      assert.ok(Math.abs(w.legNm - t.leg_nm) < 1e-6, `waypoint ${i} (${w.name}) leg distance`);
    });
  });
}

test("both directions cover the same distance", () => {
  const cw = totalDistanceNm(buildCourse(config, "clockwise"));
  const ccw = totalDistanceNm(buildCourse(config, "counterclockwise"));
  assert.ok(Math.abs(cw - ccw) < 0.5, `${cw.toFixed(2)} vs ${ccw.toFixed(2)} nm`);
  assert.ok(cw > 120 && cw < 170, `${cw.toFixed(1)} nm is not a plausible RAR course`);
});

test("counterclockwise reverses the order and flips every side", () => {
  const cw = config.sequence_clockwise;
  const ccw = reverseAndMirror(cw);
  assert.equal(ccw.length, cw.length);
  // Clockwise is Alicudi, Filicudi, Salina/Lipari gate, Stromboli, Vulcano/Lipari gate,
  // so counterclockwise starts by threading the Vulcano/Lipari gate the other way.
  assert.deepEqual(ccw[0], { gate: ["Vulcano", "Lipari"] }, "last CW mark becomes first");
  assert.deepEqual(ccw[1], { island: "Stromboli", side: "port" }, "and sides flip");
  assert.deepEqual(ccw[ccw.length - 1], { island: "Alicudi", side: "port" });
  assert.deepEqual(reverseAndMirror(ccw), cw, "mirroring twice is the identity");
  const gates = ccw.filter((e) => e.gate);
  assert.equal(gates.length, 2, "gates survive the flip");
  gates.forEach((g) => assert.equal(g.side, undefined, "gates have no side"));
});

test("an island rounding is an arc, not a single point", () => {
  const wps = buildCourse(config, "clockwise");
  const stromboli = wps.filter((w) => w.island === "Stromboli");
  assert.ok(stromboli.length > 4, `Stromboli rounding collapsed to ${stromboli.length} point(s)`);
  // Every arc point sits at the same distance from the island centre...
  const island = config.islands.find((i) => i.name === "Stromboli");
  const r = island.radius_nm + config.rounding.margin_nm;
  for (const w of stromboli) {
    const d = Math.hypot((w.lat - island.lat) * 60, (w.lon - island.lon) * 60 * Math.cos((w.lat * Math.PI) / 180));
    assert.ok(Math.abs(d - r) < 0.05, `arc point ${w.name} is ${d.toFixed(2)} nm out, expected ${r}`);
  }
  // ...and the arc actually passes the island rather than turning back short of it.
  const maxLat = Math.max(...stromboli.map((w) => w.lat));
  assert.ok(maxLat > island.lat, "the rounding draws level with and past the island");
});

test("gate points sit between their two islands", () => {
  const salina = config.islands.find((i) => i.name === "Salina");
  const lipari = config.islands.find((i) => i.name === "Lipari");
  const g = gatePoint(salina, lipari);
  assert.ok(g.lat < salina.lat && g.lat > lipari.lat, "between them in latitude");
  const wps = buildCourse(config, "clockwise");
  const gates = wps.filter((w) => w.kind === "gate");
  assert.equal(gates.length, 2);
  gates.forEach((w) => assert.equal(w.side, undefined, "a gate is not rounded"));
});

test("the course starts and finishes at Capo d'Orlando", () => {
  const wps = buildCourse(config, "clockwise");
  assert.equal(wps[0].kind, "start");
  assert.equal(wps[wps.length - 1].kind, "finish");
  assert.equal(wps[0].lat, wps[wps.length - 1].lat);
  assert.equal(wps[0].lon, wps[wps.length - 1].lon);
  assert.equal(wps[0].legNm, 0, "no leg into the start");
});

test("displayLegs collapses each arc to one row", () => {
  const wps = buildCourse(config, "clockwise");
  const rows = displayLegs(wps);
  assert.ok(rows.length < wps.length, "arcs are grouped");
  const roundings = rows.filter((r) => r.kind === "island_round");
  assert.equal(roundings.length, 3, "Alicudi, Filicudi and Stromboli are rounded");
  assert.deepEqual(roundings.map((r) => r.island), ["Alicudi", "Filicudi", "Stromboli"]);
  roundings.forEach((r) => assert.ok(r.points.length > 1, `${r.island} arc has multiple points`));
  // Grouping must not lose or double-count distance.
  const summed = rows.reduce((s, r) => s + r.distNm, 0);
  assert.ok(Math.abs(summed - totalDistanceNm(wps)) < 1e-9, "distance is preserved");
});

test("no waypoint on the built course sits on land", () => {
  const coast = read("../data/aeolian_coast.geojson");
  for (const direction of ["clockwise", "counterclockwise"]) {
    for (const w of buildCourse(config, direction)) {
      const kind = isOnLand(w, coast);
      assert.equal(kind, null, `${direction}: ${w.name} is on ${kind} at ${w.lat},${w.lon}`);
    }
  }
});

test("isOnLand recognises land it should", () => {
  const coast = read("../data/aeolian_coast.geojson");
  assert.ok(isOnLand({ lat: 38.7889, lon: 15.2133 }, coast), "the summit of Stromboli is land");
  assert.equal(isOnLand({ lat: 38.65, lon: 14.7 }, coast), null, "open water between the islands");
});
