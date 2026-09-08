/**
 * Navigation maths for RAR Nav.
 *
 * Pure functions only - no DOM, no globals - so `node --test` can exercise
 * every number the app displays.
 *
 * Conventions, stated once because mixing them up is the classic way to get a
 * plausible-looking wrong answer:
 *   - All angles are degrees, 0..360, TRUE, unless a name says otherwise.
 *   - TWD is the direction the wind comes FROM.
 *   - Current SET is the direction the water flows TOWARD, DRIFT its speed.
 *   - Vectors are {e, n} = (east, north) components in knots, pointing the way
 *     the thing actually moves.
 *   - Magnetic variation is east-positive: Magnetic = True - variation.
 */

export const KN_PER_MS = 1.943844;

import { clock } from "./clock.js";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EARTH_NM = 3440.065; // mean earth radius in nautical miles

export const norm360 = (d) => ((d % 360) + 360) % 360;

/** Signed smallest angle from `b` to `a`, in -180..180. */
export function angDiff(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

// --- geodesy ---------------------------------------------------------------

/** Great-circle distance in nautical miles. Points are {lat, lon} in degrees. */
export function haversineNm(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const la1 = a.lat * D2R;
  const la2 = b.lat * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from `a` to `b`, degrees true. */
export function initialBearing(a, b) {
  const la1 = a.lat * D2R;
  const la2 = b.lat * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) -
    Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return norm360(Math.atan2(y, x) * R2D);
}

/** Point reached from `a` on `bearing` after `distNm` along a great circle. */
export function destinationPoint(a, bearing, distNm) {
  const d = distNm / EARTH_NM;
  const br = bearing * D2R;
  const la1 = a.lat * D2R;
  const lo1 = a.lon * D2R;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br)
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2)
    );
  return { lat: la2 * R2D, lon: norm360((lo2 * R2D + 540)) - 180 };
}

export const trueToMagnetic = (deg, variation) => norm360(deg - variation);
export const magneticToTrue = (deg, variation) => norm360(deg + variation);

// --- vectors ---------------------------------------------------------------

/** Vector of magnitude `speed` pointing TOWARD compass direction `dir`. */
export const vec = (dir, speed) => ({
  e: speed * Math.sin(dir * D2R),
  n: speed * Math.cos(dir * D2R),
});
export const mag = (v) => Math.hypot(v.e, v.n);
export const dirOf = (v) => norm360(Math.atan2(v.e, v.n) * R2D);
export const sub = (a, b) => ({ e: a.e - b.e, n: a.n - b.n });
export const add = (a, b) => ({ e: a.e + b.e, n: a.n + b.n });

/**
 * The wind as the BOAT feels it, i.e. referenced to the moving water.
 *
 * Polars are measured against wind-over-water and speed-through-water, but the
 * wind you read off a forecast or observe from shore is over ground. With 2 kn
 * of current in the Vulcano/Lipari strait the difference is ~15 degrees of wind
 * angle, which is the difference between laying a mark and not.
 */
export function windOverWater(twd, tws, set, drift) {
  const windFlow = vec(norm360(twd + 180), tws); // where the air is GOING
  const water = vec(set, drift);
  const rel = sub(windFlow, water);
  return { tws: mag(rel), twd: norm360(dirOf(rel) + 180) };
}

/**
 * Speed made good to windward, from the boat's own track over the ground.
 *
 * The component of the boat's velocity along the wind axis: positive when it
 * is gaining ground toward where the wind comes from, negative when running
 * away from it. This is the number that says whether the last shift was worth
 * taking, and it is the one to compare against `Polar.vmgOptimum` — sailing
 * 0.3 kn under target VMG for ten minutes is a boat length a tack.
 *
 * Deliberately ground-referenced, to match the SOG and COG it is built from
 * and the windward mark it is being sailed toward. It is NOT the through-water
 * VMG a polar is measured at, so in a strong cross-set the two differ; the
 * difference is the tide doing the work, which is exactly what you want to see.
 *
 * Returns null when there is nothing to compute from — a boat sitting still
 * has no course over ground, and a made-up number here would read as fact.
 */
