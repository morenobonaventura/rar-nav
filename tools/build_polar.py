"""Generate data/polar_dufour40.json from the router's Dufour 40 CSV.

The measured data covers TWA 52-150 deg and TWS 6-20 kn ONLY. That box excludes
exactly the region where the upwind and downwind VMG optima live, so clamping at
the edges (what the Python router does) would peg the beat angle at 52 deg in
every condition. Instead the grid is extended and the missing cells filled from
the documented shape factors below.

Every generated cell is flagged in `estimated` so the in-app editor can colour
it and the user can overwrite it with numbers from their own boat.

    python3 tools/build_polar.py [path/to/dufour_40.csv]
"""
import csv, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT = os.path.join(ROOT, "..", "sailing_routing", "RAR", "polars", "dufour_40.csv")
src = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else DEFAULT)

rows = list(csv.DictReader(open(src)))
meas = {(float(r["tws_kn"]), float(r["twa_deg"])): float(r["boat_speed_kn"]) for r in rows}
meas_tws = sorted({t for t, _ in meas})          # 6..20
meas_twa = sorted({a for _, a in meas})          # 52..150

TWS = [4, 6, 8, 10, 12, 14, 16, 20, 25]
TWA = [0, 40, 45, 50, 52, 60, 75, 90, 110, 120, 135, 150, 160, 170, 180]

# Shape factors for the unmeasured regions, as a fraction of the nearest
# measured angle (52 upwind, 150 downwind). Typical monohull cruiser-racer
# shape: the upwind curve falls away steeply inside ~45 deg, the downwind curve
# loses little between 150 and 180 for a boat without an asymmetric.
UPWIND = {0: 0.0, 40: 0.76, 45: 0.92, 50: 0.985}
DOWNWIND = {160: 0.96, 170: 0.91, 180: 0.88}
# Wind-speed extrapolation: light air falls away fast, and by 25 kn a 40-footer
# is at hull speed and depowering, so it gains very little over 20.
TWS_FACTOR = {4: (6, 0.72), 25: (20, 1.03)}


def measured_speed(tws, twa):
    """Bilinear lookup inside the measured box, clamped to its edges."""
    def bracket(grid, v):
        if v <= grid[0]:
            return grid[0], grid[0], 0.0
        if v >= grid[-1]:
            return grid[-2], grid[-1], 1.0
        for i in range(len(grid) - 1):
            if grid[i] <= v <= grid[i + 1]:
                return grid[i], grid[i + 1], (v - grid[i]) / (grid[i + 1] - grid[i])
    s0, s1, fs = bracket(meas_tws, tws)
    a0, a1, fa = bracket(meas_twa, twa)
    return (meas[(s0, a0)] * (1 - fs) * (1 - fa) + meas[(s1, a0)] * fs * (1 - fa)
            + meas[(s0, a1)] * (1 - fs) * fa + meas[(s1, a1)] * fs * fa)


speeds, estimated = [], []
for tws in TWS:
    row, est_row = [], []
    base_tws, tws_factor = TWS_FACTOR.get(tws, (tws, 1.0))
    for twa in TWA:
        if twa in UPWIND:
            v = measured_speed(base_tws, 52) * UPWIND[twa]
            is_est = True
        elif twa in DOWNWIND:
            v = measured_speed(base_tws, 150) * DOWNWIND[twa]
            is_est = True
        else:
            v = measured_speed(base_tws, twa)
            is_est = tws not in meas_tws or twa not in meas_twa
        row.append(round(v * tws_factor, 2))
        est_row.append(is_est)
    speeds.append(row)
    estimated.append(est_row)

out = {
    "name": "Dufour 40 (generic)",
    "tws": TWS,
    "twa": TWA,
    "speeds": speeds,
    "estimated": estimated,
    "measured_box": {"tws": [min(meas_tws), max(meas_tws)], "twa": [min(meas_twa), max(meas_twa)]},
    "note": ("Cells outside TWA 52-150 / TWS 6-20 are ESTIMATED, not measured. "
             "Edit them in the app with numbers from your own boat; your edits "
             "are stored on the phone and never leave it."),
    "source": os.path.basename(src),
}
path = os.path.join(ROOT, "data", "polar_dufour40.json")
json.dump(out, open(path, "w"), indent=1)
n_est = sum(sum(r) for r in estimated)
print(f"wrote {path}: {len(TWS)}x{len(TWA)} grid, {n_est} estimated of {len(TWS)*len(TWA)}")
