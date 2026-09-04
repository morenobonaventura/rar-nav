/**
 * RAR Nav — state and wiring.
 *
 * Everything is recomputed from one `state` object whenever an input changes;
 * there is no animation loop and no timer redrawing the map, which keeps the
 * battery cost of leaving this open on deck close to the screen alone.
 */

import { Polar, solveLeg, solveRoute, fmtBearing, fmtDuration, fmtClock, norm360, haversineNm } from "./nav.js";
import { buildCourse, displayLegs, isOnLand } from "./course.js";
import { createMap, addCoast, CourseLayer, BoatLayer, ProbeLayer, ArrowField } from "./map.js";
import { Gps, Wake, SAMPLE_MS, WINDOW_MS } from "./gps.js";
import { sparkline, timeSeries, histogram, stats, dial, dialDirection } from "./charts.js";
import { renderLegs, renderPolarTable, renderMarksTable, renderStats, fillProbe, describe } from "./ui.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "rarnav.settings.v1";
const POLAR_KEY = "rarnav.polar.v1";

const state = {
  course: null,
  coast: null,
  polarData: null,
  polar: null,
  waypoints: [],
  rows: [],
  route: null,
  direction: "clockwise",
  variant: "full",
  variation: 4.1,
  wind: { tws: 12, twd: 310 },
  current: { drift: 0.4, set: 40 },
  activeIndex: 0,
  probe: null,
  // A hand-placed position, used when the GPS has dropped out or when you want
  // to see what a leg looks like from somewhere you are not yet. It overrides
  // the GPS until cleared, and is labelled everywhere so it can never be
  // mistaken for a real fix. Deliberately not persisted: a position set by
  // hand yesterday must not quietly still be in force at the start gun.
  manual: null,
  placing: false,
  night: false,
  historyField: "sog",
  historyView: "series",
};

const gps = new Gps();
const wake = new Wake();
let map, coastLayer, courseLayer, boatLayer, probeLayer, field;

// --- boot ------------------------------------------------------------------

async function boot() {
  const [course, coast, polar] = await Promise.all([
    fetch("data/course.json").then((r) => r.json()),
    fetch("data/aeolian_coast.geojson").then((r) => r.json()),
    fetch("data/polar_dufour40.json").then((r) => r.json()),
  ]);
  state.course = course;
  state.coast = coast;
  state.variation = course.magnetic_variation_deg;
  state.polarData = loadPolar(polar);
  state.polar = Polar.fromJSON(state.polarData);
  restoreSettings();

  map = createMap($("map"), course.bbox);
  coastLayer = addCoast(map, coast);
  courseLayer = new CourseLayer(map);
  boatLayer = new BoatLayer(map);
  probeLayer = new ProbeLayer(map);
  field = new ArrowField(map, $("field"));
  courseLayer.onSelect = (i) => {
    if (!state.placing) return selectRow(i);
    const t = state.rows[i]?.target;
    if (t) placeBoat({ lat: t.lat, lon: t.lon }); // marks swallow the map click
  };
  map.on("click", (e) => {
    const at = { lat: e.latlng.lat, lon: e.latlng.lng };
    if (state.placing) placeBoat(at);
    else setProbe(at);
  });
  map.on("zoomend", () => courseLayer.refresh());

  wireUi();
  rebuildCourse();
  gps.addEventListener("change", onGps);
  gps.start();

  tickClock();
  setInterval(tickClock, 1000);
  // The buffer ages even when no fix arrives, so refresh the sparklines on the
  // same cadence they are sampled at.
  setInterval(() => drawSparklines(), SAMPLE_MS);

  registerServiceWorker();

  // A handle on the running app, for checking what it thinks is going on
  // without a laptop: rarnav.state.wind, rarnav.gps.history(), and
  // rarnav.feed({lat, lon, sog, cog}) to drive the display from a made-up
  // position when you want to see what a leg will look like before you sail it.
  window.rarnav = {
    state,
    gps,
    recompute,
    feed(fix) {
      gps.onFix({
        timestamp: Date.now(),
        coords: {
          latitude: fix.lat, longitude: fix.lon,
          accuracy: fix.accuracy ?? 8,
          speed: fix.sog == null ? null : fix.sog / 1.943844,
          heading: fix.cog ?? null,
        },
      });
    },
  };
}

