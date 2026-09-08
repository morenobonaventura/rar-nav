/**
 * Routing around the islands.
 *
 * Why a visibility graph rather than an isochrone search: the time to sail a
 * displacement d is |d| / VMC(direction of d), and VMC is read off the convex
 * hull of the boat's achievable ground velocities (see solveCourse). That makes
 * sailing time a convex gauge — a positively homogeneous convex function of the
 * displacement. Two consequences follow, and together they decide the algorithm:
 *
 *   1. In open water the fastest path between two points is the straight line,
 *      tacked as necessary. solveLeg already solves that exactly.
 *   2. With polygonal obstacles, the fastest path is a polyline that bends ONLY
 *      at obstacle corners.
 *
 * So the whole problem reduces to: build a graph of the start, the destination
 * and the corners of whatever land is in the way; join every pair that can see
 * each other; weight each edge with the tacking time from solveLeg; run
 * Dijkstra. That is exact for the model, up to how finely the coastline is
 * modelled — no time step, no heading grid, no pruning heuristics to tune.
 *
 * It assumes wind and tide are uniform and unchanging, which is this app's model
 * everywhere. A real weather router cannot make that assumption and has to use
 * isochrones; here it would be throwing away an exact answer for an approximate
 * one.
 */

import { haversineNm, initialBearing, solveLeg, vmcTable } from "./nav.js";

// --- obstacle preparation --------------------------------------------------

/**
 * Turn the coastline into routing obstacles: simplified, and grown by the
 * distance you want to keep off the rocks.
 *
 * Simplifying to ~150 m is deliberate. The coastline is stored at 15 m, which is
 * right for drawing but would put thousands of nodes in the graph for detail
 * that a 300 m safety margin swallows anyway.
 */
export function buildObstacles(coast, clearanceM = 300, simplifyM = 150) {
  return coast.features
    .map((f) => {
      const ring = f.geometry.coordinates[0].map(([lon, lat]) => ({ lat, lon }));
      // Two resolutions, for two different jobs. The coarse one, grown outward,
      // only has to put candidate corners roughly in the right places -- being
      // approximate there costs nothing, because every edge is then checked
      // exactly. The fine one is what that exact check measures against.
      const coarse = simplify(ring, simplifyM);
      const fine = simplify(ring, Math.min(simplifyM, 50));
      if (coarse.length < 3 || fine.length < 3) return null;
      return {
        ring: grow(coarse, clearanceM),        // candidate corners
        raw: fine,                             // the coast, for measuring against
        bbox: bboxOf(fine),
        kind: f.properties.kind,
        area: f.properties.area_km2,
      };
    })
    .filter(Boolean);
}

/** Douglas–Peucker, in metres, on a closed ring. */
function simplify(pts, tolM) {
  if (pts.length < 4) return pts;
  const lat0 = pts[0].lat;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  const xy = pts.map((p) => [p.lon * kx, p.lat * ky]);
  const keep = new Array(xy.length).fill(false);
  keep[0] = keep[xy.length - 1] = true;
  const stack = [[0, xy.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const norm = Math.hypot(dx, dy);
    let best = -1;
    let bi = -1;
    for (let k = a + 1; k < b; k++) {
      const [px, py] = xy[k];
      const d = norm === 0
        ? Math.hypot(px - ax, py - ay)
        : Math.abs(dy * px - dx * py + bx * ay - by * ax) / norm;
      if (d > best) { best = d; bi = k; }
    }
    if (best > tolM) { keep[bi] = true; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Push every corner of a land ring outward along its bisector, so the obstacle
 * includes the water you want to stay out of.
 *
 * The extension is capped: at a needle-sharp corner the exact bisector offset
 * runs away to infinity, and a spike reaching miles out to sea would block
 * water that is perfectly safe.
 */
function grow(ring, clearanceM) {
  const n = ring.length;
  const lat0 = ring[0].lat;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  const closed = ring[0].lat === ring[n - 1].lat && ring[0].lon === ring[n - 1].lon;
  const pts = closed ? ring.slice(0, -1) : ring;
  const m = pts.length;
  const area = signedArea(pts, kx, ky);
  const wind = area > 0 ? 1 : -1; // outward normal depends on winding

  const out = pts.map((p, i) => {
    const prev = pts[(i - 1 + m) % m];
    const next = pts[(i + 1) % m];
    const n1 = normal(prev, p, kx, ky, wind);
    const n2 = normal(p, next, kx, ky, wind);
    let nx = n1.x + n2.x;
    let ny = n1.y + n2.y;
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) return { ...p };
    nx /= len; ny /= len;
    // 1/cos(half-angle) is the exact bisector scaling; cap it at 3.
    const scale = Math.min(3, 1 / Math.max(0.34, (n1.x * nx + n1.y * ny)));
    const d = clearanceM * scale;
    return { lat: p.lat + (ny * d) / ky, lon: p.lon + (nx * d) / kx };
  });
  out.push({ ...out[0] });
  return out;
}

function normal(a, b, kx, ky, wind) {
  const dx = (b.lon - a.lon) * kx;
  const dy = (b.lat - a.lat) * ky;
  const len = Math.hypot(dx, dy) || 1;
  return { x: (wind * dy) / len, y: (-wind * dx) / len };
}

function signedArea(pts, kx, ky) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.lon * kx * (q.lat * ky) - q.lon * kx * (p.lat * ky);
  }
  return a / 2;
}

const bboxOf = (ring) => ({
  latMin: Math.min(...ring.map((p) => p.lat)),
  latMax: Math.max(...ring.map((p) => p.lat)),
  lonMin: Math.min(...ring.map((p) => p.lon)),
  lonMax: Math.max(...ring.map((p) => p.lon)),
});

// --- geometry --------------------------------------------------------------

const orient = (a, b, c) =>
  (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);

/** Do segments ab and cd properly cross? Touching at an endpoint does not count. */
function segmentsCross(a, b, c, d) {
  const d1 = orient(a, b, c);
  const d2 = orient(a, b, d);
  const d3 = orient(c, d, a);
  const d4 = orient(c, d, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > p.lat !== b.lat > p.lat &&
        p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon)
      inside = !inside;
  }
  return inside;
}

