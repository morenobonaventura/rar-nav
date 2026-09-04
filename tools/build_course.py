"""Generate data/course.json from the private router's race config.

Single-sources the course definition from
  ../sailing_routing/RAR/configs/rar2026.yaml
so this app and the Python router cannot silently disagree about the course.

The output holds the DEFINITION only (islands, sides, gates, rounding
parameters). Rounding arcs and the counterclockwise sequence are derived at
runtime by js/course.js, so the direction can be flipped in the app.

    python3 tools/build_course.py [path/to/rar2026.yaml]
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_YAML = os.path.join(ROOT, "..", "sailing_routing", "RAR", "configs", "rar2026.yaml")
src = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_YAML)

try:
    import yaml
except ImportError:
    sys.exit("needs pyyaml:  pip install pyyaml")

raw = yaml.safe_load(open(src))

course = {
    "race": {
        "name": raw["race"]["name"],
        "organiser": raw["race"]["organiser"],
        "dates": raw["race"]["dates"],
        "distance_nm": raw["race"]["course_distance_nm"],
    },
    # NOAA WMM-2025 evaluated at five points across the course for 2026-09-25:
    # 4.07 (Alicudi) .. 4.21 (Stromboli), spread 0.14 deg, inside the model's
    # own +/-0.33 deg uncertainty. Secular change +0.077 deg/yr.
    "magnetic_variation_deg": 4.1,
    "variation_note": "WMM-2025 @ 2026-09-25, east positive. Magnetic = True - variation.",
    "bbox": raw["bbox"],
    "start_finish": {
        "name": raw["start_finish"]["name"],
        "lat": raw["start_finish"]["lat"],
        "lon": raw["start_finish"]["lon"],
    },
    "islands": raw["islands"],
    "sequence_clockwise": raw["course_sequence"]["clockwise"],
    "cruising_clockwise": raw.get("cruising_sequence", {}).get("clockwise", []),
    "rounding": {
        "margin_nm": raw["routing"]["rounding_margin_nm"],
        "arc_step_deg": raw["routing"].get("rounding_arc_step_deg", 45.0),
        "min_sweep_deg": 15.0,
    },
    "provenance": (
        "PLACEHOLDER GEOMETRY, NOT OFFICIAL MARKS. Island positions are geographic "
        "centroids and gate points their midpoints; radii are rough half-lengths plus "
        "margin. The course SEQUENCE (Alicudi, Filicudi, Salina/Lipari gate, Stromboli, "
        "Vulcano/Lipari gate) was confirmed by a sailor of this race, but Stromboli's "
        "clockwise side is inferred by mirror symmetry. Replace every coordinate from "
        "the official Sailing Instructions before racing."
    ),
    "source": os.path.relpath(src, ROOT),
}

out = os.path.join(ROOT, "data", "course.json")
json.dump(course, open(out, "w"), indent=2)
print(f"wrote {out}")
print(f"  {len(course['islands'])} islands, {len(course['sequence_clockwise'])} marks, "
      f"variation {course['magnetic_variation_deg']} deg E")
