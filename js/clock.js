/**
 * The one place the app asks what time it is.
 *
 * Every buffer in here is measured against the wall clock: the GPS history
 * keeps five minutes, the sparklines plot against a five-minute window, the
 * shift detector compares the last minute of COG against the rest of the run.
 * All of that is correct on a boat and fatal to a simulation, because a
 * simulator has to compress a twenty-hour race into minutes. Feed a compressed
 * track against real time and every sample is already outside the window by the
 * time it arrives: the history empties, the sparklines blank, and the detector
 * returns null forever. Nothing errors. It just looks like a broken detector.
 *
 * So the clock is a seam. `clock.now` is a function, not a value, and the
 * simulator replaces it with one that runs on its own time base. Nothing else
 * in the app is allowed to call `Date.now()`; a test enforces that.
 *
 * Deliberately a mutable property rather than a module-level `let` with a
 * setter: the swap has to be visible to modules that captured `clock` at import
 * time, which is all of them.
 */
export const clock = {
  /** Milliseconds since the epoch, on whatever time base is in force. */
  now: () => Date.now(),
};

/** Put the real clock back. Always safe to call. */
export function resetClock() {
  clock.now = () => Date.now();
}
