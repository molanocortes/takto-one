// gestures.js - the bare-hand and controller gestures of the UI, pure logic.
// No three.js: positions arrive as plain numbers in the button's local frame
// (x right, y up, z toward the user, metres), so utils/test_pose_fallback.mjs
// can drive every edge case.

/**
 * POKE: a fingertip presses a flat round button by crossing its face from the
 * front. Hover wakes it early; a press needs the tip to come from in front
 * (armed) and reach the surface inside the radius; it re-arms only after the
 * tip backs off, so resting a finger on a button fires once.
 */
export const POKE = { R: 0.024, HOVER_R: 0.034, HOVER_Z: 0.09, PRESS_Z: 0.006,
                      ARM_Z: 0.022, BACK_Z: -0.05 };

export class PokeState {
  constructor() { this.armed = false; this.hover = false; this.depth = 0; }
  /** local tip [x,y,z] or null. Returns "press" on the frame it fires. */
  update(p) {
    if (!p) { this.hover = false; this.armed = false; this.depth = 0; return null; }
    const r = Math.hypot(p[0], p[1]), z = p[2];
    this.hover = r < POKE.HOVER_R && z < POKE.HOVER_Z && z > POKE.BACK_Z;
    // visual press depth 0..1 while the tip is on the face
    this.depth = this.hover ? Math.max(0, Math.min(1, (POKE.ARM_Z - z) / (POKE.ARM_Z - POKE.PRESS_Z + 0.004))) : 0;
    if (r < POKE.R && z > POKE.ARM_Z && z < POKE.HOVER_Z) this.armed = true;
    if (r > POKE.HOVER_R || z < POKE.BACK_Z) this.armed = false;   // slid off / came from behind
    if (this.armed && r < POKE.R && z <= POKE.PRESS_Z) { this.armed = false; return "press"; }
    return null;
  }
}

/**
 * Two-hand PINCH HOLD: both thumb-index pinches closed for holdS seconds.
 * Used for "recenter here" (the midpoint of the pinches becomes the desk
 * reach). Hysteresis on the pinch distance so a trembling pinch does not
 * restart the timer. Fires once per hold.
 */
export class PinchHold {
  constructor({ closeM = 0.02, openM = 0.035, holdS = 1.0 } = {}) {
    Object.assign(this, { closeM, openM, holdS });
    this.l = false; this.r = false; this.t = 0; this.fired = false;
  }
  /** dl / dr: thumb-tip to index-tip distance per hand (m), null = untracked. */
  update(dt, dl, dr) {
    const upd = (was, d) => (d === null || d === undefined ? false
      : was ? d < this.openM : d < this.closeM);
    this.l = upd(this.l, dl); this.r = upd(this.r, dr);
    if (this.l && this.r) this.t += dt; else { this.t = 0; this.fired = false; }
    if (!this.fired && this.t >= this.holdS) { this.fired = true; return true; }
    return false;
  }
  get progress() { return this.fired ? 1 : Math.min(1, this.t / this.holdS); }
  get active() { return this.l && this.r && !this.fired; }
}

/** A held button (controller A/X): fires once after holdS, re-arms on release. */
export class HoldButton {
  constructor(holdS = 0.6) { this.holdS = holdS; this.t = 0; this.fired = false; }
  update(dt, down) {
    if (!down) { this.t = 0; this.fired = false; return false; }
    this.t += dt;
    if (!this.fired && this.t >= this.holdS) { this.fired = true; return true; }
    return false;
  }
  get progress() { return this.fired ? 1 : Math.min(1, this.t / this.holdS); }
}

/** One action per target per window: a trigger that is both a ray select and
 *  a reach click, or a poke that bounces, fires once. */
export class Debounce {
  constructor(ms = 350) { this.ms = ms; this.last = new Map(); }
  ok(key, nowMs) {
    const t = this.last.get(key);
    if (t !== undefined && nowMs - t < this.ms) return false;
    this.last.set(key, nowMs);
    return true;
  }
}
