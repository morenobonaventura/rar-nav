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

**Marks** — ⚠️ **placeholder positions, not the official course.** The *sequence*
(Alicudi, Filicudi, Salina/Lipari gate, Stromboli, Vulcano/Lipari gate) was
confirmed by a sailor of this race, but Stromboli's clockwise side is inferred by
mirror symmetry, and every coordinate is seeded rather than official. Replace
them from the Sailing Instructions before racing. Setup lists them all so you can
see exactly what you are trusting.

**The course is a list of marks with a required side — not a route.** The race
rule is "leave Alicudi to starboard", not "pass within 300 m of it", so what the
config holds is the thing you must honour. How you get between consecutive marks
is a separate question, currently answered with a straight line.

A rounding is therefore a run of buoys down one side of the island, each carrying
its side, rather than a single point: one point can only say "touch this spot",
never "go around it". Their default positions come from ray-casting the real
coastline and stepping out by `clearance_m` (300 m), and the generator then
subdivides any pair whose straight chord would clip a headland — these islands
are not circles, and a chord between two bearings can cut a bulge that neither
bearing sees. Gates get their own, smaller clearance (100 m), because at 300 m a
side the Bocche di Vulcano would be reduced to a 333 m slot the race never asked
for.

Sailing the course the other way round reverses the order and flips every side,
in one place, so the two directions cannot drift apart. The toggle for it is on
the main page, not in Setup, because it is decided on the water.

**One leg genuinely cannot be sailed straight**, in either direction: leaving the
Bocche di Vulcano for Sicily, the rhumb line runs over Vulcano. There is no mark
there because the race does not require one — you simply have to go round the
island. The app says so rather than drawing a course through it, and a test pins
that known conflict so a *new* one shows up as a failure instead of as scenery.

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

`js/nav.js` and `js/course.js` are pure and carry the tests. The course tests
assert the properties that matter rather than a golden file: every mark sits
between 100 m and 900 m off the rocks, no mark is on land, no chord within a
rounding cuts the island it is rounding, both gates are wide enough to be fair,
and sailing the other way round is the exact mirror — same buoys, reversed, every
side flipped.

Regenerating the data:

```sh
tools/build_coast.py [metres]              # needs tools/coastline_raw.json; curl is in the header
tools/build_course.py [--clearance 300]    # marks, seeded off the real coastline
tools/build_polar.py                       # from the router's polars/dufour_40.csv
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
