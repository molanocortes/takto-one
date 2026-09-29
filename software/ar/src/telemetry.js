// telemetry.js - the data layer for the AR experience.
//
// One interface, two backends:
//   - MockSource:      seeded, physically-plausible telemetry generated in the
//                      page. No backend, no hardware. Default with ?mock=1.
//   - WebSocketSource: connects to the real host bridge (ws://host:8765/ws) or
//                      the python mock (ws://localhost:8766/ws).
//
// Build the whole experience against TelemetrySource. Flip one flag to go live.
// The snapshot shape is defined in ../../HARDWARE_IO.md Section 3; the `body`,
// `device` and `world` blocks and the neutral-calibration acks follow
// ../MOTION_PIPELINE.md (the binding motion contract).
//
// TRANSPORT SELECTION (explicit, never silent - see ../ar/README.md):
//   ?ws=<url>      use this bridge; REMEMBERED in localStorage for next time
//   ?ws=off        forget the remembered bridge
//   ?mock=1        force the in-page simulator (an explicit ?ws= still wins)
//   ?mock=0        refuse the simulator: talk to the default bridge below
//   no params      remembered ?ws=, else https -> wss://<same host>/ws (the
//                  serve_https.py tunnel), else http -> the SIMULATOR.
// Whenever the simulator runs, describe().simulated is true and the page shows
// a SIMULATED badge (DOM + in-headset), so mock data is never mistaken for the
// device.
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
import { qmul, qrot, qFromAxisAngle, BodyAnchor, Q_SEG_TO_WRIST } from "./world/poseFallback.js";

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
    this.poseLane = true;          // subscribe to {"kind":"pose"} on connect
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
    this._ws.onopen = () => {
      this._attempt = 0; this._lastRx = performance.now(); this.connected = true;
      // the fast pose lane (MOTION_PIPELINE.md section 8): ask on EVERY
      // (re)connect; a bridge without the lane simply ignores the command and
      // the page keeps rendering from snap (ui/poseLane.js falls back)
      if (this.poseLane) this.send({ cmd: "stream", pose: true });
    };
    this._ws.onmessage = (ev) => {
      this._lastRx = performance.now();
      // forward EVERY typed message (snap, ack, takes, take_data, env, envs,
      // ...); consumers filter on kind. The old snap/ack-only gate dropped the
      // take library, so replay could never list a take.
      try { const s = JSON.parse(ev.data); if (s && typeof s.kind === "string") this._emit(s); }
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
  // a message already serialized elsewhere (envScan builds multi-MB uploads
  // in chunks across frames, so no single frame pays for one JSON.stringify)
  sendRaw(str) {
    if (this._ws && this._ws.readyState === 1) { this._ws.send(str); return true; }
    return false;
  }
  get isOpen() { return !!(this._ws && this._ws.readyState === 1); }
  describe() {
    return { kind: "ws", url: this.url, connected: this.connected, simulated: false,
             reason: this.reason || "" };
  }
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
    // MOTION_PIPELINE.md body model: provisional neutral until a calibrate
    // command runs the countdown/hold/done sequence (acks exactly like the
    // bridge's), then calibrated. boot_id is per mock "power-up".
    this._bootId = 1 + Math.floor(this.rng() * 65534);
    this._calibrated = false;
    this._neutralAt = 0;                     // ms (mock clock) of the last neutral
    this._neutralRunning = false;
    this._neutralTimers = [];
    this._takes = [makeMockTakeMeta("mock_take_0001", "reach + grasp (simulated)", 12)];
  }

  start() {
    const dt = 1000 / this.hz;
    this._timer = setInterval(() => this._tick(), dt);
    // the bridge pushes the take library on join; so does the mock
    setTimeout(() => this._emit({ kind: "takes", takes: this._takes.slice() }), 0);
    // and the page subscribes to the pose lane on connect (WebSocketSource)
    if (this.poseLane !== false) this._startPoseLane();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._poseTimer) clearInterval(this._poseTimer);
    for (const h of this._neutralTimers) clearTimeout(h);
  }

  // the fast pose lane, emulated with the bridge's message shape (100 Hz,
  // section 8). Only after {"cmd":"stream","pose":true}, like the bridge.
  _startPoseLane() {
    if (this._poseTimer) return;
    let seq = 0;
    this._poseTimer = setInterval(() => {
      if (this.t0 == null) return;
      const t = this._now(), ts = t / 1000;
      const b = mockBody(ts, { calibrated: this._calibrated });
      const snap = this._lastSnap;
      const j = snap ? POSE_JOINT_IDS.map((id) => {
        const jj = snap.joints.find((x) => x.id === id);
        return jj && jj.ok ? jj.deg : null;
      }) : POSE_JOINT_IDS.map(() => null);
      const wall = Date.now();
      this._emit({ kind: "pose", t: Math.floor(t), us: Math.floor(t * 1000), seq: seq++,
                   rx: wall - 2, tx: wall, cal: this._calibrated ? 2 : 1, live: true,
                   e: b.elbow_m, w: b.wrist_m, h: b.hand_m, fq: b.forearm_quat, hq: b.hand_quat,
                   wd: [b.wrist_deg.flex, b.wrist_deg.dev, b.wrist_deg.pro], j, tq: null });
    }, 10);
  }
  sendRaw(str) { try { this.send(JSON.parse(str)); return true; } catch (_) { return false; } }
  get isOpen() { return true; }

  // neutral capture, simulated with the bridge's ack shape:
  //   {kind:"ack", event:"neutral", phase:"countdown"|"hold"|"done"|"abort", t}
  _runNeutral() {
    if (this._neutralRunning) return;
    this._neutralRunning = true;
    const ack = (phase, t) => this._emit({ kind: "ack", event: "neutral", phase, t });
    const at = (ms, fn) => this._neutralTimers.push(setTimeout(fn, ms));
    ack("countdown", 3);
    at(1000, () => ack("countdown", 2));
    at(2000, () => ack("countdown", 1));
    at(3000, () => ack("hold", 2));
    at(4000, () => ack("hold", 1));
    at(5000, () => {
      this._neutralRunning = false;
      this._calibrated = true;
      this._neutralAt = this._now();
      ack("done", 0);
    });
  }

  send(cmd) {
    if (!cmd || !cmd.cmd) return;
    switch (cmd.cmd) {
      case "mode": this.mode = cmd.mode || "atelier"; break;
      case "stream": if (cmd.pose) this._startPoseLane(); break;
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
          // the stopped take joins the library with synthetic replay rows, so
          // the replay mode round-trips offline exactly like on the bridge
          const secs = Math.max(2, Math.min(60, (this._now() - this._recStart) / 1000));
          this._takes.unshift(makeMockTakeMeta(this._recId, "recorded in the mock", secs));
          this._emit({ kind: "takes", takes: this._takes.slice() });
        }
        break;
      case "calibrate":
        if (cmd.what === "neutral") this._runNeutral();
        else this._emit({ kind: "ack", event: "calibrated" });
        break;
      case "take_data": {
        const meta = this._takes.find((t) => t.id === cmd.id);
        if (!meta) { this._emit({ kind: "ack", event: "error", error: "no replay data", id: cmd.id }); break; }
        setTimeout(() => this._emit(makeMockTakeData(meta)), 30);
        break;
      }
      case "env_get":
        // the mock never stores rooms (see env_save below): say so, like the
        // bridge does for an unknown id
        this._emit({ kind: "ack", event: "error", error: "unknown env", id: cmd.id });
        break;
      case "env_save":
        // HONESTY: the mock has no bridge and no disk. It must NEVER ack
        // env_saved (a sim capture cannot masquerade as a real, stored one).
        // Refuse immediately with a specific, actionable error so the scan
        // fails fast and legibly instead of hanging until the 8 s upload
        // timeout. envScan's ack hook turns this into phase "error".
        this._emit({ kind: "ack", event: "error",
          error: "env_save: not connected to a bridge (SIMULATED transport). "
               + "Open the AR page with ?ws=wss://<PC-IP>:8765/ws (see software/ar/README.md)." });
        break;
      default: break;
    }
  }

  describe() {
    return { kind: "mock", url: null, connected: false, simulated: true, reason: this.reason || "" };
  }

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

    // ---- body model (MOTION_PIPELINE.md section 7) + device + world --------
    const body = mockBody(ts, {
      calibrated: this._calibrated,
      sinceNeutralS: this._calibrated ? (t - this._neutralAt) / 1000 : ts,
    });
    const device = {
      fw: 16, boot_id: this._bootId,
      sd_present: true, sd_recording: this._recording, sd_take: this._recording ? 1 : 0,
      sd_rows: this._recording ? Math.floor((t - this._recStart) / 10) : 0,
      standby: false, standalone_auto_record: true, neutral_running: this._neutralRunning,
    };
    // no headset feeds the mock, so there is never a vision-anchored world
    const world = { pos_m: null, quat: null, source: "none", occluded: false };

    this._emit(this._lastSnap = {
      kind: "snap", t_ms: Math.floor(t), source: "mock",
      mode: this.mode, state: this._recording ? "running" : "ready", safety: "ok",
      link: { device: true, motors: true },
      hand, forearm, joints, actuators, activation,
      session, reps: { done: this._reps.done, goal: this._reps.goal },
      body, device, world,
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
// mock body model + mock takes (pure functions of time; deterministic)
// =============================================================================
const X_AXIS = [1, 0, 0], Y_AXIS = [0, 1, 0], Z_AXIS = [0, 0, 1];
const POSE_JOINT_IDS = FINGERS.flatMap((f) => SEGMENTS.map((sg) => `${f}_${sg}`));
const L_UA = 0.30, L_FA = 0.26;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** A plausible right arm in the body frame at time ts [s]: the forearm sweeps
 *  left/right and lifts a little, the wrist flexes and deviates, the upper arm
 *  mostly hangs. Positions follow the section-4 chain exactly. */
export function mockBody(ts, { calibrated = false, sinceNeutralS = 0 } = {}) {
  const yaw = 0.35 * Math.sin(ts * 0.23);                  // forearm heading [rad]
  const lift = 0.12 + 0.10 * Math.sin(ts * 0.31);          // forearm elevation
  const elev = 0.22 + 0.08 * Math.sin(ts * 0.19);          // upper-arm elevation
  const flexD = 18 * Math.sin(ts * 0.5);                   // + palm-ward
  const devD = 8 * Math.sin(ts * 0.37);                    // + radial (thumb side)
  const proD = 10 * Math.sin(ts * 0.17);                   // + pronation
  const D = Math.PI / 180;
  const qU = qFromAxisAngle(X_AXIS, Math.PI / 2 - elev);   // +Z -> down, raised by elev
  const qF = qmul(qmul(qFromAxisAngle(Y_AXIS, yaw), qFromAxisAngle(X_AXIS, -lift)),
                  qFromAxisAngle(Z_AXIS, proD * D));
  const qH = qmul(qmul(qF, qFromAxisAngle(X_AXIS, flexD * D)), qFromAxisAngle(Y_AXIS, devD * D));
  const shoulder = [0, 0, 0];
  const elbow = qrot(qU, [0, 0, L_UA]);
  const wrist = elbow.map((v, i) => v + qrot(qF, [0, 0, L_FA])[i]);
  const hand = wrist.map((v, i) => v + qrot(qH, [0, 0.01, 0.055])[i]);
  const q4 = (q) => q.map(r4);
  return {
    frame: "body_yup_v1",
    calibrated, provisional: !calibrated, live: true,
    shoulder_m: shoulder, elbow_m: elbow.map(r4), wrist_m: wrist.map(r4), hand_m: hand.map(r4),
    upperarm_quat: q4(qU), forearm_quat: q4(qF), hand_quat: q4(qH), thumb_quat: null,
    wrist_deg: { flex: +flexD.toFixed(2), dev: +devD.toFixed(2), pro: +proD.toFixed(2) },
    pos_source: "arm",
    quality: { since_neutral_s: +sinceNeutralS.toFixed(1), inertial_conf: 0, still: false },
  };
}

export function makeMockTakeMeta(id, task, secs) {
  return { id, task, profile: "mock", created_ms: Date.now(), duration_s: +secs.toFixed(1),
           samples: Math.round(secs * 50), has_data: true, traj: true, joint_source: "sim",
           simulated: true };
}

// replay row columns: the bridge's ROW_COLS, then the section-7 body columns
const MOCK_COLS = ["t_ms"]
  .concat(...FINGERS.map((f) => SEGMENTS.map((sg) => `${f}_${sg}`)))
  .concat(["hq_w", "hq_x", "hq_y", "hq_z", "fq_w", "fq_x", "fq_y", "fq_z",
           "tq_w", "tq_x", "tq_y", "tq_z", "blend", "act",
           "px", "py", "pz", "pq_w", "pq_x", "pq_y", "pq_z",
           "thumb_abd", "thumb_mcp", "thumb_ip",
           "ihx", "ihy", "ihz", "ifx", "ify", "ifz", "i_conf",
           "b_ex", "b_ey", "b_ez", "b_wx", "b_wy", "b_wz",
           "b_fq_w", "b_fq_x", "b_fq_y", "b_fq_z", "b_hq_w", "b_hq_x", "b_hq_y", "b_hq_z", "b_cal"]);

/** Synthetic replay rows at 50 Hz. The first ~60 % carries VISION columns
 *  (px..pq_z, as if the headset saw the wrist under a desk-side anchor), the
 *  rest is "occluded" (px null, body columns only) - so a replay exercises
 *  both placement paths and the handover between them. */
export function makeMockTakeData(meta) {
  const n = Math.max(20, Math.round(meta.duration_s * 50));
  const anchor = new BodyAnchor();
  anchor.setDefaultNeutralAt([0.13, 0.88, -0.22]);          // the desktop rest point
  const SPLAY = [9, 2.5, -4, -10];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ts = i / 50;
    const b = mockBody(ts * 1.6 + 3, { calibrated: true });
    const curl = 0.5 - 0.5 * Math.cos((ts / 2.4) * 2 * Math.PI);
    const row = [Math.round(ts * 1000)];
    FINGERS.forEach((f, fi) => {
      const pr = curlToJoints(curl * (1 - fi * 0.04));
      row.push(r4(SPLAY[fi] * (1 - 0.75 * curl)), r4(pr.mcpDeg), r4(pr.pipDeg));
    });
    row.push(...b.hand_quat, ...b.forearm_quat, null, null, null, null, 0.35, r4(curl * 0.6));
    if (i < n * 0.6) {
      const p = anchor.point(b.wrist_m);
      const q = qmul(anchor.quat(b.hand_quat), Q_SEG_TO_WRIST);
      row.push(...p.map(r4), ...q.map(r4));
    } else row.push(null, null, null, null, null, null, null);
    row.push(null, null, null, null, null, null, null, null, null, null);
    row.push(...b.elbow_m, ...b.wrist_m, ...b.forearm_quat, ...b.hand_quat, 2);
    rows.push(row);
  }
  return { kind: "take_data", id: meta.id, cols: MOCK_COLS.slice(), rows,
           joint_source: "sim", simulated: true };
}

// =============================================================================
// factory
// =============================================================================
const WS_KEY = "takto.ar.ws";
function _lsGet(k) { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : null; } catch (_) { return null; } }
function _lsSet(k, v) {
  try {
    if (!globalThis.localStorage) return;
    if (v === null) globalThis.localStorage.removeItem(k); else globalThis.localStorage.setItem(k, v);
  } catch (_) { /* private mode: the URL param still works for this load */ }
}

