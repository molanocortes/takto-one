// telemetry.js - the data layer for the AR experience.
//
// One interface, two backends:
//   - MockSource:      seeded, physically-plausible telemetry generated in the
//                      page. No backend, no hardware. Default with ?mock=1.
//   - WebSocketSource: connects to the real host bridge (ws://host:8765/ws) or
//                      the python mock (ws://localhost:8766/ws).
//
// Build the whole experience against TelemetrySource. Flip one flag to go live.
// The snapshot shape is defined in ../../HARDWARE_IO.md Section 3.
//
// Usage:
//   import { makeTelemetry } from "./telemetry.js";
//   const tele = makeTelemetry();                 // auto: mock if ?mock=1
//   tele.onSnapshot(s => { latest = s; });        // ~30-50 Hz
//   tele.send({ cmd: "mode", mode: "touch" });
//   tele.send({ cmd: "walls", walls: [{ joint:"index_drive", x_wall_deg:40, K:2.5, B:0.02, f_max_ma:80 }] });
//
// No em dashes. SI where physical; deg/ms/mA in the wire format.

import { curlToJoints } from "./kinematics.js";

const KT_NM_PER_A = 0.92;          // torque constant [N m/A]
const I_GENTLE_MA = 80;            // gentle current ceiling [mA]
const FINGERS = ["index", "middle", "ring", "pinky"];
const SEGMENTS = ["mcp", "pip", "dip"];

// --- seeded RNG (mulberry32), so every run is reproducible -------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// small helpers
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const lerp = (a, b, t) => a + (b - a) * t;
const D2R = Math.PI / 180;

// quaternion from small roll/pitch/yaw in degrees, [w,x,y,z]
function quatFromRPY(rollDeg, pitchDeg, yawDeg) {
  const r = rollDeg * D2R * 0.5, p = pitchDeg * D2R * 0.5, y = yawDeg * D2R * 0.5;
  const cr = Math.cos(r), sr = Math.sin(r);
  const cp = Math.cos(p), sp = Math.sin(p);
  const cy = Math.cos(y), sy = Math.sin(y);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}

// =============================================================================
// Base class
// =============================================================================
class TelemetrySource {
  constructor() { this._cbs = []; }
  onSnapshot(cb) { this._cbs.push(cb); return () => { this._cbs = this._cbs.filter(c => c !== cb); }; }
  _emit(snap) { for (const cb of this._cbs) cb(snap); }
  send(_cmd) {}
  start() {}
  stop() {}
  // transport identity for the diagnostic HUD (kind + url + live connection)
  describe() { return { kind: "none", url: null, connected: false }; }
}

// =============================================================================
// WebSocketSource - the real host or the python mock
// =============================================================================
class WebSocketSource extends TelemetrySource {
  constructor(url) {
    super();
    this.url = url;
    this._ws = null;
    this._hb = null;
    this._watch = null;
    this._closed = false;
    this._attempt = 0;
    this._lastRx = 0;
    this.connected = false;
  }
  start() {
    this._closed = false;
    this._connect();
    this._hb = setInterval(() => this.send({ cmd: "ping" }), 500);
    // half-open watchdog: the host streams ~30 Hz; 3 s of silence on an open
    // socket means the link died even if TCP has not noticed. Force-close so
    // onclose schedules the reconnect.
    this._watch = setInterval(() => {
      if (this.connected && performance.now() - this._lastRx > 3000) { try { this._ws.close(); } catch (_) {} }
    }, 1000);
  }
  stop() {
    this._closed = true;
    if (this._hb) clearInterval(this._hb);
    if (this._watch) clearInterval(this._watch);
    if (this._ws) this._ws.close();
    this.connected = false;
  }
  _connect() {
    try {
      this._ws = new WebSocket(this.url);
    } catch (e) { this._retry(); return; }
    this._ws.onopen = () => { this._attempt = 0; this._lastRx = performance.now(); this.connected = true; };
    this._ws.onmessage = (ev) => {
      this._lastRx = performance.now();
      // forward snaps AND acks; consumers filter on kind (main.js keeps snaps)
      try { const s = JSON.parse(ev.data); if (s && (s.kind === "snap" || s.kind === "ack")) this._emit(s); }
      catch (_) {}
    };
    this._ws.onclose = () => { this.connected = false; if (!this._closed) this._retry(); };
    this._ws.onerror = () => { try { this._ws.close(); } catch (_) {} };
  }
  _retry() {
    // exponential backoff, 0.5 s doubling to a 5 s steady retry, plus jitter
    const d = Math.min(500 * 2 ** Math.min(this._attempt++, 4), 5000);
    setTimeout(() => { if (!this._closed) this._connect(); }, d + Math.random() * 250);
  }
  send(cmd) {
    if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(cmd));
  }
  describe() { return { kind: "ws", url: this.url, connected: this.connected }; }
}

