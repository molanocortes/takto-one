// telemetry.js - the data layer for the console.
//
// One interface, three backends:
//   AutoSource:      the DEFAULT. Tries the live bridge first (ws://localhost:8765/ws,
//                    or a remembered ?ws= URL) and falls back to the built-in mock
//                    after a short timeout, then keeps probing so a bridge that
//                    starts later takes over by itself. Whenever the mock is the
//                    source the page says SIMULATED DATA (sim_badge.js): a demo
//                    must never pass simulated data off as live.
//   MockSource:      rich, seeded, living scene generated in the page. No backend.
//                    Forced with ?mock (or ?mock=1). Emits the full v16 contract
//                    (body, device, sd_takes, neutral acks, take_data) so every
//                    surface is exercisable offline.
//   WebSocketSource: connects to the real host only. Forced with ?ws=<url>
//                    (strict: an unreachable bridge shows LINK DOWN, never mock).
//
// Snapshot shape: software/MOTION_PIPELINE.md (body/device/sd) on top of the
// older DATA_CONTRACT.md keys. No em dashes.

import { curlToJoints } from "./kinematics.js";
import {
  L_UA_M, L_FA_M, HAND_PALM_M, qMul, qConj, qRot, qRx, qRy, qRz, qFromUnitVectors,
  vAdd, vScale, bodyToWorldZup, qNorm,
} from "./arm_model.js";

const FINGERS = ["index", "middle", "ring", "pinky"];
const SEGMENTS = ["mcp", "pip", "dip"];
// The firmware scans 14 mux channels; 12 of them carry an AS5600 (4 fingers x 3),
// and channels 12/13 are wired but unpopulated. Mirrors the bridge's JOINT2CH,
// so the mock's channel numbering is the hardware's, not an invention.
const MOCK_N_CH = 14;
// MOCK DATA ONLY: mirrors the bridge's IMU_CFG_DEFAULT and IMU_OFFSET_PRESETS so
// the #/imu bench can be driven with no bridge. The real values are owned by the
// bridge and arrive in an imu_cfg frame; nothing else may hold a copy.
const MOCK_IMU_PRESETS = {
  identity: [1, 0, 0, 0], "180x": [0, 1, 0, 0], "180y": [0, 0, 1, 0], "180z": [0, 0, 0, 1],
};
const MOCK_IMU_DEFAULT = {
  hand:    { remap: [[-1, "x"], [-1, "z"], [-1, "y"]], offset: [1, 0, 0, 0], flip: null, gain: 1.0, align: null },
  forearm: { remap: [[1, "y"], [1, "z"], [1, "x"]],    offset: [1, 0, 0, 0], flip: null, gain: 1.0, align: null },
  thumb:   { remap: [[1, "x"], [1, "y"], [1, "z"]],    offset: [1, 0, 0, 0], flip: null, gain: 1.0, align: null },
};
const MOCK_CH2JOINT = {};
FINGERS.forEach((f, fi) => SEGMENTS.forEach((s, si) => { MOCK_CH2JOINT[fi * 3 + si] = f + "_" + s; }));
const D2R = Math.PI / 180;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const lerp = (a, b, t) => a + (b - a) * t;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function quatFromRPY(r, p, y) {
  r *= D2R * 0.5; p *= D2R * 0.5; y *= D2R * 0.5;
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p),
        cy = Math.cos(y), sy = Math.sin(y);
  return [cr*cp*cy + sr*sp*sy, sr*cp*cy - cr*sp*sy, cr*sp*cy + sr*cp*sy, cr*cp*sy - sr*sp*cy];
}

// MOCK DATA ONLY: a copy of software/watch/catalog.json so ?mock=1 can exercise the
// watch-face panel with no bridge. The real catalog is generated from the
// firmware registry and served by the host; nothing but this mock may hold a
// face list, and the UI still reads it from the watch_catalog frame.
// MOCK DATA ONLY, mirroring device_screen.js's SCREENS/MODES and the bridge's
// DEVICE_MODES/_DUI_SCREENS. Kept as a literal (not imported) for the same
// reason MOCK_WATCH_CATALOG is: the mock must not reach into a real UI module.
const MOCK_DEVICE_MODES = ["home", "transparent", "capture", "operator", "calibrate"];
const MOCK_DUI_SCREENS = ["boot", "home", "transparent", "capture", "operator", "saved", "calibrate", "safe"];
const MOCK_DUI_ALIASES = { ready: "home", position: "operator", playback: "saved", summary: "saved", fault: "safe" };
const MOCK_DEVICE_ACTIONS = ["nav", "press", "home", "screen", "cal"];

const MOCK_WATCH_CATALOG = {
  kind: "watch_catalog",
  states: ["boot", "idle", "linked", "standalone", "teleop", "recording", "calib", "saved", "stop", "fault", "battery"],
  faces: [
    { id: "thesis", name: "Takto", colorways: [
      { id: "sapphire", name: "Sapphire Depth", rgb: [102, 184, 255], canonical: true, note: "The palette as submitted. The only canonical thesis colorway." },
      { id: "graphite", name: "Graphite", rgb: [150, 165, 180], canonical: false, note: "Non-canonical recolor. Not the documented look." },
      { id: "amber", name: "Amber", rgb: [226, 160, 80], canonical: false, note: "Non-canonical recolor. Not the documented look." },
      { id: "sea", name: "Sea Glass", rgb: [79, 168, 160], canonical: false, note: "Muted teal, tuned for restrained contrast on the round panel." },
      { id: "violet", name: "Violet", rgb: [158, 110, 255], canonical: false, note: "Deep violet with a high-contrast connection marker." },
      { id: "ice", name: "Ice", rgb: [210, 235, 255], canonical: false, note: "Cool white-blue for bright, clean legibility." },
    ] },
  ],
};

function mockWatchPublic(faceId, colorwayId, persisted = false, source = "host") {
  const face = MOCK_WATCH_CATALOG.faces.find((f) => f.id === faceId);
  const cw = face && face.colorways.find((c) => c.id === colorwayId);
  return {
    face: faceId, colorway: colorwayId, persisted, source,
    face_name: face ? face.name : faceId,
    colorway_name: cw ? cw.name : colorwayId,
    rgb: cw ? [...cw.rgb] : [], canonical: !!(cw && cw.canonical),
  };
}

class TelemetrySource {
  constructor() { this._cbs = []; this.kind = "base"; }
  onSnapshot(cb) { this._cbs.push(cb); return () => { this._cbs = this._cbs.filter(c => c !== cb); }; }
  _emit(s) { for (const cb of this._cbs) cb(s); }
  // Transport contract: true means the command was accepted by the active
  // source, false means it never left the caller.  Views use this distinction
  // to show an honest offline warning without guessing from snapshot timing.
  send() { return false; } start() {} stop() {}
  listTakes() { return Promise.resolve([]); }
}

