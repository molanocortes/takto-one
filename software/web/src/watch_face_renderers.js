// Browser mirrors of the two alternate 240 x 240 firmware faces.
//
// The physical device remains authoritative (firmware/takto_one/watch/).  This module
// intentionally shares its state vocabulary and measurements so the console
// preview never substitutes the old generic sapphire page when Ferro or Rams
// is selected.  Thesis continues to use device_screen.js's submitted layouts.

const S = 240;
const C = S / 2;
const TAU = Math.PI * 2;

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const rgba = (rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
const hash = (n) => {
  const x = Math.sin(n * 127.31) * 43758.545;
  return x - Math.floor(x);
};

// Public website stages -> the firmware FaceState each one represents.
// Legacy aliases remain accepted only so an old snapshot cannot blank a face.
export const WEB_TO_FACE_STATE = Object.freeze({
  boot: "boot",
  home: "idle",
  ready: "idle",
  operator: "linked",
  position: "linked",
  transparent: "teleop",
  capture: "recording",
  saved: "saved",
  summary: "saved",
  playback: "saved",
  calibrate: "calib",
  safe: "stop",
  fault: "fault",
  battery: "battery",
});

export function canonicalFaceState(screen) {
  return WEB_TO_FACE_STATE[screen] || "idle";
}

function accentOf(watch, fallback) {
  const v = watch && watch.rgb;
  return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
    ? v.map((x) => Math.max(0, Math.min(255, Math.round(x))))
    : fallback;
}

function meanGrip(st) {
  const vals = [];
  for (const j of st.joints || []) {
    if (j && j.ok !== false && Number.isFinite(j.deg)) vals.push(clamp01(j.deg / 90));
  }
  if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
  if (Number.isFinite(st.angleDeg)) return clamp01(st.angleDeg / 90);
  return clamp01(st.effort);
}

function fingerLevels(st) {
  const out = [[], [], [], []];
  const names = ["index", "middle", "ring", "pinky"];
  for (const j of st.joints || []) {
    const i = names.findIndex((n) => String(j.id || "").startsWith(n + "_"));
    if (i >= 0 && j.ok !== false && Number.isFinite(j.deg)) out[i].push(clamp01(j.deg / 90));
  }
  const fallback = meanGrip(st);
  return out.map((v, i) => v.length ? v.reduce((a, b) => a + b, 0) / v.length
    : clamp01(fallback * (1 - i * 0.06)));
}

function line(ctx, x0, y0, x1, y1, color, width = 1.5) {
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "butt"; ctx.stroke();
}

function arc(ctx, r, a0, a1, color, width = 2) {
  ctx.beginPath(); ctx.arc(C, C, r, a0, a1);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "butt"; ctx.stroke();
}

function text(ctx, value, x, y, size, color, weight = 600, spacing = 0) {
  const str = String(value);
  ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `${weight} ${size}px 'Inter Tight','Inter',system-ui,sans-serif`;
  if (!spacing || typeof ctx.measureText !== "function") { ctx.fillText(str, x, y); return; }
  const widths = [...str].map((ch) => ctx.measureText(ch).width);
  let cx = x - (widths.reduce((a, b) => a + b, 0) + spacing * (str.length - 1)) / 2;
  ctx.textAlign = "left";
  [...str].forEach((ch, i) => { ctx.fillText(ch, cx, y); cx += widths[i] + spacing; });
}

// ---------------------------------------------------------------- Ferro ----

function ferroParams(state, st, t) {
  const effort = clamp01(st.effort);
  const p = {
    mass: .62, tempo: .55, agitation: .08, spikes: 3, elong: 0, direction: -Math.PI / 2,
    rim: .35, scatter: 0, glass: 0, pale: 0, fracture: 0, companion: 0,
    orbit: 0, progress: -1, freeze: 0,
  };
  switch (state) {
    case "boot": {
      const u = clamp01(t / 2.2); p.scatter = 1 - u; p.mass = .1 + .52 * u;
      p.rim = .4 * u; p.spikes = 3 * u; break;
    }
    case "linked": p.companion = clamp01(t / 1.4); p.spikes = 2 + 8 * effort; break;
    case "standalone": p.scatter = .3; p.mass = .55; p.rim = .14; p.spikes = 1 + 6 * effort; break;
    case "teleop": p.tempo = 1.4; p.agitation = .35 + .3 * effort; p.spikes = 3 + 14 * effort;
      p.elong = .35 + .65 * effort; p.rim = .6 + .4 * effort; break;
    case "recording": p.orbit = 1; p.progress = clamp01((st.recSec || t) / 24);
      p.spikes = 2 + 10 * effort; break;
    case "saved": p.orbit = Math.max(0, 1 - t / 1.4); p.progress = 1; p.rim = .55; break;
    case "calib": p.glass = clamp01(st.calProgress != null ? st.calProgress : t / 5);
      p.agitation = .5 * (1 - p.glass); p.spikes = (2 + 10 * effort) * (1 - p.glass); break;
    case "stop": p.freeze = 1; p.pale = 1; p.spikes = 9; p.rim = .5; break;
    case "fault": p.fracture = .9; p.agitation = .3; p.spikes = 1 + 6 * effort; p.rim = .55; break;
    case "battery": p.mass = .35; p.progress = clamp01(st.battery == null ? .35 : st.battery); break;
    default: p.spikes = 2 + 12 * effort; p.rim = .28 + .35 * effort;
  }
  return p;
}

function drawFerro(ctx, watch, st, t) {
  const state = canonicalFaceState(st.screen);
  const ac = accentOf(watch, [46, 123, 255]);
  const p = ferroParams(state, st, t);
  ctx.fillStyle = "#050607"; ctx.fillRect(0, 0, S, S);

  const cx = C + Math.cos(p.direction) * p.elong * 14;
  const cy = C + 2 + Math.sin(p.direction) * p.elong * 13;
  const breath = 1 + .045 * (1 - p.glass) * (1 - p.freeze) * Math.sin(t * p.tempo * TAU);
  const radius = (26 + p.mass * 36) * breath;

  // Boot fusion / standalone drift droplets stay bounded, like the firmware.
  if (p.scatter > .02) {
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * TAU + hash(i) * 2;
      const d = radius + 8 + p.scatter * (28 + hash(i + 9) * 40);
      ctx.beginPath(); ctx.arc(cx + Math.cos(a + t * .1) * d,
        cy + Math.sin(a + t * .1) * d * .94, (2 + hash(i + 3) * 4) * Math.min(1, p.scatter * 2), 0, TAU);
      ctx.fillStyle = "#101318"; ctx.fill(); ctx.strokeStyle = rgba(ac, p.rim * .3); ctx.lineWidth = .8; ctx.stroke();
    }
  }

  const rAt = (a) => {
    let r = radius + Math.pow(Math.abs(Math.sin(a * 4.5 + (p.freeze ? 1.3 : t * .35))), 2) * p.spikes * (1 - p.glass);
    r += Math.sin(a * 7 + t * 6) * p.agitation * 3 * (1 - p.glass);
    if (p.elong) {
      const c = Math.cos(a - p.direction);
      r += p.elong * (34 * Math.max(0, c) ** 2 + 12 * Math.max(0, -c) ** 2);
    }
    if (p.freeze) r += (hash(Math.round(a / TAU * 140)) * 2 - 1) * 4.5;
    return r;
  };

  ctx.beginPath();
  for (let i = 0; i <= 140; i++) {
    const a = i / 140 * TAU, r = rAt(a);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * .94;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  const g = ctx.createRadialGradient(cx - 14, cy - 18, 4, cx, cy, radius + 28);
  if (p.pale) { g.addColorStop(0, "#E4E9EF"); g.addColorStop(.6, "#B9C2CC"); g.addColorStop(1, "#7E8994"); }
  else { g.addColorStop(0, "#15181C"); g.addColorStop(.5, "#0A0C0E"); g.addColorStop(1, "#040506"); }
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = p.pale ? "rgba(228,236,244,.55)" : rgba(ac, p.rim);
  ctx.lineWidth = 1.6; ctx.stroke();

  if (!p.pale) {
    ctx.beginPath(); ctx.ellipse(cx - radius * .32, cy - radius * .42, radius * .2, radius * .09, -.5, 0, TAU);
    ctx.fillStyle = "rgba(150,190,255,.14)"; ctx.fill();
  }
  if (p.elong) {
    for (let i = -1; i <= 1; i++) {
      const ph = (t * 1.6 + i * .33) % 1, u0 = -.9 + ph * 1.4, u1 = u0 + .35;
      line(ctx, cx + radius * u0 + i * 9, cy, cx + radius * u1 + i * 9, cy, rgba(ac, .22), 1.6);
    }
  }
  if (p.companion) {
    const a = -.7 + t * .5, rr = radius + 26 * p.companion;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 3.5, 0, TAU);
    ctx.fillStyle = "#101318"; ctx.fill(); ctx.strokeStyle = rgba(ac, .9); ctx.stroke();
  }
  if (p.orbit) {
    const a = -Math.PI / 2 + t * .55, rr = radius + 28 * p.orbit;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 3.8, 0, TAU);
    ctx.fillStyle = "#101318"; ctx.fill(); ctx.strokeStyle = rgba(ac, .9); ctx.stroke();
  }
  if (p.progress >= 0) arc(ctx, 112, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(.002, p.progress), rgba(ac, .7), 2);
  arc(ctx, 108, 0, TAU, rgba(ac, .08), 1);

  if (p.fracture) {
    for (let i = 0; i < 5; i++) {
      const a = .4 + i * 1.1;
      line(ctx, cx, cy, cx + Math.cos(a) * radius * .78, cy + Math.sin(a) * radius * .72, "rgba(2,3,4,.95)", 2.2);
    }
    text(ctx, "△", C, 196, 18, rgba(ac, .9), 700);
  }
  if (state === "stop") text(ctx, "S T O P", C, 196, 15, "rgba(235,241,247,.95)", 700);
  if (state === "saved") text(ctx, "✓", C, 196, 16, rgba(ac, .9), 700);
}

