/**
 * The situations worth simulating, and what each one is for.
 *
 * Step 3 of SIMULATION.md: every scenario carries its own TRUTH wind, which is
 * a function of elapsed seconds rather than a constant. That is the one thing
 * the app cannot represent -- its wind is typed and held -- and therefore the
 * one thing worth simulating hardest.
 *
 * These are not a demo reel. Each exists to make a specific claim falsifiable,
 * and the most important one is negative: `wander-steady` must produce no
 * verdict at all. A shift detector that cries wolf gets ignored inside one
 * race, and then the only reading here that a mistyped wind cannot corrupt is
 * worth nothing.
 *
 * Bearings are degrees true, TWD is the direction the wind comes FROM.
 */

/** Open water south of Filicudi: room to beat without meeting an island. */
const OPEN_WATER = { lat: 38.35, lon: 14.70 };
const ALICUDI = { lat: 38.545, lon: 14.36 };

const steady = (twd, tws) => () => ({ twd, tws });

/** ±`amp` degrees on a `periodSec` cycle. The classic oscillating breeze. */
const oscillating = (twd, tws, amp, periodSec) => (t) =>
  ({ twd: twd + amp * Math.sin((2 * Math.PI * t) / periodSec), tws });

/** A one-way shift of `deg` spread over `overSec`, then it stays there. */
const veering = (twd, tws, deg, overSec) => (t) =>
  ({ twd: twd + deg * Math.min(1, t / overSec), tws });

const HELM = { sigmaDeg: 3, rho: 0.9 };   // a decent helm on a quiet day
const SLOPPY = { sigmaDeg: 12, rho: 0.9 }; // tired, at night, in a seaway
const SEA = { sigmaKn: 0.06, periodSec: 7 };

export const SCENARIOS = {
  "beat-oscillating": {
    name: "beat-oscillating",
    what: "Beat, breeze oscillating +/-12 deg on a 6 min cycle",
    proves: "HEADED appears on the headed board within ~60 s of each shift, and lifted on the other",
    seed: 11,
    start: OPEN_WATER,
    mode: "beat",
    startTack: "starboard",
    wind: oscillating(310, 12, 12, 360),
    durationSec: 30 * 60,
    wander: HELM,
    sea: SEA,
  },

  "beat-oscillating-wrong-wind": {
    name: "beat-oscillating-wrong-wind",
    what: "The same beat, to be read by an app whose TWD is 25 deg wrong",
    proves: "Identical verdicts and sizes to beat-oscillating: the typed wind cannot corrupt it",
    seed: 11,
    start: OPEN_WATER,
    mode: "beat",
    startTack: "starboard",
    wind: oscillating(310, 12, 12, 360),
    durationSec: 30 * 60,
    wander: HELM,
    sea: SEA,
    appTwdError: 25,
  },

  tack: {
    name: "tack",
    what: "Steady breeze, one tack ten minutes in",
    proves: "The detector goes quiet across the tack and stays quiet until it has a baseline",
    seed: 23,
    start: OPEN_WATER,
    mode: "beat",
    startTack: "starboard",
    wind: steady(310, 12),
    tacks: [10 * 60],
    durationSec: 20 * 60,
    wander: HELM,
    sea: SEA,
  },

  "wander-steady": {
    name: "wander-steady",
    what: "Steady breeze, helm wandering +/-12 deg",
    proves: "steady throughout. NO header is ever called on a wave. The one that matters most",
    seed: 37,
    start: OPEN_WATER,
    mode: "beat",
    startTack: "starboard",
    wind: steady(310, 12),
    durationSec: 30 * 60,
    wander: SLOPPY,
    sea: SEA,
  },

  "persistent-veer": {
    name: "persistent-veer",
    what: "A 30 deg veer over 20 minutes, and it stays",
    proves: "Headed on one board for the duration, not a flicker in and out",
    seed: 41,
    start: OPEN_WATER,
    mode: "beat",
    startTack: "starboard",
    wind: veering(310, 12, 30, 20 * 60),
    durationSec: 30 * 60,
    wander: HELM,
    sea: SEA,
  },

  "reach-shifting": {
    name: "reach-shifting",
    what: "Beam reach on a compass course, same shifting breeze",
    proves: "Silence. Off the wind COG follows the helm, not the weather",
    seed: 53,
    start: OPEN_WATER,
    mode: "steer",
    heading: 40,
    wind: oscillating(310, 12, 12, 360),
    durationSec: 30 * 60,
    wander: HELM,
    sea: SEA,
  },

  "layline-approach": {
    name: "layline-approach",
    what: "Steering at Alicudi from open water, in a foul tide",
    proves: "Distance falls monotonically and the ETA converges; no jump backwards",
    seed: 67,
    start: OPEN_WATER,
    mode: "steer",
    target: ALICUDI,
    // From the south-west, so the 306 deg track to Alicudi is a fetch. The
    // first draft of this put the wind on the nose and the boat sat still for
    // an hour, which is a fair test of the generator and a useless one of the
    // approach.
    wind: steady(216, 14),
    current: { set: 90, drift: 0.8 },
    durationSec: 60 * 60,
    wander: HELM,
    sea: SEA,
  },

  "near-calm": {
    name: "near-calm",
    what: "TWS 3 kn, below the polar's 6 kn floor",
    proves: "Every speed on screen is a clamp, and nothing currently says so",
    seed: 71,
    start: OPEN_WATER,
    mode: "beat",
    startTack: "starboard",
    wind: steady(310, 3),
    durationSec: 20 * 60,
    wander: HELM,
    sea: SEA,
  },
};