// ---------------------------------------------------------------------------
class WebSocketSource extends TelemetrySource {
  constructor(url, opts = {}) {
    super(); this.kind = "ws"; this.url = url;
    this._ws = null; this._hb = null; this._watch = null; this._closed = false;
    this._takes = []; this._attempt = 0; this._lastRx = 0; this._retryT = null;
    // steady-state retry period; AutoSource lengthens it while the mock is
    // standing in, so an absent bridge costs one refused connect every few s
    this.maxBackoffMs = opts.maxBackoffMs || 5000;
    this.connected = false; this._stateCbs = [];
  }
  // connection-state signal (true = live frames flowing), for the UI badges
  onState(cb) { this._stateCbs.push(cb); return () => { this._stateCbs = this._stateCbs.filter((c) => c !== cb); }; }
  _setUp(up) { if (this.connected === up) return; this.connected = up; for (const cb of this._stateCbs) { try { cb(up); } catch (_) {} } }
  start() {
    this._closed = false;
    this._connect();
    this._hb = setInterval(() => this.send({ cmd: "ping" }), 500);
    // half-open watchdog: the host streams ~30 Hz, so 3 s of silence on an
    // "open" socket means the link is dead even if TCP has not noticed yet.
    // Force-close; onclose schedules the reconnect.
    this._watch = setInterval(() => {
      if (this.connected && performance.now() - this._lastRx > 3000) { try { this._ws.close(); } catch (_) {} }
    }, 1000);
  }
  stop() { this._closed = true; clearInterval(this._hb); clearInterval(this._watch); clearTimeout(this._retryT); if (this._ws) this._ws.close(); this._setUp(false); }
  _connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { return this._retry(); }
    this._ws = ws;
    ws.onopen = () => {
      if (this._ws !== ws) return;
      this._attempt = 0; this._lastRx = performance.now(); this._setUp(true);
    };
    ws.onmessage = (ev) => {
      if (this._ws !== ws) return;
      this._lastRx = performance.now();
      try {
        const s = JSON.parse(ev.data);
        if (s.kind === "snap" || s.kind === "ack") this._emit(s);
        else if (s.kind === "takes") { this._takes = s.takes || []; this._emit(s); }
        else if (s.kind) this._emit(s);   // envs / env / take_data / future kinds
      } catch (_) {}
    };
    ws.onclose = () => {
      // Ignore a late close from an obsolete socket.  Without this guard a
      // stale callback can mark a newer, open connection down and make rapid
      // controls report a false reconnecting state.
      if (this._ws !== ws) return;
      this._ws = null;
      this._setUp(false);
      if (!this._closed) this._retry();
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  _retry() {
    // exponential backoff, 0.5 s doubling to a steady retry, plus jitter
    const d = Math.min(500 * 2 ** Math.min(this._attempt++, 5), this.maxBackoffMs);
    clearTimeout(this._retryT);
    this._retryT = setTimeout(() => { if (!this._closed) this._connect(); }, d + Math.random() * 250);
  }
  // connect again NOW (the "try the bridge" button), instead of waiting out
  // the backoff. A socket that is already connecting is left alone.
  retryNow() {
    if (this._closed || this.connected) return;
    if (this._ws && this._ws.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this._retryT);
    this._attempt = 0;
    this._connect();
  }
  send(cmd) {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(cmd));
      return true;
    } catch (_) {
      // A synchronous send failure is a real link failure.  Closing lets the
      // normal reconnect path take over; the caller gets false and can warn.
      try { ws.close(); } catch (_) {}
      return false;
    }
  }
  listTakes() { return Promise.resolve(this._takes.slice()); }
}

// ---------------------------------------------------------------------------
// MOCK DATA ONLY: a synthetic arm choreography in the contract's body frame
// (MOTION_PIPELINE.md section 7). Shoulder flexion/abduction moves the elbow
// on its sphere, elbow flexion + yaw + pronation turn the forearm, and the
// wrist flexes and deviates. Incommensurate periods so it never visibly
// loops. Used by the live mock AND by the mock's recorded takes.
function mockArmRaw(ts, wave = 0) {
  const s = Math.sin;
  // translation lives mostly in the SHOULDER (what the arm view is for); the
  // segment rotations stay moderate, so the pinned twins (landing hero,
  // hand-only view) keep a calm, readable pose
  const shFlex = 18 + 14 * s(ts * 0.21) + 6 * s(ts * 0.53 + 1);    // deg, forward elevation
  const shAbd = 8 + 7 * s(ts * 0.17 + 2);                          // deg, lateral (right arm: -X)
  const u = qRot(qRz(-shAbd), [0, -Math.cos(shFlex * D2R), Math.sin(shFlex * D2R)]);
  const elev = 8 + 10 * s(ts * 0.37) + 3 * s(ts * 0.9 + 0.5);        // forearm above horizontal
  const yaw = 8 * s(ts * 0.23 + 0.7);
  const pro = 14 * s(ts * 0.31 + 1.3);                             // + = pronation (thumb down)
  let flex = 12 * s(ts * 0.71 + 0.2) + 4 * s(ts * 1.7);              // + = palm-ward
  let dev = 6 * s(ts * 0.43 + 2.1);                                // + = radial
  if (wave) { flex = lerp(flex, 38 * s(ts * 3.2), wave); dev = lerp(dev, 0, wave); }
  return { u, elev, yaw, pro, flex, dev };
}
const MOCK_NEUTRAL_RAW = { u: [0, -1, 0], elev: 0, yaw: 0, pro: 0, flex: 0, dev: 0 };
function mockArmPose(raw) {
  const { u, elev, yaw, pro, flex, dev } = raw;
  const un = Math.hypot(...u) || 1;
  const uu = [u[0] / un, u[1] / un, u[2] / un];
  const elbow = vScale(uu, L_UA_M);
  const qf = qNorm(qMul(qMul(qRy(yaw), qRx(-elev)), qRz(-pro)));
  const qh = qNorm(qMul(qMul(qf, qRx(flex)), qRy(dev)));
  const wrist = vAdd(elbow, qRot(qf, [0, 0, L_FA_M]));
  const hand = vAdd(wrist, qRot(qh, HAND_PALM_M));
  return { elbow, wrist, hand, qf, qh, qu: qFromUnitVectors([0, 0, 1], uu),
           wrist_deg: { flex, dev, pro } };
}
function mixRaw(a, b, k) {
  const o = {};
  for (const key of Object.keys(a)) {
    o[key] = Array.isArray(a[key]) ? a[key].map((v, i) => lerp(v, b[key][i], k)) : lerp(a[key], b[key], k);
  }
  return o;
}
const r4 = (v) => Math.round(v * 1e4) / 1e4;
function quatToRpyDeg(q) {
  const [w, x, y, z] = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(clamp(2 * (w * y - z * x), -1, 1));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [roll / D2R, pitch / D2R, yaw / D2R].map((v) => +v.toFixed(1));
}
function mockJointsAt(ts, degradedRing = false) {
  const joints = [];
  const SPLAY = [9, 2.5, -4, -10];
  FINGERS.forEach((f, fi) => {
    const phase = ts * 0.6 + fi * 0.4;
    const curl = 0.5 - 0.5 * Math.cos(phase);
    const jig = Math.sin(ts * 2 + fi) * 0.4;
    const pair = curlToJoints(curl);
    const degs = {
      mcp: SPLAY[fi] * (1 - 0.75 * curl) + Math.sin(ts * 0.9 + fi * 1.7) * 1.2,
      pip: pair.mcpDeg + jig,
      dip: pair.pipDeg + jig,
    };
    SEGMENTS.forEach((seg, si) => {
      const ok = !(degradedRing && f === "ring" && si === 1);
      // a dead channel is published the way the bridge does it: ok:false, 0.0
      joints.push({ id: `${f}_${seg}`, deg: ok ? +degs[seg].toFixed(2) : 0.0, ok });
    });
  });
  return joints;
}

