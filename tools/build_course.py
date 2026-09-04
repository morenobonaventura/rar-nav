"""Generate data/course.json: the marks the course must honour.

The race rule is "leave Alicudi to starboard", not "pass within 300 m of it".
So what this produces is a list of MARKS with a required side -- the things you
have to honour -- and not a route. How you get between them is a separate
question, and one this app currently answers with a straight line.

Rounding marks are seeded by ray-casting the real OSM coastline from each
island's centroid and stepping out by `clearance_m`, so the defaults sit just
off the rocks instead of miles out to sea. They go into the config as explicit
coordinates precisely so they can be replaced, one line at a time, with the real
ones from the Sailing Instructions.

Gates are a pair of buoys facing each other across the strait; the boat passes
between them and rounds neither island.

    python3 tools/build_course.py [--clearance 300] [path/to/rar2026.yaml]
"""
import argparse, json, math, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_YAML = os.path.join(ROOT, "..", "sailing_routing", "RAR", "configs", "rar2026.yaml")
LAT_M = 111320.0

ap = argparse.ArgumentParser()
ap.add_argument("yaml_path", nargs="?", default=DEFAULT_YAML)
ap.add_argument("--clearance", type=float, default=300.0, help="metres off the coast")
# Gates get less: the course only asks you to pass BETWEEN the islands, so the
# buoys should span most of the strait. At 300 m each side the Bocche di Vulcano
# -- barely 900 m wide -- would leave a 333 m slot, a constraint the race never
# imposed.
ap.add_argument("--gate-clearance", type=float, default=100.0)
# A chord between two marks on a curve of radius R cuts inside it by
# R*(1-cos(step/2)). Keeping that under the clearance is what stops the straight
# line between consecutive marks from crossing the island it is rounding.
ap.add_argument("--max-step-deg", type=float, default=45.0)
args = ap.parse_args()

try:
    import yaml
except ImportError:
    sys.exit("needs pyyaml:  pip install pyyaml")

raw = yaml.safe_load(open(os.path.abspath(args.yaml_path)))
coast = json.load(open(os.path.join(ROOT, "data", "aeolian_coast.geojson")))
islands = {i["name"]: i for i in raw["islands"]}


def local(lat0, lon0, lat, lon):
    """Metres east and north of a reference point."""
    return ((lon - lon0) * LAT_M * math.cos(math.radians(lat0)), (lat - lat0) * LAT_M)


def geo(lat0, lon0, e, n):
    """Back from metres east/north to degrees."""
    return (lat0 + n / LAT_M, lon0 + e / (LAT_M * math.cos(math.radians(lat0))))


def island_ring(isl):
    """The coastline ring belonging to this island: the nearest sizeable one."""
    best, bd = None, 1e9
    for f in coast["features"]:
        if f["properties"].get("kind") != "island" or f["properties"]["area_km2"] < 0.5:
            continue
        r = f["geometry"]["coordinates"][0]
        cx = sum(p[0] for p in r) / len(r)
        cy = sum(p[1] for p in r) / len(r)
        d = math.hypot((cx - isl["lon"]) * math.cos(math.radians(isl["lat"])), cy - isl["lat"])
        if d < bd:
            bd, best = d, r
    return best


def coast_distance(isl, ring, bearing_deg):
    """Metres from the island centroid to its FURTHEST coast along a bearing."""
    th = math.radians(bearing_deg)
    dx, dy = math.sin(th), math.cos(th)  # bearing 0 = north
    pts = [local(isl["lat"], isl["lon"], p[1], p[0]) for p in ring]
    best = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        ex, ey = x2 - x1, y2 - y1
        den = dx * ey - dy * ex
        if abs(den) < 1e-9:
            continue
        t = (x1 * ey - y1 * ex) / den            # along the ray
        u = (x1 * dy - y1 * dx) / den            # along the segment, 0..1
        if t > 0 and 0.0 <= u <= 1.0:
            best = max(best, t)
    return best


def offset_point(isl, ring, bearing_deg, clearance):
    """A point `clearance` metres off the coast, on the given bearing."""
    d = coast_distance(isl, ring, bearing_deg) + clearance
    th = math.radians(bearing_deg)
    lat, lon = geo(isl["lat"], isl["lon"], d * math.sin(th), d * math.cos(th))
    return {"lat": round(lat, 5), "lon": round(lon, 5)}


def bearing(a, b):
    la1, la2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlon = math.radians(b["lon"] - a["lon"])
    y = math.sin(dlon) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dlon)
    return math.degrees(math.atan2(y, x)) % 360


def point_on_land(lat, lon):
    """Ray-casting point-in-polygon against the whole coastline."""
    for f in coast["features"]:
        ring = f["geometry"]["coordinates"][0]
        inside = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        if inside:
            return True
    return False


def chord_hits_land(a, b, step_m=40.0):
    """Would a straight line between two marks run over the rocks?"""
    dx, dy = local(a["lat"], a["lon"], b["lat"], b["lon"])
    dist = math.hypot(dx, dy)
    n = max(2, int(dist / step_m))
    for i in range(1, n):
        t = i / n
        lat, lon = geo(a["lat"], a["lon"], dx * t, dy * t)
        if point_on_land(lat, lon):
            return True
    return False


def compass(deg):
    names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
             "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return names[int((deg % 360) / 22.5 + 0.5) % 16]


