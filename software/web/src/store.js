// store.js - one telemetry connection + one 60 fps interpolation loop, shared
// by every surface. Views subscribe to frames (smoothed values, render-ready)
// or raw snapshots (contract-shaped). Never block a render frame on the socket.

import { makeTelemetry } from "./telemetry.js";
import { clamp, lerp } from "./ui.js";
import { qValid } from "./arm_model.js";

const CURL_MIN = 0, CURL_MAX = 95;   // mean flexion over the true ROM (90 MCP / 110 PIP)

// Interpolation time constants (ms) for the 60 fps render smoothing. Lower = snappier
// (less finger->twin lag), higher = smoother. Joints ride the clean AS5600 encoders so
// they can be fast; orientation rides the (noisier) IMUs so it is a touch smoother.
// History: 90 -> 38/60 -> 22/40 when the bridge went to 60 Hz snapshots
// (2026-07-18 latency pass): with frames every ~17 ms the filter no longer
// needs to paper over 33 ms gaps, so the smoothing lag drops almost in half
// while staying step-free.
const SMOOTH_MS = 22;        // joints, activation, motors
const SMOOTH_QUAT_MS = 40;   // hand / forearm orientation
const SMOOTH_POS_MS = 40;    // body-model positions (m), same feel as the quats
// The fast pose lane (MOTION_PIPELINE.md s.8): with a new sample every 10 ms
// straight from the ingest thread, the twin no longer needs to paper over a
// 60 Hz snapshot's sampling steps, so the render smoothing drops to about one
// display frame (the lag it adds falls from ~40 ms to ~15 ms).
const POSE_SMOOTH_MS = 12;        // joints from the pose lane
const POSE_SMOOTH_QUAT_MS = 16;   // segment quaternions from the pose lane
const POSE_SMOOTH_POS_MS = 16;    // elbow / wrist / palm from the pose lane
const POSE_FRESH_MS = 150;        // older than this: the twin falls back to the snapshot
// ?pose=0 keeps the twin on the 60 Hz snapshot (A/B the lane on the bench)
const POSE_LANE_ON = (() => {
  try { return new URLSearchParams(location.search).get("pose") !== "0"; } catch (_) { return true; }
})();

// Where a DEAD encoder channel (the bridge publishes ok:false with a 0.0
// zero-fill) is held: a relaxed open finger, not the 0 deg hyper-extension the
// zero-fill would draw. The twin also ghosts that finger, so a held channel is
// never mistaken for a measured one. Per channel role: {f}_mcp = abduction,
// {f}_pip = MCP flexion, {f}_dip = PIP flexion.
const DEAD_NEUTRAL_DEG = { mcp: 0, pip: 6, dip: 4 };
const deadNeutral = (id) => DEAD_NEUTRAL_DEG[id.split("_")[1]] ?? 0;

function nlerpQuat(a, b, t) {
  // normalized lerp: plenty for the small orientation deltas we stream
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const out = [
    lerp(a[0], s * b[0], t), lerp(a[1], s * b[1], t),
    lerp(a[2], s * b[2], t), lerp(a[3], s * b[3], t),
  ];
  const n = Math.hypot(...out) || 1;
  return out.map((v) => v / n);
}

class Series {
  constructor(windowMs = 12000) { this.t = []; this.v = []; this.windowMs = windowMs; }
  push(t, v) {
    // t_ms is NOT wall clock: it is the Teensy's millis (or the bridge's own t0
    // offset in --sim), so it RESETS on a device reboot or a bridge restart, and
    // the socket reconnects by itself. The front-prune below assumes monotonic t,
    // so a reset would leave every old sample permanently past the cut and the
    // array would grow at the frame rate for the rest of the session. Drop the
    // stale window instead: charts restart clean on the new time base.
    if (!Number.isFinite(t)) return;
    if (this.t.length && t < this.t[this.t.length - 1]) { this.t.length = 0; this.v.length = 0; }
    this.t.push(t); this.v.push(v);
    const cut = t - this.windowMs;
    let i = 0;
    while (i < this.t.length && this.t[i] < cut) i++;
    if (i > 0) { this.t.splice(0, i); this.v.splice(0, i); }
  }
}

