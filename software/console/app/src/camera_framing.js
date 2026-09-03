// Pure camera-fit math shared by the live twin and its deterministic check.
// A bounding sphere is conservative: if the sphere fits, every articulated
// fingertip inside it fits at any manual orbit angle.
export function fitSphereDistance(radius, verticalFovDeg, aspect, {
  margin = 1.16, min = 3.0, max = 9.5, fallback = 4.6,
} = {}) {
  if (![radius, verticalFovDeg, aspect].every(Number.isFinite) ||
      radius <= 0 || verticalFovDeg <= 0 || aspect <= 0) return fallback;
  const v = verticalFovDeg * Math.PI / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  const halfLimitingFov = Math.max(0.05, Math.min(v, h) / 2);
  const required = radius * margin / Math.sin(halfLimitingFov);
  return Math.max(min, Math.min(max, required));
}

