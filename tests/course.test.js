import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCourse, reverseCourse, displayLegs, totalDistanceNm,
  gateMidpoint, gateWidthNm, isOnLand, crossesLand, courseLandConflicts, clearanceM,
} from "../js/course.js";
import { haversineNm } from "../js/nav.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const config = read("../data/course.json");
const coast = read("../data/aeolian_coast.geojson");

const M_PER_NM = 1852;

/**
 * The course is a list of MARKS with a required side, not a route. These tests
 * are about that: the marks sit where they should, the sides are consistent,
 * and sailing the course the other way round is the exact mirror.
 */

test("every rounding mark sits just off its island, not miles out", () => {
  const wps = buildCourse(config, "clockwise").filter((w) => w.kind === "mark");
  assert.ok(wps.length > 0, "the course has rounding marks");
  for (const w of wps) {
    const m = clearanceM(w, coast);
    assert.ok(m >= 100, `${w.name} is only ${m} m off the rocks`);
    assert.ok(m <= 900, `${w.name} is ${m} m offshore — the clearance is ${config.clearance_m} m`);
  }
});

test("no mark is on land", () => {
  for (const direction of ["clockwise", "counterclockwise"]) {
    for (const w of buildCourse(config, direction)) {
      assert.equal(isOnLand(w, coast), null, `${direction}: ${w.name} is on land`);
    }
  }
});

test("rounding an island never means sailing over it", () => {
  // Within a rounding the marks are ours to place, so a chord that clips a
  // headland is a bug in where we put them, not a fact about the course.
  for (const direction of ["clockwise", "counterclockwise"]) {
    const wps = buildCourse(config, direction);
    for (let i = 1; i < wps.length; i++) {
      if (wps[i].kind !== "mark" || wps[i - 1].kind !== "mark") continue;
      if (wps[i].island !== wps[i - 1].island) continue;
      assert.equal(
        crossesLand(wps[i - 1], wps[i], coast), null,
        `${direction}: ${wps[i - 1].name} → ${wps[i].name} cuts the island it is rounding`
      );
    }
  }
});

/**
 * The one leg that genuinely cannot be sailed straight, in both directions:
 * leaving the Bocche di Vulcano for Sicily, the rhumb line runs over Vulcano.
 * The course carries no mark there because the race does not require one — you
 * simply have to go round the island, which is a routing problem and not a
 * course problem. This test pins the known conflict so that it stays visible
 * and so that any NEW one shows up as a failure rather than as scenery.
 */
