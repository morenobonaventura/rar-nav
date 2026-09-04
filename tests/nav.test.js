import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  haversineNm, initialBearing, destinationPoint, angDiff, norm360,
  trueToMagnetic, windOverWater, vec, mag, dirOf, add,
  Polar, solveCourse, solveLeg, solveRoute, fmtDuration, fmtBearing,
} from "../js/nav.js";

const polarData = JSON.parse(readFileSync(new URL("../data/polar_dufour40.json", import.meta.url)));
const polar = Polar.fromJSON(polarData);

const CAPO_ORLANDO = { lat: 38.1667, lon: 14.7333 };
const STROMBOLI = { lat: 38.7889, lon: 15.2133 };
const ALICUDI = { lat: 38.545, lon: 14.36 };
const NO_CURRENT = { drift: 0, set: 0 };

const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a} (tol ${tol})`);

// --- geodesy, cross-checked against the Python router's physics module ------

test("distance and bearing match the Python router", () => {
  close(haversineNm(CAPO_ORLANDO, STROMBOLI), 43.641190, 1e-3, "CdO->Stromboli distance");
  close(initialBearing(CAPO_ORLANDO, STROMBOLI), 30.980140, 1e-3, "CdO->Stromboli bearing");
  close(haversineNm(CAPO_ORLANDO, ALICUDI), 28.719275, 1e-3, "CdO->Alicudi distance");
  close(initialBearing(CAPO_ORLANDO, ALICUDI), 322.382706, 1e-3, "CdO->Alicudi bearing");
});

test("destinationPoint inverts distance and bearing", () => {
  const p = destinationPoint(CAPO_ORLANDO, 30.98014, 43.64119);
  close(p.lat, STROMBOLI.lat, 1e-6, "round-trip lat");
  close(p.lon, STROMBOLI.lon, 1e-6, "round-trip lon");
});

test("angle helpers wrap correctly", () => {
  assert.equal(norm360(-10), 350);
  assert.equal(angDiff(10, 350), 20);
  assert.equal(angDiff(350, 10), -20);
  assert.equal(angDiff(180, 0), -180);
});

test("magnetic variation is east-positive: magnetic reads lower than true", () => {
  close(trueToMagnetic(90, 4.1), 85.9, 1e-9);
  close(trueToMagnetic(2, 4.1), 357.9, 1e-9, "wraps below zero");
});

// --- wind over water -------------------------------------------------------

test("with no current, wind over water equals wind over ground", () => {
  const ww = windOverWater(310, 14, 0, 0);
  close(ww.tws, 14, 1e-9);
  close(ww.twd, 310, 1e-9);
});

test("current flowing downwind reduces the wind the boat feels", () => {
  // Wind FROM 000 (blowing toward 180); water also flowing toward 180 at 2 kn.
  const ww = windOverWater(0, 12, 180, 2);
  close(ww.tws, 10, 1e-9, "12 kn wind minus 2 kn of following water");
  close(ww.twd, 0, 1e-9, "direction unchanged");
});

test("cross current shifts the wind direction the boat feels", () => {
  // Wind FROM 000 at 10 kn, water flowing east at 2 kn. Riding east with the
  // water, the boat feels an extra 2 kn from the east, so the wind it sails
  // to is veered east of north.
  const ww = windOverWater(0, 10, 90, 2);
  close(ww.tws, Math.hypot(10, 2), 1e-9);
  close(ww.twd, (Math.atan2(2, 10) * 180) / Math.PI, 1e-6, "veered, not backed");
  assert.ok(ww.twd > 0 && ww.twd < 90);
});

// --- polar -----------------------------------------------------------------

test("polar returns table values exactly on grid points", () => {
  const i = polarData.tws.indexOf(12);
  const j = polarData.twa.indexOf(90);
  close(polar.speed(90, 12), polarData.speeds[i][j], 1e-9);
});

test("polar is symmetric about the wind and clamps outside the grid", () => {
  close(polar.speed(-60, 12), polar.speed(60, 12), 1e-9, "port equals starboard");
  close(polar.speed(90, 100), polar.speed(90, 25), 1e-9, "clamps at the top of the range");
  close(polar.speed(90, 0), polar.speed(90, 4), 1e-9, "clamps at the bottom");
});

test("polar cannot sail straight into the wind", () => {
  close(polar.speed(0, 12), 0, 1e-9);
});

test("upwind VMG optimum sits between the no-go zone and a close reach", () => {
  const up = polar.vmgOptimum(12, "up");
  assert.ok(up.twa > 35 && up.twa < 55, `beat angle ${up.twa} deg is implausible`);
  const down = polar.vmgOptimum(12, "down");
  assert.ok(down.twa > 140, `run angle ${down.twa} deg is implausible`);
});

// --- the leg solver --------------------------------------------------------

test("a beam reach is sailed directly at the mark", () => {
  const s = solveCourse(90, { tws: 12, twd: 0 }, NO_CURRENT, polar);
  assert.equal(s.mode, "direct");
  assert.equal(s.legs.length, 1);
  close(s.legs[0].h, 90, 0.5, "steer the bearing");
  close(s.vmc, polar.speed(90, 12), 1e-6, "VMC is simply boat speed");
});

test("a dead beat produces two symmetric tacks at the VMG angle", () => {
  const s = solveCourse(0, { tws: 12, twd: 0 }, NO_CURRENT, polar);
  assert.equal(s.mode, "beat");
  assert.equal(s.legs.length, 2);
  const up = polar.vmgOptimum(12, "up");
  close(s.vmc, up.vmg, 1e-2, "VMC equals the upwind VMG");
  close(s.legs[0].fraction, 0.5, 1e-6, "equal time on each tack with no current");
  close(Math.abs(s.legs[0].twa), Math.abs(s.legs[1].twa), 0.6, "tacks are symmetric");
  close(Math.abs(s.legs[0].twa), up.twa, 1.0, "tacking at the VMG angle");
  assert.ok(s.legs[0].twa * s.legs[1].twa < 0, "one board each side of the wind");
});

test("tacks are named for the side the wind comes over", () => {
  // Wind from due north. Heading 045 puts it on the port bow; 315 on the starboard bow.
  const beat = solveLeg({ lat: 38, lon: 15 }, { lat: 38.5, lon: 15 }, { tws: 12, twd: 0 }, NO_CURRENT, polar, 4.1);
  assert.equal(beat.mode, "beat");
  const port = beat.legs.find((l) => l.tack === "port");
  const stbd = beat.legs.find((l) => l.tack === "starboard");
  assert.ok(port && stbd, "one board on each tack");
  assert.ok(port.headingTrue > 0 && port.headingTrue < 180, `port tack heads east of the wind, got ${port.headingTrue}`);
  assert.ok(stbd.headingTrue > 180, `starboard tack heads west of the wind, got ${stbd.headingTrue}`);
});

test("a fetchable mark is one heading, not a hair-splitting pair", () => {
  // The exact heading almost never lands on the sampling grid; the solver must
  // resolve that to a single course to steer rather than a spurious two-tack.
  for (const brg of [30.98, 47.3, 91.7, 123.4, 176.2, 271.9]) {
    const s = solveCourse(brg, { tws: 12, twd: brg - 110 }, NO_CURRENT, polar);
    assert.equal(s.mode, "direct", `bearing ${brg} is a reach and should be fetchable`);
    assert.equal(s.legs.length, 1);
    close(s.legs[0].h, brg, 1e-6, "steer the bearing exactly");
  }
});

test("a dead run produces two gybes", () => {
  const s = solveCourse(180, { tws: 12, twd: 0 }, NO_CURRENT, polar);
  assert.equal(s.mode, "run");
  assert.equal(s.legs.length, 2);
  close(s.vmc, polar.vmgOptimum(12, "down").vmg, 1e-2);
  assert.ok(Math.abs(s.legs[0].twa) > 140 && Math.abs(s.legs[1].twa) > 140);
});

test("cross current is crabbed into so the TRACK still lays the mark", () => {
  // Beam reach east, water setting north at 2 kn: must steer south of east.
  const s = solveCourse(90, { tws: 12, twd: 0 }, { drift: 2, set: 0 }, polar);
  assert.equal(s.mode, "direct");
  assert.ok(s.legs[0].h > 90, "heading is offset upstream of the bearing");
  close(s.legs[0].cog, 90, 0.5, "but the resulting course over ground is the bearing");
});

test("a foul current strong enough to sweep you sideways is unreachable", () => {
  const s = solveCourse(0, { tws: 6, twd: 180 }, { drift: 30, set: 90 }, polar);
  assert.equal(s.mode, "unreachable");
  assert.equal(s.legs.length, 0);
});

test("the hull solver agrees with an exhaustive search over heading pairs", () => {
  // The convex-hull LP is the only clever thing in this file, so check it
  // against the obvious O(n^2) version under conditions that force an edge
  // solution (a beat) with an asymmetric current.
  const wind = { tws: 11, twd: 25 };
  const current = { drift: 1.6, set: 300 };
  const bearing = 25;
  const s = solveCourse(bearing, wind, current, polar);

  const ww = windOverWater(wind.twd, wind.tws, current.set, current.drift);
  const cur = vec(current.set, current.drift);
  const u = vec(bearing, 1);
  const p = { e: u.n, n: -u.e };
  const pts = [];
  for (let h = 0; h < 360; h += 0.5) {
    const g = add(vec(h, polar.speed(angDiff(h, ww.twd), ww.tws)), cur);
    pts.push({ a: g.e * u.e + g.n * u.n, c: g.e * p.e + g.n * p.n });
  }
  let brute = -Infinity;
  for (const A of pts) {
    if (Math.abs(A.c) < 1e-9) brute = Math.max(brute, A.a);
    for (const B of pts) {
      if (A.c < 0 && B.c > 0) {
        const f = B.c / (B.c - A.c);
        brute = Math.max(brute, f * A.a + (1 - f) * B.a);
      }
    }
  }
  close(s.vmc, brute, 1e-9, "hull optimum equals brute-force optimum");
});

test("the two-tack time split is what makes the average track lay the mark", () => {
  const bearing = 25;
  const s = solveCourse(bearing, { tws: 11, twd: 25 }, { drift: 1.6, set: 300 }, polar);
  assert.equal(s.legs.length, 2, "asymmetric current on a beat needs two tacks");
  assert.notEqual(s.legs[0].fraction, 0.5, "and an uneven split between them");
  // Average the two ground velocities by their time fractions.
  const avg = s.legs.reduce(
    (acc, l) => add(acc, { e: l.fraction * mag(vec(l.cog, l.sog)) * Math.sin(l.cog * Math.PI / 180),
                           n: l.fraction * mag(vec(l.cog, l.sog)) * Math.cos(l.cog * Math.PI / 180) }),
    { e: 0, n: 0 }
  );
  close(dirOf(avg), bearing, 1e-3, "the averaged track lays the mark");
  close(mag(avg), s.vmc, 1e-3, "and its magnitude is the reported VMC");
});

// --- leg and route reporting -----------------------------------------------

test("solveLeg reports both bearings and a finite ETA", () => {
  const leg = solveLeg(CAPO_ORLANDO, STROMBOLI, { tws: 12, twd: 250 }, NO_CURRENT, polar, 4.1);
  close(leg.distNm, 43.641190, 1e-3);
  close(leg.bearingTrue, 30.980140, 1e-3);
  close(leg.bearingMag, 30.980140 - 4.1, 1e-3);
  assert.equal(leg.mode, "direct", "wind from 250 makes 031 a broad reach");
  assert.ok(leg.hours > 0 && Number.isFinite(leg.hours));
  close(leg.hours, leg.distNm / leg.vmc, 1e-9);
});

test("solveLeg warns when the wind is outside the polar", () => {
  const leg = solveLeg(CAPO_ORLANDO, STROMBOLI, { tws: 34, twd: 250 }, NO_CURRENT, polar, 4.1);
  assert.ok(leg.warnings.some((w) => w.includes("outside the polar")));
});

test("solveRoute accumulates distance, time and clock ETAs in order", () => {
  const t0 = new Date("2026-09-25T10:00:00Z").getTime();
  const pts = [{ ...ALICUDI, name: "Alicudi" }, { ...STROMBOLI, name: "Stromboli" }];
  const r = solveRoute(CAPO_ORLANDO, pts, { tws: 12, twd: 250 }, NO_CURRENT, polar, 4.1, t0);
  assert.equal(r.legs.length, 2);
  close(r.legs[0].cumNm, haversineNm(CAPO_ORLANDO, ALICUDI), 1e-9);
  close(r.totalNm, haversineNm(CAPO_ORLANDO, ALICUDI) + haversineNm(ALICUDI, STROMBOLI), 1e-9);
  assert.ok(r.legs[1].cumHours > r.legs[0].cumHours, "time accumulates");
  assert.ok(r.legs[1].eta > r.legs[0].eta, "ETAs run forward");
  close(r.legs[1].eta.getTime(), t0 + r.totalHours * 3600e3, 1);
});

// --- formatting ------------------------------------------------------------

test("formatters are chartplotter-shaped", () => {
  assert.equal(fmtBearing(7), "007°");
  assert.equal(fmtBearing(-1), "359°");
  assert.equal(fmtDuration(2.5), "2h 30m");
  assert.equal(fmtDuration(0.25), "15m");
  assert.equal(fmtDuration(Infinity), "--");
});