// =============================================================================
// MockSource - a small, plausible simulator of the whole rig
// =============================================================================
class MockSource extends TelemetrySource {
  constructor(opts = {}) {
    super();
    this.rng = mulberry32(opts.seed || 7);
    this.hz = opts.hz || 40;                 // snapshot rate
    this.activationPresent = opts.activation !== false;
    this.mode = "atelier";
    this.t0 = null;
    this._timer = null;
    this._walls = [];                        // last received wall descriptors
    this._pen = {};                          // per-joint felt penetration [rad]
    this._recording = false;
    this._recId = null;
    this._recStart = 0;
    this._reps = { done: 0, goal: 20 };
    this._repPhase = 0;                      // for rhythm rep counting
    this._fatigue = 0;
    this._dropoutUntil = 0;                  // scripted sensor dropout window
    this._nextDropout = 6000;               // first dropout at t=6 s
  }

  start() {
    const dt = 1000 / this.hz;
    this._timer = setInterval(() => this._tick(), dt);
  }
  stop() { if (this._timer) clearInterval(this._timer); }

  send(cmd) {
    if (!cmd || !cmd.cmd) return;
    switch (cmd.cmd) {
      case "mode": this.mode = cmd.mode || "atelier"; break;
      case "goal": this._reps.goal = cmd.value || this._reps.goal; break;
      case "feedback": /* arm/disarm; mock always ready */ break;
      case "walls": this._walls = Array.isArray(cmd.walls) ? cmd.walls : []; break;
      case "record":
        if (cmd.action === "start") {
          this._recording = true;
          this._recStart = this._now();
          this._recId = "sess_" + Math.floor(this._recStart);
          this._emit({ kind: "ack", event: "rec_started", id: this._recId });
        } else if (cmd.action === "stop") {
          this._recording = false;
          this._emit({ kind: "ack", event: "rec_stopped", id: this._recId });
        }
        break;
      case "env_save":
        // HONESTY: the mock has no bridge and no disk. It must NEVER ack
        // env_saved (a sim capture cannot masquerade as a real, stored one).
        // Refuse immediately with a specific, actionable error so the scan
        // fails fast and legibly instead of hanging until the 8 s upload
        // timeout. envScan's ack hook turns this into phase "error".
        this._emit({ kind: "ack", event: "error",
          error: "env_save: not connected to a bridge (mock transport). "
               + "Open the AR page with ?ws=wss://<host>:8443/ws so the room can be stored + sent." });
        break;
      default: break;
    }
  }

  describe() { return { kind: "mock", url: null, connected: false }; }

  _now() { return this.t0 == null ? 0 : (performance.now() - this.t0); }

  _tick() {
    if (this.t0 == null) this.t0 = performance.now();
    const t = this._now();               // ms
    const ts = t / 1000;                 // s

    // ---- hand + forearm: gentle breathing drift ----
    const breathe = Math.sin(ts * 0.5);
    const hand = {
      quat: quatFromRPY(2 + breathe * 1.5, -4 + Math.sin(ts * 0.31) * 2, 6 + breathe * 2),
      rpy_deg: [2 + breathe * 1.5, -4, 6 + breathe * 2],
      lin_acc: [0.03 * breathe, 9.81, -0.02 * breathe],
    };
    const forearm = {
      quat: quatFromRPY(1, 0.5 * Math.sin(ts * 0.2), 3),
      rpy_deg: [1, 0.5, 3], lin_acc: [0, 9.81, 0],
    };

    // ---- drive a per-mode "intent" flex signal in [0..1] ----
    let intent = 0;         // how much the user is flexing this instant
    let strong = false;     // is this a high-effort repetition
    if (this.mode === "capture" || this.mode === "rhythm") {
      const period = this.mode === "rhythm" ? 1.6 : 2.4;   // s per rep
      const phase = (ts % period) / period;                // 0..1
      intent = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);  // smooth close/open
      strong = (Math.floor(ts / period) % 4) === 0;        // every 4th rep is strong
      // rep counting on the falling edge
      if (phase < this._repPhase) { this._reps.done += 1; }
      this._repPhase = phase;
      if (this.mode === "rhythm") this._fatigue = clamp(this._fatigue + 0.0008, 0, 0.6);
    } else if (this.mode === "touch") {
      // the user reaches and presses in slowly, then releases
      const period = 4.0;
      const phase = (ts % period) / period;
      intent = clamp(Math.sin(phase * Math.PI) * 1.4, 0, 1);
    } else {
      intent = 0.05 + 0.05 * Math.sin(ts * 0.7);           // atelier micro-motion
    }

