/**
 * The shift detector, against simulated boats rather than hand-built arrays.
 *
 * `nav.test.js` proves the arithmetic on tracks written by hand, where the only
 * thing that moves is the thing under test. These are the opposite: a boat with
 * a wandering helm in a seaway, where the signal is buried in exactly the noise
 * that made the first two versions of the noise floor useless.
 *
 * Everything is generated from a seed, so a failure here is reproducible. The
 * seeds are swept rather than fixed at one, because a threshold tuned until a
 * single seed passes is not a test, it is a coincidence.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeTrack, applyFaults, polar } from "../tools/make_track.js";
import { SCENARIOS } from "../tools/scenarios.js";
import { shiftFromCog, haversineNm, angDiff } from "../js/nav.js";
import { Gps, WINDOW_MS } from "../js/gps.js";
import { clock, resetClock } from "../js/clock.js";

const p = polar();
const SEEDS = [11, 12, 13, 14, 15, 16, 17, 18];

/** Every verdict the app would have shown, sample by sample, as it played. */
function verdicts(scn, { twdError = 0, seed } = {}) {
  const track = makeTrack({ ...scn, ...(seed ? { seed } : {}) }, p);
  const appTwd = 310 + twdError;
  return track.samples.map((s, i) => {
    if (i < 20) return null;
    const window = track.samples.slice(0, i + 1);
    return { at: s, shift: shiftFromCog(window, appTwd, s.t) };
  });
}

const rate = (rows, pred) => rows.filter(Boolean).filter(pred).length / rows.filter(Boolean).length;
const said = (state) => (r) => r.shift?.state === state;

// --- the negative one, which matters most ----------------------------------

test("a wandering helm in a steady breeze is never called a shift", () => {
  // The scenario the first noise floor failed outright: 26% of samples were
  // called headed or lifted in a wind that never moved. A detector that cries
  // wolf gets ignored inside one race, and then it is worth nothing.
  for (const seed of SEEDS) {
    const rows = verdicts(SCENARIOS["wander-steady"], { seed });
    const wrong = rate(rows, (r) => r.shift && r.shift.state !== "steady");
    assert.ok(wrong < 0.03, `seed ${seed}: ${(wrong * 100).toFixed(1)}% false verdicts`);
  }
});

test("a near-calm steady breeze is not a shift either", () => {
  const rows = verdicts(SCENARIOS["near-calm"]);
  assert.ok(rate(rows, (r) => r.shift && r.shift.state !== "steady") < 0.02);
});

// --- the positive ones ------------------------------------------------------

test("an oscillating breeze is read as headers and lifts, and both appear", () => {
  const rows = verdicts(SCENARIOS["beat-oscillating"]);
  assert.ok(rate(rows, said("headed")) > 0.05, "no headers found in a shifting breeze");
  assert.ok(rate(rows, said("lifted")) > 0.05, "no lifts found either");
});

test("what it calls a header really is the wind coming forward", () => {
  // Checked against the ground truth the app never sees: the generator's own
  // wind. Getting the SIGN wrong here would sail the wrong side of every shift
  // on the course, so this has to hold for essentially every verdict called.
  const scn = SCENARIOS["beat-oscillating"];
  const track = makeTrack(scn, p);
  let checked = 0, agreed = 0;
  for (let i = 20; i < track.samples.length; i++) {
    const s = shiftFromCog(track.samples.slice(0, i + 1), 310, track.samples[i].t);
    if (!s || s.state === "steady") continue;
    // The detector compares the last minute against the whole run on this
    // tack, so a "header" means the wind is now right of its RUNNING MEAN --
    // not that it moved in the last minute. That is the more useful of the
    // two: it is the sense in which you tack on the headers and not on every
    // wobble. The truth check has to ask the same question.
    const base = track.samples.slice(0, Math.max(1, i - 12));
    const meanTwd = base.reduce((a, x) => a + x.truth.twd, 0) / base.length;
    const veeredRight = angDiff(track.samples[i].truth.twd, meanTwd) > 0;
    const tackSign = track.samples[i].truth.tack === "starboard" ? 1 : -1;
    // starboard: veering right heads you. port: the mirror.
    const shouldBeHeaded = tackSign > 0 ? veeredRight : !veeredRight;
    checked++;
    if ((s.state === "headed") === shouldBeHeaded) agreed++;
  }
  assert.ok(checked > 50, `only ${checked} verdicts to check`);
  assert.ok(agreed / checked > 0.9,
    `sign agrees with the truth wind only ${((agreed / checked) * 100).toFixed(0)}% of the time`);
});