def gate_buoys(name_a, name_b, clearance):
    """Two buoys facing each other across the strait between two islands."""
    out = []
    for first, second in ((name_a, name_b), (name_b, name_a)):
        isl, other = islands[first], islands[second]
        p = offset_point(isl, island_ring(isl), bearing(isl, other), clearance)
        out.append({"name": f"{first} side", "lat": p["lat"], "lon": p["lon"], "island": first})
    return out


def rounding_marks(island_name, side, approach, exit_aim, clearance, max_step):
    """Marks tracing the required side of an island, just off the rocks.

    Leaving the island to STARBOARD means the bearing from its centre to the
    boat increases as the boat goes round; to PORT it decreases. Sweeping from
    the entry bearing to the exit bearing in that direction automatically takes
    the long way round whenever the side demands it.
    """
    isl = islands[island_name]
    ring = island_ring(isl)
    th_in = bearing(isl, approach)
    th_out = bearing(isl, exit_aim)
    rot = 1.0 if side == "starboard" else -1.0
    sweep = (rot * (th_out - th_in)) % 360.0
    if sweep < 15.0:                             # approach and exit bear alike:
        sweep += 360.0                           # going "around" means a circuit
    steps = max(1, math.ceil(sweep / max_step))
    thetas = [(th_in + rot * sweep * k / steps) % 360.0 for k in range(steps + 1)]

    # These islands are not circles. A chord between two bearings can clip a
    # headland that neither bearing sees, so subdivide any chord that runs over
    # land until it does not -- rather than trusting a step angle derived from a
    # circle that does not exist.
    def at(th):
        p = offset_point(isl, ring, th, clearance)
        return {"name": f"{island_name} {compass(th)}", "lat": p["lat"], "lon": p["lon"],
                "side": side, "island": island_name, "_th": th}

    marks = [at(t) for t in thetas]
    for _ in range(6):
        out = [marks[0]]
        split = False
        for prev, nxt in zip(marks, marks[1:]):
            if chord_hits_land(prev, nxt):
                gap = (rot * (nxt["_th"] - prev["_th"])) % 360.0
                out.append(at((prev["_th"] + rot * gap / 2) % 360.0))
                split = True
            out.append(nxt)
        marks = out
        if not split:
            break
    for m in marks:
        m.pop("_th", None)
    return marks


start = {"lat": raw["start_finish"]["lat"], "lon": raw["start_finish"]["lon"]}
sequence = raw["course_sequence"]["clockwise"]


def aim(entry):
    """Rough position of a sequence entry, for working out approach bearings."""
    if "island" in entry:
        i = islands[entry["island"]]
        return {"lat": i["lat"], "lon": i["lon"]}
    a, b = (islands[n] for n in entry["gate"])
    return {"lat": (a["lat"] + b["lat"]) / 2, "lon": (a["lon"] + b["lon"]) / 2}


next_aims = [aim(e) for e in sequence[1:]] + [start]
legs, prev = [], start
for entry, exit_aim in zip(sequence, next_aims):
    if "island" in entry:
        marks = rounding_marks(entry["island"], entry["side"], prev, exit_aim,
                               args.clearance, args.max_step_deg)
        legs.append({"type": "rounding", "island": entry["island"],
                     "side": entry["side"], "marks": marks})
        prev = {"lat": marks[-1]["lat"], "lon": marks[-1]["lon"]}
    else:
        a, b = entry["gate"]
        buoys = gate_buoys(a, b, args.gate_clearance)
        legs.append({"type": "gate", "islands": [a, b], "marks": buoys})
        prev = {"lat": sum(m["lat"] for m in buoys) / 2,
                "lon": sum(m["lon"] for m in buoys) / 2}

course = {
    "race": {
        "name": raw["race"]["name"],
        "organiser": raw["race"]["organiser"],
        "dates": raw["race"]["dates"],
        "distance_nm": raw["race"]["course_distance_nm"],
    },
    "magnetic_variation_deg": 4.1,
    "variation_note": "WMM-2025 @ 2026-09-25, east positive. Magnetic = True - variation.",
    "bbox": raw["bbox"],
    "start_finish": {"name": raw["start_finish"]["name"], **start},
    "islands": raw["islands"],
    "clearance_m": args.clearance,
    "gate_clearance_m": args.gate_clearance,
    "sequence_clockwise": legs,
    "provenance": (
        "PLACEHOLDER MARKS, NOT THE OFFICIAL COURSE. Positions are seeded "
        f"{args.clearance:.0f} m off the real OSM coastline on the side the course "
        "requires - close enough to be sane, but invented. The course SEQUENCE "
        "(Alicudi, Filicudi, Salina/Lipari gate, Stromboli, Vulcano/Lipari gate) was "
        "confirmed by a sailor of this race; Stromboli's clockwise side is inferred by "
        "mirror symmetry. Replace every coordinate from the Sailing Instructions."
    ),
    "source": os.path.relpath(os.path.abspath(args.yaml_path), ROOT),
}

out = os.path.join(ROOT, "data", "course.json")
json.dump(course, open(out, "w"), indent=1)
print(f"wrote {out}")
for l in legs:
    kind = f"{l['island']} ({l['side']})" if l["type"] == "rounding" else f"gate {'-'.join(l['islands'])}"
    print(f"  {kind:<26} {len(l['marks'])} marks")
print(f"  {sum(len(l['marks']) for l in legs)} marks total, {args.clearance:.0f} m clearance")