test("the only leg crossing land is the Vulcano transit, and it is reported", () => {
  for (const direction of ["clockwise", "counterclockwise"]) {
    const conflicts = courseLandConflicts(buildCourse(config, direction), coast);
    assert.equal(conflicts.length, 1, `${direction}: unexpected legs crossing land`);
    const names = [conflicts[0].from.name, conflicts[0].to.name].join(" → ");
    assert.ok(/Vulcano/.test(names) && /Capo d'Orlando/.test(names), `unexpected conflict: ${names}`);
    assert.equal(conflicts[0].kind, "island");
  }
});

test("marks are close enough together that the straight line between them stays clear", () => {
  // The chord between two marks on a curve of radius R cuts inside it by
  // R(1-cos(step/2)); this is what keeps a straight-line route off the rocks
  // while there is no router to go around.
  const wps = buildCourse(config, "clockwise");
  for (let i = 1; i < wps.length; i++) {
    if (wps[i].kind !== "mark" || wps[i - 1].kind !== "mark") continue;
    if (wps[i].island !== wps[i - 1].island) continue;
    const nm = haversineNm(wps[i - 1], wps[i]);
    assert.ok(nm * M_PER_NM < 2500, `${wps[i - 1].name} → ${wps[i].name} is ${(nm * M_PER_NM).toFixed(0)} m apart`);
  }
});

test("a gate is passed between two buoys and rounds neither island", () => {
  const gates = buildCourse(config, "clockwise").filter((w) => w.kind === "gate");
  assert.equal(gates.length, 2, "Salina/Lipari and Vulcano/Lipari");
  for (const g of gates) {
    assert.equal(g.gate.length, 2, `${g.name} has two buoys`);
    assert.equal(g.side, undefined, "a gate has no side to be left on");
    const width = gateWidthNm(g.gate) * M_PER_NM;
    assert.ok(width > 400, `${g.name} is only ${width.toFixed(0)} m wide — too tight to be a fair gate`);
    // The waypoint is the middle of the gate.
    const mid = gateMidpoint(g.gate);
    assert.ok(Math.abs(mid.lat - g.lat) < 1e-9 && Math.abs(mid.lon - g.lon) < 1e-9);
    assert.equal(isOnLand(mid, coast), null, `${g.name} midpoint is on land`);
  }
});

test("sailing the other way round mirrors the course exactly", () => {
  const cw = buildCourse(config, "clockwise");
  const ccw = buildCourse(config, "counterclockwise");
  assert.equal(cw.length, ccw.length, "same number of waypoints");

  // Marks in reverse order, sides flipped.
  const marks = (w) => w.filter((x) => x.kind === "mark");
  const cwMarks = marks(cw);
  const ccwMarks = marks(ccw);
  assert.equal(cwMarks.length, ccwMarks.length);
  cwMarks.forEach((m, i) => {
    const other = ccwMarks[ccwMarks.length - 1 - i];
    assert.equal(m.name, other.name, `mark ${i} is the same buoy both ways`);
    assert.notEqual(m.side, other.side, `${m.name} is left on the other side`);
  });

  // And the distances match, since it is the same marks in the other order.
  assert.ok(
    Math.abs(totalDistanceNm(cw) - totalDistanceNm(ccw)) < 0.5,
    `${totalDistanceNm(cw).toFixed(2)} vs ${totalDistanceNm(ccw).toFixed(2)} nm`
  );
});

test("reversing twice is the identity", () => {
  assert.deepEqual(reverseCourse(reverseCourse(config.sequence_clockwise)), config.sequence_clockwise);
});

test("the course is a plausible Round Aeolian Race", () => {
  const nm = totalDistanceNm(buildCourse(config, "clockwise"));
  assert.ok(nm > 120 && nm < 175, `${nm.toFixed(1)} nm is not a plausible RAR course`);
});

test("the course starts and finishes at Capo d'Orlando", () => {
  const wps = buildCourse(config, "clockwise");
  assert.equal(wps[0].kind, "start");
  assert.equal(wps[wps.length - 1].kind, "finish");
  assert.equal(wps[0].lat, wps[wps.length - 1].lat);
  assert.equal(wps[0].lon, wps[wps.length - 1].lon);
  assert.equal(wps[0].legNm, 0, "no leg into the start");
});

test("displayLegs collapses each rounding to one row without losing distance", () => {
  const wps = buildCourse(config, "clockwise");
  const rows = displayLegs(wps);
  assert.ok(rows.length < wps.length, "marks are grouped");
  const roundings = rows.filter((r) => r.kind === "rounding");
  assert.deepEqual(roundings.map((r) => r.island), ["Alicudi", "Filicudi", "Stromboli"]);
  roundings.forEach((r) => {
    assert.ok(r.points.length > 1, `${r.island} is rounded via several marks`);
    r.points.forEach((m) => assert.equal(m.side, r.side, "every mark shares the rounding's side"));
  });
  const summed = rows.reduce((s, r) => s + r.distNm, 0);
  assert.ok(Math.abs(summed - totalDistanceNm(wps)) < 1e-9, "distance is preserved");
});

test("both gates and all three roundings survive into the leg list", () => {
  const rows = displayLegs(buildCourse(config, "clockwise")).filter((r) => r.kind !== "start");
  assert.equal(rows.filter((r) => r.kind === "gate").length, 2);
  assert.equal(rows.filter((r) => r.kind === "rounding").length, 3);
  assert.equal(rows[rows.length - 1].kind, "finish");
});

test("crossesLand and isOnLand recognise land they should", () => {
  assert.ok(isOnLand({ lat: 38.7889, lon: 15.2133 }, coast), "the summit of Stromboli is land");
  assert.equal(isOnLand({ lat: 38.65, lon: 14.7 }, coast), null, "open water between the islands");
  // A line straight through Alicudi must be caught.
  const through = crossesLand({ lat: 38.545, lon: 14.30 }, { lat: 38.545, lon: 14.42 }, coast);
  assert.ok(through, "a track drawn through Alicudi is flagged");
  assert.equal(through.kind, "island");
});

test("an unknown direction is refused rather than silently guessed", () => {
  assert.throws(() => buildCourse(config, "widdershins"), /unknown direction/);
});
