/**
 * Map layers: coastline, course, boat, and the wind/tide arrow field.
 *
 * Leaflet with NO tile layer. Everything drawn here comes from files in data/,
 * so the map works identically in airplane mode — and a vector coast reads
 * better at sea than raster tiles, which are mostly empty blue out here.
 *
 * The arrow field is a plain canvas sitting over the map rather than a Leaflet
 * pane, because it is redrawn from scratch on every move and has no business
 * being transformed. It hides itself during the zoom animation instead of
 * fighting Leaflet's transform, then redraws once the gesture settles.
 */

/* global L */

const DEG = Math.PI / 180;

export function createMap(el, bbox) {
  const map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    tap: false, // let our own click handler own taps; Leaflet's shim double-fires on iOS
    maxZoom: 16,
    minZoom: 7,
    zoomSnap: 0,
    worldCopyJump: false,
  });
  map.attributionControl.setPrefix("");
  map.attributionControl.addAttribution("Coastline © OpenStreetMap contributors (ODbL)");
  map.fitBounds([
    [bbox.lat_min, bbox.lon_min],
    [bbox.lat_max, bbox.lon_max],
  ]);
  map.setMaxBounds([
    [bbox.lat_min - 0.6, bbox.lon_min - 0.6],
    [bbox.lat_max + 0.6, bbox.lon_max + 0.6],
  ]);
  return map;
}

const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

/** Land polygons, drawn on canvas so a few thousand points stay cheap to pan. */
export function addCoast(map, geojson) {
  return L.geoJSON(geojson, {
    renderer: L.canvas({ padding: 0.3 }),
    style: () => ({
      fillColor: css("--land"),
      fillOpacity: 1,
      color: css("--land-edge"),
      weight: 1,
      lineJoin: "round",
    }),
    interactive: false,
  }).addTo(map);
}

/**
 * The course: rhumb lines between marks, rounding arcs as curves, and a
 * labelled mark at each turning point. Rounding arcs are drawn as arcs so it is
 * visible at a glance which side of an island the boat has to pass.
 */
export class CourseLayer {
  constructor(map) {
    this.map = map;
    this.group = L.layerGroup().addTo(map);
    this.onSelect = null;
  }

  draw(waypoints, displayRows, activeIndex) {
    this.group.clearLayers();
    if (!waypoints.length) return;
    this.last = { waypoints, displayRows, activeIndex };

    // Alicudi and Filicudi are 10 nm apart; zoomed out to the whole course that
    // is 35 px, and every label collides with its neighbour. Declutter the way
    // a plotter does — drop the labels when they cannot be read, but never the
    // one for the mark being sailed to.
    const labelled = this.map.getZoom() >= 9.5;

    const track = waypoints.map((w) => [w.lat, w.lon]);
    L.polyline(track, {
      color: css("--ink-soft"),
      weight: 1.5,
      opacity: 0.55,
      dashArray: "1 5",
      lineCap: "round",
      interactive: false,
    }).addTo(this.group);

    displayRows.forEach((row, i) => {
      const active = i === activeIndex;

      // A rounding is a run of buoys down one side of the island. Draw each of
      // them, not a fat arc: they are the things you have to honour.
      if (row.kind === "rounding") {
        row.points.forEach((m) =>
          L.circleMarker([m.lat, m.lon], {
            radius: active ? 4.5 : 3,
            color: css("--mark"),
            weight: 2,
            fillColor: css("--mark"),
            fillOpacity: active ? 0.9 : 0.5,
            interactive: false,
          }).addTo(this.group)
        );
      }

      // A gate is the water between two buoys, so draw the line you sail through.
      if (row.kind === "gate" && row.gate?.length === 2) {
        L.polyline(row.gate.map((m) => [m.lat, m.lon]), {
          color: css("--mark"),
          weight: active ? 4 : 3,
          opacity: active ? 1 : 0.75,
          lineCap: "butt",
          interactive: false,
        }).addTo(this.group);
        row.gate.forEach((m) =>
          L.circleMarker([m.lat, m.lon], {
            radius: 4,
            color: css("--mark"),
            weight: 2,
            fillColor: css("--mark"),
            fillOpacity: 1,
            interactive: false,
          }).addTo(this.group)
        );
      }

      const p = row.target;
      const isEnd = row.kind === "start" || row.kind === "finish";
      L.circleMarker([p.lat, p.lon], {
        radius: active ? 8 : 6,
        color: isEnd ? css("--boat") : css("--mark"),
        weight: 2.5,
        fillColor: css("--paper"),
        fillOpacity: row.kind === "gate" ? 0 : 1,
      })
        .addTo(this.group)
        .on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          this.onSelect?.(i);
        });

      if (labelled || active) {
        L.marker([p.lat, p.lon], {
          interactive: false,
          icon: L.divIcon({
            className: "",
            html: `<span class="mark-label">${escapeHtml(shortName(row))}</span>`,
            iconSize: [0, 0],
            iconAnchor: [-9, 7],
          }),
        }).addTo(this.group);
      }
    });
  }

  /** Redraw at the current zoom, so labels appear and vanish with it. */
  refresh() {
    if (this.last) this.draw(this.last.waypoints, this.last.displayRows, this.last.activeIndex);
  }
}