// MOCK DATA ONLY: the take row layout, mirroring the bridge's ROW_COLS (44
// columns) plus the v16 body columns (MOTION_PIPELINE.md section 7).
const MOCK_ROW_COLS_44 = ["t_ms", ...FINGERS.flatMap((f) => SEGMENTS.map((s) => `${f}_${s}`)),
  "hq_w", "hq_x", "hq_y", "hq_z", "fq_w", "fq_x", "fq_y", "fq_z",
  "tq_w", "tq_x", "tq_y", "tq_z", "blend", "act",
  "px", "py", "pz", "pq_w", "pq_x", "pq_y", "pq_z",
  "thumb_abd", "thumb_mcp", "thumb_ip",
  "ihx", "ihy", "ihz", "ifx", "ify", "ifz", "i_conf"];
const MOCK_BODY_COLS = ["b_ex", "b_ey", "b_ez", "b_wx", "b_wy", "b_wz",
  "b_fq_w", "b_fq_x", "b_fq_y", "b_fq_z", "b_hq_w", "b_hq_x", "b_hq_y", "b_hq_z", "b_cal"];
// where the mock's body frame sits inside the mock room (the headset's
// local-floor space): shoulder 1.32 m up, turned 35 deg, off the room centre
const MOCK_ROOM_YAW = 0.61;
const MOCK_ROOM_SHOULDER = [0.35, 1.32, -0.55];
function bodyToRoom(p) {
  const c = Math.cos(MOCK_ROOM_YAW), s = Math.sin(MOCK_ROOM_YAW);
  return [MOCK_ROOM_SHOULDER[0] + c * p[0] + s * p[2], MOCK_ROOM_SHOULDER[1] + p[1],
          MOCK_ROOM_SHOULDER[2] - s * p[0] + c * p[2]];
}
const MOCK_ROOM_Q = [Math.cos(MOCK_ROOM_YAW / 2), 0, Math.sin(MOCK_ROOM_YAW / 2), 0];

// formats of the mock library: "body" = v16 rows with b_* columns, "legacy" =
// the frozen 34-column layout (headset vision), "inertial" = 44 columns with
// the Z-up inertial displacement only - so replay's fallbacks get exercised
function mockTakeRows(format, durS, seed, withVision) {
  const hz = format === "body" ? 100 : 50;
  const n = Math.round(durS * hz);
  const rows = [];
  const cols = format === "legacy" ? MOCK_ROW_COLS_44.slice(0, 34)
    : format === "inertial" ? MOCK_ROW_COLS_44.slice()
    : MOCK_ROW_COLS_44.concat(MOCK_BODY_COLS);
  let h0 = null;
  for (let i = 0; i < n; i++) {
    const ts = i / hz + seed * 7.3;
    const arm = mockArmPose(mockArmRaw(ts));
    const joints = mockJointsAt(ts);
    const act = clamp(0.4 + 0.35 * Math.sin(ts * 0.9), 0, 1);
    const row = [Math.round(i * 1000 / hz), ...joints.map((j) => j.deg),
      ...arm.qh.map(r4), ...arm.qf.map(r4), 0, 0, 0, 0, 0.35, +act.toFixed(3)];
    if (withVision) {
      row.push(...bodyToRoom(arm.wrist).map(r4), ...qMul(MOCK_ROOM_Q, arm.qh).map(r4));
    } else row.push(null, null, null, null, null, null, null);
    if (format !== "legacy") {
      row.push(null, null, null);                       // no vision thumb
      // inertial displacement since the start, in the IMU's own Z-up world, mm
      if (!h0) h0 = arm.hand;
      const hd = bodyToWorldZup([arm.hand[0] - h0[0], arm.hand[1] - h0[1], arm.hand[2] - h0[2]]);
      row.push(...hd.map((v) => +(v * 1000).toFixed(1)), 0, 0, 0, +(0.6 + 0.3 * Math.sin(ts * 0.25)).toFixed(2));
    }
    if (format === "body") {
      row.push(...arm.elbow.map(r4), ...arm.wrist.map(r4), ...arm.qf.map(r4), ...arm.qh.map(r4), 2);
    }
    rows.push(row);
  }
  return { cols, rows };
}

// MOCK DATA ONLY: a small synthetic room (floor, two walls, a table) as a
// depth point cloud plus a coarse mesh, in the same local-floor space the AR
// client uploads. Deterministic, ~5k points.
function mockEnv() {
  const rng = mulberry32(99);
  const pts = [], w = [];
  const add = (x, y, z, k) => { pts.push(+x.toFixed(3), +y.toFixed(3), +z.toFixed(3)); w.push(k); };
  for (let i = 0; i < 2200; i++) add(-2 + rng() * 4, 0.002 * rng(), -2.4 + rng() * 4, 2 + Math.floor(rng() * 5));
  for (let i = 0; i < 1300; i++) add(-2 + rng() * 4, rng() * 2.5, -2.4, 1 + Math.floor(rng() * 6));
  for (let i = 0; i < 1000; i++) add(-2, rng() * 2.5, -2.4 + rng() * 4, 1 + Math.floor(rng() * 6));
  for (let i = 0; i < 700; i++) add(0.1 + rng() * 1.2, 0.74, -1.25 + rng() * 0.7, 3 + Math.floor(rng() * 4));
  const positions = [-2, 0, -2.4, 2, 0, -2.4, 2, 0, 1.6, -2, 0, 1.6,
    0.1, 0.74, -1.25, 1.3, 0.74, -1.25, 1.3, 0.74, -0.55, 0.1, 0.74, -0.55];
  const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  return { id: "env_mock", name: "Mock lab (synthetic)", points: pts, weights: w, positions, indices };
}

