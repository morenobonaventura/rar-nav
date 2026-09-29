"""Build the wide-area coastline that surrounds the Aeolian chart.

The detailed file (data/aeolian_coast.geojson, 15 m, straight from Overpass)
covers the race and nothing else, which leaves the boat on a blank blue field
the moment it sails off the course -- on a delivery down the Tyrrhenian, or at
any other regatta on this coast. This adds the rest of Italy at a coarser
resolution, from the same ultimate source.

    npm pack @geo-maps/earth-lands-10m      # OSM land polygons, ODbL
    tar xzf geo-maps-earth-lands-10m-*.tgz
    python3 tools/build_italy_coast.py path/to/package/map.geo.json

That source is the whole planet as ONE MultiPolygon of 129 MB, so it is read a
polygon at a time rather than loaded: handing the parsed world to a geometry
library costs several gigabytes and was killed for it. Each polygon is rejected
on its own bounding box in plain arithmetic first, which leaves a few hundred
to actually clip.

Two clips matter. The bbox keeps Italy and the coasts across the water from it;
the detailed file's own bbox is then cut OUT, so every point on the chart is
drawn from exactly one source and the two can never disagree about where the
water is.

Holes are dropped and only outer rings are written: `isOnLand` reads one ring
per feature, and a lake inside a headland is not water this boat can reach.
"""
import json, math, os, sys
from shapely.geometry import box, mapping, Polygon
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "italy_coast.geojson")
SRC = sys.argv[1] if len(sys.argv) > 1 else "package/map.geo.json"

# Italy from Lampedusa to the Alps, with the Corsican, Croatian and Tunisian
# edges that fall inside it. A navigator on this coast wants the other side of
# the water drawn too.
BBOX = dict(lat_min=35.4, lat_max=46.6, lon_min=6.2, lon_max=18.8)
# The detailed file's own bbox, cut out of this one.
HOLE = dict(lat_min=37.85, lat_max=39.05, lon_min=14.15, lon_max=15.55)
# Anything smaller than this is a rock the 100 m data cannot describe honestly.
MIN_AREA_KM2 = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05
SIMPLIFY_M = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0

LATSCALE = math.cos(math.radians(41.0))
KM_PER_DEG = 111.32

area = box(BBOX["lon_min"], BBOX["lat_min"], BBOX["lon_max"], BBOX["lat_max"])
hole = box(HOLE["lon_min"], HOLE["lat_min"], HOLE["lon_max"], HOLE["lat_max"])
keep = area.difference(hole)


def polygons(path):
    """Every polygon in the source, streamed, as a list of rings."""
    try:
        import ijson
    except ImportError:
        print("no ijson: falling back to a full parse, which needs ~6 GB", flush=True)
        src = json.load(open(path))
        geoms = (src["geometries"] if src["type"] == "GeometryCollection"
                 else [f["geometry"] for f in src["features"]])
        for g in geoms:
            if g["type"] == "Polygon":
                yield g["coordinates"]
            elif g["type"] == "MultiPolygon":
                yield from g["coordinates"]
        return

    for prefix in ("geometries.item.coordinates.item", "features.item.geometry.coordinates.item"):
        found = False
        with open(path, "rb") as f:
            for poly in ijson.items(f, prefix):
                found = True
                yield poly
        if found:
            return


def overlaps(ring):
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    return (max(lons) >= BBOX["lon_min"] and min(lons) <= BBOX["lon_max"]
            and max(lats) >= BBOX["lat_min"] and min(lats) <= BBOX["lat_max"])


print("reading", SRC, flush=True)
seen = kept = 0
parts = []
for rings in polygons(SRC):
    seen += 1
    outer = [(float(x), float(y)) for x, y in rings[0]]
    if len(outer) < 4 or not overlaps(outer):
        continue
    kept += 1
    p = Polygon(outer)
    if not p.is_valid:
        p = p.buffer(0)
    clipped = p.intersection(keep)
    if not clipped.is_empty:
        parts.append(clipped)
    if seen % 100000 == 0:
        print(f"  {seen} polygons scanned, {kept} near the box", flush=True)

print(f"{seen} polygons in the source, {kept} overlap the box", flush=True)

land = unary_union(parts) if parts else None
polys = [g for g in (getattr(land, "geoms", [land]) if land else []) if isinstance(g, Polygon)]
print(f"{len(polys)} polygons after clipping", flush=True)

eps_deg = SIMPLIFY_M / (KM_PER_DEG * 1000)
feats = []
for p in polys:
    p = p.simplify(eps_deg, preserve_topology=True)
    if p.is_empty:
        continue
    km2 = p.area * (KM_PER_DEG ** 2) * LATSCALE
    if km2 < MIN_AREA_KM2:
        continue
    ring = [[round(x, 5), round(y, 5)] for x, y in p.exterior.coords]
    feats.append({"type": "Feature",
                  "properties": {"kind": "coast", "area_km2": round(km2, 4)},
                  "geometry": {"type": "Polygon", "coordinates": [ring]}})

feats.sort(key=lambda f: -f["properties"]["area_km2"])
gj = {"type": "FeatureCollection",
      "properties": {"source": "OpenStreetMap contributors via @geo-maps/earth-lands-10m (ODbL)",
                     "bbox": BBOX, "excludes": HOLE, "simplify_m": SIMPLIFY_M,
                     "min_area_km2": MIN_AREA_KM2},
      "features": feats}
json.dump(gj, open(OUT, "w"), separators=(",", ":"))
pts = sum(len(f["geometry"]["coordinates"][0]) for f in feats)
print(f"features={len(feats)} points={pts} bytes={os.path.getsize(OUT)}", flush=True)
print("largest km2:", [round(f["properties"]["area_km2"]) for f in feats[:6]])