// A small fixed ring of numbers (latency / arrival samples), no allocation per sample.
class Ring {
  constructor(n) { this.a = new Float64Array(n); this.n = 0; this.i = 0; }
  push(v) { this.a[this.i] = v; this.i = (this.i + 1) % this.a.length; if (this.n < this.a.length) this.n++; }
  values() { return Array.from(this.a.subarray(0, this.n)); }
  clear() { this.n = 0; this.i = 0; }
}
const pctOf = (arr, q) => {
  if (!arr.length) return null;
  const v = arr.slice().sort((x, y) => x - y);
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
};

class Store {
  constructor() {
    this.tele = makeTelemetry();
    // connected = frames are actually flowing. The mock is its own source, so
    // it always counts; a ws source reports its real socket state.
    this.connected = this.tele.kind === "mock";
    this._sourceCbs = new Set();
    this.snap = null;                    // latest raw snapshot
    this.series = new Map();             // name -> Series
    this._frameCbs = new Set();
    this._snapCbs = new Set();
    this._ackCbs = new Set();
    this._takesCbs = new Set();
    this._linkCbs = new Set();
    this._kindCbs = new Map();           // kind -> Set(cb): envs / env / take_data / ...
    this.lastTakes = [];                 // latest library pushes, render-ready caches
    this.lastEnvs = [];
    this.lastSd = null;                  // latest sd_takes message (device SD library)
    this._raf = null;
    this._last = performance.now();
    this._force = {};                    // dev: id -> deg override (window.__setJoint), for hinge calibration
    // fast pose lane: the newest {"kind":"pose"} and its arrival stats
    this.pose = null;
    this._poseAt = 0;                    // performance.now() of its arrival
    this._poseArr = new Ring(256);       // arrival times (performance.now), for the rate
    this._poseLat = new Ring(512);       // wall now - rx: bridge receive -> this page (same-machine clocks)
    this._poseBr = new Ring(512);        // tx - rx: inside the bridge
    this._poseSeqGap = 0;                // frames the page never saw (bridge coalesced or dropped)

    // smoothed, render-ready state
    this.smooth = {
      joints: {},                        // id -> deg
      curl: 0,                           // 0..1 whole-hand flexion
      fingers: {},                       // finger -> 0..1 curl
      handQuat: [1, 0, 0, 0],
      forearmQuat: [1, 0, 0, 0],
      wristQuat: null,                    // constrained hand-in-forearm pose from rel.quat
      jointOk: {},                       // id -> false while the channel is dead (held at neutral)
      // body-frame arm (MOTION_PIPELINE.md section 7), smoothed; null when the
      // bridge sends no body block (old bridge): the twin then synthesises one
      body: null,
      poseLane: false,                   // true while the twin rides the 100 Hz pose lane
      thumbRel: null,                    // thumb-tip IMU in the hand frame (null = sensor absent)
      rel: null,                         // bridge hand-vs-forearm pose (quat/pos_mm/dist_mm/...)
      blend: null,                       // transparency crown 0..1 (null until the host reports one)
      activation: { level: 0, fatigue: 0, direction: 0 },
      motors: {},                        // id -> {pos, vel, current, temp}
    };

    const safely = (cb, s) => { try { cb(s); } catch (e) { console.error("[store] subscriber error", e); } };
    this.tele.onSnapshot((s) => {
      if (s.kind === "pose") { this._onPose(s); return; }       // hot path: 100 Hz, no subscribers
      if (s.kind === "ack") { for (const cb of this._ackCbs) safely(cb, s); return; }
      if (s.kind === "takes") {
        this.lastTakes = s.takes || [];
        for (const cb of this._takesCbs) safely(cb, this.lastTakes);
        return;
      }
      if (s.kind !== "snap") {
        if (s.kind === "envs") this.lastEnvs = s.envs || [];
        if (s.kind === "sd_takes") this.lastSd = s;
        const set = this._kindCbs.get(s.kind);
        if (set) for (const cb of set) safely(cb, s);
        return;
      }
      this.snap = s;
      this._ingest(s);
      for (const cb of this._snapCbs) safely(cb, s);
    });
    if (this.tele.onState) this.tele.onState((up) => {
      this.connected = up;
      // every (re)connect to a live bridge: ask for the pose lane. An older
      // bridge answers unknown_cmd and the twin stays on the snapshot.
      if (up && this.live) this._subscribePose();
      if (!up) this._resetPose();
      for (const cb of this._linkCbs) safely(cb, up);
    });
    // AutoSource: the source itself can change (pending -> mock, mock -> ws).
    // Caches from the old source are dropped; the new one pushes its own.
    if (this.tele.onSource) this.tele.onSource((kind) => {
      this.snap = null;
      this.lastTakes = []; this.lastEnvs = []; this.lastSd = null;
      this.series.clear();
      this._resetPose();
      for (const cb of this._sourceCbs) safely(cb, kind);
    });
    this.tele.start();
    this._tick = this._tick.bind(this);
  }