test("a persistent veer is a sustained header on one board, not a flicker", () => {
  const rows = verdicts(SCENARIOS["persistent-veer"]);
  assert.ok(rate(rows, said("headed")) > 0.4, "a 30 degree veer should dominate the run");
  assert.ok(rate(rows, said("lifted")) < 0.02, "and it must never read as a lift");
});

// --- the claim the whole design rests on ------------------------------------

test("a 25 degree error in the typed wind does not change what it says", () => {
  // The detector's reason to exist: the app's wind is typed and can be wrong,
  // and this reading must survive that. Compared verdict by verdict on ONE
  // track, read by two apps whose winds differ by 25 degrees.
  const right = verdicts(SCENARIOS["beat-oscillating"]);
  const wrong = verdicts(SCENARIOS["beat-oscillating"], { twdError: 25 });

  let both = 0, same = 0;
  for (let i = 0; i < right.length; i++) {
    if (!right[i]?.shift || !wrong[i]?.shift) continue;
    both++;
    if (right[i].shift.state === wrong[i].shift.state) same++;
  }
  assert.ok(both > 100, `only ${both} samples where both spoke`);
  assert.ok(same / both > 0.95,
    `verdicts agree only ${((same / both) * 100).toFixed(0)}% of the time`);
});

// --- the ones where silence is the right answer -----------------------------

test("off the wind it says nothing at all", () => {
  const rows = verdicts(SCENARIOS["reach-shifting"]);
  assert.equal(rate(rows, (r) => r.shift !== null), 0,
    "a beam reach has no tack to lose, and COG there follows the helm");
});

test("it goes quiet across a tack and needs a run before it speaks again", () => {
  const scn = SCENARIOS["tack"];
  const track = makeTrack(scn, p);
  const tackAt = track.samples[0].t + scn.tacks[0] * 1000;

  const after = track.samples
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.t > tackAt);
  const firstSpoke = after.find(({ s, i }) =>
    shiftFromCog(track.samples.slice(0, i + 1), 310, s.t) !== null);

  assert.ok(firstSpoke, "it never spoke again after the tack");
  const blackoutS = (firstSpoke.s.t - tackAt) / 1000;
  assert.ok(blackoutS >= 60, `spoke again after only ${blackoutS} s, with no baseline to compare`);
  assert.ok(blackoutS <= 180, `still silent ${blackoutS} s after the tack`);
});

// --- the boat itself --------------------------------------------------------

test("steering at a mark actually closes on it", () => {
  const scn = SCENARIOS["layline-approach"];
  const track = makeTrack(scn, p);
  const to = (s) => haversineNm(s, scn.target);

  assert.ok(to(track.samples[0]) - to(track.samples[track.samples.length - 1]) > 3,
    "an hour of steering at Alicudi should eat several miles");
  // Not strictly monotonic -- a foul tide and a wandering helm both push back.
  const backwards = track.samples.filter((s, i) => i > 0 && to(s) > to(track.samples[i - 1])).length;
  assert.ok(backwards / track.samples.length < 0.1,
    "the boat should not spend a tenth of the hour going backwards");
});

test("the polar floor is silently clamping the whole near-calm run", () => {
  // Not a passing feature -- a documented hole, pinned so it cannot be
  // forgotten. In 3 kn of breeze every speed the app shows is the polar's 6 kn
  // floor, and nothing anywhere says so. See SIMULATION.md, scenario 8.
  const track = makeTrack(SCENARIOS["near-calm"], p);
  const floor = p.twsGrid[0];
  assert.ok(SCENARIOS["near-calm"].wind(0).tws < floor,
    "scenario is meant to sit below the polar's calibrated range");
  const moving = track.samples.filter((s) => s.sog > 3).length;
  assert.ok(moving / track.samples.length > 0.9,
    "the boat sails on regardless, at a speed the polar cannot support");
});

