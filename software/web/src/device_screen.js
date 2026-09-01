// device_screen.js - the on-device round screen (GC9A01 240x240), rendered live in
// the browser as the device-screen twin. One renderer, driven by a single `deviceUi`
// state that the bridge owns and broadcasts, so the physical screen, this web twin,
// and the AR app all show the SAME stage. Sapphire aesthetic (matches the console).
//
// Drawing is plain 2D canvas on a 240x240 buffer (circular-masked), deliberately
// close to what the GC9A01 firmware would push, so the same stage layouts port over.
//
// State shape (all optional except `screen`):
//   { screen, health:{imu,enc,drv,lnk}, boot,
//     menuIndex, modes:[...],
//     angleDeg, targetDeg,
//     effort, assist,
//     recSec, takeName, recording,
//     playName, playDur, playing,
//     calStep, calStepName, calProgress,
//     summaryOk, summaryText,
//     faultReason, source }

import { canonicalFaceState, renderAlternateWatchFace } from "./watch_face_renderers.js";

const S = 240;                       // native panel size (px)
const C = S / 2;                     // center
const R = 118;                       // usable radius (inside the bezel)
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

const COL = {
  bg: "#080B11", panel: "#10151E", ring: "#1E2637", ringSoft: "#161C28",
  text: "#EDF2F9", dim: "#8091A8", faint: "#4A566B",
  accent: "#66B8FF", accentDeep: "#2D5FC8",
  ok: "#4CC98D", warn: "#E8B14E", stop: "#F4564D",
};

// These are the firmware's real status stages.  The old browser-only
// `position` and `playback` pages had no FaceState on the Teensy, so selecting
// them made Ferro/Rams fall back to READY and look as if their UI was missing.
// Keep the public picker on the wire states the physical screen can render.
export const SCREENS = ["boot", "home", "transparent", "capture", "operator", "saved", "calibrate", "safe"];
export const MODES = ["home", "transparent", "capture", "operator", "calibrate"];
export const MODE_LABEL = {
  home: "READY", transparent: "TRANSP.", capture: "CAPTURE",
  operator: "OPERATOR", saved: "SAVED", calibrate: "CALIBRATE", safe: "SAFE",
};

export class DeviceScreen {
  constructor(canvas) {
    this.canvas = canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = S * dpr;
    canvas.height = S * dpr;
    this.ctx = canvas.getContext("2d");
    this.ctx.scale(dpr, dpr);
    this._t0 = 0;
  }