export function vmgToWind(sog, cog, twd) {
  if (sog == null || cog == null || twd == null) return null;
  return sog * Math.cos(angDiff(twd, cog) * D2R);
}

/** Mean of a set of bearings, averaged as unit vectors rather than as numbers. */
export function meanBearing(degrees) {
  let e = 0, n = 0;
  for (const d of degrees) { e += Math.sin(d * D2R); n += Math.cos(d * D2R); }
  return degrees.length ? norm360(Math.atan2(e, n) * R2D) : null;
}

/**
 * Header or lift on the tack you are on, read from COG alone.
 *
 * Tack on headers is the oldest rule in the book, and the only reason this app
 * cannot follow it is that its wind is a number you typed, held constant --
 * so it can never show you a shift. But it does not have to. On a beat the helm
 * holds a roughly constant TWA, which makes COG nothing but the wind direction
 * plus a constant: let the wind veer ten degrees and your course over ground
 * veers ten degrees with it. So the shift is IN the GPS track, and needs no
 * wind input at all.
 *
 * TWD still decides which tack you are on, but only through the sign of the
 * wind angle -- you would have to be some forty degrees out before that flips.
 * The magnitude of the shift never touches it. That is the whole point: this is
 * the one tactical reading in the app that a mistyped wind cannot corrupt.
 *
 * Which way is bad depends on the tack. Let the wind veer right: on port you
 * can point higher and it is a LIFT; on starboard the same shift pushes your
 * bow away from the mark and it is a HEADER. Since positive TWA is port tack,
 *
 *     headed = -sign(twa) x (change in COG)
 *
 * with a positive result meaning headed, and headed means tack.
 *
 * Only samples since the last tack are compared -- a tack is a 90 degree change
 * in COG that has nothing to do with the wind, and averaging across one would
 * report a shift that never happened. The recent window is measured against the
 * rest of that run, and anything smaller than the track's own wander is called
 * steady rather than dressed up as a shift.
 *
 * @returns null when it cannot honestly say, else {tack, shiftDeg, state, ...}
 */
export function shiftFromCog(samples, twd, now = clock.now(), opts = {}) {
  const { recentMs = 60000, minRun = 8, minRecent = 3, minShiftDeg = 4,
          minSogKn = 1.0, maxTwaDeg = 70 } = opts;

  const usable = samples.filter(
    (s) => s.cog != null && !Number.isNaN(s.cog) && (s.sog ?? 0) >= minSogKn
  );
  if (usable.length < minRun) return null;

  const last = usable[usable.length - 1];
  // Close-hauled only. Off the wind COG follows the helm's chosen course, not
  // the breeze, so the same arithmetic would read steering as weather.
  const twaNow = angDiff(last.cog, twd);
  if (Math.abs(twaNow) > maxTwaDeg) return null;

  const tackOf = (s) => (angDiff(s.cog, twd) > 0 ? 1 : -1); // +1 port, -1 starboard
  const sign = tackOf(last);
  let i = usable.length - 1;
  while (i > 0 && tackOf(usable[i - 1]) === sign) i--;
  const run = usable.slice(i);
  if (run.length < minRun) return null; // still settling after a tack

  const recent = run.filter((s) => now - s.t <= recentMs);
  const base = run.slice(0, run.length - recent.length);
  if (recent.length < minRecent || base.length < minRecent) return null;

  const shiftDeg = -sign * angDiff(meanBearing(recent.map((s) => s.cog)),
                                  meanBearing(base.map((s) => s.cog)));

  // The boat's own wander sets the floor: steering and sea state move COG about
  // regardless of the wind, and calling that a shift would have you tacking on
  // waves.
  const mean = meanBearing(run.map((s) => s.cog));
  const wander = Math.sqrt(
    run.reduce((a, s) => a + angDiff(s.cog, mean) ** 2, 0) / run.length
  );
  const floor = Math.max(minShiftDeg, wander * 0.75);

  return {
    tack: sign > 0 ? "port" : "starboard",
    shiftDeg,
    state: Math.abs(shiftDeg) < floor ? "steady" : shiftDeg > 0 ? "headed" : "lifted",
    wander,
    sinceMs: now - run[0].t,
    n: run.length,
  };
}

