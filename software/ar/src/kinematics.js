// kinematics.js - the ONE mechanical model both digital twins render from.
//
// SHARED SOURCE OF TRUTH. The byte-identical copy at
// Fable/ar/app/src/kinematics.js is enforced by ecosystem_test.py; edit THIS
// file and re-copy (never edit the AR copy directly).
//
// Every constant and law here has a provenance in the thesis or the validated
// engineering code. Nothing is visual tuning:
//
//   SLIDE LAW (the telescopic prismatic pairs). The dorsal pivot sits a
//   standoff h above the anatomical axis, so flexion demands a slide in the
//   link spanning the joint (thesis ch3, eq:sliding ~ h*theta linearised).
//   The EXACT relation (thesis eq:sliding-exact) is implemented in the
//   validated sizing engine (hand_measure/sizing.py sliding_travel, mirrored
//   in Fable/linkmodel/kinematics.py slide_exact, FD-validated):
//       dx = a + b cos(t) + h sin(t)
//       dy = h (1 - cos(t)) + b sin(t)
//       ds = hypot(dx, dy) - (a + b)          [signed, mm]
//   with anchors a = kappa*proximal_segment, b = kappa*distal_segment
//   (kappa = 0.5) and per-joint segments per the sizing engine's anchor rule:
//   MCP uses a = b = kappa*l1; PIP uses a = kappa*l1, b = kappa*l2. A joint's
//   slide lives in the slot of its DISTAL segment's link (slot_avail =
//   railFrac*distal), i.e. the MCP slide extends the telescopic link along
//   the proximal phalanx (the three-plate two-stage pair in the CAD:
//   "two sliding pairs in series telescope symmetrically about the centre",
//   thesis ch3) and the PIP slide extends the single pair to the fingertip
//   cradle.
//
//   KNUCKLE SLIDE (the palm-side prismatic pair, Knuckle_Thin/Knuckle in the
//   CAD, over the back of the palm). The Knuckle part is the MCP joint block:
//   it carries the flexion pivot and rides a rail on the Knuckle_Thin proximal
//   link, so the pivot migrates distally as the MCP flexes and stays aligned
//   with the anatomical axis. Closure from the same standoff geometry as
//   slideLink: the pivot lies on the palm rail (height h above the metacarpal
//   line) AND at standoff h above the flexed phalanx line; intersecting the
//   two rail lines gives the exact migration
//       s(theta) = h * tan(theta/2)
//   (first order h*theta/2: the knuckle rail absorbs the palm-side half of
//   eq:sliding's total h*theta demand, the cuff liner the finger-side half).
//   Small and monotonic: 3.31 mm at 45 deg, h = 8 mm at the 90 deg stop,
//   inside the pair's ~24 mm rail engagement in the CAD.
//
//   SPOOL LAW (the motor digital twin). As-built tendon-over-spool
//   transmission (hand_control/config.py, cross-checked against the printed
//   STLs): cable conservation DeltaL = h_arm*theta_j = r_s*theta_s, with
//   h_arm = 5 mm (RAIL_HEIGHT_MM) and r_s = 5 mm (SPOOL_RADIUS_MM drum), so
//   theta_spool = (h_arm/r_s)*theta_j = 1.0*theta_j nominally (the bench
//   affine calibration absorbs residual geometry). One spool per joint,
//   antagonist pair on a single spool, two motors per finger (thesis ch3).
//
//   HARD STOPS: MCP 90 deg, PIP 110 deg (sizing ROM_DEG; as-built
//   JOINT_LIMITS_DEG), abduction +-16 deg (device abduction envelope).
//
// Angles in DEGREES at the API (the wire contract's unit); slides in mm
// (model/GLB unit). No dependencies; safe for browser and node.

//   SEA LAW (2026-07-27, the series-elastic tendons). Each wire of the PIP
//   pair carries an inline extension spring with a parallel slack loop
//   (COMPENSATOR-SPEC-v2), so MOTOR ANGLE NO LONGER EQUALS JOINT ANGLE:
//   the spool law above remains the RIGID transmission's ideal and the
//   twins keep rendering joints from ENCODERS and spools from MOTOR state
//   (which was always the split here - under SEA it is now mandatory, not
//   just correct). seaWireState() exposes the dual-rate spring law so a
//   surface can render spring stretch / tension estimates it receives from
//   the host (snap.sea) or sanity-check them; the numbers are the Fable/sea
//   config values and are UNIDENTIFIED until the bench closes them.

export const KIN_VERSION = 3;   // v3: SEA dual-rate wire law (series-elastic tendons)

