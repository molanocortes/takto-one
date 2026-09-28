// replayData.js - turn a bridge take ({kind:"take_data", cols, rows}) into a
// playable track in the room. PURE (no three.js): node-tested by
// utils/test_pose_fallback.mjs.
//
// Columns are indexed BY NAME (the bridge ships `cols`; never hand-count).
//   joints : {index,middle,ring,pinky}_{mcp,pip,dip}  wire convention
//            (_mcp = abduction, _pip = MCP flexion, _dip = PIP flexion)
//   vision : px,py,pz, pq_w..pq_z   the Quest wrist pose, local-floor of the
//            session that RECORDED the take (WebXR wrist convention)
//   body   : b_ex..b_ez, b_wx..b_wz, b_fq_w..z, b_hq_w..z, b_cal
//            the arm model in the body frame (MOTION_PIPELINE.md section 7)
//
// Placement, per row:
//   - a vision row is its own truth (take frame = the recording's local-floor)
//   - a body row is placed under a TAKE anchor solved from the rows that carry
//     both vision and body (the same yaw+translation solve the live hand uses),
//     so an occluded stretch continues exactly where vision left it
//   - a take with body rows but NO vision rows is placed under the LIVE anchor
//     (the wearer's shoulder now): "your arm again", already in room frame
// The caller then maps take frame -> room with `roomFromTake` (identity for the
// env scanned this session, the anchor relocation for a restored room, or a
// recentring translation when the take's frame is unknown).

import { BodyAnchor, qmul, qnorm, Q_SEG_TO_WRIST } from "../world/poseFallback.js";

const FINGERS = ["index", "middle", "ring", "pinky"];
const SEGS = ["mcp", "pip", "dip"];
const JOINT_IDS = FINGERS.flatMap((f) => SEGS.map((s) => `${f}_${s}`));

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse cols/rows into frames. Returns null for an unusable payload. */
export function parseTake(payload) {
  if (!payload || !Array.isArray(payload.cols) || !Array.isArray(payload.rows)) return null;
  const ix = {};
  payload.cols.forEach((c, i) => { ix[c] = i; });
  const col = (row, name) => (ix[name] === undefined ? null : num(row[ix[name]]));
  const vec = (row, names) => {
    const v = names.map((n) => col(row, n));
    return v.every((x) => x !== null) ? v : null;
  };
  const frames = [];
  let t0 = null;
  for (const row of payload.rows) {
    if (!Array.isArray(row)) continue;
    const t = col(row, "t_ms");
    if (t === null) continue;
    if (t0 === null) t0 = t;
    const joints = {};
    for (const id of JOINT_IDS) { const d = col(row, id); if (d !== null) joints[id] = d; }
    const vp = vec(row, ["px", "py", "pz"]);
    const vq = vec(row, ["pq_w", "pq_x", "pq_y", "pq_z"]);
    const bw = vec(row, ["b_wx", "b_wy", "b_wz"]);
    const bh = vec(row, ["b_hq_w", "b_hq_x", "b_hq_y", "b_hq_z"]);
    const cal = col(row, "b_cal");
    frames.push({
      t: t - t0,
      joints,
      vision: vp && vq ? { pos: vp, quat: qnorm(vq) } : null,
      body: bw && bh && cal !== 0 ? {
        wrist_m: bw, hand_quat: bh,
        elbow_m: vec(row, ["b_ex", "b_ey", "b_ez"]),
        forearm_quat: vec(row, ["b_fq_w", "b_fq_x", "b_fq_y", "b_fq_z"]),
        shoulder_m: [0, 0, 0],
        calibrated: cal === 2, provisional: cal === 1 || cal === null, live: true,
      } : null,
    });
  }
  if (!frames.length) return null;
  return { id: payload.id || null, env: payload.env || null,
           jointSource: payload.joint_source || null, frames,
           durationMs: frames[frames.length - 1].t };
}

/**
 * Resolve every frame to a wrist pose.
 *   liveAnchor: a BodyAnchor for body-only takes (copied, not referenced)
 * Returns { frames:[{t, joints, src, pos, quat(wrist conv.), inRoom}],
 *           hasVision, hasBody, bodyOnly, durationMs }
 */