// --- polar -----------------------------------------------------------------

export class Polar {
  /**
   * @param {number[]} twsGrid  ascending true wind speeds, knots
   * @param {number[]} twaGrid  ascending true wind angles, 0..180 degrees
   * @param {number[][]} table  table[iTws][iTwa] = boat speed through water, knots
   */
  constructor(twsGrid, twaGrid, table) {
    if (table.length !== twsGrid.length)
      throw new Error("polar table rows must match twsGrid");
    if (table.some((r) => r.length !== twaGrid.length))
      throw new Error("polar table columns must match twaGrid");
    this.twsGrid = twsGrid;
    this.twaGrid = twaGrid;
    this.table = table;
  }

  static fromJSON(o) {
    return new Polar(o.tws, o.twa, o.speeds);
  }

  toJSON() {
    return { tws: this.twsGrid, twa: this.twaGrid, speeds: this.table };
  }

  /** Boat speed through water. TWA is folded to 0..180; both axes clamp at the edges. */
  speed(twa, tws) {
    const a = Math.abs(angDiff(twa, 0)); // fold 0..180, port/starboard symmetric
    const [i, fi] = bracket(this.twsGrid, tws);
    const [j, fj] = bracket(this.twaGrid, a);
    const t = this.table;
    const s =
      t[i][j] * (1 - fi) * (1 - fj) +
      t[i + 1][j] * fi * (1 - fj) +
      t[i][j + 1] * (1 - fi) * fj +
      t[i + 1][j + 1] * fi * fj;
    return Math.max(0, s);
  }

  /**
   * Best velocity made good straight up- or downwind, by scanning TWA.
   * @param {'up'|'down'} which
   */
  vmgOptimum(tws, which) {
    let best = { twa: which === "up" ? 45 : 180, vmg: -Infinity, speed: 0 };
    for (let a = 0; a <= 180; a += 0.5) {
      const s = this.speed(a, tws);
      const vmg = which === "up" ? s * Math.cos(a * D2R) : -s * Math.cos(a * D2R);
      if (vmg > best.vmg) best = { twa: a, vmg, speed: s };
    }
    return best;
  }
}

/** Index `i` and fraction `f` such that value sits between grid[i] and grid[i+1]. */
function bracket(grid, value) {
  const n = grid.length;
  if (value <= grid[0]) return [0, 0];
  if (value >= grid[n - 1]) return [n - 2, 1];
  let i = 0;
  while (i < n - 2 && grid[i + 1] < value) i++;
  return [i, (value - grid[i]) / (grid[i + 1] - grid[i])];
}

// --- the leg solver --------------------------------------------------------

/**
 * Fastest way to make good a given bearing, given wind, current and a polar.
 *
 * This is a linear program, not a search. Plot the boat's achievable
 * over-ground velocity for every heading as points (cross-track, along-track)
 * relative to the desired bearing; the fastest way to make good that bearing is
 * the highest point of that set on the line cross-track = 0. Because any mix of
 * two headings is reachable by splitting your time between them, the feasible
 * set is the CONVEX HULL of those points - so the answer is either
 *
 *   a hull VERTEX  -> one heading lays the mark: fetching, sail it
 *   a hull EDGE    -> two headings either side: that is a beat or a run, and
 *                     the time split is where the edge crosses zero cross-track
 *
 * which is exactly the tactical distinction, falling out of the geometry rather
 * than being hard-coded. Handles current in both cases without special-casing:
 * a foul tide simply shifts every point and can tilt the answer onto an edge.
 */
