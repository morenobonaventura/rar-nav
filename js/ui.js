/**
 * DOM rendering. Everything here takes data and writes elements; the state and
 * the event wiring live in app.js.
 */

import { fmtBearing, fmtDistance, fmtDuration, fmtClock } from "./nav.js";

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
  if (row.kind === "rounding") return `${row.island} (${row.side === "port" ? "P" : "S"})`;
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

/**
 * The waypoints you saved yourself, under the course legs in the same list.
 *
 * Same row as a leg, because they are sailed to the same way, with two
 * differences: a flag instead of a leg number, since they have no place in the
 * course and numbering them alongside it would invite sailing to the wrong
 * one, and a bin, which only these have. Deleting takes two taps -- the first
 * arms the row, the second does it. There is no undo on a phone in a wet
 * pocket, and a stray thumb on a bin is exactly the kind of tap that happens
 * on the way to windward.
 */
export function renderSaved(list, rows, { label, stored, activeId, armedId, onSelect, onDelete }) {
  if (!rows.length) return;
  list.append(el("li", `legs-sep${stored ? "" : " warn"}`, label));

  rows.forEach((row) => {
    const li = el("li", "saved-row");
    const b = el("button", "leg");
    b.type = "button";
    if (row.id === activeId) b.setAttribute("aria-current", "true");
    if (row.mode === "unreachable") b.classList.add("unreachable");

    b.append(el("span", "leg-n", "\u2691"));
    b.append(el("span", "leg-name", row.name));

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
    b.addEventListener("click", () => onSelect(row.id));

    const armed = row.id === armedId;
    const bin = el("button", `bin${armed ? " armed" : ""}`);
    bin.type = "button";
    bin.title = armed ? `Delete ${row.name}` : `Delete ${row.name} — tap twice`;
    bin.setAttribute("aria-label", bin.title);
    if (armed) bin.append(el("span", null, "Delete?"));
    else bin.innerHTML = TRASH;
    bin.addEventListener("click", () => onDelete(row.id));

    li.append(b, bin);
    list.append(li);
  });
}

const TRASH = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 7h16M10 4.5h4a1 1 0 0 1 1 1V7H9V5.5a1 1 0 0 1 1-1z"/>
  <path d="M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7"/>
  <path d="M10.5 10.5v7M13.5 10.5v7"/>
</svg>`;

/**
 * The recordings in Setup, newest first.
 *
 * Each row says when it ran and how much is in it, and carries the only two
 * things you can do to one: take it off the phone, or throw it away. Deleting
 * takes two taps -- there is no undo and no copy anywhere else, and this is
 * the one control in the app that can lose a whole race.
 */
export function renderRecordingList(host, rows, { armedId, onExport, onDelete }) {
  host.replaceChildren();
  rows.forEach((r) => {
    const li = el("li", "rec-row");
    const when = el("div", "rec-when");
    when.append(el("b", null, fmtRecSpan(r)));
    const facts = [`${r.count.toLocaleString()} ${r.count === 1 ? "fix" : "fixes"}`];
    if (r.dropped) facts.push(`${r.dropped.toLocaleString()} dropped`);
    const sub = el("span", null, facts.join(" · "));
    if (r.recording) {
      sub.append(document.createTextNode(" · "));
      sub.append(el("em", "rec-live", "RECORDING"));
    }
    when.append(sub);
    li.append(when);

    const csv = el("button", "ghost-btn", "CSV");
    csv.type = "button";
    csv.disabled = !r.count;
    csv.title = `Download this recording as a CSV file`;
    csv.addEventListener("click", () => onExport(r.id));

    const armed = r.id === armedId;
    const del = el("button", `ghost-btn${armed ? " danger" : ""}`, armed ? "Sure?" : "Delete");
    del.type = "button";
    del.addEventListener("click", () => onDelete(r.id));

    li.append(csv, del);
    host.append(li);
  });
}

/** "26 Sep 09:15 → 11:02", with the date repeated only when it changes, and an
 *  open recording left open rather than given an end it does not have yet. */
function fmtRecSpan(r) {
  const a = new Date(r.startedAt);
  const day = (d) => d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  if (r.recording) return `${day(a)} ${fmtClock(a)} →`;
  const b = new Date(r.endedAt ?? r.lastT ?? r.startedAt);
  const sameDay = a.toDateString() === b.toDateString();
  return `${day(a)} ${fmtClock(a)} → ${sameDay ? "" : `${day(b)} `}${fmtClock(b)}`;
}

/** Fill the tapped-point readout. */
export function fillProbe(refs, leg, title, point) {
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

  // Warnings only. The readout states the numbers and stops: a paragraph of
  // prose is not something anyone reads off a phone clipped to a bulkhead.
  refs.mode.className = "probe-mode";
  refs.mode.hidden = !leg.warnings.length;
  refs.mode.classList.toggle("warn", leg.warnings.length > 0);
  refs.mode.textContent = leg.warnings[0] ?? "";
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