// ----------------------------------------------------------------- Rams ----

function ramsWord(state, st) {
  return ({ boot: t => t < 1.8 ? "SELF TEST" : "STARTING", idle: () => "READY",
    linked: () => "LINKED", standalone: () => "LOCAL", teleop: () => "TELEOP",
    recording: () => "REC", saved: () => "SAVED", calib: () => "CALIBRATE",
    fault: () => "FAULT", battery: () => st.charging ? "CHARGING" : "BATTERY" }[state] || (() => "READY"))(st.stateT || 0);
}

function ramsPrimary(state, st, t) {
  if (state === "boot") return clamp01(t < .9 ? t / .9 : t < 1.8 ? 1 - (t - .9) / .9 : meanGrip(st));
  if (state === "recording") return clamp01(((st.recSec || t) % 60) / 60);
  if (state === "saved") return 1;
  if (state === "calib") return clamp01(st.calProgress);
  if (state === "battery") return clamp01(st.battery == null ? .72 : st.battery);
  return meanGrip(st);
}

function drawRams(ctx, watch, st, t) {
  const state = canonicalFaceState(st.screen);
  const ac = accentOf(watch, [242, 176, 30]);
  if (state === "stop") {
    ctx.fillStyle = "#D0342C"; ctx.fillRect(0, 0, S, S);
    text(ctx, "STOP", C, 108, 38, "#FFFDF8", 800, 2);
    text(ctx, "SYSTEM SAFE", C, 145, 13, "rgba(255,253,248,.8)", 650, 2);
    return;
  }
  ctx.fillStyle = "#0C0C0D"; ctx.fillRect(0, 0, S, S);
  const A0 = 3 * Math.PI / 4, SW = 3 * Math.PI / 2;
  const v = ramsPrimary(state, st, t);
  const structure = "#70706C", dim = "#343432", ink = "#EEEDE7", inkDim = "#969690";
  arc(ctx, 106, A0, A0 + SW, dim, 1.5);
  for (let i = 0; i <= 20; i++) {
    const a = A0 + SW * i / 20, major = i % 5 === 0;
    const r0 = major ? 96 : 100;
    line(ctx, C + Math.cos(a) * r0, C + Math.sin(a) * r0,
      C + Math.cos(a) * 106, C + Math.sin(a) * 106, major ? structure : dim, major ? 3 : 2);
  }
  if (["recording", "saved", "calib"].includes(state)) {
    const progress = state === "saved" ? 1 : state === "calib" ? clamp01(st.calProgress) : v;
    arc(ctx, 106, A0, A0 + SW * progress, rgba(ac, .95), 3.5);
  }
  if (state === "teleop") {
    const q = clamp01(st.torque == null ? st.effort : st.torque);
    arc(ctx, 106, A0 + SW * Math.min(v, q), A0 + SW * Math.max(v, q), rgba(ac, .6), 3.5);
  }

  const h = st.health || {};
  const lamps = [h.imu, h.enc, st.activationPresent !== false, h.drv, h.lnk];
  const x0 = 74;
  lamps.forEach((ok, i) => {
    const x = x0 + i * 20;
    if (ok !== false) { ctx.fillStyle = inkDim; ctx.fillRect(x, 54, 12, 12); }
    else { ctx.strokeStyle = state === "fault" && Math.floor(t * 2) % 2 ? rgba(ac, 1) : dim; ctx.lineWidth = 2; ctx.strokeRect(x, 54, 12, 12); }
  });

  const word = ramsWord(state, { ...st, stateT: t });
  text(ctx, word, C, 80, 13, ["recording", "fault"].includes(state) ? rgba(ac, 1) : inkDim, 700, 2);
  if (state === "linked") {
    line(ctx, 69, 70, 69, 90, rgba(ac, 1), 2); line(ctx, 171, 70, 171, 90, rgba(ac, 1), 2);
  }
  if (state === "recording" && Math.floor(t * 2) % 2 === 0) { ctx.fillStyle = rgba(ac, 1); ctx.fillRect(75, 74, 12, 12); }

  const numeral = ["recording", "saved"].includes(state)
    ? `${String(Math.floor((st.recSec || 0) / 60)).padStart(2, "0")}:${String(Math.floor(st.recSec || 0) % 60).padStart(2, "0")}`
    : `${Math.round(v * 100)}%`;
  text(ctx, numeral, C, 120, 35, ink, 750);
  const caption = state === "battery" ? "CHARGE" : ["recording", "saved"].includes(state) ? "CAPTURE" : "HAND CLOSURE";
  text(ctx, caption, C, 160, 12, inkDim, 600, 2);

  ctx.fillStyle = dim; ctx.fillRect(72, 178, 96, 8);
  ctx.fillStyle = inkDim; ctx.fillRect(72, 178, Math.round(96 * clamp01(st.effort)), 8);
  ctx.fillStyle = structure; ctx.fillRect(119, 176, 2, 12);

  if (state === "battery") {
    for (let i = 0; i < 10; i++) {
      const a = Math.PI / 3 + i * (Math.PI / 3) / 9;
      line(ctx, C + Math.cos(a) * 104, C + Math.sin(a) * 104,
        C + Math.cos(a) * 86, C + Math.sin(a) * 86, i < Math.round(v * 10) ? rgba(ac, 1) : dim, 5);
    }
  } else if (state === "fault") {
    for (let i = -3; i <= 3; i++) line(ctx, 91 + i * 9, 203, 104 + i * 9, 218, rgba(ac, .8), 2);
  } else {
    fingerLevels(st).forEach((f, i) => {
      const a = Math.PI / 3 + i * (Math.PI / 3) / 3;
      line(ctx, C + Math.cos(a) * 104, C + Math.sin(a) * 104,
        C + Math.cos(a) * (104 - 20 * f), C + Math.sin(a) * (104 - 20 * f), inkDim, 10);
    });
  }

  const ai = A0 + SW * v;
  const indexColor = ["idle", "standalone"].includes(state) ? rgba([238, 237, 231], .75 + .25 * Math.sin(t * Math.PI)) : rgba(ac, 1);
  line(ctx, C + Math.cos(ai) * 78, C + Math.sin(ai) * 78,
    C + Math.cos(ai) * 94, C + Math.sin(ai) * 94, indexColor, 6);
  if (state === "teleop") {
    const q = clamp01(st.torque == null ? st.effort : st.torque), aq = A0 + SW * q;
    line(ctx, C + Math.cos(aq) * 82, C + Math.sin(aq) * 82,
      C + Math.cos(aq) * 94, C + Math.sin(aq) * 94, ink, 1.5);
  }
}

// Ferro and Rams are retained above as archived design studies.  The production
// product has one TAKTO face, rendered by device_screen.js, so no alternate
// face can be selected by a stale browser or bridge session.
export function renderAlternateWatchFace(ctx, watch, st, tSeconds) {
  return false;
}