  _ingest(s) {
    const t = s.t_ms;
    const put = (name, v) => {
      if (!this.series.has(name)) this.series.set(name, new Series());
      this.series.get(name).push(t, v);
    };
    if (s.joints) {
      // curl summarises the LIVE FLEXION channels only, exactly like _tick: a
      // *_mcp channel is the MCP ABDUCTION encoder (signed, small) and a channel
      // the bridge marked ok:false is zero-filled, not really at 0 deg. Counting
      // either one dilutes the mean and made this series disagree with sm.curl.
      let sum = 0, n = 0;
      for (const j of s.joints) {
        if (j.ok) put("j:" + j.id, j.deg);   // ok:false is a zero-fill, not a 0.0 deg sample
        if (j.ok && !j.id.endsWith("_mcp")) { sum += j.deg; n++; }
      }
      if (n) put("curl", clamp((sum / n - CURL_MIN) / (CURL_MAX - CURL_MIN), 0, 1));
    }
    if (s.encoders) for (const e of s.encoders) { if (e.ok) put("e:" + e.ch, e.deg); }
    if (s.activation && s.activation.present) put("activation", s.activation.level);
    if (s.motors) for (const m of s.motors) {
      put("i:" + m.id, m.current_ma);
      put("p:" + m.id, m.pos_deg);
      put("v:" + m.id, m.vel_dps);
    }
    // SEA control layer (the host-side SEA runner, not in this release, via
    // the bridge): tensions and
    // stretches are ESTIMATES from the spring model - series names say so
    if (s.sea && s.sea.joints) {
      for (const [j, d] of Object.entries(s.sea.joints)) {
        put(`sea:tgt:${j}`, d.target_deg);
        put(`sea:th:${j}`, d.theta_deg);
        if (d.tension_est_n) {
          put(`sea:tf:${j}`, d.tension_est_n.flex);
          put(`sea:te:${j}`, d.tension_est_n.ext);
        }
        if (d.stretch_est_mm) {
          put(`sea:xf:${j}`, d.stretch_est_mm.flex);
          put(`sea:xe:${j}`, d.stretch_est_mm.ext);
        }
        put(`sea:i:${j}`, d.i_ma);
      }
    }
  }

  getSeries(name) { return this.series.get(name) || null; }