// ---------------------------------------------------------------------------
// AutoSource: live bridge first, simulated fallback, live again when it can.
// The page never guesses silently: `kind` is "pending" while the first probe
// runs, "ws" once the bridge answers, "mock" while the simulation stands in,
// and every change is announced (onSource) so badges and views can follow.
class AutoSource extends TelemetrySource {
  constructor(url, opts = {}) {
    super();
    Object.defineProperty(this, "kind", { get: () => this._active, configurable: true });
    this.url = url;
    this.opts = opts;
    this.fallbackMs = opts.fallbackMs || 1600;
    this._active = "pending";
    this.ws = new WebSocketSource(url);
    this.mock = null;
    this.connected = false;
    this._stateCbs = [];
    this._srcCbs = [];
    this._fallbackT = null;
    this.ws.onSnapshot((s) => { if (this._active === "ws") this._emit(s); });
    this.ws.onState((up) => {
      if (up && this._active !== "ws") this._activate("ws");
      else if (this._active === "ws") this._setUp(up);
    });
  }
  onState(cb) { this._stateCbs.push(cb); return () => { this._stateCbs = this._stateCbs.filter((c) => c !== cb); }; }
  onSource(cb) { this._srcCbs.push(cb); return () => { this._srcCbs = this._srcCbs.filter((c) => c !== cb); }; }
  _setUp(up) {
    if (this.connected === up) return;
    this.connected = up;
    for (const cb of this._stateCbs) { try { cb(up); } catch (_) {} }
  }
  _activate(kind) {
    if (this._active === kind) return;
    clearTimeout(this._fallbackT);
    if (kind === "ws") {
      // the bridge came up: the simulation leaves for good (a later link drop
      // shows LINK DOWN; it never quietly slides back to simulated data)
      if (this.mock) { this.mock.stop(); this.mock = null; }
      this.ws.maxBackoffMs = 5000;
    } else if (kind === "mock") {
      this.mock = new MockSource(this.opts);
      this.mock.onSnapshot((s) => { if (this._active === "mock") this._emit(s); });
      // keep listening for the bridge, gently: one refused connect every ~8 s
      // (each refused connect is a network error line in the dev console)
      this.ws.maxBackoffMs = 8000;
      this.ws._attempt = Math.max(this.ws._attempt, 5);
    }
    this._active = kind;
    for (const cb of this._srcCbs) { try { cb(kind); } catch (_) {} }
    if (kind === "mock") this.mock.start();
    this._setUp(kind === "mock" ? true : this.ws.connected);
  }
  start() {
    this.ws.start();
    this._fallbackT = setTimeout(() => {
      if (this._active === "pending") this._activate("mock");
    }, this.fallbackMs);
  }
  stop() { clearTimeout(this._fallbackT); this.ws.stop(); if (this.mock) this.mock.stop(); }
  /** Probe the bridge now; resolves true if it answered within `ms`. */
  retryNow(ms = 1800) {
    if (this._active === "ws") return Promise.resolve(this.ws.connected);
    this.ws.retryNow();
    return new Promise((res) => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        if (this._active === "ws") { clearInterval(iv); res(true); }
        else if (performance.now() - t0 > ms) { clearInterval(iv); res(false); }
      }, 100);
    });
  }
  send(cmd) {
    if (this._active === "ws") return this.ws.send(cmd);
    if (this._active === "mock" && this.mock) return this.mock.send(cmd);
    return false;
  }
  listTakes() {
    if (this._active === "ws") return this.ws.listTakes();
    if (this._active === "mock" && this.mock) return this.mock.listTakes();
    return Promise.resolve([]);
  }
}

// ---------------------------------------------------------------------------
class MockSource extends TelemetrySource {
  constructor(opts = {}) {
    super();
    this.kind = "mock";
    this.rng = mulberry32(opts.seed || 7);
    this.hz = opts.hz || 40;
    this.activationPresent = opts.activation !== false;
    this.t0 = null; this._timer = null;
    this._degraded = null;                 // a stream name to show unhealthy
    this._rec = { recording: false, paused: false, id: null, profile: null, task: null,
                  storage: "sd", start: 0, samples: 0, quality: "good" };
    this._reps = { active: false, done: 0, goal: 20 };
    this._motorMode = { index_drive: "hold", middle_drive: "off" };
    // no device behind the mock, so the selection is host-held and unpersisted:
    // exactly the state the panel must not present as "the screen changed"
    this._watch = mockWatchPublic("thesis", "sapphire");
    this._imu = structuredClone(MOCK_IMU_DEFAULT);   // mock-only, never persisted
    // device-screen nav state, mirroring teensy_bridge.py's `_dui` / device_command()
    // field for field so ?mock=1 exercises the SAME control the live bridge does,
    // rather than silently no-opping the way an unhandled cmd would.
    this._dui = { screen: "home", mode: "transparent", menuIndex: 1, cal: false, source: "mock" };
    this._watchLast = {};
    for (const f of MOCK_WATCH_CATALOG.faces) {
      const c = (f.colorways.find((x) => x.canonical) || f.colorways[0]);
      this._watchLast[f.id] = c && c.id;
    }
    this._takes = this._seedTakes();
    // ---- v16 device + body model state (MOTION_PIPELINE.md sections 3, 6, 7)
    this._dev = { fw: 16, boot_id: 1 + Math.floor(this.rng() * 65534),
      sd_present: true, sd_recording: false, sd_take: 0, sd_rows: 0,
      standby: false, standalone_auto_record: true, neutral_running: false };
    this._sdNext = 13;
    this._sd = [
      { name: "TK00010.CSV", bytes: 1812344, imported_take: "take_0002" },
      { name: "TK00011.CSV", bytes: 2403118, imported_take: null },
      { name: "TK00012.CSV", bytes: 906452, imported_take: null },
    ];
    this._sdBusy = false;
    // none -> provisional (auto, first stillness) -> calibrated (explicit neutral)
    this._neutral = { state: "none", at: 0 };
    this._calTimers = [];
    this._toNeutral = 0;          // 0..1: the arm eases to the neutral pose while capturing
    this._toNeutralT = 0;
    this._wave = 0;               // 0..1: wrist-axis step (flexion/extension waves)
    this._waveT = 0;
    this._env = null;             // built on first request
  }
  start() {
    const dt = 1000 / this.hz;
    this._timer = setInterval(() => this._tick(), dt);
    this._emit(MOCK_WATCH_CATALOG);           // host pushes the catalog on join
    // the bridge's join pushes: library, environments, SD library
    this._emit({ kind: "takes", takes: this._takes.slice() });
    this._emit({ kind: "envs", envs: [this._envMeta()] });
    this._emitSd();
  }
  stop() {
    clearInterval(this._timer);
    for (const t of this._calTimers) clearTimeout(t);
    this._calTimers = [];
  }
  listTakes() { return Promise.resolve(this._takes.map((t) => this._pub(t))); }

