# RAR Nav

An offline navigator for the Round Aeolian Race, built to live on an iPhone home
screen and work with the radio off.

Open it, see the islands and the course, type in the wind and tide you actually
observe, tap a mark, and get distance, bearing (true and magnetic) and an ETA
from your own polar — plus live SOG and COG from the phone's GPS with five
minutes of history behind them.

It is deliberately *not* a router. The isochrone optimiser that plans the race
from forecast grids is a separate project; this is the instrument you hold on
deck once you are sailing it.

## Using it on the boat

Open the published page once with signal, then **Share → Add to Home Screen**.
After that it runs in airplane mode: everything it needs is cached on the phone.

- **Tap anywhere on the map** for distance, bearing and ETA to that point, and
  the track to sail it. A fetch is the straight dashed line. A beat or a run is
  drawn as two solid tracks — one tack either side, both landing on the mark in
  the same time — which together are the cone you have to stay inside. The tack
  points are marked, and the readout says how far and how long to the first one.
  Which side to take is yours: shifts, tide, traffic and the next mark all bear
  on it, and the app knows none of them.
- **Tap a leg** in the list to make it the mark you are sailing to; the rest of
  the course re-times behind it.
- **Tap SOG or COG** for the last five minutes, as a time series or a
  distribution.
- **Position** arms the map: the next tap puts the boat where you tapped. Use it
  when the GPS has dropped out and you have a position from somewhere else, or
  to see what a leg will look like from a place you have not reached yet. A
  placed position overrides the GPS until you tap the status bar to hand control
  back, and is drawn as a crosshair in a different colour so it can never be
  mistaken for a fix. SOG and COG read `--` while it is in force, because a pin
  has no speed. It is not remembered across a reload — a position set by hand
  yesterday must not still be in force at the start gun.
- **Wind and tide** are set by dragging the compass dials or typing the numbers.
- **Night** switches to red-on-black to keep your night vision.
- **Awake** holds the screen on. It is a toggle, not the default, so the app
  never fights your auto-lock when you put the phone down.

Battery is dominated by the screen, not the GPS — roughly 2–3 W against 0.2 W.
Expect four to six hours of screen-on use, less in direct sun.

## What the numbers mean

**Bearings** are great-circle, true unless marked `M`. Magnetic uses a single
variation of **+4.1° E**: NOAA's WMM-2025 evaluated across the course for
25 September 2026 runs from +4.07° at Alicudi to +4.21° at Stromboli, a spread
well inside the model's own ±0.33° uncertainty. `Magnetic = True − variation`.
It is editable in Setup.

**Wind** is entered as the direction it blows *from*; **tide** as the direction
it flows *toward*. Polars are measured against the wind over the water, but the
wind you observe is over the ground, so the app subtracts the current vector
before reading the polar. In the Bocche di Vulcano two knots of stream shifts
the wind the boat actually feels by about 15°, which is the difference between
laying a mark and not.

**ETA** comes from a small linear program rather than a pile of special cases.
Plot the boat's achievable over-ground velocity for every heading as points
(cross-track, along-track) relative to the bearing you want; the fastest way to
make that bearing good is the highest point of that set on the line
cross-track = 0. Because you can split your time between any two headings, the
feasible set is their convex hull, so the answer is either

- a hull **vertex** — one heading lays the mark, so it is a fetch; or
- a hull **edge** — two headings either side, which *is* a beat or a run, with
  the time split set by where the edge crosses zero cross-track.

The tactical distinction falls out of the geometry instead of being hard-coded,
and a foul tide is handled the same way in both cases: it shifts every point and
can tilt a fetch into a beat on its own.

Conditions are held constant across the whole course. That is the point — it
answers "given what I see right now", not "given what the forecast says".

**The drawn track is point to point.** It does not go around anything. It will
warn you when a track runs over land — the coastline is right there, so there is
no excuse for offering a route through Filicudi — but a warning is all it is,
and a rock narrower than the 0.15 nm sampling step can slip between samples.
Routing that actually navigates around the islands and takes the marks in order
is the next piece of work.

