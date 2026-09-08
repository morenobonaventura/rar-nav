# Simulation mode

Built. This describes what is there; the history of why is in the commits.

## Why

This is an instrument for one race a year, and everything interesting about it
only happens while the boat is moving. Before this existed, the shift detector
had been checked only against arrays written by hand — tracks where the single
thing that moves is the thing under test. The first time it met a boat with a
wandering helm it failed outright, calling headers on a wind that never moved
26% of the time. That is the kind of defect you otherwise discover once, in
September, with no second attempt.

## Using it

```sh
node tools/make_track.js                    # list the scenarios
node tools/make_track.js beat-oscillating   # write one to data/tracks/
node tools/make_track.js --all
npm run serve                               # then open:
#   http://localhost:8000/?sim=beat-oscillating
```

The app plays the track into `Gps.onFix` in the shape the browser's geolocation
would, so nothing downstream knows the difference — an instrument tested through
a special "test mode" is an instrument you have not tested. Time runs at 30×.

Tracks are **not committed**. Regenerate them from the seed: a fixture on disk
goes stale the first time the boat model improves while still looking
authoritative. Tests never read them, calling `makeTrack()` directly instead.

## The pieces

| File | What it is |
|---|---|
| `js/clock.js` | The seam. One `clock.now()`, so time can be compressed |
| `tools/make_track.js` | The boat, the helm, the sea, and the faults |
| `tools/scenarios.js` | Eight situations, each with a claim to falsify |
| `js/sim.js` | The player, and the rules that keep it off the boat |
| `tests/sim.test.js` | The claims, swept across eight seeds |

### The clock came first

Every buffer here is measured against the wall clock — five minutes of GPS
history, the sparklines' window, the minute of COG the detector compares against
the rest of the run. All correct on a boat, all fatal to a compressed track:
each sample would be outside the window before it arrived, the history would
empty, and `shiftFromCog` would return `null` forever. Nothing errors. It looks
exactly like a broken detector.

Seven sites read the clock. Four already took an injectable `now` that no caller
ever passed, so they only *looked* ready. A test walks `js/` and fails on any
`Date.now()` outside `clock.js`, because the seam rots silently otherwise.

### The boat is the router

There is no second boat model. `solveCourse` already knows what the hull does in
a given wind and tide and `Polar.vmgOptimum` knows the angle to beat at, so the
generator adds only what the router has no model of:

- **A helm, whose wander is correlated.** A person drifts off course and comes
  back over half a minute; they do not jitter. That distinction is the entire
  test of the detector's noise floor — white noise averages away in a minute and
  would never trigger it, while a slow wander looks exactly like a shift.
- **A sea**, modulating speed at wave period.
- **A wind that moves.** The app cannot represent one; its wind is typed and
  held. Handing it a track made under a moving wind is not a flaw in the
  harness, it is the condition `shiftFromCog` exists for.

## What it found

**The noise floor was measuring the wrong thing**, and it took three attempts.

The original compared the shift against the raw spread of COG. But that is the
spread of the *samples*, not the uncertainty of their *mean*, and here the two
are far apart: the wander is autocorrelated at ρ ≈ 0.85, so thirteen samples
carry the information of about one, and the standard error of a one-minute mean
is nine degrees while the floor sat at seven.

Detrending each window was the second wrong answer — right for the long window,
exactly wrong for the short one, where the wander *is* the trend, so removing it
left no noise at all and the floor collapsed.

What separates helm from weather is the timescale: a helm moves the boat between
one fix and the next, a shift moves it over minutes. The noise now comes from
**first differences**, which see the wander and are nearly blind to the shift,
and becomes the error of a mean through the AR(1) relations. The floor is three
of those and adapts — a steady helm earns a sensitive detector, a sloppy one
gets a cautious one.

Measured over eight seeds:

| Scenario | headed | lifted | steady | silent |
|---|---|---|---|---|
| `wander-steady` — *the one that matters* | 0.1% | 0.3% | **99.4%** | 0.2% |
| `tack` (steady wind) | 0.2% | 0.0% | 93.0% | 6.8% |
| `near-calm` | 0.2% | 0.4% | 99.4% | 0.0% |
| `beat-oscillating` | 17.0% | 26.9% | 56.1% | 0.0% |
| `persistent-veer` | 67.2% | 0.0% | 32.8% | 0.0% |
| `reach-shifting` | — | — | — | **100%** |

False alarms in a steady breeze: **26% → 0.4%**, with real shifts still found.

**The TWA gate was too tight.** At 70° a 25° error in the typed wind pushed a
genuine beat outside it and silenced the detector in exactly the case it exists
to survive. Now 80°.

**`[hidden]` was a no-op on some elements.** `.fix { display: flex }` overrides
the user agent's `[hidden]` rule, so hiding that element by property did
nothing. Settled globally with `[hidden] { display: none !important }`.

## Keeping it off the boat

The codebase already draws this line for the hand-placed position — "labelled
everywhere so it can never be mistaken for a real fix", and deliberately not
persisted. Simulation is the same hazard and worse, because it looks alive.

- Starts only from `?sim=<name>` in the URL. Never a setting, never stored, so a
  reload without the flag is a real app.
- **Refuses outright if a real fix has already arrived** this session.
- The rail carries a permanent `SIM · <name>` badge in the warning colour. The
  GPS chip and the Position button stand down — there is no GPS running and they
  have nothing true to report.
- `js/sim.js` is dynamically imported and **not** in the service worker's
  precache list, so offline it is absent rather than merely disabled.

## Still open

- **Faults exist but only four are asserted.** `jump` and `accuracy` are
  generated and nothing checks what the app does with them — a 200 m multipath
  spike is still unfiltered, which is a known gap rather than a surprise.
- **The polar floor clamps silently.** In 3 kn every speed shown is the polar's
  6 kn floor and nothing says so. `tests/sim.test.js` pins the hole so it cannot
  be forgotten; the fix is to thread `Polar.in_range()` through and warn.
- **No replay of real GPS logs.** A track from last year's race would be the
  real test. Nothing is available to replay, and a generator is needed anyway to
  produce shifts on demand.
- **Rate is capped at 60×.** Above that the app's own five-second sampling
  starves the buffers and the windows stop meaning anything. A twenty-hour race
  at 30× is forty minutes, which is the honest limit of this approach.
- **The wake lock and the service worker are on real time**, not the sim clock.
  Believed harmless, unverified.