  // ---- primitives ----------------------------------------------------------
  _clipFace() {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.arc(C, C, C, 0, TAU);
    ctx.clip();
    // deep radial background
    const g = ctx.createRadialGradient(C, C - 20, 10, C, C, C);
    g.addColorStop(0, "#0E141E");
    g.addColorStop(1, COL.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  _bezel() {
    const { ctx } = this;
    ctx.restore();                       // undo face clip
    ctx.beginPath(); ctx.arc(C, C, C - 1, 0, TAU);
    ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = 2; ctx.stroke();
  }
  _ticks() {                              // faint minute ticks around the rim
    const { ctx } = this;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU - Math.PI / 2;
      const ro = R + 2, ri = i % 5 === 0 ? R - 6 : R - 3;
      ctx.beginPath();
      ctx.moveTo(C + Math.cos(a) * ri, C + Math.sin(a) * ri);
      ctx.lineTo(C + Math.cos(a) * ro, C + Math.sin(a) * ro);
      ctx.strokeStyle = i % 5 === 0 ? "rgba(120,140,175,0.30)" : "rgba(90,105,135,0.15)";
      ctx.lineWidth = 1; ctx.stroke();
    }
  }
  _arc(r, a0, a1, color, w, glow = true) {
    const { ctx } = this;
    const s = a0 * D2R - Math.PI / 2, e = a1 * D2R - Math.PI / 2;
    if (glow) {
      ctx.beginPath(); ctx.arc(C, C, r, s, e);
      ctx.strokeStyle = color + "33"; ctx.lineWidth = w * 3.2; ctx.lineCap = "round"; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(C, C, r, s, e);
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.stroke();
  }
  _ringTrack(r, w) {
    const { ctx } = this;
    ctx.beginPath(); ctx.arc(C, C, r, 0, TAU);
    ctx.strokeStyle = COL.ring; ctx.lineWidth = w; ctx.stroke();
  }
  _text(str, x, y, size, color = COL.text, weight = 600, align = "center", spacing = 0, mono = false) {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.textAlign = align; ctx.textBaseline = "middle";
    ctx.font = `${weight} ${size}px ${mono ? "ui-monospace, Menlo, monospace" : "'Inter Tight','Inter',system-ui,sans-serif"}`;
    if (spacing) {
      const total = str.split("").reduce((w2, ch) => w2 + ctx.measureText(ch).width + spacing, -spacing);
      let cx = align === "center" ? x - total / 2 : x;
      ctx.textAlign = "left";
      for (const ch of str) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
      ctx.textAlign = align;
    } else ctx.fillText(str, x, y);
  }
  _kicker(str, y = C + 74) { this._text(str, C, y, 12, COL.dim, 700, "center", 3); }
  _lamp(x, y, on, color = COL.ok) {
    const { ctx } = this;
    ctx.beginPath(); ctx.arc(x, y, 3.4, 0, TAU);
    ctx.fillStyle = on ? color : COL.faint; ctx.fill();
    if (on) { ctx.beginPath(); ctx.arc(x, y, 6, 0, TAU); ctx.fillStyle = color + "30"; ctx.fill(); }
  }

  // ---- the stages ----------------------------------------------------------
  render(st = {}, t = 0) {
    if (!this._t0) this._t0 = t;
    const tt = (t - this._t0) / 1000;    // seconds since first render (for pulses)
    this._clipFace();
    // The browser is a fixed, readable operator preview. IMU orientation is
    // intentionally a physical-watch behavior only.
    const face = (st.watch && st.watch.face) || "thesis";
    const stage = canonicalFaceState(st.screen || "boot");
    this.canvas.dataset.face = face;
    this.canvas.dataset.stage = stage;
    // Ferro and Rams have their own complete visual languages in firmware.
    // Render those here before the Thesis tick/layout pass; otherwise every
    // website selection looked like the same generic sapphire screen.
    if (renderAlternateWatchFace(this.ctx, st.watch, st, tt)) {
      this._bezel();
      return;
    }
    this._ticks();
    const s = st.screen || "boot";
    ({
      boot: () => this._boot(st, tt),
      home: () => this._home(st, tt),
      ready: () => this._home(st, tt),          // backwards-compatible alias
      position: () => this._position(st, tt),
      transparent: () => this._transparent(st, tt),
      capture: () => this._capture(st, tt),
      playback: () => this._playback(st, tt),
      operator: () => this._operator(st, tt),
      // Calibration is an action, not a separate end-user watch page. Match
      // the firmware: retain a calm, unified Home screen while it runs.
      calibrate: () => this._home(st, tt),
      summary: () => this._summary(st, tt),
      saved: () => this._summary(st, tt),
      safe: () => this._safe(st, tt),
      fault: () => this._safe(st, tt),
    }[s] || (() => this._boot(st, tt)))();
    this._bezel();
  }

  _boot(st, tt) {
    const h = st.health || {};
    const p = st.boot != null ? st.boot : 1;
    // scanning sapphire ring
    this._ringTrack(R - 6, 4);
    const sweep = (tt * 220) % 360;
    this._arc(R - 6, sweep, sweep + 90 * Math.min(1, p + 0.2), COL.accent, 4);
    // TAKTO five-bar mark
    const { ctx } = this;
    const bars = [10, 20, 28, 20, 10]; const bw = 5, gap = 4;
    const totalW = bars.length * bw + (bars.length - 1) * gap;
    let bx = C - totalW / 2;
    for (const bh of bars) {
      ctx.fillStyle = COL.accent;
      ctx.fillRect(bx, C - 30 - bh / 2, bw, bh); bx += bw + gap;
    }
    // status lamps (no labels)
    const lamps = [h.imu, h.enc, h.drv, h.lnk];
    const lx0 = C - 30;
    lamps.forEach((on, i) => this._lamp(lx0 + i * 20, C + 26, !!on, on ? COL.ok : COL.stop));
  }

  _home(st, tt) {
    // Same calm connection field as the physical TAKTO Home screen. Its tip
    // advances about one panel pixel per update instead of acting as a menu.
    const rgb = st.watch && Array.isArray(st.watch.rgb) ? st.watch.rgb : [102, 184, 255];
    const accent = `rgb(${rgb.join(",")})`;
    const a = (tt * 36) % 360;                     // 0.6° / physical 60 ms frame
    this._arc(98, a, a + 62, accent, 1.5, false);
    const rad = (a + 62) * D2R - Math.PI / 2;
    const { ctx } = this;
    ctx.beginPath(); ctx.arc(C + Math.cos(rad) * 98, C + Math.sin(rad) * 98, 2.2, 0, TAU);
    ctx.fillStyle = accent; ctx.fill();
    const pts = [[0, -42], [42, 0], [0, 42], [-42, 0]];
    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(C + x, C + y) : ctx.moveTo(C + x, C + y));
    ctx.closePath(); ctx.strokeStyle = accent; ctx.globalAlpha = .78; ctx.lineWidth = 1.1; ctx.stroke(); ctx.globalAlpha = 1;
    for (const [x, y] of pts) {
      ctx.beginPath(); ctx.arc(C + x, C + y, 4.2, 0, TAU); ctx.fillStyle = accent; ctx.globalAlpha = .5; ctx.fill(); ctx.globalAlpha = 1;
    }
    ctx.beginPath(); ctx.arc(C, C, 7, 0, TAU); ctx.fillStyle = accent; ctx.globalAlpha = .45; ctx.fill(); ctx.globalAlpha = 1;
  }

  _position(st) {
    const a = st.angleDeg != null ? st.angleDeg : 0;
    const tgt = st.targetDeg;
    this._ringTrack(R - 8, 5);
    this._arc(R - 8, 135, 135 + (a / 90) * 270, COL.accent, 5);
    if (tgt != null) {                   // target lume tick
      const ang = (135 + (tgt / 90) * 270);
      const rad = ang * D2R - Math.PI / 2;
      const { ctx } = this;
      ctx.beginPath();
      ctx.arc(C + Math.cos(rad) * (R - 8), C + Math.sin(rad) * (R - 8), 3.5, 0, TAU);
      ctx.fillStyle = COL.warn; ctx.fill();
    }
    this._text(`${a.toFixed(0)}°`, C, C, 48, COL.text, 700);
  }

  _transparent(st, tt) {
    const e = Math.max(0, Math.min(1, st.effort || 0));
    this._ringTrack(R - 8, 6);
    this._arc(R - 8, -90 + 0, -90 + 360 * e || 0.001, COL.ok, 6);
    this._text(`${Math.round(e * 100)}`, C, C - 2, 46, COL.text, 700);
    this._text("%", C + 47, C + 8, 16, COL.dim, 600);
    // assist indicator: a dot only (green = assisting)
    const on = !!st.assist;
    const { ctx } = this;
    if (on) { ctx.beginPath(); ctx.arc(C, C + 36, 8, 0, TAU); ctx.fillStyle = COL.ok + "33"; ctx.fill(); }
    ctx.beginPath(); ctx.arc(C, C + 36, 4, 0, TAU);
    ctx.fillStyle = on ? COL.ok : COL.faint; ctx.fill();
  }

  _capture(st, tt) {
    const sec = st.recSec || 0;
    const rec = st.recording !== false;
    const pulse = rec ? 0.5 + 0.5 * Math.sin(tt * 5) : 0;
    // top arc accent
    this._arc(R - 8, -40, 40, COL.stop, 4);
    // REC dot
    const { ctx } = this;
    ctx.beginPath(); ctx.arc(C, C - 36, 5, 0, TAU);
    ctx.fillStyle = `rgba(244,86,77,${0.4 + pulse * 0.6})`; ctx.fill();
    this._text(`${sec.toFixed(1)}s`, C, C + 8, 44, COL.text, 700);
  }

  _operator(st) {
    const h = st.health || {};
    const ok = [h.imu, h.enc, h.drv, h.lnk];
    this._ringTrack(R - 8, 4);
    this._arc(R - 8, -90, 270, COL.accent, 4, false);
    this._text("CONNECTED", C, C - 8, 24, COL.text, 750, "center", 1);
    ok.forEach((on, i) => this._lamp(C - 30 + i * 20, C + 32, !!on, on ? COL.ok : COL.stop));
  }

  _playback(st, tt) {
    const { ctx } = this;
    const playing = !!st.playing;
    // transport glyph
    ctx.fillStyle = COL.accent;
    if (playing) {
      ctx.beginPath(); ctx.moveTo(C - 12, C - 24); ctx.lineTo(C - 12, C); ctx.lineTo(C + 14, C - 12); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillRect(C - 13, C - 24, 9, 24); ctx.fillRect(C + 5, C - 24, 9, 24);
    }
    this._text(st.playDur != null ? `${st.playDur.toFixed(1)}s` : "--", C, C + 26, 22, COL.dim, 600);
  }

  _calibrate(st, tt) {
    const step = st.calStep || 0;
    const prog = Math.max(0, Math.min(1, st.calProgress != null ? st.calProgress : 0));
    const names = ["RELAX", "PUSH MAX", "HOLD STILL"];
    this._ringTrack(R - 8, 5);
    this._arc(R - 8, -90, -90 + 360 * prog || 0.001, COL.warn, 5);
    this._text(st.calStepName || names[step] || "CAL", C, C - 4, step === 1 ? 27 : 23, COL.text, 800, "center", 1);
    // 3 progress dots
    const { ctx } = this;
    [0, 1, 2].forEach((i) => {
      const x = C - 16 + i * 16;
      ctx.beginPath(); ctx.arc(x, C + 32, 3.5, 0, TAU);
      ctx.fillStyle = i <= step ? COL.warn : COL.faint;
      ctx.globalAlpha = i === step ? 1 : (i < step ? 0.8 : 0.4); ctx.fill(); ctx.globalAlpha = 1;
    });
  }

  _summary(st, tt) {
    const ok = st.summaryOk !== false;
    this._arc(R - 8, -90, 270, ok ? COL.ok : COL.warn, 5);
    // check ring + mark
    const { ctx } = this;
    ctx.beginPath(); ctx.arc(C, C, 30, 0, TAU);
    ctx.strokeStyle = ok ? COL.ok : COL.warn; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(C - 12, C); ctx.lineTo(C - 3, C + 10); ctx.lineTo(C + 14, C - 12);
    ctx.strokeStyle = ok ? COL.ok : COL.warn; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
  }

  _safe(st, tt) {
    const flash = 0.5 + 0.5 * Math.sin(tt * 4);
    const { ctx } = this;
    // flashing red ring
    ctx.beginPath(); ctx.arc(C, C, R - 6, 0, TAU);
    ctx.strokeStyle = `rgba(244,86,77,${0.35 + flash * 0.5})`; ctx.lineWidth = 6; ctx.stroke();
    // STOP octagon
    ctx.save(); ctx.translate(C, C); ctx.rotate(Math.PI / 8);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; const x = Math.cos(a) * 38, y = Math.sin(a) * 38; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath(); ctx.fillStyle = COL.stop; ctx.fill(); ctx.restore();
    this._text("STOP", C, C, 20, "#fff", 800, "center", 1);
  }
}
