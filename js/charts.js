/**
 * Charts for the SOG and COG history: a sparkline in the instrument head, and
 * a full time series plus distribution in the history panel.
 *
 * COG is circular data, which is the only subtle thing here. A course wobbling
 * around north reads 359, 002, 358 — averaged naively that is 240 degrees,
 * pointing southwest. So headings are unwrapped before plotting (no vertical
 * jump across the 360 seam), averaged as unit vectors, and their spread
 * measured as circular deviation.
 */

const css = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
const D2R = Math.PI / 180;

/**
 * Prepare a canvas for crisp drawing at the device pixel ratio.
 *
 * The backing size is rounded before comparing: devicePixelRatio is often
 * fractional (0.9 on a scaled external display, 2.625 on some Androids), and
 * `canvas.width = w * dpr` truncates to an integer. Comparing the truncated
 * attribute against the fractional product is never equal, so without the
 * rounding every single draw reallocates and clears the canvas.
 */
function surface(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Unwrap a sequence of headings so consecutive values never jump the seam. */
export function unwrap(degrees) {
  const out = [];
  let offset = 0;
  degrees.forEach((d, i) => {
    if (i > 0) {
      const prev = degrees[i - 1];
      if (d - prev > 180) offset -= 360;
      else if (d - prev < -180) offset += 360;
    }
    out.push(d + offset);
  });
  return out;
}

/** Mean, spread and range, handling headings as directions rather than numbers. */
export function stats(values, circular) {
  const v = values.filter((x) => x != null && !Number.isNaN(x));
  if (!v.length) return null;
  if (!circular) {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    return { mean, sd, min: Math.min(...v), max: Math.max(...v), n: v.length };
  }
  const e = v.reduce((a, d) => a + Math.sin(d * D2R), 0) / v.length;
  const n = v.reduce((a, d) => a + Math.cos(d * D2R), 0) / v.length;
  const R = Math.hypot(e, n);
  const mean = (Math.atan2(e, n) / D2R + 360) % 360;
  // Circular standard deviation; goes to infinity as the directions spread out.
  const sd = R > 0 ? Math.sqrt(-2 * Math.log(R)) / D2R : 180;
  const un = unwrap(v);
  return { mean, sd, min: Math.min(...un), max: Math.max(...un), n: v.length, spread: Math.max(...un) - Math.min(...un) };
}

/**
 * Tiny bars under a gauge. Enough to show a trend, not to be read precisely.
 *
 * Bars are placed by timestamp across the whole window rather than spread to
 * fill it, so a buffer that is only a minute old draws a short run of bars on
 * the right and visibly fills up — instead of two enormous bars implying five
 * minutes of data that was never sampled.
 */
export function sparkline(canvas, samples, field, circular, windowMs, now = Date.now()) {
  const { ctx, w, h } = surface(canvas);
  const usable = samples.filter((s) => s[field] != null && !Number.isNaN(s[field]));
  if (usable.length < 2) return;
  const v = usable.map((s) => s[field]);
  const series = circular ? unwrap(v) : v;
  let lo = Math.min(...series);
  let hi = Math.max(...series);
  // Scale to the window's own range, not to zero. A boat holding 6-8 kn drawn
  // from zero is a solid block; what the helm needs to see is the wobble.
  const pad = Math.max(circular ? 6 : 0.4, (hi - lo) * 0.25);
  lo -= pad;
  hi += pad;
  const span = hi - lo || 1;

  const t0 = now - windowMs;
  const slots = Math.max(1, Math.round(windowMs / (usable[1].t - usable[0].t || 5000)));
  const bw = Math.max(1, w / slots - 1);
  ctx.fillStyle = css("--rule");
  series.forEach((x, i) => {
    const bh = Math.max(1, ((x - lo) / span) * (h - 2));
    const age = (usable[i].t - t0) / windowMs;
    if (age < 0 || age > 1) return;
    ctx.globalAlpha = 0.35 + 0.65 * age; // recent samples read stronger
    ctx.fillRect(age * (w - bw), h - bh, bw, bh);
  });
  ctx.globalAlpha = 1;
}

/** Value against time, oldest left. Gaps in sampling are left as gaps. */
export function timeSeries(canvas, samples, field, opts = {}) {
  const { ctx, w, h } = surface(canvas);
  if (samples.length < 2) {
    empty(ctx, w, h, "Not enough samples yet");
    return;
  }
  const circular = field === "cog";
  const pad = { l: 40, r: 8, t: 10, b: 22 };
  const raw = samples.map((s) => s[field]).map((x) => (x == null ? NaN : x));
  const series = circular ? unwrapWithGaps(raw) : raw;

  const finite = series.filter((x) => !Number.isNaN(x));
  if (!finite.length) {
    empty(ctx, w, h, "No data in this window");
    return;
  }
  let lo = circular ? Math.min(...finite) : 0;
  let hi = Math.max(...finite);
  if (circular) {
    const padv = Math.max(10, (hi - lo) * 0.2);
    lo -= padv;
    hi += padv;
  } else hi = Math.max(hi * 1.15, 1);

  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const spanT = Math.max(1, t1 - t0);
  const X = (t) => pad.l + ((t - t0) / spanT) * (w - pad.l - pad.r);
  const Y = (v) => h - pad.b - ((v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);

  axes(ctx, w, h, pad, lo, hi, opts.unit);

  // Bars, one per sample, so a dropped sample is visibly absent.
  const bw = Math.max(1.5, (w - pad.l - pad.r) / samples.length - 1);
  ctx.fillStyle = opts.colour ?? css("--wind");
  samples.forEach((s, i) => {
    if (Number.isNaN(series[i])) return;
    const y = Y(series[i]);
    const base = circular ? Y(lo) : h - pad.b;
    ctx.globalAlpha = 0.35 + 0.65 * (i / Math.max(1, samples.length - 1));
    ctx.fillRect(X(s.t) - bw / 2, Math.min(y, base), bw, Math.abs(base - y) || 1);
  });
  ctx.globalAlpha = 1;

  ctx.fillStyle = css("--ink-soft");
  ctx.font = "10px -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`${Math.round((t1 - t0) / 60000)} min ago`, pad.l, h - 6);
  ctx.textAlign = "right";
  ctx.fillText("now", w - pad.r, h - 6);
}

/** Unwrap headings, but never bridge a NaN — a gap must stay a gap. */
function unwrapWithGaps(values) {
  const out = [];
  let offset = 0;
  let prev = null;
  for (const d of values) {
    if (Number.isNaN(d)) {
      out.push(NaN);
      prev = null;
      continue;
    }
    if (prev != null) {
      if (d - prev > 180) offset -= 360;
      else if (d - prev < -180) offset += 360;
    }
    out.push(d + offset);
    prev = d;
  }
  return out;
}

/** How often each value occurred. Headings bucket around the compass. */
export function histogram(canvas, samples, field, opts = {}) {
  const { ctx, w, h } = surface(canvas);
  const circular = field === "cog";
  const values = samples.map((s) => s[field]).filter((x) => x != null && !Number.isNaN(x));
  if (values.length < 2) {
    empty(ctx, w, h, "Not enough samples yet");
    return;
  }
  const pad = { l: 40, r: 8, t: 10, b: 26 };

  let edges;
  if (circular) {
    const st = stats(values, true);
    const centre = st.mean;
    const half = Math.min(180, Math.max(20, st.spread / 2 + 10));
    const n = 12;
    edges = Array.from({ length: n + 1 }, (_, i) => centre - half + (2 * half * i) / n);
  } else {
    const lo = 0;
    const hi = Math.max(...values) * 1.1 || 1;
    const n = 10;
    edges = Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
  }

  const counts = new Array(edges.length - 1).fill(0);
  for (const v of values) {
    let x = v;
    if (circular) {
      // Fold each heading into the window around the mean.
      const mid = (edges[0] + edges[edges.length - 1]) / 2;
      x = mid + (((v - mid) % 360) + 540) % 360 - 180;
    }
    for (let i = 0; i < counts.length; i++) {
      if (x >= edges[i] && (x < edges[i + 1] || i === counts.length - 1)) {
        counts[i]++;
        break;
      }
    }
  }

  const maxC = Math.max(...counts, 1);
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const bw = plotW / counts.length;

  ctx.strokeStyle = css("--rule");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, h - pad.b + 0.5);
  ctx.lineTo(w - pad.r, h - pad.b + 0.5);
  ctx.stroke();

  ctx.fillStyle = opts.colour ?? css("--wind");
  counts.forEach((c, i) => {
    if (!c) return;
    const bh = (c / maxC) * plotH;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(pad.l + i * bw + 1, h - pad.b - bh, bw - 2, bh);
  });
  ctx.globalAlpha = 1;

  ctx.fillStyle = css("--ink-soft");
  ctx.font = "10px -apple-system, sans-serif";
  ctx.textAlign = "center";
  const fmt = (v) => (circular ? `${Math.round(((v % 360) + 360) % 360)}°` : v.toFixed(1));
  for (let i = 0; i < edges.length; i += Math.ceil(edges.length / 5)) {
    ctx.fillText(fmt(edges[i]), pad.l + i * bw, h - pad.b + 13);
  }
  ctx.textAlign = "right";
  ctx.fillText(`${maxC}`, pad.l - 5, pad.t + 8);
  ctx.fillText("0", pad.l - 5, h - pad.b);
  ctx.textAlign = "center";
  ctx.fillText(opts.unit ?? "", w / 2, h - 4);
}

function axes(ctx, w, h, pad, lo, hi, unit) {
  ctx.strokeStyle = css("--rule");
  ctx.fillStyle = css("--ink-soft");
  ctx.font = "10px -apple-system, sans-serif";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    const y = h - pad.b - ((v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
    ctx.globalAlpha = i === 0 ? 1 : 0.35;
    ctx.beginPath();
    ctx.moveTo(pad.l, y + 0.5);
    ctx.lineTo(w - pad.r, y + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const label = unit === "°" ? `${Math.round(((v % 360) + 360) % 360)}` : v.toFixed(1);
    ctx.fillText(label, pad.l - 5, y + 3);
  }
}

function empty(ctx, w, h, message) {
  ctx.fillStyle = css("--ink-soft");
  ctx.font = "13px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, w / 2, h / 2);
}

/**
 * The compass dial used to set wind and tide direction by dragging.
 *
 * `inbound` draws the arrow flying from the rim at `dir` toward the centre,
 * which is what a wind direction means — the air arrives from there. The tide
 * dial is outbound, because a set is where the water goes. Both then agree with
 * the arrows on the map, where wind and tide alike fly the way the fluid moves.
 */
export function dial(canvas, dir, speed, colour, label, inbound = false) {
  const { ctx, w, h } = surface(canvas);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 14;

  ctx.strokeStyle = css("--rule");
  ctx.fillStyle = css("--ink-soft");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = "10px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let a = 0; a < 360; a += 30) {
    const rad = (a - 90) * D2R;
    const inner = a % 90 === 0 ? r - 9 : r - 5;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rad) * inner, cy + Math.sin(rad) * inner);
    ctx.lineTo(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (a % 90 === 0) {
      const t = { 0: "N", 90: "E", 180: "S", 270: "W" }[a];
      ctx.fillText(t, cx + Math.cos(rad) * (r + 8), cy + Math.sin(rad) * (r + 8));
    }
  }

  const rad = (dir - 90) * D2R;
  const len = r - 12;
  // Tail at the rim on `dir`, head toward the centre, when the arrow is inbound.
  const tail = inbound ? len : -len * 0.55;
  const head = inbound ? -len * 0.45 : len;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const hx = cx + ux * head;
  const hy = cy + uy * head;
  const sign = inbound ? -1 : 1;

  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx + ux * tail, cy + uy * tail);
  ctx.lineTo(hx - ux * sign * 4, hy - uy * sign * 4);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - sign * (ux * 12 - uy * 6), hy - sign * (uy * 12 + ux * 6));
  ctx.lineTo(hx - sign * (ux * 12 + uy * 6), hy - sign * (uy * 12 - ux * 6));
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = css("--ink");
  ctx.font = "600 17px -apple-system, sans-serif";
  ctx.fillText(`${speed.toFixed(1)}`, cx, cy - 6);
  ctx.fillStyle = css("--ink-soft");
  ctx.font = "10px -apple-system, sans-serif";
  ctx.fillText(label, cx, cy + 9);
}

/** Compass direction of a point on the dial, for dragging. */
export function dialDirection(canvas, clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const dx = clientX - (r.left + r.width / 2);
  const dy = clientY - (r.top + r.height / 2);
  return (Math.round(Math.atan2(dx, -dy) / D2R) + 360) % 360;
}
