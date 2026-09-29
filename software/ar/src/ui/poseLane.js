// poseLane.js - the bridge's fast pose lane (MOTION_PIPELINE.md section 8),
// pure logic: merge + latency. No three.js, node-testable.
//
// On connect the page asks {"cmd":"stream","pose":true}; the bridge then sends
// {"kind":"pose", t, us, seq, rx, tx, cal, live, e, w, h, fq, hq, wd, j, tq}
// once per DEVICE frame (100 Hz), built the moment the S-line arrives. The
// 60 Hz snap still carries everything else. The twin and the device hand are
// rendered from the newest pose: mergePose() overlays it on the latest snap so
// every consumer (handLink, twin, contacts) reads one snapshot shape. When no
// pose arrived for staleMs (old bridge, lane off, link hiccup) the snap is used
// unchanged: the fallback is automatic and says so (PoseLane.active).

// joint order of pose.j (wire names, JOINT order of the bridge)
export const POSE_JOINTS = [
  "index_mcp", "index_pip", "index_dip",
  "middle_mcp", "middle_pip", "middle_dip",
  "ring_mcp", "ring_pip", "ring_dip",
  "pinky_mcp", "pinky_pip", "pinky_dip",
];

const f3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const f4 = (q) => Array.isArray(q) && q.length === 4 && q.every(Number.isFinite);

/** A pose message the lane can use (anything else is ignored, never thrown). */
export function poseUsable(p) {
  return !!(p && p.kind === "pose" && (f4(p.hq) || Array.isArray(p.j)));
}

/**
 * Overlay a pose message on a snapshot. Returns a NEW shallow object (the
 * snap itself is never mutated: other listeners hold it). Fields the pose
 * lacks keep the snap's values; a null joint keeps the snap's last degree
 * and reads ok:false (the channel is not live).
 */
export function mergePose(snap, pose) {
  const base = snap || { kind: "snap" };
  const out = Object.assign({}, base);
  const sb = base.body || null;
  const body = Object.assign({ frame: "body_yup_v1", shoulder_m: [0, 0, 0] }, sb || {});
  if (f3(pose.e)) body.elbow_m = pose.e;
  if (f3(pose.w)) body.wrist_m = pose.w;
  if (f3(pose.h)) body.hand_m = pose.h;
  if (f4(pose.fq)) body.forearm_quat = pose.fq;
  if (f4(pose.hq)) body.hand_quat = pose.hq;
  if (Array.isArray(pose.wd) && pose.wd.length >= 3 && pose.wd.slice(0, 3).every(Number.isFinite)) {
    body.wrist_deg = { flex: pose.wd[0], dev: pose.wd[1], pro: pose.wd[2] };
  }
  if (pose.cal === 0 || pose.cal === 1 || pose.cal === 2) {
    body.calibrated = pose.cal === 2;
    body.provisional = pose.cal === 1;
  }
  if (typeof pose.live === "boolean") body.live = pose.live;
  out.body = body;
  if (Array.isArray(pose.j)) {
    const prev = {};
    const rest = [];
    for (const jj of base.joints || []) {
      if (POSE_JOINTS.indexOf(jj.id) >= 0) prev[jj.id] = jj; else rest.push(jj);
    }
    const joints = [];
    for (let i = 0; i < POSE_JOINTS.length; i++) {
      const id = POSE_JOINTS[i], v = pose.j[i];
      if (Number.isFinite(v)) joints.push({ id, deg: v, ok: true });
      else joints.push({ id, deg: prev[id] ? prev[id].deg : 0, ok: false });
    }
    out.joints = joints.concat(rest);
  }
  if (Number.isFinite(pose.t)) out.t_ms = pose.t;   // the device clock of THIS frame
  out._pose = { seq: pose.seq, t: pose.t };
  return out;
}

const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * The lane's state + latency meter.
 *   push(pose, wallMs, perfMs)  on every pose message (wallMs = Date.now())
 *   active(perfMs)              a pose arrived within staleMs
 *   stats(perfMs)               { rateHz, bridgeMs, netMs, totalMs, synced, dropped }
 * bridgeMs = median(tx - rx): the bridge's own leg (same clock, exact).
 * netMs = median(wallMs - tx): network + page, ONLY meaningful when both
 * clocks agree (same machine, or NTP-synced headset). It is reported as
 * synced only inside a plausible band; otherwise the HUD says the clocks
 * differ instead of printing a made-up number.
 */
export class PoseLane {
  constructor({ staleMs = 250, window = 64 } = {}) {
    this.staleMs = staleMs;
    this.window = window;
    this.latest = null;
    this.lastAt = -Infinity;       // perf ms of the newest pose
    this.count = 0;
    this.dropped = 0;              // seq gaps
    this._seq = null;
    this._arr = [];                // perf ms of recent arrivals (rate)
    this._bridge = [];
    this._net = [];
  }
  push(pose, wallMs, perfMs) {
    if (!poseUsable(pose)) return false;
    if (Number.isFinite(pose.seq) && this._seq !== null) {
      const gap = pose.seq - this._seq - 1;
      if (gap > 0 && gap < 1000) this.dropped += gap;
      if (pose.seq <= this._seq && this._seq - pose.seq < 1000) return false;   // stale / duplicate
    }
    if (Number.isFinite(pose.seq)) this._seq = pose.seq;
    this.latest = pose;
    this.lastAt = perfMs;
    this.count++;
    this._arr.push(perfMs);
    while (this._arr.length && perfMs - this._arr[0] > 1000) this._arr.shift();
    if (Number.isFinite(pose.rx) && Number.isFinite(pose.tx)) {
      this._bridge.push(pose.tx - pose.rx);
      if (this._bridge.length > this.window) this._bridge.shift();
    }
    if (Number.isFinite(pose.tx) && Number.isFinite(wallMs)) {
      this._net.push(wallMs - pose.tx);
      if (this._net.length > this.window) this._net.shift();
    }
    return true;
  }
  active(perfMs) { return this.latest !== null && perfMs - this.lastAt <= this.staleMs; }
  stats(perfMs) {
    const recent = this._arr.filter((t) => perfMs - t <= 1000).length;
    const bridgeMs = median(this._bridge);
    const net = median(this._net);
    const synced = net !== null && net > -5 && net < 400;
    const netMs = synced ? Math.max(0, net) : null;
    const totalMs = bridgeMs !== null && netMs !== null ? bridgeMs + netMs : null;
    return { rateHz: this.active(perfMs) ? recent : 0, bridgeMs, netMs, totalMs, synced,
             dropped: this.dropped, active: this.active(perfMs) };
  }
  reset() {
    this.latest = null; this.lastAt = -Infinity; this.count = 0; this.dropped = 0;
    this._seq = null; this._arr = []; this._bridge = []; this._net = [];
  }
}

/** Snap arrival rate meter (the lane's fallback, and the HUD's second number). */
export class RateMeter {
  constructor() { this._t = []; }
  note(perfMs) {
    this._t.push(perfMs);
    while (this._t.length && perfMs - this._t[0] > 1000) this._t.shift();
  }
  hz(perfMs) { return this._t.filter((t) => perfMs - t <= 1000).length; }
}
