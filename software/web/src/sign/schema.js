// schema.js - the ONE feature-schema contract for TAKTO-SIGN.
//
// SHARED SOURCE OF TRUTH. The Python mirror at Fable/signlang/dataset/schema.py
// must agree column-for-column; tools/signlang_test.py enforces the parity
// (the same discipline as kinematics.js <-> the python sizing engine).
//
// A captured frame is a fixed-width vector drawn from the bridge snapshot
// (Fable/web/DATA_CONTRACT.md). Two column groups:
//
//   DEVICE (24, always present): what TAKTO ONE physically senses.
//     Per finger f in {idx, mid, rng, pnk}, three angles in DEGREES:
//       {f}_abd  finger abduction   (bridge channel "{finger}_mcp", signed +-16)
//       {f}_mcp  MCP flexion        (bridge channel "{finger}_pip", 0..90)
//       {f}_pip  PIP flexion        (bridge channel "{finger}_dip", 0..110)
//     NOTE the deliberate re-labelling: the bridge names channels by encoder
//     POSITION along the chain ({f}_mcp/pip/dip), but anatomically they are
//     abduction / MCP-flexion / PIP-flexion. We store the ANATOMICAL names so
//     the model and docs read correctly. The mechanism has NO DIP sensor.
//     Then two orientation quaternions [w,x,y,z] (unit, tared, hand-frame):
//       hand_q{w,x,y,z}   global hand orientation  (snap.hand.quat)
//       fore_q{w,x,y,z}   forearm orientation      (snap.forearm.quat)
//       thmb_q{w,x,y,z}   thumb-tip pose in the HAND frame (snap.thumb.rel_quat)
//     A dead channel at a given frame is stored as NaN (lossless liveness);
//     when the thumb sensor is absent the whole thumb_q block is NaN.
//
//   CAMERA (4, OPTIONAL): the fused MediaPipe modality (right hand only).
//     cam_wx, cam_wy   normalized image coords of the right wrist (0..1)
//     cam_wz           relative wrist depth (MediaPipe world z, meters-ish)
//     cam_present      1 while a right hand is tracked, else 0
//     A device-only session omits the camera group entirely (has_camera=false);
//     a fused session stores it aligned frame-for-frame (NaN where no hand).
//
// Angles in degrees, quats unit [w,x,y,z], camera normalized. No em dashes.

export const SCHEMA_VERSION = 1;

export const FINGERS = ["idx", "mid", "rng", "pnk"];
// map our finger token -> the bridge's finger name
export const FINGER_BRIDGE = { idx: "index", mid: "middle", rng: "ring", pnk: "pinky" };
// map our anatomical angle -> the bridge channel suffix on that finger
//   abd <- _mcp (abduction encoder), mcp <- _pip (MCP flexion), pip <- _dip (PIP flexion)
export const ANGLE_BRIDGE_SUFFIX = { abd: "mcp", mcp: "pip", pip: "dip" };

function fingerAngleCols() {
  const out = [];
  for (const f of FINGERS) for (const a of ["abd", "mcp", "pip"]) out.push(`${f}_${a}`);
  return out;
}
function quatCols(prefix) {
  return ["w", "x", "y", "z"].map((c) => `${prefix}_q${c}`);
}

export const DEVICE_COLS = [
  ...fingerAngleCols(),                 // 12 finger angles
  ...quatCols("hand"),                  // 4
  ...quatCols("fore"),                  // 4
  ...quatCols("thmb"),                  // 4  (thumb-tip in hand frame; NaN when absent)
];                                       // = 24

export const CAMERA_COLS = ["cam_wx", "cam_wy", "cam_wz", "cam_present"];

export const N_DEVICE = DEVICE_COLS.length;   // 24
export const N_CAMERA = CAMERA_COLS.length;   // 4

// index helpers (column name -> position within the DEVICE group)
export const DEVICE_INDEX = Object.fromEntries(DEVICE_COLS.map((c, i) => [c, i]));

/**
 * Pull the DEVICE feature row (length 24) out of one bridge snapshot.
 * Dead channels -> NaN (lossless liveness). Absent thumb -> NaN quat block.
 * Returns { row:Float64Array(24), anyLive:bool, thumbLive:bool, encLive:int }.
 */
export function deviceRowFromSnap(snap) {
  const row = new Float64Array(N_DEVICE).fill(NaN);
  let encLive = 0;
  const byId = {};
  // a null / non-object element in the joints array must not crash extraction
  if (Array.isArray(snap.joints)) for (const j of snap.joints) if (j && typeof j === "object") byId[j.id] = j;
  for (const f of FINGERS) {
    const bf = FINGER_BRIDGE[f];
    for (const a of ["abd", "mcp", "pip"]) {
      const j = byId[`${bf}_${ANGLE_BRIDGE_SUFFIX[a]}`];
      const idx = DEVICE_INDEX[`${f}_${a}`];
      if (j && j.ok && Number.isFinite(j.deg)) { row[idx] = j.deg; encLive++; }
    }
  }
  const putQuat = (prefix, q) => {
    if (Array.isArray(q) && q.length === 4 && q.every((v) => Number.isFinite(v))) {
      for (let i = 0; i < 4; i++) row[DEVICE_INDEX[`${prefix}_q${"wxyz"[i]}`]] = q[i];
      return true;
    }
    return false;
  };
  putQuat("hand", snap.hand && snap.hand.quat);
  putQuat("fore", snap.forearm && snap.forearm.quat);
  const thumbLive = !!(snap.thumb && putQuat("thmb", snap.thumb.rel_quat));
  return { row, anyLive: encLive > 0, thumbLive, encLive };
}

/** Per-frame camera row (length 4) from an optional MediaPipe result, or a
 *  NaN row when no camera modality is present this frame. */
export function cameraRow(cam) {
  const row = new Float64Array(N_CAMERA).fill(NaN);
  if (cam && Number.isFinite(cam.wx)) {
    row[0] = cam.wx; row[1] = cam.wy;
    row[2] = Number.isFinite(cam.wz) ? cam.wz : NaN;
    row[3] = cam.present ? 1 : 0;
  }
  return row;
}