  // ---- the fast pose lane ------------------------------------------------
  _subscribePose() {
    if (!POSE_LANE_ON) return;
    this.send({ cmd: "stream", pose: true });
  }
  _resetPose() {
    this.pose = null; this._poseAt = 0;
    this._poseArr.clear(); this._poseLat.clear(); this._poseBr.clear(); this._poseSeqGap = 0;
  }
  _onPose(p) {
    const now = performance.now();
    const prev = this.pose;
    if (prev && Number.isFinite(prev.seq) && Number.isFinite(p.seq)) {
      if (p.seq <= prev.seq) { if (p.seq < prev.seq - 1000) this._resetPose(); else return; }   // stale / bridge restart
      else if (p.seq > prev.seq + 1) this._poseSeqGap += p.seq - prev.seq - 1;
    }
    this.pose = p;
    this._poseAt = now;
    this._poseArr.push(now);
    if (Number.isFinite(p.rx)) {
      this._poseLat.push(performance.timeOrigin + now - p.rx);   // sub-ms wall clock
      if (Number.isFinite(p.tx)) this._poseBr.push(p.tx - p.rx);
    }
  }
  /** The pose lane's newest message while it is fresh, else null. */
  freshPose() {
    return this.pose && performance.now() - this._poseAt < POSE_FRESH_MS ? this.pose : null;
  }
  /**
   * Live timing for the small readouts (IMU bench, link tooltip):
   * pose-lane arrival rate at this page, bridge-internal latency (tx - rx,
   * from the messages themselves, and the bridge's own link.latency_ms),
   * receive -> page latency (only meaningful when page and bridge share a
   * clock, i.e. the same machine: hidden otherwise), IMU sample ages.
   */
  linkTiming() {
    const now = performance.now();
    const arr = this._poseArr.values().filter((t) => now - t < 2000);
    const active = !!this.freshPose();
    const hz = arr.length > 2 ? (arr.length - 1) / ((Math.max(...arr) - Math.min(...arr)) / 1000) : 0;
    const lat = this._poseLat.values(), br = this._poseBr.values();
    let page = null;
    const p50 = pctOf(lat, 0.5), p95 = pctOf(lat, 0.95);
    if (p50 != null && p50 > -5 && p95 < 2000) page = { p50, p95 };
    const link = (this.snap && this.snap.link) || {};
    return {
      active, requested: POSE_LANE_ON, hz, missed: this._poseSeqGap,
      bridge: br.length ? { p50: pctOf(br, 0.5), p95: pctOf(br, 0.95) } : null,
      bridgeReported: link.latency_ms || null,
      page, frameHz: link.frame_hz ?? null, poseHz: link.pose_hz ?? null,
      serialJitter: link.serial_jitter_ms || null, imuAge: link.imu_age_ms || null,
    };
  }

  // true = the real bridge is the source; false = the simulation, or still
  // probing for the bridge. Read it at use time: with the default AutoSource
  // it changes once the probe resolves (and again if a bridge starts later).
  get live() { return this.tele.kind === "ws"; }
  /** "ws" | "mock" | "pending" */
  get sourceKind() { return this.tele.kind; }
  get simulated() { return this.tele.kind === "mock"; }
  onSource(cb) { this._sourceCbs.add(cb); return () => this._sourceCbs.delete(cb); }
  /** Probe the bridge now (AutoSource only); resolves true when it answered. */
  retryLive() { return this.tele.retryNow ? this.tele.retryNow() : Promise.resolve(this.live && this.connected); }

