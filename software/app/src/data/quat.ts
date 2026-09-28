// quat.ts - the handful of quaternion and vector operations the data layer
// needs, on plain arrays so frames stay serialisable and three.js stays out of
// the feed. Convention (MOTION_PIPELINE.md section 2): [w, x, y, z], Hamilton,
// active rotations; positions in metres.
import type { Quat, Vec3 } from './types';

export const QI: Quat = [1, 0, 0, 0];

export function qmul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function qconj(q: Quat): Quat { return [q[0], -q[1], -q[2], -q[3]]; }

export function qnorm(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-9 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
}

/** rotation of `deg` degrees about a unit axis */
export function qaxis(ax: Vec3, deg: number): Quat {
  const h = (deg * Math.PI) / 360, s = Math.sin(h);
  return [Math.cos(h), ax[0] * s, ax[1] * s, ax[2] * s];
}
export const qx = (deg: number) => qaxis([1, 0, 0], deg);
export const qy = (deg: number) => qaxis([0, 1, 0], deg);
export const qz = (deg: number) => qaxis([0, 0, 1], deg);

/** v rotated by q */
export function qrot(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  // t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** shortest-path spherical interpolation */
export function qslerp(a: Quat, b: Quat, k: number): Quat {
  let [bw, bx, by, bz] = b;
  let cos = a[0] * bw + a[1] * bx + a[2] * by + a[3] * bz;
  if (cos < 0) { cos = -cos; bw = -bw; bx = -bx; by = -by; bz = -bz; }
  if (cos > 0.9995) {
    return qnorm([a[0] + (bw - a[0]) * k, a[1] + (bx - a[1]) * k, a[2] + (by - a[2]) * k, a[3] + (bz - a[3]) * k]);
  }
  const th = Math.acos(Math.min(1, cos)), s = Math.sin(th);
  const wa = Math.sin((1 - k) * th) / s, wb = Math.sin(k * th) / s;
  return [a[0] * wa + bw * wb, a[1] * wa + bx * wb, a[2] * wa + by * wb, a[3] * wa + bz * wb];
}

export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vlerp = (a: Vec3, b: Vec3, k: number): Vec3 =>
  [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** a finite 4-array, normalised, or null */
export function asQuat(v: unknown): Quat | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const n = Math.hypot(v[0], v[1], v[2], v[3]);
  return n > 1e-6 ? qnorm(v as Quat) : null;
}
/** a finite 3-array, or null */
export function asVec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  return v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as Vec3) : null;
}