// --- where the boat is -----------------------------------------------------

/**
 * The one place anything asks where the boat is. A hand-placed position wins
 * over the GPS until it is cleared; nothing else in the app reads `gps.fix`
 * directly, so a manual position cannot be half-applied.
 *
 * A placed position carries no speed or course — the app has no way to know
 * how fast a pin is moving — so those read as unknown rather than as stale
 * satellite data.
 */
function boatFix() {
  if (state.manual) return { ...state.manual, sog: null, cog: null, accuracy: null, manual: true };
  return gps.fix;
}

/** Fall back to the start line when there is no position at all. */
const boatOrStart = () =>
  boatFix() ?? { lat: state.course.start_finish.lat, lon: state.course.start_finish.lon };

function armPlacing(on) {
  state.placing = on;
  $("btn-place").setAttribute("aria-pressed", String(on));
  map.getContainer().style.cursor = on ? "crosshair" : "";
  onGps();
}

function placeBoat(at) {
  state.manual = at;
  armPlacing(false); // refreshes the chip, gauges, marker and route via onGps
}

/** Hand control back to the satellites. */
function clearManual() {
  state.manual = null;
  onGps();
}

// --- course ----------------------------------------------------------------

function rebuildCourse() {
  state.waypoints = buildCourse(state.course, state.direction, state.variant);
  // The start is where you already are, not somewhere to sail to, so it is not
  // a leg. The finish sits on the same spot and keeps the marker.
  state.rows = displayLegs(state.waypoints).filter((r) => r.kind !== "start");
  state.activeIndex = Math.min(state.activeIndex, state.rows.length - 1);

  const onLand = state.waypoints.filter((w) => isOnLand(w, state.coast));
  $("marks-note").textContent = onLand.length
    ? `${onLand.length} mark(s) fall on land: ${onLand.map((w) => w.name).join(", ")}. Check the coordinates.`
    : state.course.provenance;
  $("marks-note").classList.toggle("warn", onLand.length > 0);
  renderMarksTable($("marks-table"), state.waypoints);
  recompute();
}

/**
 * Solve every remaining waypoint from the boat (or from the start if there is
 * no fix yet), then fold each rounding arc's waypoints back into one row.
 */
function recompute() {
  const from = boatOrStart();
  const firstWp = state.rows[state.activeIndex]?.points[0];
  const startIdx = firstWp ? state.waypoints.indexOf(firstWp) : 0;
  const remaining = state.waypoints.slice(startIdx);

  const solved = solveRoute(from, remaining, state.wind, state.current, state.polar, state.variation);

  // Group the per-waypoint legs back into display rows.
  const rows = [];
  let k = 0;
  for (let i = state.activeIndex; i < state.rows.length; i++) {
    const src = state.rows[i];
    const group = solved.legs.slice(k, k + src.points.length);
    k += src.points.length;
    if (!group.length) break;
    const head = group[0];
    rows.push({
      ...src,
      bearingTrue: head.bearingTrue,
      bearingMag: head.bearingMag,
      mode: head.mode,
      legs: head.legs,
      vmc: head.vmc,
      warnings: head.warnings,
      distNm: group.reduce((s, g) => s + g.distNm, 0),
      hours: group.reduce((s, g) => s + g.hours, 0),
      eta: group[group.length - 1].eta,
      index: i,
    });
  }
  state.route = { rows, totalNm: solved.totalNm, totalHours: solved.totalHours };

  renderLegs($("legs"), rows, 0, (i) => selectRow(rows[i].index));
  $("legs-total").textContent = rows.length
    ? `${solved.totalNm.toFixed(1)} nm · ${fmtDuration(solved.totalHours)}`
    : "";
  $("legs-title").textContent = boatFix() ? "Legs from the boat" : "Legs from the start";

  courseLayer.draw(state.waypoints, state.rows, state.activeIndex);
  field.set(state.wind, state.current);
  updateConditionText();
  refreshProbe();
}

