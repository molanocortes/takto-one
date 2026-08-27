// charts.js - hand-rolled canvas charts tuned to the design system.
// StripChart: a rolling live trace fed from a Store Series. Quiet, luminous.
// Performance notes: canvas shadowBlur is banned here (it costs whole
// milliseconds per stroke); glow is a wide low-alpha under-stroke instead.
// Canvas rects come from a shared ResizeObserver, never per-frame layout reads.

import { clamp } from "./ui.js";
import { unwrapCircularValues } from "./circular.js";

// Read the ratio when we size a canvas, never once at module load: dragging the
// window to a 1x monitor (or a browser zoom change) alters devicePixelRatio, and
// a frozen value leaves every backing store mis-scaled until a reload.
const dpr = () => Math.min(1.5, window.devicePixelRatio || 1);

// rect cache: one observer for every chart canvas in the app
const _sizes = new WeakMap();
const _ro = new ResizeObserver((entries) => {
  const d = dpr();
  for (const e of entries) {
    const r = e.contentRect;
    _sizes.set(e.target, { w: Math.max(2, Math.round(r.width * d)), h: Math.max(2, Math.round(r.height * d)), dpr: d });
  }
});

function setupCanvas(canvas) {
  let s = _sizes.get(canvas);
  const d = dpr();
  if (!s) {
    _ro.observe(canvas);
    const r = canvas.getBoundingClientRect();   // once, at first draw
    s = { w: Math.max(2, Math.round(r.width * d)), h: Math.max(2, Math.round(r.height * d)), dpr: d };
    _sizes.set(canvas, s);
  } else if (s.dpr !== d) {
    // the display changed under us: re-derive the backing store from the CSS box
    const r = canvas.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      s = { w: Math.max(2, Math.round(r.width * d)), h: Math.max(2, Math.round(r.height * d)), dpr: d };
      _sizes.set(canvas, s);
    }
  }
  if (canvas.width !== s.w || canvas.height !== s.h) { canvas.width = s.w; canvas.height = s.h; }
  return { ctx: canvas.getContext("2d"), w: s.w, h: s.h, dpr: s.dpr };
}

export class StripChart {
  // opts: { color, min, max, windowMs, fill (bool), width, wrap (period) }
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.o = Object.assign(
      { color: "#2F76BF", min: 0, max: 1, windowMs: 8000, fill: true, width: 1.8 },
      opts
    );
  }

  // series: [{t[], v[], color?, fill?}] or a single Series-like object
  draw(seriesList, tNow) {
    const { ctx, w, h, dpr } = setupCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const list = Array.isArray(seriesList) ? seriesList : [seriesList];
    const { min, max, windowMs } = this.o;
    const pad = 2 * dpr;

    // faint horizontal midline
    ctx.strokeStyle = "rgba(35, 30, 22, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5);
    ctx.stroke();

    for (const entry of list) {
      if (!entry || !entry.t || entry.t.length < 2) continue;
      // Plot circular samples in a continuous local frame. Keeping the raw
      // values would draw a full-height false stroke whenever an AS5600 crosses
      // its 0/360 seam.
      const values = this.o.wrap
        ? unwrapCircularValues(entry.v, this.o.wrap)
        : entry.v;
      const color = entry.color || this.o.color;
      const doFill = entry.fill != null ? entry.fill : this.o.fill;
      const t0 = tNow - windowMs;
      const X = (t) => ((t - t0) / windowMs) * w;
      const Y = (v) => pad + (1 - clamp((v - min) / (max - min), 0, 1)) * (h - pad * 2);

      const trace = () => {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < entry.t.length; i++) {
          if (entry.t[i] < t0 - 200) continue;
          const x = X(entry.t[i]), y = Y(values[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        return started;
      };

      if (!trace()) continue;

      if (doFill) {
        const lastX = X(entry.t[entry.t.length - 1]);
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, color + "2E");
        grad.addColorStop(1, color + "00");
        ctx.lineTo(lastX, h); ctx.lineTo(0, h); ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        trace();
      }
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      // glow: wide soft pass under the core line (no shadowBlur)
      ctx.strokeStyle = color + "40";
      ctx.lineWidth = this.o.width * 3.2 * dpr;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = this.o.width * dpr;
      ctx.stroke();

      // live head dot: soft halo + core
      const hx = X(entry.t[entry.t.length - 1]);
      const hy = Y(values[values.length - 1]);
      ctx.beginPath();
      ctx.arc(hx, hy, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = color + "33";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hx, hy, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
}

// A static sparkline for take cards: one pass, no animation.
export function drawSpark(canvas, values, color = "#2F76BF", wrap = null) {
  const { ctx, w, h, dpr } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!values || values.length < 2) return;
  if (wrap) values = unwrapCircularValues(values, wrap);
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 1e-6) hi = lo + 1;
  const pad = 2 * dpr;
  const X = (i) => (i / (values.length - 1)) * w;
  const Y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + "26");
  grad.addColorStop(1, color + "00");
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4 * dpr;
  ctx.lineJoin = "round";
  ctx.stroke();
}
