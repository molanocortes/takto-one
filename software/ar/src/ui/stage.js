// stage.js - WHERE the experience sits in the room (recenter), pure math.
//
// Every mode is laid out in one canonical frame: a seated user, the desk point
// at CANON_DESK = (0, 0.75, -0.55) (the ANCHOR constant of every mode), +Y up.
// That frame used to BE local-floor, so starting standing, at another desk
// height, or facing another way misplaced everything.
//
// The fix is one rigid transform, the STAGE: a yaw about +Y plus a translation
// that says where the canonical frame's origin sits in the headset's
// local-floor ("base"):
//
//     p_base = Ry(stage.yaw) * p_canon + stage.pos
//
// In XR it is applied as an offset reference space
// (base.getOffsetReferenceSpace(stage)), so hands, the camera, anchors and the
// room scan are all read in the canonical frame and NO mode changes. On the
// desktop the simulated head is carried by the inverse (passthrough.js).
//
// Recenter solves the stage from the head pose: the desk point lands REACH_M in
// front of the eyes (horizontally, along the gaze heading) and BELOW_EYE_M
// below them, on a detected table plane when one is under that point, or at
// the tracked hand's reach/height when a hand is offered. Per-room persistence
// stores the stage in the frame of a persisted room anchor, so a restored
// anchor puts the scene back where it was in that room.
//
// Units: metres, radians. Matrices: column-major Float64Array(16), the WebXR
// and roomAnchor.js layout. No three.js: node-testable.

export const CANON_DESK = [0, 0.75, -0.55];
export const REACH_M = 0.45;          // desk point ahead of the eyes (horizontal)
export const BELOW_EYE_M = 0.25;      // desk point below the eyes without a table
// a detected plane counts as "the table" only in this height band
export const TABLE_MIN_Y = 0.45;              // m above the floor
export const TABLE_MIN_BELOW_EYE = 0.12;      // at least this far under the eyes
export const TABLE_MAX_BELOW_EYE = 0.70;      // standing at a low table: float at chest height instead
export const TABLE_EDGE_SLACK_M = 0.18;       // target may overhang the plane edge
// a hand offered at recenter sets reach and height within these bounds
export const HAND_REACH_MIN = 0.30, HAND_REACH_MAX = 0.65;

const wrapPi = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const IDENTITY_STAGE = Object.freeze({ yaw: 0, pos: Object.freeze([0, 0, 0]) });

/** Rotate v about +Y by yaw (active, right-handed). */
export function rotY(yaw, v) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

/** Yaw whose canonical forward (-Z) maps to the horizontal direction (fx, fz). */
export function yawFromForward(fx, fz) { return Math.atan2(-fx, -fz); }

/** Horizontal heading of a forward vector, or null when it points (nearly)
 *  straight up or down and has no usable heading. */
export function headingOf(fwd) {
  const n = Math.hypot(fwd[0], fwd[2]);
  return n < 0.2 ? null : [fwd[0] / n, fwd[2] / n];
}

/**
 * Solve the stage from the head pose.
 *   head      : { pos:[x,y,z], fwd:[x,y,z] }  in base (local-floor) coordinates
 *   tableY    : height of a table plane under the target point, or null
 *   hand      : [x,y,z] of an offered hand (palm/pinch), or null
 *   prevYaw   : heading to keep when the head looks straight down/up
 * Returns { yaw, pos, desk:[x,y,z] (where CANON_DESK lands), reach, source }.
 */
export function solveStage({ head, tableY = null, hand = null, prevYaw = 0 } = {}) {
  const hp = head.pos;
  let h = headingOf(head.fwd);
  if (!h) h = [-Math.sin(prevYaw), -Math.cos(prevYaw)];
  const yaw = yawFromForward(h[0], h[1]);
  let reach = REACH_M, source = "head";
  let y = hp[1] - BELOW_EYE_M;
  if (hand) {
    const along = (hand[0] - hp[0]) * h[0] + (hand[2] - hp[2]) * h[1];
    reach = clamp(along, HAND_REACH_MIN, HAND_REACH_MAX);
    y = clamp(hand[1] - 0.08, hp[1] - 0.55, hp[1] - 0.15);
    source = "hand";
  }
  if (tableY !== null && Number.isFinite(tableY)) { y = tableY; source = hand ? "hand+table" : "table"; }
  y = Math.max(0.3, y);
  const desk = [hp[0] + h[0] * reach, y, hp[2] + h[1] * reach];
  const r = rotY(yaw, CANON_DESK);
  return { yaw, pos: [desk[0] - r[0], desk[1] - r[1], desk[2] - r[2]], desk, reach, source };
}