const D2R = Math.PI / 180;

// rail standoff above the anatomical axis (sizing engine DEFAULT_PARAMS.h_mm;
// thesis standoff example h ~ 8 mm)
export const H_RAIL_MM = 8.0;
// anchor fraction: cuff anchors sit mid-segment (sizing engine kappa)
export const KAPPA = 0.5;
// reference-build phalanx lengths, mm (sizing engine NOMINAL_MM; Middle
// 45/28/22 is the thesis prototype)
export const SEG_MM = {
  index:  [40.0, 24.0, 18.0],
  middle: [45.0, 28.0, 22.0],
  ring:   [42.0, 27.0, 20.0],
  pinky:  [33.0, 20.0, 17.0],
};
// as-built transmission (hand_control/config.py)
export const H_ARM_MM = 5.0;      // tendon moment arm at the joint
export const R_SPOOL_MM = 5.0;    // spool drum radius
export const SPOOL_PER_JOINT = H_ARM_MM / R_SPOOL_MM;   // theta_s / theta_j

// mechanical envelope (deg)
export const AB_MIN = -16, AB_MAX = 16;
export const MCP_MIN = -10, MCP_MAX = 90;
export const PIP_MIN = -10, PIP_MAX = 110;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** CUFF-RAIL travel at flexion thetaRad (thesis eq:sliding-exact, the sizing
 *  engine's quantity): relative slide between the exo link and the finger
 *  cuff anchors - what the jam-margin analysis sizes. Small (~3 mm) and
 *  non-monotonic. NOT the visible telescopic extension; kept for parity with
 *  the validated sizing engine. */
export function slideExact(thetaRad, aMm, bMm, hMm = H_RAIL_MM) {
  const c = Math.cos(thetaRad), s = Math.sin(thetaRad);
  const dx = aMm + bMm * c + hMm * s;
  const dy = hMm * (1 - c) + bMm * s;
  return Math.hypot(dx, dy) - (aMm + bMm);
}

/** PIN-TO-PIN extension of a telescopic device link at flexion thetaRad -
 *  the VISIBLE telescoping the twins render. Both device hinges sit the
 *  standoff h above their anatomical axes; the link spans a segment of
 *  neutral length spanMm between them. From the device geometry (O_prox at
 *  -h under the proximal pin, O_dist = O_prox + span*x1(theta), distal pin
 *  at O_dist + h*y1(theta)):
 *      D(theta) = sqrt(span^2 + 2 h^2 (1-cos t) + 2 span h sin t)
 *  Extension = D - span: zero at the extended stop, monotonic through the
 *  ROM (~ h sin t + h^2(1-cos t)/span), ~8.6 mm at 90 deg on the middle
 *  finger - the "lengthens as the finger flexes" behavior of the built
 *  two-stage link (thesis ch3). */
export function slideLink(thetaRad, spanMm, hMm = H_RAIL_MM) {
  const c = Math.cos(thetaRad), s = Math.sin(thetaRad);
  const D = Math.sqrt(spanMm * spanMm + 2 * hMm * hMm * (1 - c) + 2 * spanMm * hMm * s);
  return D - spanMm;
}

/** KNUCKLE-RAIL slide at MCP flexion thetaRad: distal migration of the MCP
 *  joint block (CAD Knuckle) along the rail on the proximal link (CAD
 *  Knuckle_Thin), the palm-side prismatic pair over the back of the palm.
 *  The pivot stays on the palm rail (height h) while staying at standoff h
 *  above the flexed phalanx line; the rail-line intersection migrates by
 *  exactly h*tan(theta/2) (see header). Monotonic, h at the 90 deg stop. */
export function slideKnuckle(thetaRad, hMm = H_RAIL_MM) {
  return hMm * Math.tan(thetaRad / 2);
}

/**
 * The complete finger mechanism state for one finger.
 *
 * Inputs are the wire-contract channels in degrees, palm outward:
 *   abDeg  = {f}_mcp channel = MCP abduction (signed)
 *   mcpDeg = {f}_pip channel = MCP flexion
 *   pipDeg = {f}_dip channel = PIP flexion
 *
 * Returns every rigid-body coordinate the twins render:
 *   ab, mcp, pip          clamped joint angles (deg)
 *   slideKnuckleMm        distal migration of the MCP joint block (Knuckle)
 *                         on the palm-side knuckle rail; the MCP flexion
 *                         pivot rides it, staying aligned with the anatomy
 *   slideMcpMm            extension of the two-stage link along the proximal
 *                         phalanx (total; the centre member moves half)
 *   slideMcpMidMm         = slideMcpMm / 2 ("telescope symmetrically")
 *   slidePipMm            extension of the fingertip-cradle pair
 *   spoolMcpDeg, spoolPipDeg   spool rotations that produce the tendon
 *                         displacement for those joint angles (as-built law)
 */
export function fingerPose(finger, abDeg, mcpDeg, pipDeg) {
  const seg = SEG_MM[finger] || SEG_MM.middle;
  const ab = clamp(abDeg ?? 0, AB_MIN, AB_MAX);
  const mcp = clamp(mcpDeg ?? 8, MCP_MIN, MCP_MAX);
  const pip = clamp(pipDeg ?? 8, PIP_MIN, PIP_MAX);

  // Pin-to-pin telescopic extension per span: the link along the proximal
  // phalanx (neutral span l1) absorbs the MCP's slide; the fingertip-cradle
  // pair (span l2) absorbs the PIP's. The knuckle rail carries the MCP
  // pivot itself distally (palm-side pair). Evaluated from the mechanical
  // zero (0 deg = extended hard stop); hyperextension bottoms at the stop.
  const slideKnuckleMm = slideKnuckle(Math.max(0, mcp) * D2R);
  const slideMcpMm = slideLink(Math.max(0, mcp) * D2R, seg[0]);
  const slidePipMm = slideLink(Math.max(0, pip) * D2R, seg[1]);

  return {
    ab, mcp, pip,
    slideKnuckleMm,
    slideMcpMm,
    slideMcpMidMm: slideMcpMm / 2,
    slidePipMm,
    spoolMcpDeg: SPOOL_PER_JOINT * Math.max(0, mcp),
    spoolPipDeg: SPOOL_PER_JOINT * Math.max(0, pip),
  };
}

/**
 * Spool-station map: which GLB spool node serves which finger/joint.
 * The forearm carries ten stations, two per digit: eight for the long
 * fingers and two reserved for a future thumb (thesis ch4, "ten spool bays,
 * two per digit"). Bank a = MCP motors, bank b = PIP motors, rows ordered
 * index..pinky + thumb reserve. LAYOUT ASSUMPTION pending a bench check of
 * the tendon routing; the per-station angles are exact either way.
 */
export const SPOOL_STATIONS = {
  spool_a0: { finger: "index",  joint: "mcp" },
  spool_a1: { finger: "middle", joint: "mcp" },
  spool_a2: { finger: "ring",   joint: "mcp" },
  spool_a3: { finger: "pinky",  joint: "mcp" },
  spool_a4: null,                                  // thumb reserve, parked
  spool_b0: { finger: "index",  joint: "pip" },
  spool_b1: { finger: "middle", joint: "pip" },
  spool_b2: { finger: "ring",   joint: "pip" },
  spool_b3: { finger: "pinky",  joint: "pip" },
  spool_b4: null,                                  // thumb reserve, parked
};

// ---------------------------------------------------------------------------
// Thumb-tip IMU (pure sensing: the mechanism is thumb-out by scope, the tip
// wears a third BNO085). The host streams snap.thumb {quat, rpy_deg,
// rel_quat}; rel_quat = the thumb pose expressed in the HAND frame, computed
// host-side as conj(hand) x thumb. Both twins render a sensor pod whose
// ORIENTATION is the exact measurement; the pod's anchor point on the palm's
// thumb side is presentational (the sensor is worn on the wearer's thumb tip,
// which the device does not model), stated here once for both platforms.
// Model frame: +Z distal, +Y dorsal, +X thumb side; mm.
export const THUMB_POD_ANCHOR_MM = { x: 42, y: 6, z: 18 };

/** Hamilton product a x b, quaternions [w,x,y,z] (matches the bridge). */
export function quatMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** q_rel with parent x q_rel == child (both unit [w,x,y,z]). The bridge
 *  already ships snap.thumb.rel_quat; this is the same math for clients that
 *  need to re-derive or verify it. */
export function relQuat(parent, child) {
  return quatMul([parent[0], -parent[1], -parent[2], -parent[3]], child);
}

/** Canonical whole-hand flexion coupling: one 0..1 curl -> per-joint degrees.
 *  THE single source for every SYNTHESIZED hand pose (web mock, AR mock, AR
 *  bare-hand fallback, mirror therapy). Mirrors teensy_bridge.py sim_thread:
 *    MCP = 90*c          (hard stop 90)
 *    PIP = 110*(0.8c + 0.2c^2)   (hard stop 110, trails then catches up)
 *  Change it HERE (and in the bridge sim) or nowhere - per-view curl->deg
 *  formulas are how the mirror view once shipped a 90-deg-capped PIP. */
export const MCP_MAX_DEG = 90;
export const PIP_MAX_DEG = 110;
export function curlToJoints(c) {
  const k = c < 0 ? 0 : c > 1 ? 1 : c;
  return {
    mcpDeg: MCP_MAX_DEG * k,
    pipDeg: PIP_MAX_DEG * (0.8 * k + 0.2 * k * k),
  };
}

// ---------------------------------------------------------------------------
// Series-elastic wire law (mirrors Fable/sea/config.py + geometry.Wire; the
// python spec parity-checks the shared constants against this file via node).
// Dual-rate: closed-wound extension spring (rate K_SEA_SPRING, initial
// tension SEA_P_INIT) in parallel with a slack bypass loop that goes taut at
// extension = SEA_STROKE_MM (rate K_SEA_LOOP beyond). ALL FOUR VALUES ARE
// SPEC-DERIVED, NOT MEASURED - flip nothing here without the bench run.
export const K_SEA_SPRING = 0.094;   // N/mm  soft-regime rate
export const SEA_P_INIT = 1.2;       // N     spring initial tension
export const SEA_STROKE_MM = 16.0;   // mm    stroke (dead band of the pair)
export const K_SEA_LOOP = 15.0;      // N/mm  bypass loop taut (estimate)

/** Tension (N) of one series-elastic wire at spring extension xMm (mm).
 *  x <= 0 is a slack cable (a wire cannot push); 0..stroke rides the soft
 *  spring; past the stroke the bypass loop carries the load stiffly. */
export function seaWireTension(xMm) {
  if (xMm <= 0) return 0;
  if (xMm < SEA_STROKE_MM) return SEA_P_INIT + K_SEA_SPRING * xMm;
  return SEA_P_INIT + K_SEA_SPRING * SEA_STROKE_MM + K_SEA_LOOP * (xMm - SEA_STROKE_MM);
}

/** Regime label for a wire at extension xMm: "slack" | "soft" | "taut".
 *  The soft regime is the force-sensing band (~1.2..2.7 N); taut is the
 *  rigid drive branch. Surfaces use this to label spring state honestly.
 *  Only valid for a wire that HAS a spring - see seaJointRegime below. */
export function seaWireRegime(xMm) {
  if (xMm <= 0) return "slack";
  return xMm < SEA_STROKE_MM ? "soft" : "taut";
}

// Which series element each joint's wire pair actually carries in the demo
// routing. Mirrors Fable/sea/config.py WIRE_KIND (sea/spec.py section B
// parity-checks this constant). The MCP wires are SHORT-RUN and un-sprung:
// a stiff loop from zero extension, so they have NO soft band and cannot be
// labelled with the dual-rate law. Only the PIP wires carry the inline
// series-elastic element, so only they have a force-sensing regime.
export const SEA_WIRE_KIND = { mcp: "rigid", pip: "sea" };

/** Regime label for ONE JOINT's wire at extension xMm, honest about which
 *  series element that joint actually has: a rigid wire reads "rigid" when
 *  loaded and "slack" when not, never "soft"/"taut" (it has no spring to
 *  ride). Any surface that knows which joint it is labelling MUST use this
 *  instead of seaWireRegime(), or a 5 N rigid MCP wire at 0.36 mm prints as
 *  "soft" - the dual-rate law read off a wire that does not obey it. */
export function seaJointRegime(joint, xMm) {
  if (SEA_WIRE_KIND[joint] !== "sea") return xMm > 0 ? "rigid" : "slack";
  return seaWireRegime(xMm);
}

/** Spool angle (deg) for a station given the four fingers' poses
 *  (a map finger -> fingerPose result). Motor state wins when provided:
 *  motorsDeg maps "<finger>_drive" -> motor position deg (the control
 *  variable); the same as-built law converts it to spool rotation. */
export function spoolAngleDeg(stationName, poses, motorsDeg) {
  const st = SPOOL_STATIONS[stationName];
  if (!st) return 0;
  const m = motorsDeg && motorsDeg[`${st.finger}_drive`];
  if (st.joint === "mcp" && typeof m === "number" && isFinite(m)) {
    return SPOOL_PER_JOINT * Math.max(0, m);       // control state, directly
  }
  const p = poses[st.finger];
  if (!p) return 0;
  return st.joint === "mcp" ? p.spoolMcpDeg : p.spoolPipDeg;
}
