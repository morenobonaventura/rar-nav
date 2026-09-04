"""Build a compact offline coastline for the RAR navigator from OSM data.

Fetch the raw data first (once):

    curl -X POST https://overpass-api.de/api/interpreter \\
      --data-urlencode 'data=[out:json][timeout:180];way["natural"="coastline"](37.85,39.05,14.15,15.55);(._;>;);out body;' \\
      -o tools/coastline_raw.json

then:  python3 tools/build_coast.py [simplify_metres]   ->  data/aeolian_coast.geojson

OSM coastline ways are directed with land on the LEFT, which is what makes the
bbox-closing walk unambiguous.
"""
import json, math, os, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "tools", "coastline_raw.json")
OUT = os.path.join(ROOT, "data", "aeolian_coast.geojson")
BBOX = dict(lat_min=37.85, lat_max=39.05, lon_min=14.15, lon_max=15.55)
EPS_M = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
LATSCALE = math.cos(math.radians(38.5))

d = json.load(open(RAW))
nodes = {e["id"]: (e["lon"], e["lat"]) for e in d["elements"] if e["type"] == "node"}
ways = [e for e in d["elements"] if e["type"] == "way"]

# --- stitch ways sharing endpoints, forward then backward ---
segs = [list(w["nodes"]) for w in ways]
by_start, by_end = defaultdict(list), defaultdict(list)
for i, s in enumerate(segs):
    by_start[s[0]].append(i)
    by_end[s[-1]].append(i)
used = [False] * len(segs)
chains = []
for i0, s0 in enumerate(segs):
    if used[i0]:
        continue
    used[i0] = True
    chain = list(s0)
    while chain[-1] != chain[0]:
        nxt = [j for j in by_start[chain[-1]] if not used[j]]
        if not nxt:
            break
        j = nxt[0]; used[j] = True
        chain.extend(segs[j][1:])
    while chain[-1] != chain[0]:
        prv = [j for j in by_end[chain[0]] if not used[j]]
        if not prv:
            break
        j = prv[0]; used[j] = True
        chain = segs[j][:-1] + chain
    chains.append(chain)

def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for k in range(a + 1, b):
            px, py = pts[k]
            dist = math.hypot(px - ax, py - ay) if norm == 0 else abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if dist > best:
                best, bi = dist, k
        if best > eps:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]

def simplify(pts, eps_deg):
    scaled = [(x * LATSCALE, y) for x, y in pts]
    out = rdp(scaled, eps_deg)
    return [(round(x / LATSCALE, 5), round(y, 5)) for x, y in out]

def area_km2(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]; x2, y2 = ring[i + 1]
        a += (x1 * LATSCALE * 111.32) * (y2 * 111.32) - (x2 * LATSCALE * 111.32) * (y1 * 111.32)
    return abs(a) / 2

# --- clip open chains to bbox, then close them into rings along the perimeter ---
# Standard OSM coastline->polygon assembly: land is on the LEFT of a coastline
# way, so an open chain that exits the bbox is continued counterclockwise along
# the bbox edge until the next chain enters, and so on until the ring closes.
W, E, S, N = BBOX["lon_min"], BBOX["lon_max"], BBOX["lat_min"], BBOX["lat_max"]

def inside(p):
    return W <= p[0] <= E and S <= p[1] <= N

def cross(a, b):
    """Point where segment a->b crosses the bbox edge (a inside XOR b inside)."""
    lo, hi = 0.0, 1.0
    for _ in range(40):
        m = (lo + hi) / 2
        pm = (a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m)
        if inside(pm) == inside(a):
            lo = m
        else:
            hi = m
    t = (lo + hi) / 2
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

def clip(pts):
    """Split a polyline into the sub-polylines that lie inside the bbox."""
    out, cur = [], []
    for i, p in enumerate(pts):
        if inside(p):
            if not cur and i > 0:
                cur.append(cross(pts[i - 1], p))
            cur.append(p)
        else:
            if cur:
                cur.append(cross(pts[i - 1], p))
                out.append(cur); cur = []
    if cur:
        out.append(cur)
    return [c for c in out if len(c) >= 2]

