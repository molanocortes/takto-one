// store.js - one telemetry connection + one 60 fps interpolation loop, shared
// by every surface. Views subscribe to frames (smoothed values, render-ready)
// or raw snapshots (contract-shaped). Never block a render frame on the socket.

import { makeTelemetry } from "./telemetry.js";
import { clamp, lerp } from "./ui.js";

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

class Store {
  constructor() {
    this.tele = makeTelemetry();
    this.live = this.tele.kind === "ws"; // true = real bridge, false = built-in mock
    // connected = frames are actually flowing. The mock is its own source, so
    // it always counts; a ws source reports its real socket state.
    this.connected = !this.live;
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
    this._raf = null;
    this._last = performance.now();
    this._force = {};                    // dev: id -> deg override (window.__setJoint), for hinge calibration

    // smoothed, render-ready state
    this.smooth = {
      joints: {},                        // id -> deg
      curl: 0,                           // 0..1 whole-hand flexion
      fingers: {},                       // finger -> 0..1 curl
      handQuat: [1, 0, 0, 0],
      forearmQuat: [1, 0, 0, 0],
      wristQuat: null,                    // constrained hand-in-forearm pose from rel.quat
      thumbRel: null,                    // thumb-tip IMU in the hand frame (null = sensor absent)
      rel: null,                         // bridge hand-vs-forearm pose (quat/pos_mm/dist_mm/...)
      blend: null,                       // transparency crown 0..1 (null until the host reports one)
      activation: { level: 0, fatigue: 0, direction: 0 },
      motors: {},                        // id -> {pos, vel, current, temp}
    };

    const safely = (cb, s) => { try { cb(s); } catch (e) { console.error("[store] subscriber error", e); } };
    this.tele.onSnapshot((s) => {
      if (s.kind === "ack") { for (const cb of this._ackCbs) safely(cb, s); return; }
      if (s.kind === "takes") {
        this.lastTakes = s.takes || [];
        for (const cb of this._takesCbs) safely(cb, this.lastTakes);
        return;
      }
      if (s.kind !== "snap") {
        if (s.kind === "envs") this.lastEnvs = s.envs || [];
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
      for (const cb of this._linkCbs) safely(cb, up);
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
    // SEA control layer (Fable/sea runner via the bridge): tensions and
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

  _tick(now) {
    // only the RAF loop reschedules itself: when _raf is null the frame was
    // pumped by hand (window.__zeroStep), and rescheduling there would fork a
    // second, permanent RAF chain per pumped frame.
    if (this._raf !== null) this._raf = requestAnimationFrame(this._tick);
    const dt = Math.min(64, now - this._last);
    this._last = now;
    const s = this.snap, sm = this.smooth;
    if (s) {
      // exponential approach, time-based so it is framerate-independent
      const k = 1 - Math.exp(-dt / SMOOTH_MS);
      const kq = 1 - Math.exp(-dt / SMOOTH_QUAT_MS);
      if (s.joints) {
        const per = {};
        let sum = 0, n = 0;
        for (const j of s.joints) {
          sm.joints[j.id] = lerp(sm.joints[j.id] ?? j.deg, j.deg, k);
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
      if (s.thumb && s.thumb.rel_quat) {
        sm.thumbRel = sm.thumbRel ? nlerpQuat(sm.thumbRel, s.thumb.rel_quat, kq) : s.thumb.rel_quat.slice();
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
