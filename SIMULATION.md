# Simulation mode

**Not built. This is the spec.**

## Why

This is an instrument for one race a year. Everything interesting about it only
happens while the boat is moving, and the only way to see that today is to go
sailing — which happens once, in September, with no second attempt.

Specifically, none of the following is exercised by anything that currently
runs:

- **The shift detector** (`shiftFromCog`, `js/nav.js`). It needs a *run* of COG
  samples on one tack, then a change in the breeze. Unit tests feed it a
  hand-built array; nothing has ever fed it a track that a boat actually made.
- **Tack detection across a tack.** The detector deliberately reports nothing
  until there is a baseline on the new board. How long that blackout really
  lasts, in a seaway, has never been observed.
- **Leg advance and laylines.** `state.activeIndex` moves when a leg is picked
  by hand. Nothing has watched it approach a mark at 6 knots.
- **The iOS suspend gap.** `Gps.history()` reports `gapMs` when the app was
  backgrounded. That path has been reasoned about, never triggered.
- **The chip's nulls.** `coords.speed` and `coords.heading` go null when the
  phone is still, and sometimes when it is not; `js/gps.js` falls back to
  differencing fixes. The fallback is untested against a realistic stream.

A simulation mode is the difference between "the arithmetic is right" — which
the 69 tests already establish — and "the instrument behaves on a boat".

## What exists, and why it is not enough

`window.rarnav.feed({lat, lon, sog, cog})` injects one fix. It is genuinely
useful for eyeballing a leg, and it is how every screenshot in this repo was
made. But it is a single frame: it cannot produce a track, so it cannot produce
a tack, a shift, a gap, or an approach. Everything above needs *motion over
time*.

## The one hard problem: the clock

A 20-hour race has to play in minutes, so a simulator must compress time. That
is not free, because the app reads the wall clock in seven places and only some
of them can be told otherwise:

| Site | Injectable? |
|---|---|
| `charts.js:82` `sparkline(…, now)` | yes, defaulted |
| `gps.js:130` `history(now)` | yes, defaulted |
| `nav.js:466` `solveRoute(…, now)` | yes, defaulted |
| `gps.js:70` `onFix` — uses `pos.timestamp` | yes, via the fix |
| `app.js:106` `feed()` stamps `Date.now()` | **no** |
| `app.js:279` probe ETA | **no** |
| `gps.js:157` `load()` window cutoff | **no** |

The defaulted parameters are never passed by callers, so today every buffer is
filtered against wall time. Feed a compressed track and the samples fall outside
the five-minute window as fast as they arrive — the history empties, the
sparklines blank, and `shiftFromCog` returns `null` forever. The failure is
silent and looks like a bug in the detector.

**So the first piece of work is a clock seam, not a simulator.** One module:

```js
// js/clock.js
export const clock = { now: () => Date.now() };   // sim swaps the function
```

Route all seven sites through it. This is a small, mechanical change and it
should land on its own, with the existing tests still passing, before any
simulator is written. Everything else here depends on it.

## Shape

Two pieces, because the same track has to serve both a browser and `node --test`:

```
tools/make_track.js     seeded generator  -> tests/fixtures/*.track.json
js/sim.js               player            -> gps.onFix(), on the sim clock
```

**Reuse the router as the boat model.** Do not write a second one. At each tick
`solveCourse(bearing, wind, current, polar)` already returns the optimal heading,
boat speed, SOG and COG for the leg being sailed; `destinationPoint(from, cog,
sog * dt)` advances the boat. That yields a track that tacks where a boat would
tack, at angles the polar says are real, including the effect of current — for
free, and it stays correct as the router improves.

On top of that the generator adds what the router deliberately has no model of:

- **Steering wander.** COG noise, a few degrees, correlated between samples
  (a random walk, not white noise — a helm wanders, it does not jitter). This is
  what `shiftFromCog`'s `wander` floor exists to reject, so getting its
  *character* right matters more than its size.
- **Sea state.** SOG modulation at wave period.
- **A truth wind that moves.** See below.

Seed the PRNG and put the seed in the filename. A bug found in simulation is
worth nothing if it cannot be replayed.

## The truth wind is not the app's wind

This is the property that makes the whole thing worth building.