def perimeter_t(p):
    """Position along the bbox perimeter, 0..4, counterclockwise from the SW corner."""
    x = min(max(p[0], W), E); y = min(max(p[1], S), N)
    dw, de = abs(x - W), abs(x - E)
    ds, dn = abs(y - S), abs(y - N)
    m = min(dw, de, ds, dn)
    if m == ds: return 0 + (x - W) / (E - W)
    if m == de: return 1 + (y - S) / (N - S)
    if m == dn: return 2 + (E - x) / (E - W)
    return 3 + (N - y) / (N - S)

CORNERS = [(W, S), (E, S), (E, N), (W, N)]

def corners_between(t_from, t_to):
    """bbox corners passed going counterclockwise from t_from to t_to."""
    span = (t_to - t_from) % 4 or 4
    out = []
    for k in range(1, 5):
        step = (math.floor(t_from) + k - t_from) % 4
        if 0 < step < span:
            out.append(CORNERS[(math.floor(t_from) + k) % 4])
    return out

def close_open_chains(open_chains):
    """Join clipped open chains end->start around the bbox into closed rings."""
    ends = [(perimeter_t(c[0]), perimeter_t(c[-1])) for c in open_chains]
    used = [False] * len(open_chains)
    rings = []
    for i0 in range(len(open_chains)):
        if used[i0]:
            continue
        ring, i = [], i0
        while not used[i]:
            used[i] = True
            ring.extend(open_chains[i])
            t_exit = ends[i][1]
            # next chain = the one whose entry point comes first counterclockwise
            cand = [(((ends[j][0] - t_exit) % 4) or 4, j) for j in range(len(open_chains)) if not used[j] or j == i0]
            if not cand:
                break
            _, nxt = min(cand)
            ring.extend(corners_between(t_exit, ends[nxt][0]))
            if nxt == i0:
                break
            i = nxt
        if len(ring) >= 4:
            rings.append(ring + [ring[0]])
    return rings

feats = []
eps_deg = EPS_M / 111320.0
tot_in = tot_out = 0
open_chains = []
for chain in chains:
    pts = [nodes[n] for n in chain if n in nodes]
    if len(pts) < 3:
        continue
    closed = pts[0] == pts[-1]
    simp = simplify(pts, eps_deg)
    if closed and len(simp) < 4:        # tiny rock: keep it, unsimplified
        simp = [(round(x, 5), round(y, 5)) for x, y in pts]
    tot_in += len(pts); tot_out += len(simp)
    if closed:
        if not any(inside(p) for p in simp):
            continue
        feats.append({"type": "Feature",
                      "properties": {"kind": "island", "area_km2": round(area_km2(simp), 4)},
                      "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in simp]]}})
    else:
        open_chains.extend(clip(simp))

for ring in close_open_chains(open_chains):
    ring = [(round(x, 5), round(y, 5)) for x, y in ring]
    feats.append({"type": "Feature",
                  "properties": {"kind": "mainland", "area_km2": round(area_km2(ring), 4)},
                  "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ring]]}})

feats.sort(key=lambda f: -f["properties"]["area_km2"])
gj = {"type": "FeatureCollection",
      "properties": {"source": "OpenStreetMap contributors, natural=coastline (ODbL)",
                     "fetched": "2026-09-04", "bbox": BBOX, "simplify_m": EPS_M},
      "features": feats}
json.dump(gj, open(OUT, "w"), separators=(",", ":"))
print(f"chains={len(chains)} features={len(feats)} pts {tot_in} -> {tot_out}")
print("islands:", sum(1 for f in feats if f["properties"]["kind"] == "island"),
      " mainland:", sum(1 for f in feats if f["properties"]["kind"] == "mainland"))
print("largest:", [(f["properties"]["kind"], f["properties"]["area_km2"]) for f in feats[:8]])