export function buildTrack(parsed, { liveAnchor = null } = {}) {
  if (!parsed) return null;
  const fr = parsed.frames;
  const hasVision = fr.some((f) => f.vision);
  const hasBody = fr.some((f) => f.body);
  // take anchor: running solve over rows with both, seeded by the first fix
  const anchors = new Array(fr.length).fill(null);
  if (hasVision && hasBody) {
    const a = new BodyAnchor();
    let first = null;
    for (let i = 0; i < fr.length; i++) {
      const f = fr[i];
      const dt = i ? Math.max(0, (f.t - fr[i - 1].t) / 1000) : 1 / 50;
      if (f.vision && f.body) {
        a.solveFromVision(f.body, f.vision.pos, f.vision.quat, dt, f.t, 0.5);
        if (!first) first = { yaw: a.yaw, t: a.t.slice() };
      }
      if (a.valid) anchors[i] = { yaw: a.yaw, t: a.t.slice() };
    }
    if (first) for (let i = 0; i < fr.length && !anchors[i]; i++) anchors[i] = first;
  }
  let live = null;
  if (!hasVision && hasBody && liveAnchor && liveAnchor.valid) {
    live = new BodyAnchor();
    live.yaw = liveAnchor.yaw; live.t = liveAnchor.t.slice(); live.source = liveAnchor.source;
  }
  const scratch = new BodyAnchor();
  const out = fr.map((f, i) => {
    if (f.vision) return { t: f.t, joints: f.joints, src: "vision", pos: f.vision.pos, quat: f.vision.quat, inRoom: false };
    if (f.body) {
      let a = null;
      if (anchors[i]) { scratch.yaw = anchors[i].yaw; scratch.t = anchors[i].t; scratch.source = "vision"; a = scratch; }
      else if (live) a = live;
      const p = a ? a.place(f.body) : null;
      if (p) return { t: f.t, joints: f.joints, src: "body", pos: p.wrist, quat: p.wristQuat, inRoom: a === live };
    }
    return { t: f.t, joints: f.joints, src: "none", pos: null, quat: null, inRoom: false };
  });
  return { frames: out, hasVision, hasBody, bodyOnly: !!live, durationMs: parsed.durationMs };
}

/** Column-major translation-only 4x4 that moves the track's horizontal
 *  centroid to (cx, cz), keeping heights (local-floor y is floor-referenced). */
export function recentreMatrix(track, cx = 0, cz = -0.45) {
  let sx = 0, sz = 0, n = 0;
  for (const f of track.frames) if (f.pos) { sx += f.pos[0]; sz += f.pos[2]; n++; }
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (n) { m[12] = cx - sx / n; m[14] = cz - sz / n; }
  return m;
}

function lerp3(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
function slerp(a, b, k) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) return qnorm([a[0] + (bb[0] - a[0]) * k, a[1] + (bb[1] - a[1]) * k,
                                a[2] + (bb[2] - a[2]) * k, a[3] + (bb[3] - a[3]) * k]);
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - k) * th) / s, wb = Math.sin(k * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/** Index of the last frame with t <= tMs (binary search). */
export function frameAt(track, tMs) {
  const f = track.frames;
  let lo = 0, hi = f.length - 1;
  if (tMs <= f[0].t) return 0;
  if (tMs >= f[hi].t) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (f[mid].t <= tMs) lo = mid; else hi = mid; }
  return lo;
}

/** Interpolated sample: {src, pos, quat (wrist conv.), segQuat, joints} */
export function sampleTrack(track, tMs) {
  const i = frameAt(track, tMs);
  const a = track.frames[i], b = track.frames[Math.min(i + 1, track.frames.length - 1)];
  const span = b.t - a.t;
  const k = span > 0 ? Math.min(1, Math.max(0, (tMs - a.t) / span)) : 0;
  const joints = {};
  for (const id of Object.keys(a.joints)) {
    const bv = b.joints[id];
    joints[id] = bv === undefined ? a.joints[id] : a.joints[id] + (bv - a.joints[id]) * k;
  }
  if (!a.pos) return { src: a.src, pos: null, quat: null, segQuat: null, joints, index: i };
  const both = b.pos && b.src === a.src;
  const pos = both ? lerp3(a.pos, b.pos, k) : a.pos;
  const quat = both ? slerp(a.quat, b.quat, k) : a.quat;
  return { src: a.src, pos, quat, segQuat: qmul(quat, Q_SEG_TO_WRIST), joints, index: i };
}

export { JOINT_IDS };
