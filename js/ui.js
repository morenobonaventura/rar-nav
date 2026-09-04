/**
 * DOM rendering. Everything here takes data and writes elements; the state and
 * the event wiring live in app.js.
 */

import { fmtBearing, fmtDistance, fmtDuration, fmtClock, norm360 } from "./nav.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** How a leg is sailed, in the words a navigator would use. */
export function modeLabel(leg) {
  if (leg.mode === "unreachable") return "cannot lay";
  if (leg.mode === "beat") return "beat";
  if (leg.mode === "run") return "run";
  if (leg.mode === "twoangles") return "two angles";
  const twa = Math.abs(leg.legs[0]?.twa ?? 0);
  if (twa < 60) return "close hauled";
  if (twa < 80) return "close reach";
  if (twa < 100) return "beam reach";
  if (twa < 140) return "broad reach";
  return "running";
}

/** Mark name, short enough to survive a 393 px screen. */
export function legLabel(row) {
  if (row.kind === "island_round") return `${row.island} (${row.side === "port" ? "P" : "S"})`;
  if (row.kind === "gate") return `${row.name.replace(/^gate \((.*)\)$/, "$1").replace("-", "–")} gate`;
  return row.name;
}

/**
 * The leg list: one row per mark, rounding arcs collapsed into one.
 *
 * Two lines, because the four numbers a navigator wants — distance, bearing,
 * time to go and clock ETA — do not fit across a phone in one. Distance and
 * time to go lead; how to sail it and the exact bearings sit underneath.
 */
export function renderLegs(list, rows, activeIndex, onSelect) {
  list.replaceChildren();
  rows.forEach((row, i) => {
    const li = el("li");
    const b = el("button", "leg");
    b.type = "button";
    if (i === activeIndex) b.setAttribute("aria-current", "true");
    if (row.mode === "unreachable") b.classList.add("unreachable");

    b.append(el("span", "leg-n", String(i + 1)));
    b.append(el("span", "leg-name", legLabel(row)));

    const figures = el("span", "leg-figures");
    figures.append(el("span", "leg-dist", fmtDistance(row.distNm)));
    figures.append(el("span", "leg-eta", fmtDuration(row.hours)));
    b.append(figures);

    const sub = el("span", `leg-sub ${row.mode}`);
    sub.append(el("em", null, modeLabel(row)));
    sub.append(document.createTextNode(
      ` ${fmtBearing(row.bearingTrue)}T · ${fmtBearing(row.bearingMag)}M`
    ));
    b.append(sub);
    b.append(el("span", "leg-clock", row.eta ? fmtClock(row.eta) : "--:--"));

    b.addEventListener("click", () => onSelect(i));
    li.append(b);
    list.append(li);
  });
}

/** Fill the tapped-point readout. */
export function fillProbe(refs, leg, title, point, variation) {
  refs.name.textContent = title;
  refs.pos.textContent = `${fmtLat(point.lat)} ${fmtLon(point.lon)}`;
  refs.dist.textContent = fmtDistance(leg.distNm);
  refs.brgt.textContent = fmtBearing(leg.bearingTrue);
  refs.brgm.textContent = fmtBearing(leg.bearingMag);

  if (leg.mode === "unreachable") {
    refs.eta.textContent = "--";
    refs.etaLabel.textContent = "cannot lay";
  } else {
    refs.eta.textContent = fmtDuration(leg.hours);
    refs.etaLabel.textContent = leg.eta ? `arrive ${fmtClock(leg.eta)}` : "time to go";
  }

  refs.mode.className = "probe-mode";
  if (leg.warnings.length) {
    refs.mode.classList.add("warn");
    refs.mode.textContent = leg.warnings[0];
    return;
  }
  refs.mode.textContent = describe(leg, variation);
}

