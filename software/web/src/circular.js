// Circular-signal helpers shared by plots and readouts.
// AS5600 angles are reported modulo 360, so 359.9 -> 0.1 is a +0.2 degree
// movement, not a -359.8 degree jump.

export function circularStep(from, to, period = 360) {
  if (!(period > 0)) return to - from;
  const half = period / 2;
  return ((to - from + half) % period + period) % period - half;
}

export function unwrapCircularValues(values, period = 360) {
  if (!values || values.length === 0) return [];
  const out = [Number(values[0])];
  let rawPrev = Number(values[0]);
  for (let i = 1; i < values.length; i++) {
    const raw = Number(values[i]);
    out.push(out[out.length - 1] + circularStep(rawPrev, raw, period));
    rawPrev = raw;
  }
  return out;
}

