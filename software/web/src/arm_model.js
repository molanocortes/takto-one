// arm_model.js - the body-frame arm model every browser surface renders from.
//
// Binding contract: software/MOTION_PIPELINE.md (sections 2, 4 and 7).
//   Body frame B: +Y up, +Z forward (where the forearm pointed at the last
//   neutral capture), +X left (= the thumb side of a palm-down right hand),
//   origin at the SHOULDER, metres. Three.js-native and right-handed.
//   Segment frames (forearm, hand, upper arm): +Z distal, +Y dorsal, +X toward
//   the thumb. These are also the twin GLB's model axes.
//   Quaternions are [w, x, y, z] (Hamilton, active), exactly as on the wire.
//
// Shared by twin.js (live), replay.js (recorded takes) and the in-browser
// MockSource, so the three can never disagree on a sign or an offset.
// No DOM, no three.js: plain arrays, safe anywhere.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---- segment lengths (contract defaults for an adult, section 4) ----------
export const L_UA_M = 0.30;            // shoulder -> elbow
export const L_FA_M = 0.26;            // elbow -> wrist pivot
// palm centre from the wrist pivot, hand frame (contract: hand = wrist + Q_hand * this)
export const HAND_PALM_M = [0, 0.01, 0.055];

// ---- where the wrist pivot sits on the device GLB (model mm) ---------------
// The GLB origin is the DISTAL end of the forearm module (node "forearm" spans
// z -180.8 .. -0.2 mm), NOT the wrist joint, and the old twin found its pivot
// from the hand's bounding box at ~(4.5, 5.5, 31.6) mm: 27 mm too distal.
// Derived instead from the bridge's measured lever arms (teensy_bridge.py
// REL_F2W_MM = [0, 8, 95], REL_W2H_MM = [0, 10, 55]) and the GLB geometry:
//   forearm side: forearm IMU at the module centre (0, -6.4, -90.5)
//                 + [0, 8, 95]            -> (0.0, 1.6, 4.5)
//   hand side:    hand IMU on the dorsal plate board "palm_enc", centre
//                 (2.8, 12.0, 61.6) - [0, 10, 55] -> (2.8, 2.0, 6.6)
// Both chains agree to ~2 mm; x stays on the forearm axis (the bridge's
// constants have x = 0), y/z are the mean. Centimetre accuracy is plenty for
// a twin; the point is that the hand now turns about the real wrist.
export const WRIST_PIVOT_MM = [0, 2.0, 5.5];

// Where the neutral wrist lands in the body frame (upper arm hanging, forearm
// forward and level). The twin subtracts it so a neutral arm sits at the old
// stage origin and every existing camera framing still fits the device.
export const NEUTRAL_WRIST_M = [0, -L_UA_M, L_FA_M];

// ---- quaternion helpers ([w, x, y, z]) -------------------------------------
export function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];
export function qNorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-9 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
}
/** A usable unit quaternion, or null for absent / zero-filled / non-finite input. */
export function qValid(q) {
  if (!Array.isArray(q) || q.length !== 4) return null;
  if (!q.every(Number.isFinite)) return null;
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 0.5 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : null;
}
export function qRot(q, v) {
  // v' = q v q*, expanded (no temporaries)
  const [w, x, y, z] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}
export function qAxisAngle(axis, rad) {
  const s = Math.sin(rad / 2);
  return [Math.cos(rad / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}
export const qRx = (deg) => qAxisAngle([1, 0, 0], deg * D2R);
export const qRy = (deg) => qAxisAngle([0, 1, 0], deg * D2R);
export const qRz = (deg) => qAxisAngle([0, 0, 1], deg * D2R);
/** Shortest rotation taking unit vector a onto unit vector b. */
export function qFromUnitVectors(a, b) {
  let r = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + 1;
  let q;
  if (r < 1e-6) {                       // opposite: any perpendicular axis
    q = Math.abs(a[0]) > Math.abs(a[2]) ? [0, -a[1], a[0], 0] : [0, 0, -a[2], a[1]];
  } else {
    q = [r, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  return qNorm(q);
}
export function qNlerp(a, b, t) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  return qNorm([0, 1, 2, 3].map((i) => a[i] + (s * b[i] - a[i]) * t));
}
export const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vScale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const vLerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Yaw (about +Y, degrees) of a quaternion's distal axis, for frame fitting. */
export function yawDeg(q) {
  const d = qRot(q, [0, 0, 1]);
  return Math.atan2(d[0], d[2]) * R2D;
}

// ---- derived angles ---------------------------------------------------------
/** Elevation of the forearm above horizontal, degrees (+ = raised). */
export function forearmElevationDeg(qf) {
  const d = qRot(qf, [0, 0, 1]);
  return Math.asin(Math.max(-1, Math.min(1, d[1]))) * R2D;
}
/**
 * Wrist angles from the hand-vs-forearm rotation, in the contract's signs:
 * + flexion = palm-ward (hand +Z toward forearm -Y), + deviation = radial
 * (toward +X, the thumb), + pronation = the axial twist that turns the thumb
 * down (a negative rotation about +Z). Used when the bridge sends no
 * body.wrist_deg (old bridge) and for replaying takes.
 */
export function wristAnglesDeg(qf, qh) {
  const rel = qMul(qConj(qf), qh);
  const d = qRot(rel, [0, 0, 1]);
  const flex = Math.atan2(-d[1], d[2]) * R2D;
  const dev = Math.atan2(d[0], Math.hypot(d[1], d[2])) * R2D;
  // swing-twist: the twist about the distal axis
  const tw = qNorm([rel[0], 0, 0, rel[3]]);
  let pro = -2 * Math.atan2(tw[3], tw[0]) * R2D;
  if (pro > 180) pro -= 360;
  if (pro < -180) pro += 360;
  return { flex, dev, pro };
}

/**
 * A body block synthesised from the two segment quaternions alone, for a
 * bridge that predates the body model (no `body` in the snapshot) and for
 * replaying takes without b_* columns. Exactly the contract's zero-evidence
 * arm (section 4): upper arm hanging, forearm rotation moves the wrist on a
 * sphere around the elbow. No shoulder motion - so it is labelled synthetic.
 */
export function synthBody(qf, qh) {
  const shoulder = [0, 0, 0];
  const elbow = [0, -L_UA_M, 0];
  const wrist = vAdd(elbow, qRot(qf, [0, 0, L_FA_M]));
  const hand = vAdd(wrist, qRot(qh, HAND_PALM_M));
  return {
    frame: "body_yup_v1", synthetic: true, calibrated: false, provisional: false, live: true,
    shoulder_m: shoulder, elbow_m: elbow, wrist_m: wrist, hand_m: hand,
    upperarm_quat: qFromUnitVectors([0, 0, 1], [0, -1, 0]),
    forearm_quat: qf, hand_quat: qh, thumb_quat: null,
    wrist_deg: wristAnglesDeg(qf, qh), pos_source: "arm",
    quality: { since_neutral_s: null, inertial_conf: 0, still: false },
  };
}

// Sensor world W_s (Z up) -> body B (Y up): the contract's fixed change of
// basis C, (x, y, z)_W -> (x, z, -y)_B. Used on old takes whose inertial
// columns (ihx..ifz) are displacements in the IMU's own Z-up world.
export const worldZupToBody = (v) => [v[0], v[2], -v[1]];
export const bodyToWorldZup = (v) => [v[0], -v[2], v[1]];

export { D2R, R2D };
