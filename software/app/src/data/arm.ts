// arm.ts - the arm model of MOTION_PIPELINE.md section 4, for the places the
// app has to build a `body` itself: the synthetic feed, a take without b_*
// columns, and a bridge that only sends the legacy hand/forearm quaternions.
//
//   elbow = shoulder + L_ua * u          u = upper-arm unit vector
//   wrist = elbow + Q_forearm * [0, 0, L_fa]
//   hand  = wrist + Q_hand * [0, 0.01, 0.055]
import type { Body, Quat, Vec3 } from './types';
import { qconj, qmul, qrot, vadd } from './quat';

export const L_UA = 0.30;
export const L_FA = 0.26;
const PALM: Vec3 = [0, 0.01, 0.055];
const HANGING: Vec3 = [0, -1, 0];

const R2D = 180 / Math.PI;

/** flexion / deviation / axial twist of the hand relative to the forearm, degrees */
export function wristAngles(forearm: Quat, hand: Quat) {
  const rel = qmul(qconj(forearm), hand);
  const d = qrot(rel, [0, 0, 1]);
  return {
    flex: Math.atan2(-d[1], d[2]) * R2D,        // distal toward -Y (palm) = flexion
    dev: Math.atan2(d[0], Math.hypot(d[1], d[2])) * R2D,   // toward +X (thumb) = radial
    pro: 2 * Math.atan2(rel[3], rel[0]) * R2D,  // twist about the distal axis
  };
}

export function armBody(forearm: Quat, hand: Quat, o: {
  origin: Body['origin']; cal: Body['cal']; live: boolean; u?: Vec3; posSource?: string;
  sinceNeutralS?: number | null; still?: boolean | null;
}): Body {
  const u = o.u ?? HANGING;
  const shoulder: Vec3 = [0, 0, 0];
  const elbow: Vec3 = [u[0] * L_UA, u[1] * L_UA, u[2] * L_UA];
  const wrist = vadd(elbow, qrot(forearm, [0, 0, L_FA]));
  return {
    origin: o.origin, cal: o.cal, live: o.live,
    shoulder, elbow, wrist,
    hand: vadd(wrist, qrot(hand, PALM)),
    forearmQuat: forearm, handQuat: hand,
    wristDeg: wristAngles(forearm, hand),
    posSource: o.posSource ?? (o.origin === 'legacy' ? 'legacy' : 'arm'),
    sinceNeutralS: o.sinceNeutralS ?? null,
    inertialConf: null,
    still: o.still ?? null,
  };
}

/** palm centre from a wrist position and hand orientation */
export function palmOf(wrist: Vec3, hand: Quat): Vec3 { return vadd(wrist, qrot(hand, PALM)); }