  _seedTakes() {
    const tasks = ["grasp-cylinder", "pinch", "free-manipulation", "open-close", "grasp-sphere"];
    const names = ["A. User", "B. User", "C. User"];
    // replay formats, so every replay path runs offline: v16 body rows (with and
    // without a headset anchor), the frozen 34-column vision layout, and the
    // 44-column inertial-only layout; one take predates the 4D update entirely
    const FORMATS = { 1: ["body", true], 2: ["body", false], 3: ["legacy", true],
                      4: ["inertial", false], 5: ["body", false], 6: [null, false], 7: ["body", true] };
    const out = [];
    for (let i = 1; i <= 7; i++) {
      const spark = Array.from({ length: 120 }, (_, k) => 0.5 - 0.5 * Math.cos(k / 8 + i) + (this.rng() - 0.5) * 0.1);
      const [format, vision] = FORMATS[i];
      const t = { id: "take_" + String(i).padStart(4, "0"),
                 profile: names[i % names.length], task: tasks[i % tasks.length],
                 created_ms: i * 1000, duration_s: 12 + Math.floor(this.rng() * 14),
                 samples: 1000 + Math.floor(this.rng() * 3000),
                 quality: this.rng() > 0.15 ? "good" : "noisy", spark };
      if (format) {
        t.has_data = true;
        t._format = format; t._vision = vision; t._seed = i;
        t.traj = vision;
        t.traj_inertial = format !== "legacy";
        t.body = format === "body";
        t.joint_source = "sim";
        if (vision) t.env = "env_mock";
      }
      out.push(t);
    }
    return out.reverse();
  }

  // public copy of a take (the private generator fields stay here)
  _pub(t) {
    const o = {};
    for (const [k, v] of Object.entries(t)) if (!k.startsWith("_")) o[k] = v;
    return o;
  }
  _pushTakes() { this._emit({ kind: "takes", takes: this._takes.map((t) => this._pub(t)) }); }
  _emitSd() {
    this._emit({ kind: "sd_takes", items: this._sd.map((x) => ({ ...x })), busy: this._sdBusy });
  }
  _envMeta() {
    return { id: "env_mock", name: "Mock lab (synthetic)", created_ms: 0, pts: 5200, tris: 4,
             bbox: [[-2, 0, -2.4], [2, 2.5, 1.6]] };
  }
  _later(ms, fn) { const t = setTimeout(fn, ms); this._calTimers.push(t); return t; }

  // neutral capture, as the device + bridge run it: 3-2-1 countdown, 2 s hold,
  // done. The mock arm eases into the neutral pose so the twin shows it.
  _runNeutral() {
    if (this._dev.neutral_running) return;
    this._dev.neutral_running = true;
    this._toNeutralT = 1;
    const ack = (phase, t) => this._emit({ kind: "ack", event: "neutral", phase, t });
    ack("countdown", 3);
    this._later(1000, () => ack("countdown", 2));
    this._later(2000, () => ack("countdown", 1));
    this._later(3000, () => ack("hold", 2));
    this._later(4000, () => ack("hold", 1));
    this._later(5000, () => {
      this._neutral = { state: "calibrated", at: this._now() };
      this._dev.neutral_running = false;
      this._toNeutralT = 0;
      ack("done", 0);
    });
  }
  // functional wrist axis: 5 s of flexion/extension (the ack shape is not in
  // the contract; the UI also runs its own clock, so a bridge that only acks
  // "done" or nothing at all still reads correctly)
  _runWristAxis() {
    if (this._waveT) return;
    this._waveT = 1;
    const ack = (phase, t, extra = {}) => this._emit({ kind: "ack", event: "wrist_axis", phase, t, ...extra });
    for (let k = 0; k < 5; k++) this._later(k * 1000, () => ack("collect", 5 - k));
    this._later(5000, () => {
      this._waveT = 0;
      ack("done", 0, { ok: true, residual_deg: 3.1 });
    });
  }
  _sdImport(name) {
    const item = this._sd.find((x) => x.name === name);
    if (!item) { this._emit({ kind: "ack", event: "error", error: "no such SD take", cmd: "sd", name }); return; }
    if (this._sdBusy) { this._emit({ kind: "ack", event: "error", error: "sd busy", cmd: "sd", name }); return; }
    this._sdBusy = true;
    this._emitSd();
    for (let k = 0; k <= 10; k++) {
      this._later(k * 220, () => this._emit({ kind: "ack", event: "sd_import", name, pct: k * 10 }));
    }
    this._later(2500, () => {
      const id = "take_" + String(this._takes.length + 1).padStart(4, "0");
      const spark = Array.from({ length: 120 }, (_, k) => 0.5 - 0.5 * Math.cos(k / 7) + (this.rng() - 0.5) * 0.08);
      const dur = Math.round(item.bytes / 42000);
      this._takes.unshift({ id, profile: "Device", task: "standalone", created_ms: Math.floor(this._now()),
        duration_s: dur, samples: dur * 100, quality: "good", spark, has_data: true,
        body: true, traj: false, traj_inertial: true, joint_source: "sim", source: "sd", sd_name: name,
        _format: "body", _vision: false, _seed: 11 + this._takes.length });
      item.imported_take = id;
      this._sdBusy = false;
      this._emit({ kind: "ack", event: "sd_imported", name, take: id });
      this._pushTakes();
      this._emitSd();
    });
  }
  _takeData(id) {
    const t = this._takes.find((x) => x.id === id);
    if (!t || !t.has_data) { this._emit({ kind: "ack", event: "error", error: "no replay data", id }); return; }
    const { cols, rows } = mockTakeRows(t._format, Math.min(t.duration_s, 24), t._seed, t._vision);
    const payload = { kind: "take_data", id, cols, rows, joint_source: "sim" };
    if (t.env) payload.env = t.env;
    // off the tick: a real bridge answers a few frames later too
    setTimeout(() => this._emit(payload), 60);
  }

  send(cmd) {
    if (!cmd || !cmd.cmd) return false;
    switch (cmd.cmd) {
      case "imu_cfg":
        this._imuCfg(cmd);
        return true;
      case "record":
        if (cmd.action === "start") {
          this._rec.recording = true; this._rec.start = this._now();
          this._rec.id = "take_" + String(this._takes.length + 1).padStart(4, "0");
          this._rec.profile = (cmd.profile && cmd.profile.name) || "Operator";
          this._rec.task = cmd.task || "unlabelled"; this._rec.samples = 0;
          // v16: the host's record also writes the SD card (the archival copy)
          Object.assign(this._dev, { sd_recording: true, sd_take: this._sdNext++, sd_rows: 0 });
          this._emit({ kind: "ack", event: "rec_started", id: this._rec.id });
        } else if (cmd.action === "stop") {
          if (!this._rec.recording) break;
          const dur = (this._now() - this._rec.start) / 1000;
          const spark = Array.from({ length: 120 }, (_, k) => 0.5 - 0.5 * Math.cos(k / 8) + (this.rng() - 0.5) * 0.08);
          this._takes.unshift({ id: this._rec.id, profile: this._rec.profile, task: this._rec.task,
            created_ms: Math.floor(this._now()), duration_s: +dur.toFixed(1),
            samples: this._rec.samples, quality: this._rec.quality, spark,
            has_data: dur > 0.5, body: true, traj: false, traj_inertial: true, joint_source: "sim",
            _format: "body", _vision: false, _seed: 20 + this._takes.length });
          this._sd.push({ name: "TK" + String(this._dev.sd_take).padStart(5, "0") + ".CSV",
            bytes: this._dev.sd_rows * 420, imported_take: this._rec.id });
          Object.assign(this._dev, { sd_recording: false, sd_take: 0 });
          this._rec.recording = false;
          this._emit({ kind: "ack", event: "rec_stopped", id: this._rec.id });
          this._pushTakes();
          this._emitSd();
        }
        break;
      case "motor": if (cmd.id) this._motorMode[cmd.id] = cmd.mode || (cmd.torque ? "hold" : "off"); break;
      case "guided":
        if (cmd.action === "start") { this._reps = { active: true, done: 0, goal: cmd.goal || 20 }; }
        else { this._reps.active = false; }
        break;
      case "calibrate":
        if (cmd.what === "neutral") this._runNeutral();
        else if (cmd.what === "wrist_axis") this._runWristAxis();
        else this._emit({ kind: "ack", event: "calibrated" });
        break;
      case "sd":
        if (cmd.action === "list") this._emitSd();
        else if (cmd.action === "import") this._sdImport(String(cmd.name || ""));
        else if (cmd.action === "auto") {
          this._dev.standalone_auto_record = !!cmd.on;
          this._emit({ kind: "ack", event: "sd_auto", on: !!cmd.on });
        } else this._emit({ kind: "ack", event: "error", error: "unknown sd action", cmd: "sd" });
        break;
      case "take_data": this._takeData(String(cmd.id || "")); break;
      case "env_list": this._emit({ kind: "envs", envs: [this._envMeta()] }); break;
      case "env_get":
        if (cmd.id === "env_mock") { this._env = this._env || mockEnv(); this._emit({ kind: "env", ...this._env }); }
        else this._emit({ kind: "ack", event: "error", error: "unknown env", id: cmd.id });
        break;
      case "watch": this._watchCmd(cmd); break;
      case "device": this._deviceCmd(cmd); break;
      default: break;
    }
    return true;
  }