The app's wind is a number you typed, held constant — it has no way to know
about a shift. The simulator's wind is the real one, and it oscillates. So the
generator flies the boat on its **truth wind**, while the app under test keeps
whatever was typed into the conditions panel.

That divergence is not a flaw in the harness. It is exactly the condition
`shiftFromCog` was built for, and it is the only way to check the claim the
detector rests on: that a wrong typed wind does not corrupt it. Set the app's
TWD 25° off the truth and the header must still be reported, at the right size,
at the right moment.

## Faults worth injecting

Each of these is a real thing an iPhone does on a boat, and each has a code path
that has never run:

| Fault | Exercises |
|---|---|
| 90-second dropout mid-beat | `history().gapMs`, the "app was in the background" note |
| `speed`/`heading` null for a run of fixes | the differencing fallback in `onFix` |
| accuracy degrading to 60 m | the `fix[data-quality]` chip |
| a 200 m position jump | nothing yet — probably needs a spike filter |
| no fix at all from cold | the start-line fallback in `boatOrStart` |
| stopped, drifting under 1 kn | `lastGoodCog` hold, and the detector's `minSogKn` gate |

## Scenarios, with what they must prove

| # | Scenario | Must be true |
|---|---|---|
| 1 | Beat, breeze oscillating ±12° on a 6-minute period | `HEADED` appears within ~60 s of each right shift on starboard, `lifted` on port; never both at once |
| 2 | The same, with the app's TWD set 25° wrong | identical verdicts and sizes to scenario 1 |
| 3 | A tack | detector goes quiet, and stays quiet until there is a baseline; measure how long that actually is |
| 4 | Steady breeze, helm wandering ±12° | `steady` throughout — **no** header ever called on a wave |
| 5 | Persistent 30° veer over 20 minutes | headed on one board the whole way, not a flicker |
| 6 | Beam reach in the same shifting breeze | detector silent (COG follows the helm, not the wind) |
| 7 | Approach to a layline and round a mark | leg advances, ETA converges, no jump backwards |
| 8 | Near-calm, TWS 3 kn | the polar floor is 6 kn: every speed on screen is a clamp, and nothing currently says so |

Scenario 4 is the one that matters most. A shift detector that cries wolf gets
ignored, and then the one reading here that a mistyped wind cannot corrupt is
worth nothing.

Scenario 8 is a known defect in the sister project (`sailing_routing`, where
`Polar.in_range()` exists and is never called) and the same hole exists here.

## A simulated fix must never look real

The codebase already holds this line for the hand-placed position: `state.manual`
is "labelled everywhere so it can never be mistaken for a real fix", and it is
deliberately not persisted, because a position set by hand yesterday must not
still be in force at the start gun.

Simulation is the same hazard, louder. Requirements:

- The status rail shows **SIMULATION** in `--warn`, permanently, not a toast.
- It is never on by default: `?sim=<name>` in the URL, or an explicit toggle in
  Setup. Never a persisted preference.
- It does not survive a reload without the flag still being in the URL.
- It refuses to start if a real GPS fix has been received in this session.
- `js/sim.js` is not in the service worker's `ASSETS`, so it is not even present
  offline on the boat.

## What not to build

- **Not a second boat model.** The router is the boat model.
- **Not a forecast.** The app is an instrument, not a router; the simulator's
  wind exists to move the boat and to lie to the app, nothing more.
- **Not a replay of real GPS logs**, yet. Worth having eventually — a track from
  last year's race would be the real test — but nothing is available to replay,
  and a generator is needed either way to produce the shifts on demand.

## Open questions

- **Where does the sim clock stop?** If `clock.now()` is compressed, the wall
  clock in the rail reads race time, which is right. But wake lock, and the
  service worker, are on real time. Probably fine; unverified.
- **Time compression factor.** The detector's windows are 5 s samples and a 60 s
  recent window, so beyond about 60× the buffers hold too few samples to mean
  anything. 30× puts a 20-hour race in 40 minutes and keeps the windows honest.
- **Should `tools/make_track.js` be JS or Python?** The rest of `tools/` is
  Python, but the generator wants `solveCourse` from `js/nav.js`, and porting
  the router to write a test harness would be absurd. JS, and accept the
  inconsistency.