const shortName = (row) => {
  if (row.kind === "rounding") return `${row.island} ${row.side === "port" ? "P" : "S"}`;
  if (row.kind === "gate") return row.name.replace(/ gate$/, "");
  if (row.kind === "finish") return "Finish";
  if (row.kind === "start") return "Start";
  return row.name;
};

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Boat position, heading arrow and GPS accuracy circle. */
export class BoatLayer {
  constructor(map) {
    this.map = map;
    this.group = L.layerGroup().addTo(map);
    this.marker = null;
    this.accuracy = null;
  }

  update(fix) {
    if (!fix) {
      this.group.clearLayers();
      this.marker = this.accuracy = null;
      return;
    }
    const latlng = [fix.lat, fix.lon];
    const colour = fix.manual ? css("--warn") : css("--boat");

    // A hand-placed position gets a different shape as well as a different
    // colour: a pin, not a heading arrow, because a pin has no course and
    // drawing one pointing somewhere would be inventing information.
    const html = fix.manual
      ? `<svg width="34" height="34" viewBox="0 0 34 34">
           <circle cx="17" cy="17" r="6" fill="none" stroke="${colour}" stroke-width="3"/>
           <circle cx="17" cy="17" r="1.8" fill="${colour}"/>
           <path d="M17 2v6M17 26v6M2 17h6M26 17h6" stroke="${colour}" stroke-width="2.4"
                 stroke-linecap="round"/>
         </svg>`
      : `<svg width="34" height="34" viewBox="0 0 34 34" style="transform:rotate(${fix.cog ?? 0}deg)">
           <path d="M17 3 L26 29 L17 24 L8 29 Z" fill="${colour}"
                 stroke="${css("--paper")}" stroke-width="1.6" stroke-linejoin="round"
                 opacity="${fix.cog != null ? 1 : 0.55}"/>
         </svg>`;

    // Accuracy is a real measurement; a placed pin has none, so it gets a
    // dashed ring at a nominal radius rather than a circle implying precision.
    const ring = {
      radius: fix.manual ? 150 : fix.accuracy ?? 20,
      color: colour,
      weight: 1,
      opacity: 0.55,
      dashArray: fix.manual ? "4 4" : null,
      fillColor: colour,
      fillOpacity: fix.manual ? 0 : 0.08,
      interactive: false,
    };

    if (!this.marker) {
      this.accuracy = L.circle(latlng, ring).addTo(this.group);
      this.marker = L.marker(latlng, {
        interactive: false,
        icon: L.divIcon({ className: "boat-icon", html, iconSize: [34, 34], iconAnchor: [17, 17] }),
      }).addTo(this.group);
    } else {
      this.marker.setLatLng(latlng);
      this.marker.getElement().innerHTML = html;
      this.accuracy.setLatLng(latlng).setRadius(ring.radius).setStyle(ring);
    }
  }
}

/**
 * The tapped point, the rhumb line to it, and the track to sail.
 *
 * The straight dashed line is the bearing. The solid lines are the boards: one
 * tack either side, both landing on the mark in the same time, which together
 * draw the cone you have to stay inside. A track that runs over land is drawn
 * in the warning colour rather than quietly offered as a route.
 */
export class ProbeLayer {
  constructor(map) {
    this.group = L.layerGroup().addTo(map);
  }