export function solveCourse(bearing, wind, current, polar) {
  const ww = windOverWater(wind.twd, wind.tws, current.set, current.drift);
  const cur = vec(current.set, current.drift);
  const u = vec(bearing, 1); // along-track unit vector
  const p = { e: u.n, n: -u.e }; // cross-track unit vector, +ve to starboard

  /** Everything about sailing heading `h`, resolved onto the desired bearing. */
  const evalHeading = (h) => {
    const bs = polar.speed(angDiff(h, ww.twd), ww.tws);
    const g = add(vec(h, bs), cur); // velocity over ground
    return {
      h: norm360(h),
      bs,
      twa: angDiff(h, ww.twd),
      a: g.e * u.e + g.n * u.n, // along-track (this is the VMC)
      c: g.e * p.e + g.n * p.n, // cross-track
      sog: mag(g),
      cog: dirOf(g),
    };
  };

  const pts = [];
  for (let h = 0; h < 360; h += HEADING_STEP) pts.push(evalHeading(h));

  const best = maxAlongTrackAtZeroCross(pts, evalHeading);
  return { ...best, windOverWater: ww };
}

const HEADING_STEP = 0.5;
/**
 * Two headings closer together than this are the sampling grid straddling one
 * exact heading, not a tactical choice. A real beat or run puts its two
 * headings tens of degrees apart.
 */
const SINGLE_HEADING_DEG = 3;

/**
 * Maximise along-track speed subject to zero net cross-track, over the convex
 * hull of `pts`. Returns the winning vertex, or the pair of vertices and the
 * time split when the optimum lies on an edge.
 */
function maxAlongTrackAtZeroCross(pts, evalHeading) {
  // Upper convex hull in (cross, along): monotone chain, keeping max `a`.
  const sorted = [...pts].sort((x, y) => x.c - y.c || y.a - x.a);
  const hull = [];
  for (const q of sorted) {
    while (hull.length >= 2) {
      const [o, t] = [hull[hull.length - 2], hull[hull.length - 1]];
      // drop `t` if it is not strictly above the line o->q (right turn required)
      if ((t.c - o.c) * (q.a - o.a) - (t.a - o.a) * (q.c - o.c) >= 0) hull.pop();
      else break;
    }
    hull.push(q);
  }

  if (hull.length === 0 || hull[0].c > 0 || hull[hull.length - 1].c < 0) {
    // Every achievable heading is swept to the same side: the mark cannot be
    // laid on any combination of headings.
    return { mode: "unreachable", vmc: 0, legs: [] };
  }

  // Walk the hull for the segment spanning c = 0.
  for (let i = 0; i < hull.length - 1; i++) {
    const A = hull[i];
    const B = hull[i + 1];
    if (A.c <= 0 && B.c >= 0) {
      if (Math.abs(A.c) < 1e-9) return single(A);
      if (Math.abs(B.c) < 1e-9) return single(B);

      // The hull edge between two ADJACENT samples just means the exact
      // heading falls between them - the mark is fetchable on one heading, so
      // find it rather than reporting a spurious two-tack answer.
      if (Math.abs(angDiff(B.h, A.h)) <= SINGLE_HEADING_DEG)
        return single(refineToZeroCross(A, B, evalHeading));

      const f = B.c / (B.c - A.c); // fraction of time on A
      const vmc = f * A.a + (1 - f) * B.a;
      if (vmc <= 0) return { mode: "unreachable", vmc, legs: [] };

      // A genuine two-board solution. It is a beat or a run only when the
      // boards are on OPPOSITE tacks, because that is what tacking and gybing
      // mean — you cross the wind between them. Two boards on the SAME tack
      // means the polar has a dent and the fastest thing is to alternate either
      // side of it without ever crossing the wind; calling that a run because
      // the angles happen to average past 90 would be a lie at three in the
      // morning. A measured polar is convex and this does not arise, but the
      // polar is editable, so the label must follow the geometry.
      const crossesTheWind = A.twa * B.twa < 0;
      const deep = (Math.abs(A.twa) + Math.abs(B.twa)) / 2 > 90;
      return {
        mode: crossesTheWind ? (deep ? "run" : "beat") : "twoangles",
        vmc,
        legs: [
          { ...A, fraction: f },
          { ...B, fraction: 1 - f },
        ],
      };
    }
  }
  return { mode: "unreachable", vmc: 0, legs: [] };
}

