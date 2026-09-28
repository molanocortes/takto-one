// poseFallback.js - where the device hand is when the headset cannot see it.
//
// PURE MATH, no three.js: node-testable (utils/test_pose_fallback.mjs).
// Quaternions are [w, x, y, z] (Hamilton, active), vectors [x, y, z] metres.
//
// The contract (software/MOTION_PIPELINE.md):
//   - `world` block: the wrist pose in the headset's local-floor, fused by the
//     bridge from OUR vision poses + IMU dead reckoning. Same frame and same
//     joint convention as the WebXR wrist joint (fingers -Z, dorsal +Y), so it
//     can be used verbatim - but only while it is anchored by THIS session's
//     vision (the bridge keeps an old anchor across sessions, and in --sim it
//     substitutes a figure-eight fixture). `acceptWorld` enforces that.
//   - `body` block: an arm model in the body frame B (+Y up, +Z forward,
//     +X left, origin at the shoulder) with SEGMENT quaternions (+Z distal,
//     +Y dorsal, +X thumb side). It has no idea where the shoulder is in the
//     room, so it is placed with a BodyAnchor: a yaw + translation solved
//     continuously from the last vision-seen wrist (vision and body are both
//     gravity-referenced, so yaw is the only rotational unknown), or a
//     head-derived default when vision has never seen the hand.
//
// Frame bridge: segment frame -> WebXR wrist-joint frame is a half turn about
// Y (fingers +Z -> -Z, thumb +X -> -X, dorsal +Y stays). Q_SEG_TO_WRIST below.

export const Q_ID = [1, 0, 0, 0];
export const Q_SEG_TO_WRIST = [0, 0, 1, 0];     // Ry(pi), its own inverse (up to sign)
export const PALM_FROM_WRIST_M = 0.035;          // SensorHand WRIST offset (palm centre is distal)