    // ---- joints: map intent -> flexion, apply felt walls on the actuated joint
    const joints = [];
    // scripted sensor dropout in capture, so the quality aura can be tuned
    if (this.mode === "capture" && t > this._nextDropout && this._dropoutUntil === 0) {
      this._dropoutUntil = t + 600; this._nextDropout = t + 9000;
    }
    if (this._dropoutUntil && t > this._dropoutUntil) this._dropoutUntil = 0;

    // channel semantics follow the mechanism's chain, palm outward:
    // {f}_mcp = MCP ABDUCTION (signed deg, splayed open, adducting with the
    // curl), {f}_pip = MCP flexion, {f}_dip = PIP flexion
    const SPLAY = [9, 2.5, -4, -10];                     // index..pinky neutral splay
    for (const f of FINGERS) {
      const fi = FINGERS.indexOf(f);
      // canonical curl coupling (kinematics.js): MCP to 90, PIP to 110
      const pair = curlToJoints(intent);
      const jig = Math.sin(ts * 2 + fi * 0.5) * 0.4;
      const degs = {
        mcp: SPLAY[fi] * (1 - 0.75 * intent) + Math.sin(ts * 0.9 + fi * 1.7) * 1.0,
        pip: pair.mcpDeg + jig,
        dip: pair.pipDeg + jig,
      };
      // TOUCH: the actuated joint (MCP flexion <- index_drive) feels the wall
      if (f === "index") degs.pip = this._applyWall("index_drive", degs.pip);
      for (let s = 0; s < SEGMENTS.length; s++) {
        const id = `${f}_${SEGMENTS[s]}`;
        const ok = !(this._dropoutUntil && f === "middle" && s === 1); // one channel drops
        joints.push({ id, deg: +degs[SEGMENTS[s]].toFixed(2), ok });
      }
    }

    // ---- actuators: index_drive reports position + felt current ----
    const pen = this._pen["index_drive"] || 0;          // rad
    const wall = this._walls.find(w => w.joint === "index_drive");
    let currentMa = 0, fbMode = "off";
    if (wall && pen > 0) {
      const tauNm = clamp((wall.K || 0) * pen, 0, (wall.f_max_ma || I_GENTLE_MA) / 1000 * KT_NM_PER_A);
      currentMa = clamp((tauNm / KT_NM_PER_A) * 1000, 0, I_GENTLE_MA);
      fbMode = "wall";
    } else if (this.mode === "touch") { fbMode = "pure"; }
    const idxFlex = joints.find(j => j.id === "index_pip").deg;   // MCP flexion channel
    const actuators = [{
      id: "index_drive", pos_deg: idxFlex,
      vel_dps: +(Math.cos(ts * 2) * 6).toFixed(2),
      current_ma: +currentMa.toFixed(1), temp_c: 32.0,
      torque_on: true, feedback_mode: fbMode,
    }];

    // ---- activation channel ----
    let activation;
    if (this.activationPresent) {
      const base = intent * (strong ? 1.0 : 0.6);
      const level = clamp(base + (this.rng() - 0.5) * 0.03, 0, 1);
      activation = {
        present: true, level: +level.toFixed(3),
        channels: [+level.toFixed(3), +(level * 0.3).toFixed(3)],
        direction: +(0.3 + 0.1 * Math.sin(ts)).toFixed(2),
        fatigue: +this._fatigue.toFixed(3),
        onset: intent > 0.05 && this._repPhase < 0.15,
        quality: this._dropoutUntil ? "noisy" : "good",
      };
    } else {
      activation = { present: false, level: 0, channels: [], direction: 0, fatigue: 0, onset: false, quality: "none" };
    }