/** Squared distance between two segments, in metres, near this latitude. */
function segDistM(a, b, c, d, kx, ky) {
  const ax = a.lon * kx, ay = a.lat * ky;
  const bx = b.lon * kx, by = b.lat * ky;
  const cx = c.lon * kx, cy = c.lat * ky;
  const dx2 = d.lon * kx, dy2 = d.lat * ky;
  const ux = bx - ax, uy = by - ay;
  const vx = dx2 - cx, vy = dy2 - cy;
  const wx = ax - cx, wy = ay - cy;
  const A = ux * ux + uy * uy, B = ux * vx + uy * vy, C = vx * vx + vy * vy;
  const D = ux * wx + uy * wy, E = vx * wx + vy * wy;
  const den = A * C - B * B;
  let s, t;
  if (den < 1e-9) { s = 0; t = C > 1e-9 ? E / C : 0; }
  else { s = (B * E - C * D) / den; t = (A * E - B * D) / den; }
  s = Math.min(1, Math.max(0, s));
  t = Math.min(1, Math.max(0, t));
  // One clamp can invalidate the other, so re-solve each against the clamped one.
  const s2 = Math.min(1, Math.max(0, (B * t - D) / (A || 1)));
  const t2 = Math.min(1, Math.max(0, (B * s2 + E) / (C || 1)));
  const px = ax + ux * s2, py = ay + uy * s2;
  const qx = cx + vx * t2, qy = cy + vy * t2;
  return Math.hypot(px - qx, py - qy);
}

/**
 * Can a and b see each other, keeping `clearance` metres off the land?
 *
 * Measured as the true distance from the segment to every stretch of coast,
 * rather than by crossing a pre-grown polygon. Offsetting a polygon outward is
 * only well behaved at convex corners: at a reflex one — any bay — the offset
 * spikes and can self-intersect, leaving gaps that a route slips straight
 * through. Measuring the distance has no such failure mode, and it is what
 * "keep 300 m off" actually means.
 *
 * A boat already inside the margin is exempted for that stretch of coast: it
 * starts in Capo d'Orlando harbour, and a router that refuses to move it is
 * useless. It still may not cross the coast itself.
 */
export function visible(a, b, obstacles, clearanceM = 300) {
  const ky = 111320;
  const kx = 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const pad = (clearanceM * 1.2) / ky;
  const latMin = Math.min(a.lat, b.lat) - pad;
  const latMax = Math.max(a.lat, b.lat) + pad;
  const lonMin = Math.min(a.lon, b.lon) - pad * 1.3;
  const lonMax = Math.max(a.lon, b.lon) + pad * 1.3;

  for (const o of obstacles) {
    if (o.bbox.latMin > latMax || o.bbox.latMax < latMin ||
        o.bbox.lonMin > lonMax || o.bbox.lonMax < lonMin) continue;
    const r = o.raw;
    // Exempt only the coast the boat is already too close to, never all of it.
    const near = (p) => {
      for (let i = 0; i < r.length - 1; i++)
        if (segDistM(p, p, r[i], r[i + 1], kx, ky) < clearanceM) return true;
      return false;
    };
    const want = near(a) || near(b) ? 0 : clearanceM;
    for (let i = 0; i < r.length - 1; i++) {
      if (segDistM(a, b, r[i], r[i + 1], kx, ky) <= want) return false;
    }
    if (pointInRing(midpoint(a, b), r)) return false;
  }
  return true;
}

