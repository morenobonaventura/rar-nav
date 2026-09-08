/**
 * Fly a boat around, and write down what its GPS would have said.
 *
 * Step 2 of SIMULATION.md. The point is not to produce a pretty track: it is to
 * produce a GPS stream realistic enough that the instrument cannot tell it from
 * a boat, so the things only motion exercises -- a tack, a shift, a dropout, an
 * approach -- can be exercised at a desk in September rather than once, at sea,
 * with no second attempt.
 *
 * There is no second boat model here. `solveCourse` already knows what the hull
 * does in a given wind and tide, and `Polar.vmgOptimum` already knows the angle
 * to beat at; this file only adds what the router deliberately has no model of,
 * which is everything that makes a real track messy:
 *
 *   - a helm, who wanders, and whose wander is CORRELATED -- a person drifts
 *     off course and comes back, they do not jitter. That distinction is the
 *     whole test of the shift detector's noise floor: white noise averages
 *     away in a minute and would never trigger it, while a slow wander looks
 *     exactly like a shift and must still be rejected.
 *   - a sea, which modulates speed at wave period.
 *   - a wind that MOVES, which the app itself has no way to represent.
 *
 * That last one is the reason this exists. The app's wind is a number you typed
 * and it holds constant, so it can never show you a shift. The generator's wind
 * is the real one. Feeding a track made under a moving wind to an app that
 * believes in a fixed one is not a flaw in the harness -- it is the exact
 * condition `shiftFromCog` was built for, and the only way to check its central
 * claim: that the typed wind can be wrong and the verdict still right.
 *
 * Usage:
 *   node tools/make_track.js                    # list the scenarios
 *   node tools/make_track.js beat-oscillating   # write one, for js/sim.js
 *   node tools/make_track.js --all
 *
 * Tests do not read those files. They call `makeTrack()` directly, because a
 * fixture on disk is a fixture that goes stale the first time the boat model
 * improves, and then the tests are asserting about a boat that no longer exists.
 * The files are for the browser player, which cannot run this.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  Polar, solveCourse, windOverWater, destinationPoint, initialBearing,
  haversineNm, norm360, angDiff, vec, add, mag, dirOf,
} from "../js/nav.js";
import { SCENARIOS } from "./scenarios.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const polar = () =>
  Polar.fromJSON(JSON.parse(readFileSync(join(ROOT, "data/polar_dufour40.json"), "utf8")));

// --- randomness, on a leash -------------------------------------------------

/**
 * A seeded PRNG, because a bug found in simulation is worth nothing if it
 * cannot be replayed. Mulberry32: small, fast, good enough for noise.
 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so the wander is normal rather than a flat rattle. */