function single(v) {
  if (v.a <= 0) return { mode: "unreachable", vmc: v.a, legs: [] };
  return { mode: "direct", vmc: v.a, legs: [{ ...v, fraction: 1 }] };
}

/** Bisect between two neighbouring headings for the one with zero cross-track. */
function refineToZeroCross(A, B, evalHeading) {
  let lo = A.h;
  let hi = A.h + angDiff(B.h, A.h); // unwrapped, so bisection can't jump the 360 seam
  let loC = A.c;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const v = evalHeading(mid);
    if (v.c === 0) return v;
    if (v.c > 0 === loC > 0) {
      lo = mid;
      loC = v.c;
    } else {
      hi = mid;
    }
  }
  return evalHeading((lo + hi) / 2);
}

/**
 * Everything the display needs for one leg from `from` to `to`.
 *
 * @param {{lat,lon}} from
 * @param {{lat,lon}} to
 * @param {{tws:number, twd:number}} wind      over ground, TWD = direction FROM
 * @param {{drift:number, set:number}} current SET = direction flowing TOWARD
 * @param {Polar} polar
 * @param {number} variation                   east-positive magnetic variation
 */
export function solveLeg(from, to, wind, current, polar, variation) {
  const distNm = haversineNm(from, to);
  const brg = initialBearing(from, to);
  const sol = solveCourse(brg, wind, current, polar);

  const warnings = [];
  if (sol.mode === "unreachable")
    warnings.push("Cannot lay this mark: the current sets you back faster than you can sail.");
  if (wind.tws < polar.twsGrid[0] || wind.tws > polar.twsGrid[polar.twsGrid.length - 1])
    warnings.push(`Wind ${wind.tws.toFixed(0)} kn is outside the polar (${polar.twsGrid[0]}-${polar.twsGrid[polar.twsGrid.length - 1]} kn); edge values used.`);

  const hours = sol.vmc > 0 ? distNm / sol.vmc : Infinity;
  return {
    distNm,
    bearingTrue: brg,
    bearingMag: trueToMagnetic(brg, variation),
    mode: sol.mode,
    vmc: sol.vmc,
    hours,
    windOverWater: sol.windOverWater,
    legs: sol.legs.map((l) => ({
      headingTrue: norm360(l.h),
      headingMag: trueToMagnetic(l.h, variation),
      twa: l.twa,
      boatSpeed: l.bs,
      sog: l.sog,
      cogTrue: l.cog,
      fraction: l.fraction,
      // TWA is heading minus wind-from. Steering right of the wind's origin
      // (positive TWA) puts the breeze on the port bow: port tack.
      tack: l.twa > 0 ? "port" : "starboard",
    })),
    warnings,
  };
}

/**
 * Speed made good on every bearing, as a lookup table.
 *
 * For a fixed wind, tide and polar, VMC depends on nothing but the bearing — so
 * a router comparing thousands of legs should solve the hull once per bearing
 * rather than once per leg. Building this costs about as much as 360 legs and
 * then makes every one of them a lookup.
 *
 * @returns {(bearing:number) => number} knots made good, interpolated
 */