  update(from, to, paths = [], blocked = []) {
    this.group.clearLayers();
    if (!to) return;
    if (from) {
      L.polyline([[from.lat, from.lon], [to.lat, to.lon]], {
        color: css("--wind"),
        weight: 2,
        dashArray: "6 4",
        interactive: false,
      }).addTo(this.group);
    }

    // The two options share a start and an end, so drawn with equal weight they
    // close into a box and read as one shape rather than as a choice. The
    // recommendation is therefore drawn as a route and the alternative as a
    // faint hint of the other side.
    paths.forEach((path, i) => {
      if (path.points.length < 3) return; // a fetch is already the dashed line
      const bad = blocked[i];
      const primary = i === 0;
      L.polyline(path.points.map((p) => [p.lat, p.lon]), {
        color: bad ? css("--warn") : css("--wind"),
        weight: primary ? 3.5 : 1.5,
        opacity: bad ? 0.9 : primary ? 1 : 0.4,
        dashArray: bad ? "5 5" : primary ? null : "2 6",
        lineJoin: "round",
        interactive: false,
      }).addTo(this.group);

      if (!primary) return; // only the route you would sail gets a tack mark
      L.circleMarker([path.corner.lat, path.corner.lon], {
        radius: 5,
        color: bad ? css("--warn") : css("--wind"),
        weight: 2.5,
        fillColor: css("--paper"),
        fillOpacity: 1,
        interactive: false,
      }).addTo(this.group);
    });
    L.marker([to.lat, to.lon], {
      interactive: false,
      icon: L.divIcon({
        className: "",
        html: `<svg width="30" height="30" viewBox="0 0 30 30">
                 <circle cx="15" cy="15" r="7" fill="none" stroke="${css("--wind")}" stroke-width="2"/>
                 <path d="M15 0v6M15 24v6M0 15h6M24 15h6" stroke="${css("--wind")}" stroke-width="2"/>
               </svg>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
    }).addTo(this.group);
  }
}

/**
 * Sparse wind and tide arrows over the map.
 *
 * Both point the way the thing is GOING, which is how a sailor reads a routing
 * chart: wind arrows downwind, tide arrows down-tide. The field is uniform
 * because a single wind and a single tide is what the user typed — it confirms
 * the input, it is not a forecast, and the legend says so.
 */
export class ArrowField {
  constructor(map, canvas) {
    this.map = map;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.wind = null;
    this.current = null;

    const redraw = () => this.draw();
    map.on("move", redraw);
    map.on("moveend zoomend", () => {
      canvas.style.opacity = "1";
      this.draw();
    });
    map.on("zoomstart", () => (canvas.style.opacity = "0"));
    map.on("resize", redraw);
    window.addEventListener("resize", redraw);
  }

  set(wind, current) {
    this.wind = wind;
    this.current = current;
    this.draw();
  }

  draw() {
    const { canvas, ctx, map } = this;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (!this.wind) return;

    const STEP = 78; // screen pixels between arrows, so density holds across zoom
    const cols = Math.floor(size.x / STEP);
    const rows = Math.floor(size.y / STEP);
    const ox = (size.x - (cols - 1) * STEP) / 2;
    const oy = (size.y - (rows - 1) * STEP) / 2;

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = ox + i * STEP;
        const y = oy + j * STEP;
        if (this.wind.tws > 0) {
          // TWD is where the wind is FROM, so the arrow flies toward TWD + 180.
          this.arrow(x, y - 9, this.wind.twd + 180, 13 + Math.min(this.wind.tws, 30) * 0.7, css("--wind"), 1.7, false);
        }
        if (this.current.drift > 0) {
          this.arrow(x, y + 11, this.current.set, 10 + Math.min(this.current.drift, 5) * 5, css("--tide"), 1.5, true);
        }
      }
    }
  }

  /** One arrow, centred on (x, y), pointing toward compass `dir`. */
  arrow(x, y, dir, len, colour, width, doubled) {
    const ctx = this.ctx;
    const a = (dir - 90) * DEG; // canvas x is east, y is south
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const hx = x + (dx * len) / 2;
    const hy = y + (dy * len) / 2;
    const tx = x - (dx * len) / 2;
    const ty = y - (dy * len) / 2;

    ctx.save();
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.72;

    if (doubled) {
      // Tidal streams get a doubled shaft, the way a stream arrow is engraved.
      const px = -dy * 1.6;
      const py = dx * 1.6;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(tx + px * s, ty + py * s);
        ctx.lineTo(hx - dx * 4 + px * s, hy - dy * 4 + py * s);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx - dx * 3, hy - dy * 3);
      ctx.stroke();
    }

    const head = doubled ? 5.5 : 5;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - dx * head + dy * head * 0.5, hy - dy * head - dx * head * 0.5);
    ctx.lineTo(hx - dx * head - dy * head * 0.5, hy - dy * head + dx * head * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