**How many tacks is not a question this model can answer.** Sailing the same two
headings for the same total time arrives at the same moment however you chop it
up, so one tack and twenty are identical here. They are not identical on the
water: every manoeuvre costs a boat length or three, which argues for fewer —
and tacking on the headers gains far more than that, which argues for many. The
app knows nothing about either, so it draws one tack as the simplest case rather
than as a recommendation.

**The drawn corner is the layline, which is a limit rather than a plan.** Sailing
out to it leaves you with no options and turns any overstand into pure loss; the
tactically sound move is normally to stay inside it and work up the middle. The
readout says "tack before it, not at it" for that reason.

## Data, and how far to trust it

**Coastline** — OpenStreetMap `natural=coastline`, fetched via Overpass for
37.85–39.05 N, 14.15–15.55 E, stitched into rings and simplified to 15 m.
198 polygons, 3 896 points, 96 KB. Island areas check out against published
figures within about 1.5%, and the islets that matter are in it — Strombolicchio,
Basiluzzo, Dattilo, Lisca Bianca. © OpenStreetMap contributors, ODbL.

**Marks** — ⚠️ **placeholder geometry, not the official course.** Island
positions are geographic centroids, gates their midpoints, and rounding radii
rough half-lengths plus margin. The *sequence* (Alicudi, Filicudi, Salina/Lipari
gate, Stromboli, Vulcano/Lipari gate) was confirmed by a sailor of this race,
but Stromboli's clockwise side is inferred by mirror symmetry. Replace every
coordinate from the official Sailing Instructions before racing. Setup lists
them all so you can see exactly what you are trusting.

An island rounding is stored as an **arc**, not a point, on a circle of radius
(island + margin), swept the way the required side demands. A single point can
only say "touch this spot", never "go around it" — at Stromboli both neighbours
bear the same way, so a point degenerates into an out-and-back spike that never
passes the island.

**Polar** — a generic Dufour 40. The supplied data covers only TWA 52–150° and
TWS 6–20 kn, which excludes exactly where the upwind and downwind VMG optima
live, so the grid is extended and those cells are filled from documented shape
factors. **Every estimated cell is tinted in the editor.** Replace them with
numbers from your own boat; your edits live in the phone's `localStorage` and
never leave it or reach this repository.

## Development

```sh
npm test          # 45 tests, no dependencies
npm run serve     # http://localhost:8000
```

`js/nav.js` and `js/course.js` are pure and carry the tests. `course.js` is a
port of `rar/race/rar.py` from the routing project, and
`tests/course.test.js` checks it against a fixture generated by that Python —
waypoint for waypoint, both directions — so the two cannot silently disagree.

That fixture is generated with the Python's `nearest_water()` nudge disabled, on
purpose: it pushes marks off land using a 1-arcmin raster mask that cannot see
the 750 m Bocche di Vulcano and shifts that gate about 550 m. This app carries
precise OSM coastline instead, and asserts separately that no mark lands on it.

Regenerating the data:

```sh
tools/build_coast.py [metres]   # needs tools/coastline_raw.json; the curl is in the header
tools/build_course.py           # from ../sailing_routing/RAR/configs/rar2026.yaml
tools/build_polar.py            # from that project's polars/dufour_40.csv
tools/build_course_fixture.sh   # the golden course fixture
```

Editing a shipped file means bumping `CACHE` in `sw.js`, or phones keep serving
the old copy. While developing, unregister the service worker and clear caches
or you will spend an afternoon debugging code the browser is not running.

`window.rarnav` is a handle on the running app — `rarnav.state.wind`,
`rarnav.gps.history()`, and `rarnav.feed({lat, lon, sog, cog})` to drive the
display from a made-up position and see what a leg looks like before sailing it.

## Deploying

Static files, no build step. GitHub Pages from `main` at the repository root.
HTTPS is not optional: iOS blocks both geolocation and service workers on plain
`http://`, so a LAN test server cannot exercise the GPS or the offline path.