  // mirrors teensy_bridge.py device_command(): validates, mutates _dui, acks.
  // A rejected command changes nothing, same rule as the watch-face command.
  _deviceCmd(cmd) {
    const action = cmd.action;
    if (!MOCK_DEVICE_ACTIONS.includes(action)) {
      this._emit({ kind: "ack", event: "error", error: "unknown_device_action", cmd: "device" });
      return;
    }
    const screen = action === "screen" ? (MOCK_DUI_ALIASES[cmd.screen] || cmd.screen) : cmd.screen;
    if (action === "screen" && !MOCK_DUI_SCREENS.includes(screen)) {
      this._emit({ kind: "ack", event: "error", error: "unknown_screen", cmd: "device" });
      return;
    }
    if (action === "nav" && cmd.dir !== "cw" && cmd.dir !== "ccw") {
      this._emit({ kind: "ack", event: "error", error: "unknown_direction", cmd: "device" });
      return;
    }
    const s = this._dui;
    s.source = cmd.source || "website";
    if (action === "screen") s.screen = screen;
    else if (action === "home") s.screen = "home";
    else if (action === "cal") s.cal = cmd.screen != null ? !!cmd.screen : true;
    else if (action === "nav") {
      const n = MOCK_DEVICE_MODES.length;
      const current = MOCK_DEVICE_MODES.includes(s.screen) ? s.screen : s.mode;
      const base = Math.max(0, MOCK_DEVICE_MODES.indexOf(current));
      s.menuIndex = (base + (cmd.dir === "cw" ? 1 : -1) + n) % n;
      s.mode = MOCK_DEVICE_MODES[s.menuIndex];
      s.screen = s.mode;
    } else if (action === "press") {
      if (s.screen === "home") { s.mode = MOCK_DEVICE_MODES[s.menuIndex]; s.screen = s.mode; }
      else s.screen = "home";
    }
    this._emit({ kind: "ack", event: "device", action, requested: s.screen, mode: s.mode, source: s.source });
  }

  // the same auto-override layering as build_device_ui(): what's ACTUALLY shown
  // can differ from what was requested (recording, calibrating, no device), and
  // WHY is surfaced rather than silently swapping the screen under the user.
  _buildDeviceUi(healthMap) {
    const s = this._dui;
    let screen = s.screen;
    let override = null;
    if (this._rec.recording) { screen = "capture"; override = "recording"; }
    else if (s.cal && screen !== "boot" && screen !== "safe") { screen = "calibrate"; override = "calibrating"; }
    return {
      screen, mode: s.mode, menuIndex: s.menuIndex, modes: MOCK_DEVICE_MODES,
      requested: s.screen, override, screens: MOCK_DUI_SCREENS,
      health: { imu: healthMap.imu, enc: healthMap.encoders, drv: healthMap.motors, lnk: healthMap.link },
      boot: 1, angleDeg: 0, targetDeg: 62, source: s.source,
    };
  }

  _watchCmd(cmd) {
    const faces = MOCK_WATCH_CATALOG.faces;
    if (cmd.action === "list" || (!cmd.face && !cmd.colorway)) { this._emit(MOCK_WATCH_CATALOG); return; }
    const face = cmd.face ? faces.find((f) => f.id === cmd.face) : faces.find((f) => f.id === this._watch.face);
    if (!face) { this._emit({ kind: "ack", event: "error", error: "unknown_face", cmd: "watch" }); return; }
    let cw = cmd.colorway ? face.colorways.find((c) => c.id === cmd.colorway) : null;
    if (cmd.colorway && !cw) { this._emit({ kind: "ack", event: "error", error: "unknown_colorway", cmd: "watch" }); return; }
    if (!cw) cw = face.colorways.find((c) => c.id === this._watchLast[face.id]) || face.colorways[0];
    this._watchLast[face.id] = cw.id;
    this._watch = mockWatchPublic(face.id, cw.id);
    this._emit({ kind: "ack", event: "watch", ...this._watch });
  }