/** Resolve the transport from the URL + the remembered bridge. Pure except for
 *  the localStorage write of a new ?ws=. Returns {kind:"mock"|"ws", url, reason}. */
export function chooseTransport(search, protocol, host, opts = {}) {
  const params = new URLSearchParams(search || "");
  let wsParam = params.has("ws") ? (params.get("ws") || "").trim() : null;
  if (wsParam !== null && /^(off|clear|none|0)?$/i.test(wsParam)) { _lsSet(WS_KEY, null); wsParam = null; }
  else if (wsParam) _lsSet(WS_KEY, wsParam);
  const url = opts.url || wsParam || null;
  // ?mock is a VALUE: ?mock=0/false/off means "definitely not the simulator".
  // An explicit ?ws= in THIS url outranks ?mock=1 so it is never discarded.
  const mockParam = params.get("mock");
  const mockOff = mockParam === "0" || mockParam === "false" || mockParam === "off";
  const mockOn = mockParam !== null && !mockOff;
  if (opts.mock === true || (mockOn && !url)) return { kind: "mock", url: null, reason: "?mock=1" };
  if (url) return { kind: "ws", url, reason: "?ws=" };
  const remembered = _lsGet(WS_KEY);
  if (remembered && opts.mock !== false) return { kind: "ws", url: remembered, reason: "remembered ?ws=" };
  if (protocol === "https:") {
    // serve_https.py tunnels /ws on the page's own origin to the bridge, so
    // one certificate covers page + socket (README "Option C")
    return { kind: "ws", url: "wss://" + host + "/ws", reason: "https default (same-origin /ws tunnel)" };
  }
  if (mockOff || opts.mock === false) return { kind: "ws", url: "ws://localhost:8765/ws", reason: "?mock=0 default" };
  return { kind: "mock", url: null, reason: "plain http, no ?ws= given" };
}

export function makeTelemetry(opts = {}) {
  const loc = typeof location !== "undefined" ? location : { search: "", protocol: "http:", host: "localhost" };
  const t = chooseTransport(loc.search, loc.protocol, loc.host, opts);
  const src = t.kind === "mock" ? new MockSource(opts) : new WebSocketSource(t.url);
  src.reason = t.reason;
  return src;
}

export { TelemetrySource, MockSource, WebSocketSource, KT_NM_PER_A, I_GENTLE_MA };