function selectRow(i) {
  state.activeIndex = Math.max(0, Math.min(i, state.rows.length - 1));
  const target = state.rows[state.activeIndex]?.target;
  if (target) {
    setProbe({ lat: target.lat, lon: target.lon }, state.rows[state.activeIndex].name);
    map.panTo([target.lat, target.lon]);
  }
  recompute();
}

// --- the tapped point ------------------------------------------------------

function setProbe(point, name) {
  state.probe = point ? { ...point, name: name ?? "Tapped point" } : null;
  refreshProbe();
}

function refreshProbe() {
  const box = $("probe");
  if (!state.probe) {
    box.hidden = true;
    probeLayer.update(null, null);
    return;
  }
  const from = boatOrStart();
  const leg = solveLeg(from, state.probe, state.wind, state.current, state.polar, state.variation);
  leg.eta = Number.isFinite(leg.hours) ? new Date(Date.now() + leg.hours * 3600e3) : null;

  fillProbe(
    { name: $("probe-name"), pos: $("probe-pos"), dist: $("probe-dist"), brgt: $("probe-brgt"),
      brgm: $("probe-brgm"), eta: $("probe-eta"), etaLabel: $("probe-eta-label"), mode: $("probe-mode") },
    leg,
    state.probe.name,
    state.probe,
    state.variation
  );
  box.hidden = false;
  probeLayer.update(boatFix(), state.probe);
}

// --- GPS -------------------------------------------------------------------

function onGps() {
  const fix = boatFix();
  const fixEl = $("fix");
  if (state.placing) {
    fixEl.dataset.quality = "manual";
    $("fix-text").textContent = "Tap the map to place the boat";
  } else if (state.manual) {
    fixEl.dataset.quality = "manual";
    $("fix-text").textContent = "Position set by hand — tap for GPS";
  } else if (gps.error) {
    fixEl.dataset.quality = "none";
    $("fix-text").textContent = gps.error;
  } else if (fix) {
    const acc = Math.round(fix.accuracy ?? 0);
    fixEl.dataset.quality = acc <= 15 ? "good" : acc <= 50 ? "poor" : "none";
    $("fix-text").textContent = `GPS ±${acc} m${fix.derived ? ", speed from fixes" : ""}`;
  } else {
    fixEl.dataset.quality = "none";
    $("fix-text").textContent = "Waiting for a GPS fix";
  }

  const sogEl = $("sog");
  const cogEl = $("cog");
  sogEl.textContent = fix?.sog != null ? fix.sog.toFixed(1) : "--";
  cogEl.textContent = fix?.cog != null ? String(Math.round(fix.cog)).padStart(3, "0") : "--";
  $("gauge-sog").classList.toggle("stale", fix?.sog == null);
  $("gauge-cog").classList.toggle("stale", fix?.cog == null);

  boatLayer.update(fix);
  drawSparklines();
  recompute();
  if ($("panel-history").open) drawHistory();
}

function drawSparklines() {
  const h = gps.history();
  sparkline($("spark-sog"), h.samples, "sog", false, WINDOW_MS);
  sparkline($("spark-cog"), h.samples, "cog", true, WINDOW_MS);
}

// --- history panel ---------------------------------------------------------

function openHistory(f) {
  state.historyField = f;
  $("hist-title").textContent = f === "sog" ? "Speed over ground" : "Course over ground";
  drawHistory();
  openPanel("panel-history");
}

