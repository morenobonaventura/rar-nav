/**
 * Course model: turns the marks in data/course.json into an ordered list of
 * waypoints.
 *
 * The course is a list of MARKS with a required side, not a route. The race
 * rule is "leave Alicudi to starboard", not "pass within 300 m of it" — so what
 * lives in the config is the thing you have to honour, and how you get between
 * consecutive marks is a separate question. Today the answer is a straight line,
 * checked against the coastline; proper routing that goes around the islands
 * comes later.
 *
 * Two kinds of leg:
 *   rounding — an ordered run of marks down one side of an island, each
 *              carrying the side it must be left on
 *   gate     — two buoys facing each other across a strait. The boat passes
 *              between them and rounds neither island.
 *
 * Sailing the course the other way round reverses the order and flips every
 * side. Gates have no side and are unchanged apart from their order. That rule
 * is applied in one place, so the two directions cannot drift apart.
 */

import { haversineNm, initialBearing, destinationPoint, norm360 } from "./nav.js";

const OPPOSITE = { starboard: "port", port: "starboard" };

/** Where a gate is passed: midway between its two buoys. */
export const gateMidpoint = (marks) => ({
  lat: (marks[0].lat + marks[1].lat) / 2,
  lon: (marks[0].lon + marks[1].lon) / 2,
});

/** How wide the gate is, in nautical miles. */
export const gateWidthNm = (marks) => haversineNm(marks[0], marks[1]);

/**
 * The course sailed the other way round: legs in reverse order, marks within
 * each rounding reversed, and every side flipped.
 */
export function reverseCourse(legs) {
  return [...legs].reverse().map((leg) => {
    if (leg.type !== "rounding") return { ...leg };
    return {
      ...leg,
      side: OPPOSITE[leg.side],
      marks: [...leg.marks].reverse().map((m) => ({ ...m, side: OPPOSITE[m.side] })),
    };
  });
}

/**
 * Build the ordered waypoint list for a direction.
 *
 * @param {object} config    parsed data/course.json
 * @param {'clockwise'|'counterclockwise'} direction
 * @returns {Array<{name,lat,lon,kind,legNm,side?,island?,gate?}>}
 */
export function buildCourse(config, direction = "clockwise") {
  if (direction !== "clockwise" && direction !== "counterclockwise")
    throw new Error(`unknown direction ${direction}`);
  const legs = direction === "clockwise"
    ? config.sequence_clockwise
    : reverseCourse(config.sequence_clockwise);
  if (!legs?.length) throw new Error("no course sequence configured");

  const start = { lat: config.start_finish.lat, lon: config.start_finish.lon };
  const waypoints = [{ ...start, name: config.start_finish.name, kind: "start", legNm: 0 }];
  let prev = start;
  const push = (w) => {
    waypoints.push({ ...w, legNm: haversineNm(prev, w) });
    prev = { lat: w.lat, lon: w.lon };
  };

  for (const leg of legs) {
    if (leg.type === "rounding") {
      leg.marks.forEach((m, i) =>
        push({
          lat: m.lat, lon: m.lon, name: m.name,
          kind: "mark", island: leg.island, side: m.side ?? leg.side,
          markIndex: i, markTotal: leg.marks.length,
        })
      );
    } else {
      push({
        ...gateMidpoint(leg.marks),
        name: `${leg.islands[0]}–${leg.islands[1]} gate`,
        kind: "gate",
        islands: leg.islands,
        gate: leg.marks,
      });
    }
  }

  push({ ...start, name: `${config.start_finish.name} (finish)`, kind: "finish" });
  return waypoints;
}

/** Total course distance in nautical miles. */
export const totalDistanceNm = (waypoints) =>
  waypoints.slice(1).reduce((sum, w) => sum + w.legNm, 0);

/**
 * One row per thing you round or pass through, so the leg list reads as
 * "Alicudi (starboard)" rather than eight near-identical marks. The marks
 * themselves stay attached, because they are what you actually sail to.
 */
export function displayLegs(waypoints) {
  const out = [];
  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    if (w.kind !== "mark") {
      out.push({ name: w.name, kind: w.kind, target: w, points: [w], distNm: w.legNm, gate: w.gate });
      continue;
    }
    let j = i + 1;
    while (j < waypoints.length && waypoints[j].kind === "mark" && waypoints[j].island === w.island) j++;
    const group = waypoints.slice(i, j);
    out.push({
      name: `${w.island} (${w.side})`,
      kind: "rounding",
      island: w.island,
      side: w.side,
      target: group[group.length - 1],
      entry: group[0],
      points: group,
      distNm: group.reduce((s, g) => s + g.legNm, 0),
    });
    i = j - 1;
  }
  return out;
}

/**
 * Does a straight track run over land? Sampled along the segment, because the
 * routing here is point to point and knows nothing about what is in the way.
 *
 * Returns what it hits, or null. The sampling step is the honest limit: a rock
 * narrower than the step can slip between samples, so this is a warning, not a
 * clearance certificate.
 */
export function crossesLand(a, b, coast, stepNm = 0.05) {
  const total = haversineNm(a, b);
  if (total === 0) return null;
  const steps = Math.min(800, Math.max(2, Math.ceil(total / stepNm)));
  const brg = initialBearing(a, b);
  for (let i = 1; i < steps; i++) {
    const p = destinationPoint(a, brg, (total * i) / steps);
    const hit = isOnLand(p, coast);
    if (hit) return { at: p, kind: hit, alongNm: (total * i) / steps };
  }
  return null;
}

/**
 * Every leg of the built course that would run over land if sailed straight.
 * With marks placed a few hundred metres off the rocks this should be empty —
 * if it is not, the course needs another mark there, or real routing.
 */
export function courseLandConflicts(waypoints, coast) {
  const out = [];
  for (let i = 1; i < waypoints.length; i++) {
    const hit = crossesLand(waypoints[i - 1], waypoints[i], coast);
    if (hit) out.push({ from: waypoints[i - 1], to: waypoints[i], ...hit });
  }
  return out;
}

/** Ray-casting point-in-polygon, for warning that a mark sits on land. */
export function isOnLand(pt, coastGeoJSON) {
  for (const f of coastGeoJSON.features) {
    const ring = f.geometry.coordinates[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > pt.lat !== yj > pt.lat && pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    if (inside) return f.properties.kind;
  }
  return null;
}

/**
 * How far each mark sits off the nearest land, so the clearance the course was
 * built with can be checked rather than trusted.
 */
export function clearanceM(pt, coast, maxM = 2000) {
  for (let r = 50; r <= maxM; r += 50) {
    for (let b = 0; b < 360; b += 15) {
      if (isOnLand(destinationPoint(pt, b, r / 1852), coast)) return r;
    }
  }
  return maxM;
}
