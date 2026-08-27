// telemetry.js - the data layer for the console.
//
// One interface, two backends:
//   MockSource:      rich, seeded, living scene generated in the page. No backend.
//                    Default (or ?mock=1). Lets you build + self-verify every
//                    surface (Operator, Guided, Capture) + the live twin.
//   WebSocketSource: connects to the real host (ws://host:8765/ws) or a ws mock.
//
// Build the whole console against TelemetrySource. Flip one flag to go live.
// Snapshot shape is defined in ../../DATA_CONTRACT.md. No em dashes.

import { curlToJoints } from "./kinematics.js";

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
  constructor(url) {
    super(); this.kind = "ws"; this.url = url;
    this._ws = null; this._hb = null; this._watch = null; this._closed = false;
    this._takes = []; this._attempt = 0; this._lastRx = 0;
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
  stop() { this._closed = true; clearInterval(this._hb); clearInterval(this._watch); if (this._ws) this._ws.close(); this._setUp(false); }
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
    // exponential backoff, 0.5 s doubling to a 5 s steady retry, plus jitter
    const d = Math.min(500 * 2 ** Math.min(this._attempt++, 4), 5000);
    setTimeout(() => { if (!this._closed) this._connect(); }, d + Math.random() * 250);
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
  }
  start() {
    const dt = 1000 / this.hz;
    this._timer = setInterval(() => this._tick(), dt);
    this._emit(MOCK_WATCH_CATALOG);           // host pushes the catalog on join
  }
  stop() { clearInterval(this._timer); }
  listTakes() { return Promise.resolve(this._takes.slice()); }

  _seedTakes() {
    const tasks = ["grasp-cylinder", "pinch", "free-manipulation", "open-close", "grasp-sphere"];
    const names = ["A. User", "B. User", "C. User"];
    const out = [];
    for (let i = 1; i <= 7; i++) {
      const spark = Array.from({ length: 120 }, (_, k) => 0.5 - 0.5 * Math.cos(k / 8 + i) + (this.rng() - 0.5) * 0.1);
      out.push({ id: "take_" + String(i).padStart(4, "0"),
                 profile: names[i % names.length], task: tasks[i % tasks.length],
                 created_ms: i * 1000, duration_s: 20 + Math.floor(this.rng() * 60),
                 samples: 1000 + Math.floor(this.rng() * 3000),
                 quality: this.rng() > 0.15 ? "good" : "noisy", spark });
    }
    return out.reverse();
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
          this._emit({ kind: "ack", event: "rec_started", id: this._rec.id });
        } else if (cmd.action === "stop") {
          const dur = (this._now() - this._rec.start) / 1000;
          const spark = Array.from({ length: 120 }, (_, k) => 0.5 - 0.5 * Math.cos(k / 8) + (this.rng() - 0.5) * 0.08);
          this._takes.unshift({ id: this._rec.id, profile: this._rec.profile, task: this._rec.task,
            created_ms: Math.floor(this._now()), duration_s: +dur.toFixed(1),
            samples: this._rec.samples, quality: this._rec.quality, spark });
          this._rec.recording = false;
          this._emit({ kind: "ack", event: "rec_stopped", id: this._rec.id });
        }
        break;
      case "motor": if (cmd.id) this._motorMode[cmd.id] = cmd.mode || (cmd.torque ? "hold" : "off"); break;
      case "guided":
        if (cmd.action === "start") { this._reps = { active: true, done: 0, goal: cmd.goal || 20 }; }
        else { this._reps.active = false; }
        break;
      case "calibrate": this._emit({ kind: "ack", event: "calibrated" }); break;
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
    const breathe = Math.sin(ts * 0.5);

    const hand = { quat: quatFromRPY(3 + breathe * 2, -5, 8 + breathe * 3), rpy_deg: [3 + breathe * 2, -5, 8 + breathe * 3] };
    const forearm = { quat: quatFromRPY(1, 0.5 * Math.sin(ts * 0.2), 3), rpy_deg: [1, 0.5, 3] };

    // slow flex/extend of all fingers, staggered. Channel semantics follow
    // the mechanism's chain, palm outward: {f}_mcp = MCP ABDUCTION (signed
    // deg, splayed when open, adducting as the finger curls), {f}_pip = MCP
    // flexion, {f}_dip = PIP flexion.
    const joints = [];
    const SPLAY = [9, 2.5, -4, -10];                         // index..pinky neutral splay
    FINGERS.forEach((f, fi) => {
      const phase = ts * 0.6 + fi * 0.4;
      const curl = 0.5 - 0.5 * Math.cos(phase);              // 0..1
      const jig = Math.sin(ts * 2 + fi) * 0.4;
      const pair = curlToJoints(curl);                       // canonical: MCP 90, PIP 110
      const degs = {
        mcp: SPLAY[fi] * (1 - 0.75 * curl) + Math.sin(ts * 0.9 + fi * 1.7) * 1.2,
        pip: pair.mcpDeg + jig,                              // MCP flexion channel
        dip: pair.pipDeg + jig,                              // PIP flexion channel (trailing)
      };
      SEGMENTS.forEach((seg, si) => {
        const ok = !(this._degraded === "encoders" && f === "ring" && si === 1);
        joints.push({ id: `${f}_${seg}`, deg: +degs[seg].toFixed(2), ok });
      });
    });

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
      link: { device: true, motors: true }, hand, forearm, joints, encoders, activation, motors, health, session,
      imu_full: imuFull, inertial,
      watch: { ...this._watch }, device_ui: this._buildDeviceUi(h),
      reps: { done: this._reps.done, goal: this._reps.goal, active: this._reps.active } });
  }
}

export function makeTelemetry(opts = {}) {
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const hasLS = typeof localStorage !== "undefined";
  const forceMock = opts.mock === true || params.has("mock");
  // ?mock=1 forces the simulation AND forgets any remembered live bridge.
  if (forceMock) { try { if (hasLS) localStorage.removeItem("zero.ws"); } catch (_) {} return new MockSource(opts); }
  // A ?ws= URL wins and is REMEMBERED, so a later navigation that drops the query
  // (or a plain refresh) stays live instead of silently falling back to the mock.
  let url = opts.url || params.get("ws") || null;
  try {
    if (url && hasLS) localStorage.setItem("zero.ws", url);
    else if (!url && hasLS) url = localStorage.getItem("zero.ws");
  } catch (_) {}
  if (opts.mock === false || url) return new WebSocketSource(url || "ws://localhost:8765/ws");
  return new MockSource(opts);   // default: mock, so the console runs with no backend
}

export { TelemetrySource, MockSource, WebSocketSource };