function drawHistory() {
  const h = gps.history();
  const f = state.historyField;
  const circular = f === "cog";
  const unit = circular ? "°" : "kn";
  const colour = getComputedStyle(document.body).getPropertyValue(circular ? "--tide" : "--wind").trim();
  const canvas = $("hist-canvas");

  if (state.historyView === "series") timeSeries(canvas, h.samples, f, { unit, colour });
  else histogram(canvas, h.samples, f, { unit, colour });

  renderStats($("hist-stats"), stats(h.samples.map((s) => s[f]), circular), unit, circular);

  const mins = (h.spanMs / 60000).toFixed(1);
  const parts = [`${h.samples.length} samples over ${mins} min`];
  if (h.staleMs != null && h.staleMs > SAMPLE_MS * 2)
    parts.push(`newest is ${Math.round(h.staleMs / 1000)} s old`);
  if (h.gapMs > 0) parts.push(`${Math.round(h.gapMs / 1000)} s missing — the app was in the background`);
  $("hist-span").textContent = parts.join(" · ");
  $("hist-span").classList.toggle("warn", h.gapMs > 0 || (h.staleMs ?? 0) > 30000);
}

// --- conditions ------------------------------------------------------------

function updateConditionText() {
  $("wind-dir").textContent = String(Math.round(state.wind.twd)).padStart(3, "0");
  $("wind-spd").textContent = state.wind.tws.toFixed(1);
  $("tide-dir").textContent = String(Math.round(state.current.set)).padStart(3, "0");
  $("tide-spd").textContent = state.current.drift.toFixed(1);
}

function drawDials() {
  const c = getComputedStyle(document.body);
  // The wind arrow flies inward from where the wind comes from; the tide arrow
  // outward toward where the water goes. Both then match the map's arrow field.
  dial($("dial-wind"), state.wind.twd, state.wind.tws, c.getPropertyValue("--wind").trim(), "kn from", true);
  dial($("dial-tide"), state.current.set, state.current.drift, c.getPropertyValue("--tide").trim(), "kn toward");

  const probe = solveLeg(
    { lat: state.course.start_finish.lat, lon: state.course.start_finish.lon },
    { lat: state.course.start_finish.lat + 0.1, lon: state.course.start_finish.lon },
    state.wind, state.current, state.polar, state.variation
  );
  const ww = probe.windOverWater;
  $("ww-note").textContent =
    state.current.drift > 0
      ? `Riding the tide, the boat sails to ${ww.tws.toFixed(1)} kn from ${fmtBearing(ww.twd)} — that is the wind the polar is read against.`
      : "With no tide set, the wind over water is the wind you entered.";
}

// --- panels and inputs -----------------------------------------------------

function openPanel(id) {
  const p = $(id);
  $("scrim").hidden = false;
  p.showModal();
}

function closePanels() {
  document.querySelectorAll("dialog.panel[open]").forEach((d) => d.close());
  $("scrim").hidden = true;
}