function gauss(rand) {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Correlated noise: an AR(1) walk, not white noise.
 *
 * `rho` is how much of the last error survives into the next step. At 0 this is
 * white noise, which a one-minute mean flattens to nothing; at 0.9 the helm
 * drifts a few degrees off and takes half a minute to notice, which is what a
 * person actually does -- and what the detector has to tell apart from weather.
 */
function wanderer(rand, sigma, rho) {
  let x = 0;
  return () => {
    x = rho * x + Math.sqrt(1 - rho * rho) * sigma * gauss(rand);
    return x;
  };
}

// --- the boat ---------------------------------------------------------------

/**
 * @param {object} scn a scenario from tools/scenarios.js
 * @returns {{meta: object, samples: Array<{t,lat,lon,sog,cog,accuracy}>}}
 */
export function makeTrack(scn, p = polar()) {
  const {
    seed = 1, startAt = 1_700_000_000_000, start, target = null, heading: fixedHeading = null,
    wind, current = { set: 0, drift: 0 }, tacks = [], startTack = "starboard",
    durationSec, stepSec = 5, wander = { sigmaDeg: 0, rho: 0.9 },
    sea = { sigmaKn: 0, periodSec: 7 }, mode = "beat",
  } = scn;

  const rand = rng(seed);
  const wobble = wanderer(rand, wander.sigmaDeg, wander.rho);
  const seaPhase = rand() * Math.PI * 2;

  let pos = { ...start };
  let tack = startTack === "port" ? 1 : -1; // matches nav.js: +TWA is port
  let nextTack = 0;
  const samples = [];

  for (let t = 0; t <= durationSec; t += stepSec) {
    while (nextTack < tacks.length && t >= tacks[nextTack]) { tack = -tack; nextTack++; }

    const truth = wind(t);
    const ww = windOverWater(truth.twd, truth.tws, current.set, current.drift);

    // Where the helm is trying to point. Beating, that is the polar's own best
    // angle to the TRUE wind on the tack we are on -- so when the wind moves,
    // the heading moves with it, and the shift ends up in the GPS track. That
    // is the entire mechanism the detector reads.
    let want;
    if (mode === "beat") {
      want = norm360(truth.twd + tack * p.vmgOptimum(ww.tws, "up").twa);
    } else if (target) {
      want = initialBearing(pos, target);
    } else {
      want = fixedHeading;
    }

    const heading = norm360(want + wobble());
    const twa = angDiff(heading, ww.twd);
    const seaFactor = 1 + sea.sigmaKn * Math.sin((2 * Math.PI * t) / sea.periodSec + seaPhase);
    const bs = Math.max(0, p.speed(twa, ww.tws) * seaFactor);

    const ground = add(vec(heading, bs), vec(current.set, current.drift));
    const sog = mag(ground);
    const cog = dirOf(ground);

    samples.push({
      t: startAt + t * 1000,
      lat: pos.lat, lon: pos.lon,
      sog, cog, accuracy: 8,
      // Kept for assertions, never fed to the app -- the boat knows these and
      // the instrument does not, which is the point of testing against them.
      truth: { twd: truth.twd, tws: truth.tws, heading, twa, tack: tack > 0 ? "port" : "starboard" },
    });

    pos = destinationPoint(pos, cog, (sog * stepSec) / 3600);
  }

  return {
    meta: {
      name: scn.name, seed, startAt, stepSec, durationSec, mode,
      note: "Simulated. Not a real GPS track.",
    },
    samples,
  };
}

/**
 * Everything an iPhone does on a boat that a clean track does not.
 *
 * Step 4 of SIMULATION.md. Each of these has a code path in the app that has
 * been reasoned about and never once run, which is the same as saying it has
 * never been tested -- and the day it first runs is the day the app is 30 miles
 * offshore with no way to reload it.
 *
 * Applied as a pass over a finished track rather than inside the boat model,
 * because none of them are things the BOAT does. The boat sails on; it is the
 * phone that loses the fix, the chip that stops reporting heading, and the
 * receiver that decides it is now accurate to 60 metres.
 *
 * @param {object} track from makeTrack
 * @param {Array<{kind, fromSec, toSec, ...}>} faults
 */
export function applyFaults(track, faults = []) {
  if (!faults.length) return track;
  const t0 = track.samples[0].t;
  const within = (s, f) => {
    const at = (s.t - t0) / 1000;
    return at >= f.fromSec && at <= (f.toSec ?? f.fromSec);
  };

  let samples = track.samples.map((s) => ({ ...s }));
  for (const f of faults) {
    switch (f.kind) {
      // The app was backgrounded, or the screen locked. iOS suspends a web app
      // outright, so these samples were never taken -- the gap is real, and the
      // charts must draw it as a gap rather than a smooth line across a hole.
      case "dropout":
        samples = samples.filter((s) => !within(s, f));
        break;

      // The GPS chip's doppler solution goes null when it feels like it. The
      // app is supposed to fall back to differencing successive fixes.
      case "nullSpeed":
        samples.forEach((s) => { if (within(s, f)) s.sog = null; });
        break;
      case "nullHeading":
        samples.forEach((s) => { if (within(s, f)) s.cog = null; });
        break;

      // A poor fix is still a fix, and the rail is supposed to say so.
      case "accuracy":
        samples.forEach((s) => { if (within(s, f)) s.accuracy = f.metres ?? 60; });
        break;

      // A multipath spike off a cliff. Nothing in the app filters these yet;
      // this exists so that stays a known gap rather than a surprise.
      case "jump":
        samples.forEach((s) => {
          if (!within(s, f)) return;
          const nm = (f.metres ?? 200) / 1852;
          s.lat += nm / 60;
          s.lon += nm / 60 / Math.cos((s.lat * Math.PI) / 180);
        });
        break;

      // Parked in a hole, or hove to. Below a knot the heading is meaningless
      // and the app is supposed to hold the last good one rather than swing.
      //
      // The boat has to actually STOP, not merely report a low speed. The first
      // version only zeroed the speed field and left the positions marching on
      // at six knots, so the app's differencing fallback dutifully derived a
      // heading from them and the test failed -- correctly. Everything after
      // the window is shifted by the ground the boat did not cover, so it
      // resumes from where it really is instead of teleporting.
      case "becalmed": {
        const held = samples.find((s) => within(s, f));
        if (!held) break;
        let last = held;
        for (const s of samples) {
          if (within(s, f)) { s.sog = 0.2; last = { lat: s.lat, lon: s.lon }; s.lat = held.lat; s.lon = held.lon; }
        }
        const dLat = last.lat - held.lat, dLon = last.lon - held.lon;
        let past = false;
        for (const s of samples) {
          if (within(s, f)) { past = true; continue; }
          if (past) { s.lat -= dLat; s.lon -= dLon; }
        }
        break;
      }

      default:
        throw new Error(`unknown fault: ${f.kind}`);
    }
  }
  return { ...track, meta: { ...track.meta, faults }, samples };
}

/** Distance made good from first sample to last, for sanity in tests. */
export const trackDistanceNm = (track) =>
  haversineNm(track.samples[0], track.samples[track.samples.length - 1]);

// --- CLI --------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("make_track.js")) {
  const args = process.argv.slice(2);
  const names = args.includes("--all") ? Object.keys(SCENARIOS) : args.filter((a) => !a.startsWith("--"));

  if (!names.length) {
    console.log("Scenarios:\n" + Object.entries(SCENARIOS)
      .map(([k, v]) => `  ${k.padEnd(22)} ${v.what}`).join("\n"));
    process.exit(0);
  }

  const out = join(ROOT, "data/tracks");
  mkdirSync(out, { recursive: true });
  const p = polar();

  // An index, so sim/index.html lists what actually exists rather than a
  // hardcoded copy that rots the first time a scenario is added.
  if (args.includes("--all")) {
    writeFileSync(join(out, "index.json"), JSON.stringify(
      Object.entries(SCENARIOS).map(([name, v]) => ({ name, what: v.what, proves: v.proves })),
      null, 1));
  }

  for (const name of names) {
    const scn = SCENARIOS[name];
    if (!scn) { console.error(`no such scenario: ${name}`); process.exit(1); }
    const track = applyFaults(makeTrack(scn, p), scn.faults);
    // The player does not need the boat's private truth, and shipping it would
    // invite someone to read the answer off the track instead of the screen.
    const slim = { ...track, samples: track.samples.map(({ truth, ...s }) => s) };
    const file = join(out, `${name}.json`);
    writeFileSync(file, JSON.stringify(slim));
    console.log(`${name}: ${track.samples.length} samples, ` +
      `${trackDistanceNm(track).toFixed(1)} nm -> ${file.replace(ROOT + "/", "")}`);
  }
}