// --- the faults -------------------------------------------------------------

/**
 * Play a track through the real Gps class, on the sim clock, exactly as
 * js/sim.js does. Testing the fallbacks through anything else would be testing
 * a copy of the app rather than the app.
 */
function play(track) {
  const gps = new Gps();
  gps.samples = [];
  for (const s of track.samples) {
    clock.now = () => s.t;
    gps.onFix({
      timestamp: s.t,
      coords: {
        latitude: s.lat, longitude: s.lon, accuracy: s.accuracy ?? 8,
        speed: s.sog == null ? null : s.sog / 1.943844,
        heading: s.cog ?? null,
      },
    });
  }
  const last = track.samples[track.samples.length - 1];
  const history = gps.history(last.t);
  resetClock();
  return { gps, history };
}

test("a suspended app leaves a gap the history owns up to", () => {
  // iOS suspends a web app the moment it is backgrounded. The charts must draw
  // that as a hole rather than a smooth line across data nobody collected.
  const scn = { ...SCENARIOS["beat-oscillating"], durationSec: 8 * 60 };
  const clean = play(makeTrack(scn, p)).history;
  const gapped = play(applyFaults(makeTrack(scn, p),
    [{ kind: "dropout", fromSec: 300, toSec: 390 }])).history;

  assert.equal(clean.gapMs, 0, "a clean track should report no gap");
  assert.ok(gapped.gapMs >= 90000, `a 90 s dropout reported as ${gapped.gapMs} ms`);
});

test("the chip going null is covered by differencing successive fixes", () => {
  // coords.speed and coords.heading go null whenever the GPS feels like it.
  // gps.js falls back to differencing positions; until now nothing had ever
  // fed that path a realistic stream.
  const scn = { ...SCENARIOS["beat-oscillating"], durationSec: 8 * 60 };
  const { history } = play(applyFaults(makeTrack(scn, p), [
    { kind: "nullSpeed", fromSec: 120, toSec: 300 },
    { kind: "nullHeading", fromSec: 120, toSec: 300 },
  ]));

  const blind = history.samples.filter((s) => s.t - history.samples[0].t > 130000);
  assert.ok(blind.length > 10, "not enough samples in the blind window");
  assert.ok(blind.every((s) => s.cog != null), "COG went missing instead of being derived");
  assert.ok(blind.every((s) => s.sog > 1), "SOG went missing instead of being derived");
});

test("below a knot the heading is held, not swung about", () => {
  // A heading is meaningless when stopped, and a swinging COG would look to
  // the shift detector exactly like a wind that had gone mad.
  const scn = { ...SCENARIOS["beat-oscillating"], durationSec: 8 * 60 };
  const track = applyFaults(makeTrack(scn, p), [
    { kind: "becalmed", fromSec: 240, toSec: 420 },
    { kind: "nullHeading", fromSec: 240, toSec: 420 },
  ]);
  const { history } = play(track);
  // Inside the becalming only. Past it the boat sails again and its COG is
  // supposed to move -- the first version of this test read the last twenty
  // samples, which ran an entire minute past the end of the hole.
  // From the TRACK's start, not the history's: history keeps only the last five
  // minutes, so its first sample is already well into the run and measuring
  // from it put this window past the end of the track entirely.
  const t0 = track.samples[0].t;
  const drifting = history.samples.filter((s) => {
    const at = (s.t - t0) / 1000;
    return at > 260 && at < 410;
  });
  assert.ok(drifting.length > 10, `only ${drifting.length} samples inside the hole`);
  const spread = Math.max(...drifting.map((s) => Math.abs(angDiff(s.cog, drifting[0].cog))));
  assert.ok(spread < 5, `COG wandered ${spread.toFixed(0)} deg while stopped`);
});

test("a drifting boat produces no shift verdict", () => {
  const scn = { ...SCENARIOS["beat-oscillating"], durationSec: 10 * 60 };
  const track = applyFaults(makeTrack(scn, p), [{ kind: "becalmed", fromSec: 300, toSec: 600 }]);
  const last = track.samples[track.samples.length - 1];
  assert.equal(shiftFromCog(track.samples, 310, last.t), null,
    "a boat going nowhere has no tack to be headed on");
});