/** Is this point on actual land, as opposed to merely close to it? */
export const onLand = (p, obstacles) => obstacles.some((o) => pointInRing(p, o.raw));

const midpoint = (a, b) => ({ lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });

// --- routing ---------------------------------------------------------------

/**
 * Fastest route from `from` to `to` around the land, given wind, tide and polar.
 *
 * @returns {{
 *   legs: Array,          per-hop solveLeg results, in order
 *   points: Array,        the corners of the route, start first
 *   hours: number,        total time
 *   distNm: number,       total distance sailed over the ground
 *   direct: boolean,      true when open water made the straight line best
 *   blocked: string|null  why no route exists, if none does
 * }}
 */
export function findRoute(from, to, obstacles, wind, current, polar, variation, opts = {}) {
  const { maxNodes = 96, vmc = vmcTable(wind, current, polar) } = opts;

  const straight = solveLeg(from, to, wind, current, polar, variation);
  if (visible(from, to, obstacles)) {
    return {
      legs: [straight], points: [from, to], hours: straight.hours,
      distNm: straight.distNm, direct: true, blocked: null,
    };
  }
  if (onLand(to, obstacles)) return emptyRoute(straight, "That point is on land.");
  if (onLand(from, obstacles)) return emptyRoute(straight, "The boat's position is on land.");

  // Only the corners of land near the corridor between the two points can ever
  // be on the answer, so the graph stays small enough to solve on a phone.
  const nodes = [from, to, ...corners(from, to, obstacles, maxNodes)];
  const n = nodes.length;

  // Dijkstra. The graph is small and dense, so a linear scan for the next node
  // beats the bookkeeping of a heap.
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  const seen = new Map(); // line-of-sight, which is symmetric and worth caching
  dist[0] = 0;

  /**
   * Hours from node i to node j, or null if land is in the way. The speed comes
   * from the bearing table rather than a fresh hull solve: with thousands of
   * candidate edges, solving each one properly is what made this too slow to
   * use on a phone.
   */
  const cost = (i, j) => {
    const key = i < j ? i * n + j : j * n + i;
    let ok = seen.get(key);
    if (ok === undefined) {
      ok = visible(nodes[i], nodes[j], obstacles);
      seen.set(key, ok);
    }
    if (!ok) return null;
    const speed = vmc(initialBearing(nodes[i], nodes[j]));
    if (!(speed > 0)) return null;
    return haversineNm(nodes[i], nodes[j]) / speed;
  };

  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u === -1) break;
    if (u === 1) break; // reached the destination
    done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const hours = cost(u, v);
      if (hours === null || !Number.isFinite(hours)) continue;
      const alt = dist[u] + hours;
      if (alt < dist[v]) { dist[v] = alt; prev[v] = u; }
    }
  }

  if (!Number.isFinite(dist[1]))
    return emptyRoute(straight, "No way through: the land or the tide blocks every route.");

  const order = [];
  for (let at = 1; at !== -1; at = prev[at]) order.push(at);
  order.reverse();

  const points = order.map((i) => nodes[i]);
  const legs = [];
  for (let i = 1; i < points.length; i++)
    legs.push(solveLeg(points[i - 1], points[i], wind, current, polar, variation));

  return {
    legs, points,
    hours: legs.reduce((s, l) => s + l.hours, 0),
    distNm: legs.reduce((s, l) => s + l.distNm, 0),
    direct: false,
    blocked: null,
  };
}

const emptyRoute = (straight, why) => ({
  legs: [], points: [], hours: Infinity, distNm: straight.distNm,
  direct: false, blocked: why,
});

/**
 * Corners of land worth considering, nearest the straight line first.
 *
 * Capped, because the graph cost is quadratic in the node count and a phone
 * routing round Sicily should not stop to think about Stromboli.
 */
function corners(from, to, obstacles, maxNodes) {
  const pad = Math.max(0.08, haversineNm(from, to) / 60 / 3);
  const box = {
    latMin: Math.min(from.lat, to.lat) - pad,
    latMax: Math.max(from.lat, to.lat) + pad,
    lonMin: Math.min(from.lon, to.lon) - pad,
    lonMax: Math.max(from.lon, to.lon) + pad,
  };
  const out = [];
  for (const o of obstacles) {
    if (o.bbox.latMin > box.latMax || o.bbox.latMax < box.latMin ||
        o.bbox.lonMin > box.lonMax || o.bbox.lonMax < box.lonMin) continue;
    for (let i = 0; i < o.ring.length - 1; i++) out.push(o.ring[i]);
  }
  if (out.length <= maxNodes) return out;
  const mid = midpoint(from, to);
  return out
    .map((p) => ({ p, d: haversineNm(mid, p) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, maxNodes)
    .map((x) => x.p);
}