    // ---- session + reps ----
    const session = {
      recording: this._recording, paused: false,
      id: this._recId, elapsed_ms: this._recording ? Math.floor(t - this._recStart) : 0,
      samples: this._recording ? Math.floor((t - this._recStart) / 20) : 0,
    };

    this._emit({
      kind: "snap", t_ms: Math.floor(t),
      mode: this.mode, state: this._recording ? "running" : "ready", safety: "ok",
      link: { device: true, motors: true },
      hand, forearm, joints, actuators, activation,
      session, reps: { done: this._reps.done, goal: this._reps.goal },
    });
  }

  // model the finger meeting a wall: it advances until K*pen balances the push,
  // capped by the gentle ceiling. Hard K -> tiny penetration (a stop); soft K ->
  // the finger sinks in. Returns the felt joint angle in deg.
  _applyWall(jointId, commandedDeg) {
    const wall = this._walls.find(w => w.joint === jointId);
    if (!wall) { this._pen[jointId] = 0; return commandedDeg; }
    const xWall = wall.x_wall_deg;
    if (commandedDeg <= xWall) { this._pen[jointId] = 0; return commandedDeg; }
    // the user pushes with a roughly fixed intent torque past the surface
    const intentTorqueNm = 0.06;                 // how hard the user presses [N m]
    const ceilNm = (wall.f_max_ma || I_GENTLE_MA) / 1000 * KT_NM_PER_A;
    const usableNm = Math.min(intentTorqueNm, ceilNm);
    const penRad = usableNm / Math.max(wall.K || 1e-6, 1e-6);   // equilibrium penetration
    const penDeg = penRad / D2R;
    this._pen[jointId] = penRad;
    return xWall + Math.min(commandedDeg - xWall, penDeg);
  }
}

// =============================================================================
// factory
// =============================================================================
export function makeTelemetry(opts = {}) {
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const url = opts.url || params.get("ws") || null;
  // ?mock is a VALUE, not a bare presence flag: ?mock=0 / ?mock=false mean
  // "definitely not the simulator" (matching ?grip=0), and they used to do the
  // exact opposite. An explicit ?ws= bridge URL also outranks a bare ?mock,
  // so the URL in the address bar can never be silently discarded.
  const mockParam = params.get("mock");
  const mockOff = mockParam === "0" || mockParam === "false" || mockParam === "off";
  const mockOn = mockParam !== null && !mockOff;
  const forceMock = opts.mock === true || (mockOn && !url);
  // ?mock=0 says "not the simulator", NOT "use ws://localhost". It must fall
  // THROUGH to the transport default below, or the headset (https origin) gets
  // a mixed-content-blocked ws:// socket to the wrong host and no fallback.
  const forceWs = opts.mock === false || !!url;
  if (forceMock) return new MockSource(opts);
  if (forceWs) return new WebSocketSource(url || "ws://localhost:8765/ws");
  // The HEADSET path (2026-07-20): the Quest page is served by serve_quest.py
  // over https, and that SAME origin proxies /ws to the bridge. Defaulting to
  // it means the owner opens https://<PC-IP>:8443/ with NO hand-typed params
  // and captures reach the bridge. The old behavior (silent MockSource unless
  // ?ws= was present) is the #1 reason no real room ever landed on disk:
  // the mock drops env_save. ?ws= stays as an override; ?mock=1 still forces
  // the simulator explicitly.
  if (typeof location !== "undefined" && location.protocol === "https:") {
    return new WebSocketSource("wss://" + location.host + "/ws");
  }
  // http desktop preview with ?mock=0: the simulator is refused, so talk to the
  // local bridge rather than silently showing the mock anyway.
  if (mockOff) return new WebSocketSource("ws://localhost:8765/ws");
  return new MockSource(opts);   // http desktop preview: mock, no backend needed
}

export { TelemetrySource, MockSource, WebSocketSource, KT_NM_PER_A, I_GENTLE_MA };