  // Per-IMU mounting config. Mirrors the bridge's imu_cfg command closely enough
  // that the #/imu bench is fully exercisable with no hardware - INCLUDING the
  // rejections, because a validator that only exists on the real device is a
  // validator nobody tests. Mock-only state: nothing here is persisted, and the
  // MOCK badge on the page says so.
  _imuCfg(cmd) {
    const KEYS = ["hand", "forearm", "thumb"];
    const AX = ["x", "y", "z"];
    const reply = (extra) => this._emit({ kind: "ack", event: "imu_cfg", imu: cmd.imu, ...extra });
    const action = cmd.action || "get";
    if (action === "get") {
      reply({ ok: true, cfg: this._imu, presets: MOCK_IMU_PRESETS });
      this._emit({ kind: "imu_cfg", cfg: this._imu, presets: MOCK_IMU_PRESETS });
      return;
    }
    if (action === "reset") {
      const who = cmd.imu;
      if (who == null || who === "all") this._imu = structuredClone(MOCK_IMU_DEFAULT);
      else if (KEYS.includes(who)) this._imu[who] = structuredClone(MOCK_IMU_DEFAULT[who]);
      else return reply({ ok: false, error: `unknown imu '${who}'` });
      this._emit({ kind: "imu_cfg", cfg: this._imu });
      return reply({ ok: true, cfg: this._imu });
    }
    if (action === "set") {
      const who = cmd.imu, patch = cmd.patch || {};
      if (!KEYS.includes(who)) return reply({ ok: false, error: `unknown imu '${who}'` });
      for (const [k, v] of Object.entries(patch)) {
        if (k === "remap") {
          const seen = new Set();
          const ok = Array.isArray(v) && v.length === 3 && v.every((e) =>
            Array.isArray(e) && e.length === 2 && (e[0] === 1 || e[0] === -1) &&
            AX.includes(e[1]) && !seen.has(e[1]) && seen.add(e[1]));
          if (!ok) return reply({ ok: false, error: "remap must be 3 (sign, axis) pairs using x/y/z exactly once" });
          if (this._imu[who].align) this._imu[who].align = null;
        } else if (k === "gain") {
          if (typeof v !== "number" || v < 0 || v > 2) return reply({ ok: false, error: "gain must be between 0 and 2" });
        } else if (k === "flip") {
          if (v !== null && !AX.includes(v)) return reply({ ok: false, error: "flip must be null or one of x/y/z" });
        } else if (k !== "offset" && k !== "align") {
          return reply({ ok: false, error: `unknown field '${k}'` });
        }
        this._imu[who][k] = v;
      }
      this._emit({ kind: "imu_cfg", cfg: this._imu });
      return reply({ ok: true, cfg: this._imu });
    }
    reply({ ok: false, error: `unknown action '${action}'` });
  }

  // test hook: degrade one health stream (call from console to check the UI)
  degrade(stream) { this._degraded = stream; }

  _now() { return this.t0 == null ? 0 : (performance.now() - this.t0); }

  _tick() {
    if (this.t0 == null) this.t0 = performance.now();
    const t = this._now(), ts = t / 1000;
    const dtS = 1 / this.hz;

    // ---- the arm, in the contract's body frame --------------------------
    // eases toward the neutral pose while a neutral capture runs, and into
    // wrist waves while the wrist-axis step collects
    this._toNeutral += (this._toNeutralT - this._toNeutral) * (1 - Math.exp(-dtS / 0.45));
    this._wave += (this._waveT - this._wave) * (1 - Math.exp(-dtS / 0.35));
    const raw = mixRaw(mockArmRaw(ts, this._wave), MOCK_NEUTRAL_RAW, this._toNeutral);
    const arm = mockArmPose(raw);
    if (this._neutral.state === "none" && ts > 1.5) this._neutral = { state: "provisional", at: t };
    const calibrated = this._neutral.state === "calibrated";
    const body = {
      frame: "body_yup_v1", calibrated, provisional: this._neutral.state === "provisional",
      live: true, shoulder_m: [0, 0, 0],
      elbow_m: arm.elbow.map(r4), wrist_m: arm.wrist.map(r4), hand_m: arm.hand.map(r4),
      upperarm_quat: arm.qu.map(r4), forearm_quat: arm.qf.map(r4), hand_quat: arm.qh.map(r4),
      thumb_quat: null,
      wrist_deg: { flex: +arm.wrist_deg.flex.toFixed(1), dev: +arm.wrist_deg.dev.toFixed(1),
                   pro: +arm.wrist_deg.pro.toFixed(1) },
      pos_source: "arm+inertial",
      quality: { since_neutral_s: this._neutral.state === "none" ? null : +((t - this._neutral.at) / 1000).toFixed(1),
                 inertial_conf: +clamp(0.55 + 0.35 * Math.sin(ts * 0.25), 0, 1).toFixed(2),
                 still: this._toNeutral > 0.9 },
    };
    if (this._rec.recording) this._dev.sd_rows += Math.round(100 / this.hz);
    const device = { ...this._dev };

    // the old keys stay (contract: compatibility), derived from the same arm
    const hand = { quat: arm.qh.map(r4), rpy_deg: quatToRpyDeg(arm.qh), live: true };
    const forearm = { quat: arm.qf.map(r4), rpy_deg: quatToRpyDeg(arm.qf), live: true };
    const rel = { quat: qMul(qConj(arm.qf), arm.qh).map(r4), live: true };

    // slow flex/extend of all fingers, staggered. Channel semantics follow
    // the mechanism's chain, palm outward: {f}_mcp = MCP ABDUCTION (signed
    // deg, splayed when open, adducting as the finger curls), {f}_pip = MCP
    // flexion, {f}_dip = PIP flexion.
    const joints = mockJointsAt(ts, this._degraded === "encoders");

    const eff = this.activationPresent ? clamp(0.4 + 0.35 * Math.sin(ts * 0.9) + (this.rng() - 0.5) * 0.03, 0, 1) : 0;
    const activation = this.activationPresent
      ? { present: true, level: +eff.toFixed(3), direction: +(0.3 * Math.sin(ts)).toFixed(2),
          fatigue: +clamp(ts * 0.002, 0, 0.4).toFixed(3), onset: eff > 0.6,
          quality: this._degraded === "activation" ? "noisy" : "good" }
      : { present: false, level: 0, direction: 0, fatigue: 0, onset: false, quality: "none" };

    const motors = ["index_drive", "middle_drive"].map((id, i) => {
      const on = this._motorMode[id] !== "off";
      return { id, pos_deg: joints[i * 3 + 1].deg, vel_dps: +(Math.cos(ts * 2) * 5).toFixed(2),
               current_ma: on ? +(20 + 25 * Math.abs(Math.sin(ts + i))).toFixed(1) : 0.0,
               temp_c: +(31 + i).toFixed(1), voltage_v: 12.0, torque_on: on, mode: this._motorMode[id] };
    });

    const health = [
      { stream: "encoders", ok: this._degraded !== "encoders", rate_hz: 50, detail: this._degraded === "encoders" ? "11/12" : "12/12" },
      { stream: "imu", ok: this._degraded !== "imu", rate_hz: 50, detail: "2/2" },
      { stream: "activation", ok: this._degraded !== "activation" && this.activationPresent, rate_hz: 50 },
      { stream: "motors", ok: true, rate_hz: 50 },
      { stream: "link", ok: true, rate_hz: 30 },
    ];

    if (this._rec.recording) this._rec.samples += 1;
    if (this._reps.active && Math.sin(ts * 0.6) > 0.98) this._reps.done++;

    const session = { recording: this._rec.recording, paused: false, id: this._rec.id,
      profile: this._rec.profile, task: this._rec.task, storage: "sd",
      elapsed_ms: this._rec.recording ? Math.floor(t - this._rec.start) : 0,
      samples: this._rec.samples, quality: this._degraded ? "check" : "good" };

    const h = {};
    for (const x of health) h[x.stream] = x.ok;

    // Raw encoder channels. The operator console's encoder board reads
    // snap.encoders, and the mock never produced it, so all 14 channel chips sat
    // in their "absent" state and the footer never left its 0 / 14 placeholder
    // whenever the console ran without a bridge. The joints above are the same
    // measurements already; this is the per-CHANNEL view the hardware speaks.
    const encoders = [];
    for (let ch = 0; ch < MOCK_N_CH; ch++) {
      const j = MOCK_CH2JOINT[ch];
      const src = j ? joints.find((x) => x.id === j) : null;
      const ok = !!src && src.ok;
      encoders.push({ ch, deg: ok ? src.deg : -1.0, ok, joint: j || null });
    }

    // ---- full BNO085 report set + dead reckoning (mirrors firmware v7) ------
    // Simulated so the #/imu bench can be exercised with no hardware. The
    // numbers are physically consistent: linear acceleration is the second
    // derivative of the modelled motion, gravity is a unit-g vector, and the
    // accelerometer is their sum, which is what the real sensor reports.
    const wob = (a, f, p) => a * Math.sin(ts * f + p);
    const imuFull = {};
    const perImu = {};
    for (const [i, key] of ["hand", "forearm", "thumb"].entries()) {
      const amp = key === "hand" ? 1.0 : key === "forearm" ? 0.25 : 0.6;
      // position from a smooth path, acceleration as its exact 2nd derivative
      const w = 0.8 + i * 0.15, A = 0.06 * amp;
      const pos = [A * Math.sin(ts * w), A * 0.4 * Math.sin(ts * w * 1.7), A * 0.6 * Math.cos(ts * w)];
      const lin = [-A * w * w * Math.sin(ts * w),
                   -A * 0.4 * (w * 1.7) ** 2 * Math.sin(ts * w * 1.7),
                   -A * 0.6 * w * w * Math.cos(ts * w)];
      const grv = [wob(0.4, 0.3, i), -9.78 + wob(0.05, 0.4, i), wob(0.3, 0.25, i)];
      imuFull[key] = {
        lin: lin.map((v) => +v.toFixed(3)),
        acc: lin.map((v, k) => +(v + grv[k]).toFixed(3)),
        gyr: [wob(0.20, 0.9, i), wob(0.14, 0.7, i + 1), wob(0.10, 1.1, i + 2)].map((v) => +v.toFixed(4)),
        mag: [wob(6, 0.2, i) + 22, wob(5, 0.17, i) - 8, wob(4, 0.23, i) + 39].map((v) => +v.toFixed(2)),
        grv: grv.map((v) => +v.toFixed(3)),
        game: quatFromRPY(2, 1, 4),
        // the magnetometer sits next to twelve neodymium magnets, so a low mag
        // accuracy is the honest mock, not a pessimistic one
        accuracy: { acc: 3, gyr: 3, mag: this._degraded === "imu" ? 0 : 1 },
        rot_accuracy_rad: 0.0524,
      };
      const speed = Math.hypot(...lin);
      perImu[key] = {
        pos_mm: pos.map((v) => +(v * 1000).toFixed(1)),
        vel_mm_s: lin.map((v) => +(v * 100).toFixed(1)),
        bias: [0.002, -0.001, 0.003], still: speed < 0.05,
        since_zupt_s: +(1.5 + Math.sin(ts * 0.3)).toFixed(2),
        confidence: +Math.max(0, Math.min(1, 0.6 + 0.3 * Math.sin(ts * 0.25))).toFixed(2),
        zupts: Math.floor(ts / 4),
      };
    }
    const relP = [0, 1, 2].map((k) => +(perImu.hand.pos_mm[k] - perImu.forearm.pos_mm[k]).toFixed(1));
    const inertial = {
      per_imu: perImu, rel_pos_mm: relP,
      rel_dist_mm: +Math.hypot(...relP).toFixed(1),
      confidence: Math.min(perImu.hand.confidence, perImu.forearm.confidence),
      frames_aligned: true,
      method: "strapdown double integration of linear acceleration, ZUPT-corrected",
      drifts: true,
    };

    this._emit({ kind: "snap", t_ms: Math.floor(t), state: this._rec.recording ? "running" : "ready",
      link: { device: true, motors: true }, hand, forearm, rel, body, device,
      joints, encoders, activation, motors, health, session,
      imu_full: imuFull, inertial,
      watch: { ...this._watch }, device_ui: this._buildDeviceUi(h),
      reps: { done: this._reps.done, goal: this._reps.goal, active: this._reps.active } });
  }
}