/** One sentence saying how to sail this leg. */
export function describe(leg, variation) {
  if (leg.mode === "unreachable") return "The tide sets you back faster than you can sail.";
  const [a, b] = leg.legs;
  const speed = (l) => `${l.boatSpeed.toFixed(1)} kn`;
  if (leg.legs.length === 1) {
    const steer = Math.abs(norm360(a.headingTrue) - norm360(leg.bearingTrue)) > 0.5;
    const crab = steer
      ? ` Steer ${fmtBearing(a.headingTrue)}T / ${fmtBearing(a.headingMag)}M to hold the track.`
      : "";
    return `${modeLabel(leg)} at TWA ${Math.round(Math.abs(a.twa))}°, ${speed(a)}, ${a.sog.toFixed(1)} kn over ground.${crab}`;
  }
  const word = leg.mode === "beat" ? "Tack" : leg.mode === "run" ? "Gybe" : "Alternate";
  const pct = Math.round(a.fraction * 100);
  // Where the two laylines meet, if the track has been worked out.
  const corner = leg.paths?.[0];
  const turn = corner?.tackAfterNm
    ? ` ${word} at ${fmtDistance(corner.tackAfterNm)} (${fmtDuration(corner.tackAfterHours)}) on the ${a.tack} board, or take the other side.`
    : "";
  return (
    `${word} between ${fmtBearing(a.headingTrue)}T (${a.tack}, ${speed(a)}) and ` +
    `${fmtBearing(b.headingTrue)}T (${b.tack}, ${speed(b)}) — ` +
    `${pct}% of the time on the first. Made good ${leg.vmc.toFixed(1)} kn.${turn}`
  );
}

const fmtLat = (v) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? "N" : "S"}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? "E" : "W"}`;

/**
 * The polar editor. Cells outside the measured box are tinted, because those
 * numbers are this app's estimates and the boat's own are better.
 */
export function renderPolarTable(table, data, onEdit) {
  table.replaceChildren();
  const thead = el("thead");
  const hr = el("tr");
  hr.append(el("th", null, "TWA \\ TWS"));
  data.tws.forEach((t) => hr.append(el("th", null, `${t}`)));
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  data.twa.forEach((angle, j) => {
    const tr = el("tr");
    tr.append(el("th", null, `${angle}°`));
    data.tws.forEach((_, i) => {
      const td = el("td");
      if (data.estimated?.[i]?.[j]) td.classList.add("estimated");
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.01";
      input.min = "0";
      input.inputMode = "decimal";
      input.value = data.speeds[i][j];
      input.addEventListener("change", () => {
        const v = Math.max(0, Number(input.value) || 0);
        input.value = v;
        onEdit(i, j, v);
      });
      td.append(input);
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody);
}

/** Read-only list of where the marks actually are, with their provenance. */
export function renderMarksTable(table, waypoints) {
  table.replaceChildren();
  const thead = el("thead");
  const hr = el("tr");
  ["Mark", "Latitude", "Longitude", "Leg"].forEach((h) => hr.append(el("th", null, h)));
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  waypoints.forEach((w) => {
    const tr = el("tr");
    tr.append(el("th", null, w.name));
    tr.append(el("td", null, fmtLat(w.lat)));
    tr.append(el("td", null, fmtLon(w.lon)));
    tr.append(el("td", null, w.legNm ? fmtDistance(w.legNm) : "—"));
    tbody.append(tr);
  });
  table.append(tbody);
}

/** Stat tiles under the history chart. */
export function renderStats(host, st, unit, circular) {
  host.replaceChildren();
  if (!st) {
    host.append(el("div", null, "No samples yet"));
    return;
  }
  const round = (v) => (circular ? `${Math.round(((v % 360) + 360) % 360)}°` : v.toFixed(1));
  const tiles = circular
    ? [["mean", round(st.mean)], ["spread", `${Math.round(st.spread)}°`],
       ["swing", `${Math.round(st.sd)}°`], ["samples", String(st.n)]]
    : [["mean", `${st.mean.toFixed(1)}`], ["min", `${st.min.toFixed(1)}`],
       ["max", `${st.max.toFixed(1)}`], ["samples", String(st.n)]];
  for (const [label, value] of tiles) {
    const d = el("div");
    d.append(el("b", null, value + (circular || label === "samples" ? "" : ` ${unit}`)));
    d.append(el("span", null, label));
    host.append(d);
  }
}