/** Is a plane at height y an acceptable table for eyes at eyeY? */
export function tableHeightOk(y, eyeY) {
  return Number.isFinite(y) && y >= TABLE_MIN_Y && y <= eyeY - TABLE_MIN_BELOW_EYE &&
         y >= eyeY - TABLE_MAX_BELOW_EYE;
}

/** Distance from point (x,z) to polygon [[x,z],...] (0 when inside). */
export function distToPolygon(x, z, poly) {
  if (!poly || poly.length < 3) return Infinity;
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-12) + xi)) inside = !inside;
    const ex = xj - xi, ez = zj - zi, L = ex * ex + ez * ez || 1e-12;
    const t = clamp(((x - xi) * ex + (z - zi) * ez) / L, 0, 1);
    best = Math.min(best, Math.hypot(xi + ex * t - x, zi + ez * t - z));
  }
  return inside ? 0 : best;
}

/**
 * Pick the table height under a target point from horizontal planes.
 *   planes : [{ y, poly:[[x,z],...] (base coords), label? }]
 *   target : [x, z] where the desk point would land
 *   eyeY   : head height
 * Prefers a labelled table/desk, then the plane containing the point, then
 * the one closest to the no-table default height. null when none qualifies.
 */
export function pickTableY(planes, target, eyeY) {
  let best = null, bestScore = Infinity;
  for (const p of planes || []) {
    if (!p || !tableHeightOk(p.y, eyeY)) continue;
    const d = distToPolygon(target[0], target[1], p.poly);
    if (d > TABLE_EDGE_SLACK_M) continue;
    const lab = String(p.label || "").toLowerCase();
    const labelled = lab.indexOf("table") >= 0 || lab.indexOf("desk") >= 0;
    const score = (labelled ? 0 : 1) + d * 2 + Math.abs(p.y - (eyeY - BELOW_EYE_M)) * 0.5;
    if (score < bestScore) { bestScore = score; best = p.y; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// matrices (column-major, rigid)
// ---------------------------------------------------------------------------

/** The stage as a column-major rigid 4x4 (canonical -> base). */
export function stageMatrix(s) {
  const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
  const m = new Float64Array(16);
  m[0] = c; m[1] = 0; m[2] = -n;
  m[4] = 0; m[5] = 1; m[6] = 0;
  m[8] = n; m[9] = 0; m[10] = c;
  m[12] = s.pos[0]; m[13] = s.pos[1]; m[14] = s.pos[2]; m[15] = 1;
  return m;
}

/** A rigid 4x4 back to a yaw-only stage (any tilt is dropped: the stage never
 *  tilts, gravity is shared by every frame involved). */
export function stageFromMatrix(m) {
  // the image of +Z, projected on the horizontal plane, gives the yaw
  const zx = m[8], zz = m[10];
  const yaw = Math.hypot(zx, zz) > 1e-9 ? Math.atan2(zx, zz) : 0;
  return { yaw, pos: [m[12], m[13], m[14]] };
}

function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                     a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
function invRigid(m) {
  const o = new Float64Array(16);
  o[0] = m[0]; o[1] = m[4]; o[2] = m[8];
  o[4] = m[1]; o[5] = m[5]; o[6] = m[9];
  o[8] = m[2]; o[9] = m[6]; o[10] = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  o[12] = -(o[0] * tx + o[4] * ty + o[8] * tz);
  o[13] = -(o[1] * tx + o[5] * ty + o[9] * tz);
  o[14] = -(o[2] * tx + o[6] * ty + o[10] * tz);
  o[15] = 1;
  return o;
}
export { mul as mulMat, invRigid as invertMat };

/** Map a point with a column-major 4x4. */
export function applyMat(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

/** newFromOld: carries canonical coordinates under stage `a` to canonical
 *  coordinates under stage `b` for the SAME physical point:
 *  p_b = Tb^-1 * Ta * p_a. Everything cached in canonical coordinates (scene
 *  objects, the body anchor, a fresh env frame) is moved with it. */
export function stageDelta(a, b) { return mul(invRigid(stageMatrix(b)), stageMatrix(a)); }

/** Shortest-arc interpolation between two stages (k in 0..1). */
export function lerpStage(a, b, k) {
  return {
    yaw: a.yaw + wrapPi(b.yaw - a.yaw) * k,
    pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * k,
          a.pos[1] + (b.pos[1] - a.pos[1]) * k,
          a.pos[2] + (b.pos[2] - a.pos[2]) * k],
  };
}

/** True when two stages differ by less than mm / mrad (glide finished). */
export function stageNear(a, b, eps = 1e-3) {
  return Math.abs(wrapPi(a.yaw - b.yaw)) < eps &&
         Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < eps;
}

// ---------------------------------------------------------------------------
// per-room persistence: the stage expressed in a persisted anchor's frame
// ---------------------------------------------------------------------------

/** G = anchorBase^-1 * T : the stage in the anchor's frame. */
export function stageInAnchor(stage, anchorBase) { return mul(invRigid(anchorBase), stageMatrix(stage)); }

/** T = anchorBase * G, projected back to yaw + translation. */
export function stageFromAnchor(G, anchorBase) { return stageFromMatrix(mul(anchorBase, G)); }

/** An anchor pose read in the CURRENT (offset) reference space, carried to
 *  base: anchorBase = T * anchorCanon. */
export function anchorToBase(stage, anchorCanon) { return mul(stageMatrix(stage), anchorCanon); }

const STORE_KEY = "takto.ar.stage.v1";
const STORE_MAX = 16;
function _ls() { try { return globalThis.localStorage || null; } catch (_) { return null; } }

/** The stored stage-in-anchor for a persistent anchor handle, or null. */
export function loadRoomStage(handle) {
  const ls = _ls();
  if (!ls || !handle) return null;
  try {
    const all = JSON.parse(ls.getItem(STORE_KEY) || "{}");
    const rec = all[handle];
    return rec && Array.isArray(rec.m) && rec.m.length === 16 ? Float64Array.from(rec.m) : null;
  } catch (_) { return null; }
}

/** Remember the stage for a room anchor (newest STORE_MAX kept). */
export function saveRoomStage(handle, G, nowMs = Date.now()) {
  const ls = _ls();
  if (!ls || !handle || !G) return false;
  try {
    const all = JSON.parse(ls.getItem(STORE_KEY) || "{}");
    all[handle] = { m: Array.from(G).map((v) => Math.round(v * 1e5) / 1e5), savedMs: nowMs };
    const keys = Object.keys(all).sort((a, b) => (all[b].savedMs || 0) - (all[a].savedMs || 0));
    for (const k of keys.slice(STORE_MAX)) delete all[k];
    ls.setItem(STORE_KEY, JSON.stringify(all));
    return true;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// lazy follow: a body-locked panel that only moves when the head has turned
// away far enough (no swimming text while you read it)
// ---------------------------------------------------------------------------
export class LazyFollow {
  /** yawDeadRad: re-target when the heading leaves this cone; elev: the panel's
   *  elevation relative to the gaze, clamped to [minElev, maxElev] above the
   *  horizon (radians); tau: easing time constant (s). */
  constructor({ yawDeadRad = 0.44, pitchDeadRad = 0.21, elevAboveGaze = 0.28,
                minElev = -0.12, maxElev = 0.30, tau = 0.22 } = {}) {
    Object.assign(this, { yawDeadRad, pitchDeadRad, elevAboveGaze, minElev, maxElev, tau });
    this.yaw = 0; this.elev = 0;             // current (eased)
    this._tYaw = 0; this._tElev = 0;         // target
    this.placed = false;
  }
  _elevFor(pitch) { return clamp(pitch + this.elevAboveGaze, this.minElev, this.maxElev); }
  /** headYaw: heading (rad, atan2 convention of yawFromForward); headPitch:
   *  gaze elevation (rad, + up). Returns { yaw, elev }. */
  update(headYaw, headPitch, dt) {
    const e = this._elevFor(headPitch);
    if (!this.placed) {
      this.placed = true;
      this.yaw = this._tYaw = headYaw; this.elev = this._tElev = e;
      return { yaw: this.yaw, elev: this.elev };
    }
    if (Math.abs(wrapPi(headYaw - this._tYaw)) > this.yawDeadRad) this._tYaw = headYaw;
    if (Math.abs(e - this._tElev) > this.pitchDeadRad) this._tElev = e;
    const k = 1 - Math.exp(-Math.max(0, dt) / this.tau);
    this.yaw = wrapPi(this.yaw + wrapPi(this._tYaw - this.yaw) * k);
    this.elev += (this._tElev - this.elev) * k;
    return { yaw: this.yaw, elev: this.elev };
  }
  reset() { this.placed = false; }
}