export function vmcTable(wind, current, polar, step = 1) {
  const n = Math.round(360 / step);
  const table = new Float64Array(n);
  for (let i = 0; i < n; i++) table[i] = Math.max(0, solveCourse(i * step, wind, current, polar).vmc);
  return (bearing) => {
    const x = (norm360(bearing) / step) % n;
    const i = Math.floor(x);
    const f = x - i;
    return table[i] * (1 - f) + table[(i + 1) % n] * f;
  };
}

/**
 * The track to actually sail, as points to draw on a chart.
 *
 * A fetch is a straight line. A beat, a run, or two angles is sailed in two
 * boards, and the solver already knows their headings and how the time divides
 * between them — so the shortest way to sail it is ONE tack, at the corner
 * where the two laylines meet.
 *
 * Either board can be sailed first. Both corners land on the mark and both take
 * exactly the same time, so both are returned: that pair of tracks is the
 * classic tacking cone, and which side to take is a tactical call (shifts,
 * tide, traffic, the next mark) that this app does not have the information to
 * make for you.
 *
 * Sailing more than one tack costs nothing in these uniform conditions — the
 * same two headings for the same total time in any order arrive together — so
 * the single tack is drawn as the representative case, not as an instruction to
 * tack exactly once.
 *
 * Point to point only: it takes no account of what is in the way. Check the
 * `crossesLand` flag the caller adds, and use your eyes.
 */
export function tackPath(from, to, leg, currentCog = null) {
  if (leg.mode === "unreachable" || !leg.legs.length) return [];
  if (leg.legs.length === 1) {
    return [{ points: [from, to], boards: leg.legs, tackAfterNm: null, tackAfterHours: null }];
  }
  const paths = [0, 1].map((i) => {
    const first = leg.legs[i];
    const second = leg.legs[1 - i];
    const hours = first.fraction * leg.hours;
    const runNm = first.sog * hours;
    // Sail the first board over the ground, then run the second leg straight to
    // the mark: composing two great circles would land a few metres off and a
    // track that visibly misses the mark reads as a bug.
    const corner = destinationPoint(from, first.cogTrue, runNm);
    return {
      points: [from, corner, to],
      corner,
      boards: [first, second],
      tackAfterNm: runNm,
      tackAfterHours: hours,
    };
  });

  // Order them so one is clearly the recommendation and the other the
  // alternative. If the boat is already sailing, stay on the board it is
  // nearest to — do not tack now when you do not have to. Otherwise lead with
  // the longer first board, which keeps your options open for longer.
  const score = (p) =>
    currentCog == null
      ? p.tackAfterNm
      : 180 - Math.abs(angDiff(p.boards[0].cogTrue, currentCog));
  return score(paths[1]) > score(paths[0]) ? [paths[1], paths[0]] : paths;
}

/**
 * Chain legs from `start` through `points`, accumulating distance and clock ETA.
 * Conditions are held constant: this is a "what I see right now" instrument, not
 * a forecast router.
 */
export function solveRoute(start, points, wind, current, polar, variation, now = clock.now()) {
  let from = start;
  let cumNm = 0;
  let cumHours = 0;
  const legs = [];
  for (const pt of points) {
    const leg = solveLeg(from, pt, wind, current, polar, variation);
    cumNm += leg.distNm;
    cumHours += leg.hours;
    legs.push({
      ...leg,
      to: pt,
      name: pt.name,
      cumNm,
      cumHours,
      eta: Number.isFinite(cumHours) ? new Date(now + cumHours * 3600e3) : null,
    });
    from = pt;
  }
  return { legs, totalNm: cumNm, totalHours: cumHours };
}

// --- formatting ------------------------------------------------------------

export function fmtDuration(hours) {
  if (!Number.isFinite(hours)) return "--";
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export const fmtBearing = (deg) => `${String(Math.round(norm360(deg))).padStart(3, "0")}°`;

export function fmtDistance(nm) {
  if (nm < 1) return `${Math.round(nm * 1852)} m`;
  return `${nm.toFixed(nm < 10 ? 2 : 1)} nm`;
}

export const fmtClock = (d) =>
  d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "--:--";