// Pages served from this machine or the lab LAN probe for the bridge by
// default. A public origin does not: a browser would otherwise ask every
// visitor of the landing page for local-network access to a bridge they do
// not have. ?auto forces the probe anywhere.
function isLocalOrigin() {
  if (typeof location === "undefined") return false;
  const h = location.hostname || "";
  if (location.protocol === "file:" || !h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".test")) return true;
  if (h === "[::1]" || h === "::1") return true;
  return /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}
// the default bridge lives on the machine that serves the page (a phone on the
// lab LAN opening http://192.168.x.y must not dial its OWN localhost)
function defaultBridgeUrl() {
  const h = (typeof location !== "undefined" && location.hostname) || "localhost";
  const local = !h || h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  return `ws://${local ? "localhost" : h}:8765/ws`;
}

export function makeTelemetry(opts = {}) {
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const hasLS = typeof localStorage !== "undefined";
  const forceMock = opts.mock === true || params.has("mock");
  // ?mock forces the simulation AND forgets any remembered live bridge.
  if (forceMock) {
    try { if (hasLS) { localStorage.removeItem("zero.ws"); localStorage.removeItem("zero.ws.ts"); } } catch (_) {}
    return new MockSource(opts);
  }
  // An explicit ?ws= URL is STRICT (live or LINK DOWN, never the mock) and is
  // REMEMBERED, so a later navigation that drops the query stays on that bridge.
  const explicit = opts.url || params.get("ws") || null;
  // A remembered bridge must not outlive its usefulness. With no expiry, a single visit
  // carrying ?ws= pinned every later visit to that bridge: once it is gone, or still running
  // but no longer producing joint motion, the landing page silently shows a dead hand and
  // there is no way back short of clearing storage. Remember it, but only for a while.
  const WS_MEMORY_MS = 6 * 60 * 60 * 1000;   // 6 hours
  let remembered = null;
  try {
    if (explicit && hasLS) {
      localStorage.setItem("zero.ws", explicit);
      localStorage.setItem("zero.ws.ts", String(Date.now()));
    } else if (!explicit && hasLS) {
      const r = localStorage.getItem("zero.ws");
      const ts = Number(localStorage.getItem("zero.ws.ts") || 0);
      if (r && Date.now() - ts < WS_MEMORY_MS) remembered = r;
      else if (r) { localStorage.removeItem("zero.ws"); localStorage.removeItem("zero.ws.ts"); }
    }
  } catch (_) {}
  if (explicit || opts.mock === false) return new WebSocketSource(explicit || defaultBridgeUrl());
  // default: live bridge first (remembered URL, else the local default), and
  // the badged simulation only when nothing answers
  if (remembered || isLocalOrigin() || params.has("auto")) {
    return new AutoSource(remembered || defaultBridgeUrl(), opts);
  }
  return new MockSource(opts);   // public origin: simulation, badged as such
}

export { TelemetrySource, MockSource, WebSocketSource, AutoSource };