// ---------------------------------------------------------------------------
// quaternion / vector helpers
// ---------------------------------------------------------------------------
export function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export function qconj(q) { return [q[0], -q[1], -q[2], -q[3]]; }
export function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
export function qrot(q, v) {
  // v' = q v q*, expanded (no allocation of the pure quaternion)
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
export function qFromAxisAngle(axis, rad) {
  const s = Math.sin(rad / 2);
  return [Math.cos(rad / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}
export function yawQuat(yaw) { return [Math.cos(yaw / 2), 0, Math.sin(yaw / 2), 0]; }
/** Rotation angle about +Y of the twist part of q (swing-twist decomposition). */
export function twistYaw(q) {
  const w = q[0], y = q[2];
  if (Math.abs(w) < 1e-9 && Math.abs(y) < 1e-9) return 0;   // pure 180 deg swing: undefined
  return 2 * Math.atan2(y, w);
}
export function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
export function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function vscale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
export function vlen(a) { return Math.hypot(a[0], a[1], a[2]); }

const finite3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const finite4 = (q) => Array.isArray(q) && q.length === 4 && q.every(Number.isFinite)
  && Math.hypot(q[0], q[1], q[2], q[3]) > 0.5;

/** Segment quaternion (body frame) -> WebXR wrist-joint convention, in B. */
export function segToWrist(qSeg) { return qmul(qSeg, Q_SEG_TO_WRIST); }
/** WebXR wrist-joint quaternion -> segment convention (device/twin frame). */
export function wristToSeg(qWrist) { return qmul(qWrist, Q_SEG_TO_WRIST); }

/** Palm centre from a wrist pose in the WebXR wrist convention (fingers -Z). */
export function palmFromWrist(wristPos, wristQuat, d = PALM_FROM_WRIST_M) {
  return vadd(wristPos, qrot(wristQuat, [0, 0, -d]));
}

// ---------------------------------------------------------------------------
// validity gates
// ---------------------------------------------------------------------------

/** The body block is usable for placement: live, neutral taken (calibrated or
 *  provisional), and the fields placement reads are finite. */
export function bodyUsable(body) {
  if (!body || typeof body !== "object") return false;
  if (body.live === false) return false;
  if (!(body.calibrated || body.provisional)) return false;
  return finite3(body.wrist_m) && finite4(body.hand_quat);
}

/**
 * Is the bridge's `world` block anchored by THIS session's vision right now?
 *   world        : snap.world
 *   msSinceOwnPose: ms since this page last streamed a wrist pose (Infinity if never)
 *   opts.maxOccludedMs: how long the IMU dead reckoning is trusted after our
 *                   last vision sample (bridge bridges occlusion, but drift grows)
 * quest-fused is only OUR pose echoed back while we are still streaming (a
 * sim bridge refreshes it with a fixture once we stop for 3 s, which the
 * 1.2 s gate rejects). imu-model is the bridge carrying our last anchor.
 */
export function acceptWorld(world, msSinceOwnPose, { maxOccludedMs = 20000 } = {}) {
  if (!world || !finite3(world.pos_m) || !finite4(world.quat)) return false;
  if (!Number.isFinite(msSinceOwnPose)) return false;
  if (world.source === "quest-fused") return msSinceOwnPose < 1200;
  if (world.source === "imu-model") return msSinceOwnPose < maxOccludedMs;
  return false;
}

// ---------------------------------------------------------------------------
// BodyAnchor: body frame B -> room (local-floor) L, a yaw about +Y + translation
//   p_L = Ryaw * p_B + t        q_L = Ryaw * q_B
// ---------------------------------------------------------------------------
export class BodyAnchor {
  constructor() {
    this.yaw = 0;
    this.t = [0, 0, 0];
    this.source = "none";          // none | default | vision
    this.visionAt = -Infinity;     // ms timestamp of the last vision solve
  }

  get valid() { return this.source !== "none"; }

  /** Forget the placement (a new XR session has a new local-floor). */
  reset() { this.yaw = 0; this.t = [0, 0, 0]; this.source = "none"; this.visionAt = -Infinity; }

  /** Seed a default when vision never saw the hand: the right shoulder below
   *  and to the right of the head, body forward = where the head faces.
   *  headPos [x,y,z], headFwd horizontal-ish forward [x,y,z]. */
  setDefaultFromHead(headPos, headFwd) {
    let fx = headFwd[0], fz = headFwd[2];
    const n = Math.hypot(fx, fz);
    if (n < 1e-6) { fx = 0; fz = -1; } else { fx /= n; fz /= n; }
    this.yaw = Math.atan2(fx, fz);                       // Ryaw * (0,0,1) = fwd
    const right = [-fz, 0, fx];
    this.t = [
      headPos[0] + 0.17 * right[0] - 0.02 * fx,
      headPos[1] - 0.24,
      headPos[2] + 0.17 * right[2] - 0.02 * fz,
    ];
    this.source = "default";
  }

  /** A fixed default (desktop preview): the neutral palm lands at `palm`,
   *  body forward along `fwd` (default -Z, into the screen). */
  setDefaultNeutralAt(palm, fwd = [0, 0, -1]) {
    const n = Math.hypot(fwd[0], fwd[2]) || 1;
    this.yaw = Math.atan2(fwd[0] / n, fwd[2] / n);
    // neutral arm: upper arm hanging 0.30, forearm forward 0.26, palm 0.035 on
    const wristB = [0, -0.30, 0.26];
    const palmB = [0, -0.30, 0.26 + PALM_FROM_WRIST_M];
    const r = qrot(yawQuat(this.yaw), palmB);
    this.t = vsub(palm, r);
    this.source = "default";
    return wristB;
  }

  /**
   * Solve (and low-pass) the anchor from a vision-seen right wrist and the
   * body block of the same instant. dt in seconds; tau the smoothing time.
   * Returns true when it updated.
   */
  solveFromVision(body, xrWristPos, xrWristQuat, dt = 1 / 60, nowMs = 0, tau = 0.35) {
    if (!bodyUsable(body) || !finite3(xrWristPos) || !finite4(xrWristQuat)) return false;
    // R = Qx * Rseg->wrist * Qb^-1 ; its twist about Y is the heading offset
    const R = qmul(qmul(xrWristQuat, Q_SEG_TO_WRIST), qconj(qnorm(body.hand_quat)));
    const yaw = twistYaw(qnorm(R));
    const t = vsub(xrWristPos, qrot(yawQuat(yaw), body.wrist_m));
    if (this.source !== "vision") {
      // first vision fix (or after a default): snap, never glide from a guess
      this.yaw = yaw; this.t = t;
    } else {
      const k = 1 - Math.exp(-Math.max(0, dt) / tau);
      this.yaw = wrapPi(this.yaw + wrapPi(yaw - this.yaw) * k);
      this.t = [this.t[0] + (t[0] - this.t[0]) * k,
                this.t[1] + (t[1] - this.t[1]) * k,
                this.t[2] + (t[2] - this.t[2]) * k];
    }
    this.source = "vision";
    this.visionAt = nowMs;
    return true;
  }

  point(pB) { return vadd(qrot(yawQuat(this.yaw), pB), this.t); }
  quat(qB) { return qmul(yawQuat(this.yaw), qB); }

  /** Place the body block in the room. Returns null when unusable.
   *  { wrist, elbow, shoulder, palm, wristQuat (WebXR wrist convention),
   *    segQuat (segment convention, for the CAD twin) } */
  place(body) {
    if (!this.valid || !bodyUsable(body)) return null;
    const qHand = qnorm(body.hand_quat);
    const segQuat = this.quat(qHand);
    const wristQuat = qmul(segQuat, Q_SEG_TO_WRIST);
    const wrist = this.point(body.wrist_m);
    return {
      wrist,
      elbow: finite3(body.elbow_m) ? this.point(body.elbow_m) : null,
      shoulder: finite3(body.shoulder_m) ? this.point(body.shoulder_m) : this.point([0, 0, 0]),
      palm: palmFromWrist(wrist, wristQuat),
      wristQuat, segQuat,
    };
  }
}

/**
 * The one decision, shared by the live hand and verified by the node test.
 *   vision   : { wristPos, wristQuat } when the headset tracks the right hand
 *   snap     : latest snapshot (with ._ageMs, how old it is)
 *   ctx      : { msSinceOwnPose, anchor (BodyAnchor), presenting }
 * Returns { source, wrist, wristQuat, palm, elbow } or { source:"rest" }.
 * Vision is resolved by the caller (it owns the fingers too); this is only
 * the fallback ladder: world (fresh, our anchor) -> body (under the anchor).
 */
export function fallbackPose(snap, { msSinceOwnPose = Infinity, anchor = null,
  presenting = false, maxSnapAgeMs = 600 } = {}) {
  if (!snap || (snap._ageMs !== undefined && snap._ageMs > maxSnapAgeMs)) return { source: "rest" };
  const body = snap.body;
  // world is only meaningful in a presenting session's local-floor
  if (presenting && acceptWorld(snap.world, msSinceOwnPose)) {
    const w = snap.world;
    const wristQuat = qnorm(w.quat);
    let elbow = null;
    if (anchor && anchor.valid && bodyUsable(body) && finite3(body.elbow_m)) {
      // forearm vector from the body model, rotated into the room
      elbow = vadd(w.pos_m, qrot(yawQuat(anchor.yaw), vsub(body.elbow_m, body.wrist_m)));
    }
    return { source: "world", wrist: w.pos_m.slice(), wristQuat,
             palm: palmFromWrist(w.pos_m, wristQuat), elbow,
             occluded: w.source === "imu-model" };
  }
  if (anchor && anchor.valid && bodyUsable(body)) {
    const p = anchor.place(body);
    if (p) return { source: "body", wrist: p.wrist, wristQuat: p.wristQuat,
                    palm: p.palm, elbow: p.elbow, anchor: anchor.source };
  }
  return { source: "rest" };
}