function wireUi() {
  $("gauge-sog").addEventListener("click", () => openHistory("sog"));
  $("gauge-cog").addEventListener("click", () => openHistory("cog"));

  // Arm, then the next tap on the map places the boat. Tapping the fix chip
  // hands control back to the satellites.
  $("btn-place").addEventListener("click", () => armPlacing(!state.placing));
  $("fix").addEventListener("click", () => {
    if (state.placing) armPlacing(false);
    else if (state.manual) clearManual();
  });
  $("probe-close").addEventListener("click", () => setProbe(null));
  $("btn-centre").addEventListener("click", () => {
    const fix = boatFix();
    if (fix) map.setView([fix.lat, fix.lon], Math.max(map.getZoom(), 12));
  });
  $("btn-course").addEventListener("click", () => {
    const b = L.latLngBounds(state.waypoints.map((w) => [w.lat, w.lon]));
    map.fitBounds(b.pad(0.12));
  });

  $("grip").addEventListener("click", () => {
    const sheet = $("sheet");
    sheet.dataset.state = sheet.dataset.state === "peek" ? "open" : "peek";
    $("grip").setAttribute("aria-label", sheet.dataset.state === "peek" ? "Expand the leg list" : "Collapse the leg list");
    setTimeout(() => map.invalidateSize(), 240);
  });

  $("cond-wind").addEventListener("click", () => { syncConditionInputs(); drawDials(); openPanel("panel-conditions"); });
  $("cond-tide").addEventListener("click", () => { syncConditionInputs(); drawDials(); openPanel("panel-conditions"); });
  $("cond-more").addEventListener("click", () => { syncSetupInputs(); openPanel("panel-setup"); });

  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closePanels));
  $("scrim").addEventListener("click", closePanels);
  document.querySelectorAll("dialog.panel").forEach((d) =>
    d.addEventListener("close", () => { $("scrim").hidden = true; })
  );

  // Wind and tide numbers
  const bind = (id, apply) =>
    $(id).addEventListener("input", () => {
      const v = Number($(id).value);
      if (Number.isFinite(v)) { apply(v); saveSettings(); drawDials(); recompute(); }
    });
  bind("in-twd", (v) => (state.wind.twd = norm360(v)));
  bind("in-tws", (v) => (state.wind.tws = Math.max(0, v)));
  bind("in-set", (v) => (state.current.set = norm360(v)));
  bind("in-drift", (v) => (state.current.drift = Math.max(0, v)));
  bind("in-var", (v) => (state.variation = v));

  // Dragging the dials
  dragDial($("dial-wind"), (d) => { state.wind.twd = d; $("in-twd").value = Math.round(d); });
  dragDial($("dial-tide"), (d) => { state.current.set = d; $("in-set").value = Math.round(d); });

  // History view toggle
  $("panel-history").querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      state.historyView = b.dataset.view;
      $("panel-history").querySelectorAll("[data-view]").forEach((o) =>
        o.setAttribute("aria-selected", String(o === b)));
      drawHistory();
    })
  );

  // Course direction and variant
  $("seg-direction").querySelectorAll("[data-direction]").forEach((b) =>
    b.addEventListener("click", () => {
      state.direction = b.dataset.direction;
      $("seg-direction").querySelectorAll("[data-direction]").forEach((o) =>
        o.setAttribute("aria-selected", String(o === b)));
      state.activeIndex = 0;
      saveSettings();
      rebuildCourse();
    })
  );
  $("seg-variant").querySelectorAll("[data-variant]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.variant === "cruising" && !state.course.cruising_clockwise?.length) return;
      state.variant = b.dataset.variant;
      $("seg-variant").querySelectorAll("[data-variant]").forEach((o) =>
        o.setAttribute("aria-selected", String(o === b)));
      state.activeIndex = 0;
      saveSettings();
      rebuildCourse();
    })
  );

  // Polar editor
  $("polar-reset").addEventListener("click", async () => {
    localStorage.removeItem(POLAR_KEY);
    state.polarData = await fetch("data/polar_dufour40.json").then((r) => r.json());
    state.polar = Polar.fromJSON(state.polarData);
    renderPolarTable($("polar-table"), state.polarData, editPolar);
    recompute();
  });
  $("polar-export").addEventListener("click", exportPolar);

  // Night mode and wake lock
  $("btn-night").addEventListener("click", () => setNight(!state.night));
  const awake = $("btn-awake");
  if (!wake.supported) awake.hidden = true;
  awake.addEventListener("click", async () => {
    const on = awake.getAttribute("aria-pressed") !== "true";
    const ok = await wake.set(on);
    awake.setAttribute("aria-pressed", String(on && ok));
  });

  $("disclaimer").textContent =
    "Placeholder mark positions, not the official course. Coastline © OpenStreetMap contributors.";
}

/**
 * Drag anywhere on a compass dial to set its direction.
 *
 * Pointer capture rather than a window-level pointerup: without it a pointerup
 * that lands outside the window (or never arrives at all) leaves the dial
 * latched, and every later mouse move over it re-solves the whole route. Touch
 * handlers are not registered alongside pointer ones, because a tap would
 * otherwise run the handler twice.
 */