  // Replay rows of one take, as a promise. The bridge answers take_data with
  // the rows or an error ack; a missing answer times out instead of hanging.
  requestTakeData(id, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let offTd = null, offErr = null, timer = null;
      const done = () => { offTd && offTd(); offErr && offErr(); clearTimeout(timer); };
      offTd = this.onKind("take_data", (m) => { if (m.id === id) { done(); resolve(m); } });
      offErr = this.onAck((a) => {
        if (a.event === "error" && a.id === id) { done(); reject(new Error(a.error || "no replay data")); }
      });
      timer = setTimeout(() => { done(); reject(new Error("the host did not answer")); }, timeoutMs);
      if (!this.send({ cmd: "take_data", id })) { done(); reject(new Error("not connected")); }
    });
  }

  // One take file from the bridge's research export ({"cmd":"take_file"}),
  // reassembled from its base64 chunks: what = "raw" | "meta" | "csv".
  // Resolves {name, mime, bytes, parts: Uint8Array[]}. A transfer that goes
  // quiet for idleMs fails instead of hanging; onProgress(got, total).
  requestTakeFile(id, what, onProgress = null, idleMs = 20000) {
    return new Promise((resolve, reject) => {
      const parts = [];
      let got = 0, timer = null, offF = null, offE = null;
      const done = () => { offF && offF(); offE && offE(); clearTimeout(timer); };
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { done(); reject(new Error("the host stopped sending " + what)); }, idleMs); };
      offF = this.onKind("take_file", (m) => {
        if (m.id !== id || m.what !== what) return;
        if (m.seq !== parts.length) { done(); reject(new Error("take_file chunk out of order")); return; }
        const bin = atob(m.data || "");
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        parts.push(u); got += u.length;
        if (onProgress) { try { onProgress(got, m.bytes); } catch (_) {} }
        arm();
        if (m.last) {
          done();
          if (got !== m.bytes) reject(new Error(`${what}: got ${got} of ${m.bytes} bytes`));
          else resolve({ name: m.name, mime: m.mime, bytes: m.bytes, parts });
        }
      });
      offE = this.onAck((a) => {
        if (a.event === "error" && a.cmd === "take_file" && a.id === id && a.what === what) {
          done(); reject(new Error(a.error || "take_file failed"));
        }
        if (a.event === "error" && a.error === "unknown_cmd" && a.cmd === "take_file") {
          done(); reject(new Error("this bridge has no research export (update the bridge)"));
        }
      });
      arm();
      if (!this.send({ cmd: "take_file", id, what })) { done(); reject(new Error("not connected")); }
    });
  }

  onFrame(cb) {
    this._frameCbs.add(cb);
    if (!this._raf) { this._last = performance.now(); this._raf = requestAnimationFrame(this._tick); }
    return () => {
      this._frameCbs.delete(cb);
      if (this._frameCbs.size === 0 && this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    };
  }

  onSnap(cb) { this._snapCbs.add(cb); return () => this._snapCbs.delete(cb); }
  onKind(kind, cb) {
    if (!this._kindCbs.has(kind)) this._kindCbs.set(kind, new Set());
    this._kindCbs.get(kind).add(cb);
    return () => this._kindCbs.get(kind).delete(cb);
  }
  onAck(cb) { this._ackCbs.add(cb); return () => this._ackCbs.delete(cb); }
  onTakes(cb) { this._takesCbs.add(cb); return () => this._takesCbs.delete(cb); }
  onLink(cb) { this._linkCbs.add(cb); return () => this._linkCbs.delete(cb); }

  // Preserve the source's accepted/not-sent result.  Device controls depend on
  // this boolean; discarding it made every successful arrow click look offline.
  send(cmd) { return this.tele.send(cmd) === true; }
  listTakes() { return this.tele.listTakes(); }

  // Body-frame arm. Positions ease like the quaternions; a body block with
  // live:false (an IMU dropped) HOLDS the last pose rather than snapping, and
  // the flags (calibrated / provisional / pos_source / quality) always follow
  // the newest snapshot so the calibration prompt never lags.
  _smoothBody(b, kq, kp, k) {
    const sm = this.smooth;
    const fq = b && qValid(b.forearm_quat), hq = b && qValid(b.hand_quat);
    if (!b || !fq || !hq || !Array.isArray(b.wrist_m)) { sm.body = null; return; }
    let B = sm.body;
    const fresh = !B;
    if (fresh) {
      B = sm.body = {
        shoulder: (b.shoulder_m || [0, 0, 0]).slice(), elbow: (b.elbow_m || [0, -0.3, 0]).slice(),
        wrist: b.wrist_m.slice(), hand: (b.hand_m || b.wrist_m).slice(),
        forearmQuat: fq, handQuat: hq, upperarmQuat: qValid(b.upperarm_quat),
        wristDeg: { flex: 0, dev: 0, pro: 0 },
      };
    }
    if (b.live !== false || fresh) {
      const lp = (dst, src) => { if (Array.isArray(src)) for (let i = 0; i < 3; i++) dst[i] = lerp(dst[i], src[i], kp); };
      lp(B.shoulder, b.shoulder_m); lp(B.elbow, b.elbow_m); lp(B.wrist, b.wrist_m); lp(B.hand, b.hand_m);
      B.forearmQuat = nlerpQuat(B.forearmQuat, fq, kq);
      B.handQuat = nlerpQuat(B.handQuat, hq, kq);
      const uq = qValid(b.upperarm_quat);
      if (uq) B.upperarmQuat = B.upperarmQuat ? nlerpQuat(B.upperarmQuat, uq, kq) : uq;
      if (b.wrist_deg) for (const key of ["flex", "dev", "pro"]) {
        if (Number.isFinite(b.wrist_deg[key])) B.wristDeg[key] = lerp(B.wristDeg[key], b.wrist_deg[key], k);
      }
    }
    B.calibrated = !!b.calibrated;
    B.provisional = !!b.provisional;
    B.live = b.live !== false;
    B.posSource = b.pos_source || "arm";
    B.quality = b.quality || null;
    B.hasWristDeg = !!b.wrist_deg;
  }

  _tick(now) {
    // only the RAF loop reschedules itself: when _raf is null the frame was
    // pumped by hand (window.__zeroStep), and rescheduling there would fork a
    // second, permanent RAF chain per pumped frame.
    if (this._raf !== null) this._raf = requestAnimationFrame(this._tick);
    const dt = Math.min(64, now - this._last);
    this._last = now;
    const s = this.snap, sm = this.smooth;
    if (s) {
      // the twin rides the pose lane while it is fresh (100 Hz, straight from
      // the bridge's ingest thread); everything else, and the fallback, is
      // the snapshot
      const pz = this.freshPose();
      sm.poseLane = !!pz;
      // exponential approach, time-based so it is framerate-independent
      const k = 1 - Math.exp(-dt / SMOOTH_MS);
      const kq = 1 - Math.exp(-dt / SMOOTH_QUAT_MS);
      const kj = pz ? 1 - Math.exp(-dt / POSE_SMOOTH_MS) : k;
      const kpq = pz ? 1 - Math.exp(-dt / POSE_SMOOTH_QUAT_MS) : kq;
      const joints = pz && Array.isArray(pz.j) && s.joints && pz.j.length === s.joints.length
        ? s.joints.map((j, i) => (pz.j[i] == null ? { id: j.id, deg: 0.0, ok: false } : { id: j.id, deg: pz.j[i], ok: true }))
        : s.joints;
      if (joints) {
        const per = {};
        let sum = 0, n = 0;
        for (const j of joints) {
          // a dead channel eases to a relaxed neutral instead of the bridge's
          // 0.0 zero-fill (which drew the finger fully extended) and is flagged
          const target = j.ok ? j.deg : deadNeutral(j.id);
          sm.joints[j.id] = lerp(sm.joints[j.id] ?? target, target, kj);
          sm.jointOk[j.id] = !!j.ok;
          // curl summarises the LIVE FLEXION channels only; the *_mcp channel is
          // the MCP abduction encoder (signed, small) and would dilute it, and a
          // channel the bridge marked ok:false is published as 0.0 deg (no magnet
          // fitted / dead encoder), so averaging it in under-reports flexion by
          // the number of dead channels: on the one wired finger that capped the
          // whole-hand curl at 0.26 and broke Guided's rep detection.
          if (j.ok && !j.id.endsWith("_mcp")) {
            sum += sm.joints[j.id]; n++;
            const f = j.id.split("_")[0];
            (per[f] = per[f] || []).push(sm.joints[j.id]);
          }
        }
        if (n) sm.curl = clamp((sum / n - CURL_MIN) / (CURL_MAX - CURL_MIN), 0, 1);
        else sm.curl = lerp(sm.curl, 0, k);  // link down: relax toward open, matching the twin
        for (const [f, arr] of Object.entries(per)) {
          const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
          sm.fingers[f] = clamp((avg - CURL_MIN) / (CURL_MAX - CURL_MIN), 0, 1);
        }
      }
      // A missing IMU is represented by live:false plus the bridge's held last
      // valid pose.  Never interpolate a legacy zero/invalid quaternion into
      // the rig; keep the most recent valid render state until the sensor
      // recovers.
      if (s.hand && s.hand.live !== false && s.hand.quat)
        sm.handQuat = nlerpQuat(sm.handQuat, s.hand.quat, kq);
      if (s.forearm && s.forearm.live !== false && s.forearm.quat)
        sm.forearmQuat = nlerpQuat(sm.forearmQuat, s.forearm.quat, kq);
      if (s.rel && s.rel.live !== false && s.rel.quat) {
        sm.wristQuat = sm.wristQuat ? nlerpQuat(sm.wristQuat, s.rel.quat, kq) : s.rel.quat.slice();
      } else if (!s.rel) sm.wristQuat = null;
      if (pz && s.body) {
        // geometry from the pose lane, flags / quality from the snapshot
        const b = Object.assign({}, s.body, {
          elbow_m: pz.e, wrist_m: pz.w, hand_m: pz.h, forearm_quat: pz.fq, hand_quat: pz.hq,
          live: pz.live !== false, calibrated: pz.cal === 2, provisional: pz.cal === 1,
        });
        if (Array.isArray(pz.wd)) b.wrist_deg = { flex: pz.wd[0], dev: pz.wd[1], pro: pz.wd[2] };
        this._smoothBody(b, kpq, 1 - Math.exp(-dt / POSE_SMOOTH_POS_MS), kj);
      } else {
        this._smoothBody(s.body, kq, 1 - Math.exp(-dt / SMOOTH_POS_MS), k);
      }
      const tq = pz ? pz.tq : (s.thumb && s.thumb.rel_quat);
      if (tq) {
        sm.thumbRel = sm.thumbRel ? nlerpQuat(sm.thumbRel, tq, pz ? kpq : kq) : tq.slice();
      } else sm.thumbRel = null;         // sensor gone -> pod honestly disappears
      if (s.rel) sm.rel = s.rel;         // speeds are already EMA'd bridge-side
      if (s.blend && s.blend.present) sm.blend = lerp(sm.blend ?? s.blend.assist, s.blend.assist, k);
      else sm.blend = null;              // crown gone -> honest absence, not a frozen dial
      if (s.activation) {
        sm.activation.level = lerp(sm.activation.level, s.activation.level || 0, k);
        sm.activation.fatigue = lerp(sm.activation.fatigue, s.activation.fatigue || 0, k);
        sm.activation.direction = lerp(sm.activation.direction, s.activation.direction || 0, k);
      }
      if (s.motors) {
        const live = new Set();
        for (const m of s.motors) {
          live.add(String(m.id));
          const t = sm.motors[m.id] || (sm.motors[m.id] = { pos: m.pos_deg, vel: 0, current: 0, temp: m.temp_c });
          t.pos = lerp(t.pos, m.pos_deg, k);
          t.vel = lerp(t.vel, m.vel_dps, k);
          t.current = lerp(t.current, m.current_ma, k);
          t.temp = lerp(t.temp, m.temp_c, k);
        }
        // a motor that left the bus (unplugged / torque-off / renumbered) must
        // disappear, not keep driving the spool twin from its last known angle
        for (const id in sm.motors) if (!live.has(id)) delete sm.motors[id];
      }
    }
    for (const id in this._force) {                                  // dev override (hinge calibration)
      if (id === "handQuat" || id === "forearmQuat") sm[id] = this._force[id];
      else sm.joints[id] = this._force[id];
    }
    for (const cb of this._frameCbs) {
      try { cb(sm, s, dt); } catch (e) { console.error("[store] frame subscriber error", e); }
    }
  }
}

export const store = new Store();

// dev/test pump (same spirit as the entry view's zero:step hook): drive N
// frames by hand when the tab's requestAnimationFrame is throttled, so
// screenshot verification can step the page deterministically.
window.__zeroStep = (n = 1, dtMs = 16) => {
  const raf = store._raf;                       // park the real loop's handle so the
  store._raf = null;                            // pumped frames cannot spawn RAF chains
  for (let i = 0; i < n; i++) { store._last = 0; store._tick(dtMs); }
  store._raf = raf;
};

// dev: force a joint angle (deg) to verify the twin hinge independent of the sensor.
// __setJoint("index_pip", 55) curls; __setJoint("index_pip", null) releases to live data.
window.__setJoint = (id, deg) => { if (deg == null) delete store._force[id]; else store._force[id] = deg; };
