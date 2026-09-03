// motion.js - easing and spring helpers. Everything eases; nothing snaps.
// Default UI curve: cubic-bezier(0.22, 1, 0.36, 1). Springs for anything physical.

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// the house ease-out (approximation of cubic-bezier(0.22, 1, 0.36, 1))
export const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3.2);
export const easeInOut = (t) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

// critically-near-damped spring (stiffness ~170, damping ~22, zeta ~0.75).
// step(dt) integrates toward .target; a tiny overshoot reads as alive.
export class Spring {
  constructor(value = 0, stiffness = 170, damping = 22) {
    this.x = value; this.v = 0; this.target = value;
    this.k = stiffness; this.c = damping;
  }
  set(value) { this.x = value; this.v = 0; this.target = value; return this; }
  to(target) { this.target = target; return this; }
  step(dt) {
    dt = Math.min(dt, 0.05);
    const a = this.k * (this.target - this.x) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
  get done() { return Math.abs(this.x - this.target) < 1e-4 && Math.abs(this.v) < 1e-4; }
}

// 3-component spring for positions
export class Spring3 {
  constructor(x = 0, y = 0, z = 0, stiffness = 170, damping = 22) {
    this.sx = new Spring(x, stiffness, damping);
    this.sy = new Spring(y, stiffness, damping);
    this.sz = new Spring(z, stiffness, damping);
  }
  set(x, y, z) { this.sx.set(x); this.sy.set(y); this.sz.set(z); return this; }
  to(x, y, z) { this.sx.to(x); this.sy.to(y); this.sz.to(z); return this; }
  step(dt) { this.sx.step(dt); this.sy.step(dt); this.sz.step(dt); return this; }
  get x() { return this.sx.x; } get y() { return this.sy.x; } get z() { return this.sz.x; }
}

// critically damped smoothing toward a moving target (for telemetry values).
// tau [s] is the time constant; call step(target, dt).
export class Damped {
  constructor(value = 0, tau = 0.09) { this.x = value; this.tau = tau; }
  step(target, dt) {
    const a = 1 - Math.exp(-dt / this.tau);
    this.x += (target - this.x) * a;
    return this.x;
  }
}

// a slow breathing oscillator (0.1-0.2 Hz), phase-offsettable, in [0..1]
export class Breath {
  constructor(hz = 0.14, phase = 0) { this.hz = hz; this.phase = phase; }
  at(t) { return 0.5 + 0.5 * Math.sin(2 * Math.PI * (this.hz * t + this.phase)); }
}

// staggered reveal scheduler: schedule(fn, i) runs fn after i * gap seconds.
export class Stagger {
  constructor(gap = 0.06) { this.gap = gap; this._q = []; this.t = 0; }
  schedule(fn, i = 0, extra = 0) { this._q.push({ at: this.t + i * this.gap + extra, fn }); }
  step(dt) {
    this.t += dt;
    for (let i = this._q.length - 1; i >= 0; i--) {
      if (this._q[i].at <= this.t) { const { fn } = this._q.splice(i, 1)[0]; fn(); }
    }
  }
  clear() { this._q.length = 0; }
}

// a one-shot timeline value: play() then value(t) eases 0 -> 1 over dur seconds.
export class Ramp {
  constructor(dur = 0.6) { this.dur = dur; this.t0 = -1; this.t = 0; }
  play() { this.t0 = this.t; }
  step(dt) { this.t += dt; }
  get v() { return this.t0 < 0 ? 0 : easeOut((this.t - this.t0) / this.dur); }
  get playing() { return this.t0 >= 0 && (this.t - this.t0) < this.dur; }
}
