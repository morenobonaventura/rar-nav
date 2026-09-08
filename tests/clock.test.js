import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { clock, resetClock } from "../js/clock.js";

const JS_DIR = new URL("../js/", import.meta.url);

test("nothing outside clock.js reads the wall clock directly", () => {
  // The whole point of the seam is that a simulator can move time. One stray
  // Date.now() and a compressed track silently falls out of that buffer --
  // no error, just an instrument that stops reporting.
  // Comments are stripped first. The first version of this test failed on a
  // comment in sim.js that merely MENTIONED Date.now() to say it was avoiding
  // it -- a rule that punishes writing about itself is a rule nobody keeps.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const offenders = readdirSync(JS_DIR)
    .filter((f) => f.endsWith(".js") && f !== "clock.js")
    .filter((f) => strip(readFileSync(new URL(f, JS_DIR), "utf8")).includes("Date.now()"));
  assert.deepEqual(offenders, [], `use clock.now() instead: ${offenders.join(", ")}`);
});

test("the clock can be moved and put back", () => {
  const real = clock.now();
  clock.now = () => 42;
  assert.equal(clock.now(), 42, "a swap is visible through the imported handle");
  resetClock();
  assert.ok(clock.now() >= real, "and the real clock comes back");
});