function dragDial(canvas, apply) {
  let pointer = null;
  const at = (e) => {
    apply(dialDirection(canvas, e.clientX, e.clientY));
    saveSettings();
    drawDials();
    recompute();
  };
  canvas.addEventListener("pointerdown", (e) => {
    pointer = e.pointerId;
    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    at(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointer) return;
    e.preventDefault();
    at(e);
  });
  const release = (e) => {
    if (e.pointerId !== pointer) return;
    canvas.releasePointerCapture?.(e.pointerId);
    pointer = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
}

function syncConditionInputs() {
  $("in-twd").value = Math.round(state.wind.twd);
  $("in-tws").value = state.wind.tws;
  $("in-set").value = Math.round(state.current.set);
  $("in-drift").value = state.current.drift;
}

function syncSetupInputs() {
  $("in-var").value = state.variation;
  $("var-note").textContent = state.course.variation_note;
  $("course-provenance").textContent = state.course.provenance;
  $("polar-note").textContent = state.polarData.note;
  renderPolarTable($("polar-table"), state.polarData, editPolar);
  const cruising = state.course.cruising_clockwise?.length > 0;
  $("seg-variant").querySelector('[data-variant="cruising"]').disabled = !cruising;
}

function editPolar(i, j, value) {
  state.polarData.speeds[i][j] = value;
  if (state.polarData.estimated) state.polarData.estimated[i][j] = false;
  state.polar = Polar.fromJSON(state.polarData);
  localStorage.setItem(POLAR_KEY, JSON.stringify(state.polarData));
  renderPolarTable($("polar-table"), state.polarData, editPolar);
  recompute();
}

function exportPolar() {
  const blob = new Blob([JSON.stringify(state.polarData, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rarnav-polar.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setNight(on) {
  state.night = on;
  document.body.classList.toggle("night", on);
  $("btn-night").setAttribute("aria-pressed", String(on));
  document.querySelector('meta[name="theme-color"]').content = on ? "#000000" : "#dceaf2";
  saveSettings();
  // Layer colours are read from CSS at draw time, so everything must redraw.
  coastLayer.setStyle({
    fillColor: getComputedStyle(document.body).getPropertyValue("--land").trim(),
    color: getComputedStyle(document.body).getPropertyValue("--land-edge").trim(),
  });
  rebuildCourse();
  boatLayer.update(boatFix());
  drawSparklines();
  if ($("panel-history").open) drawHistory();
  if ($("panel-conditions").open) drawDials();
}

// --- persistence -----------------------------------------------------------

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      wind: state.wind, current: state.current, variation: state.variation,
      direction: state.direction, variant: state.variant, night: state.night,
    }));
  } catch { /* storage unavailable; settings just won't survive a reload */ }
}

function restoreSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (!s) return;
    Object.assign(state.wind, s.wind ?? {});
    Object.assign(state.current, s.current ?? {});
    if (Number.isFinite(s.variation)) state.variation = s.variation;
    if (s.direction) state.direction = s.direction;
    if (s.variant) state.variant = s.variant;
    if (s.night) setNightAtBoot();
  } catch { /* ignore malformed settings */ }
}

function setNightAtBoot() {
  state.night = true;
  document.body.classList.add("night");
  $("btn-night").setAttribute("aria-pressed", "true");
  document.querySelector('meta[name="theme-color"]').content = "#000000";
}

function loadPolar(shipped) {
  try {
    const saved = JSON.parse(localStorage.getItem(POLAR_KEY) ?? "null");
    if (saved?.speeds?.length === shipped.speeds.length) return saved;
  } catch { /* fall through to the shipped polar */ }
  return shipped;
}

// --- odds and ends ---------------------------------------------------------

function tickClock() {
  const d = new Date();
  $("clock").textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch(() => {
    /* offline caching unavailable; the app still runs while loaded */
  });
}

boot().catch((e) => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p style="padding:16px;color:#c8102e">Could not start: ${e.message}</p>`
  );
});
