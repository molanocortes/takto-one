// xrHands.js - read the headset's tracked hands STRAIGHT FROM THE XRFrame.
//
// Why not three.js's renderer.xr.getHand(i)? Two bugs lived there:
//   1. STALE POSE. three.js (r165) keeps every joint Object3D after tracking
//      is lost and only flips `.visible` to false, so "the joint exists" was
//      always true once a hand had been seen: the tips froze wherever the hand
//      left the cameras and the telemetry fallback never ran again.
//   2. HANDEDNESS RACE. Handedness only arrived through the `connected` event,
//      and the listener was attached on the first presenting frame - after the
//      session's first inputsourceschange had already fired, so the rig hand
//      could stay "undefined" (never preferred, never allowed to drive TWIN).
// Reading `session.inputSources` every frame fixes both at the root: each
// XRInputSource carries its own `handedness`, and `xrFrame.getJointPose`
// returns null the moment a joint is not tracked.
//
// A short GRACE period (default 150 ms) rides over single-frame dropouts so
// the dressed hand does not flicker between vision and the fallback; after it,
// the side reads as untracked and the caller falls back.
//
// Pure (no three.js): positions are plain {x,y,z}, orientations {x,y,z,w},
// both accepted by THREE.Vector3/Quaternion.copy. Node-testable with fakes
// (utils/test_pose_fallback.mjs).

export const HAND_JOINTS = [
  "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate",
  "index-finger-phalanx-distal", "index-finger-tip",
  "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate",
  "middle-finger-phalanx-distal", "middle-finger-tip",
  "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate",
  "ring-finger-phalanx-distal", "ring-finger-tip",
  "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate",
  "pinky-finger-phalanx-distal", "pinky-finger-tip",
];

function freshSide(handedness) {
  return {
    handedness,
    joints: {},          // name -> { position:{x,y,z}, quaternion:{x,y,z,w}, radius }
    seenAt: -Infinity,   // ms of the last frame with wrist + index tip tracked
    fresh: false,        // tracked THIS frame
    tracked: false,      // fresh, or within the grace period
  };
}

export class XRHandReader {
  constructor({ graceMs = 150 } = {}) {
    this.graceMs = graceMs;
    this.sides = { right: freshSide("right"), left: freshSide("left") };
  }

  reset() { this.sides = { right: freshSide("right"), left: freshSide("left") }; }

  /** Once per XR frame. Never throws into the frame loop. */
  update(xrFrame, refSpace, session, nowMs) {
    for (const k of ["right", "left"]) this.sides[k].fresh = false;
    if (xrFrame && refSpace && session && session.inputSources && xrFrame.getJointPose) {
      for (const src of session.inputSources) {
        if (!src || !src.hand) continue;
        const side = this.sides[src.handedness];
        if (!side || side.fresh) continue;         // "none" handedness, or already read
        try { this._read(side, src.hand, xrFrame, refSpace, nowMs); }
        catch (_) { /* a runtime hiccup reads as "not tracked this frame" */ }
      }
    }
    for (const k of ["right", "left"]) {
      const s = this.sides[k];
      s.tracked = s.fresh || (nowMs - s.seenAt) <= this.graceMs;
    }
  }

  _read(side, hand, xrFrame, refSpace, nowMs) {
    const pose = (name) => {
      const j = hand.get ? hand.get(name) : null;
      return j ? xrFrame.getJointPose(j, refSpace) : null;
    };
    // the two joints everything downstream needs; without both, not tracked
    const w = pose("wrist"), it = pose("index-finger-tip");
    if (!w || !it) return;
    for (const name of HAND_JOINTS) {
      const jp = name === "wrist" ? w : name === "index-finger-tip" ? it : pose(name);
      if (!jp) continue;                           // keep last value for a lone dropout
      const t = jp.transform, p = t.position, o = t.orientation;
      const slot = side.joints[name] || (side.joints[name] = {
        position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, radius: 0 });
      slot.position.x = p.x; slot.position.y = p.y; slot.position.z = p.z;
      slot.quaternion.x = o.x; slot.quaternion.y = o.y; slot.quaternion.z = o.z; slot.quaternion.w = o.w;
      slot.radius = jp.radius || 0;
    }
    side.fresh = true;
    side.seenAt = nowMs;
  }

  /** {hand:{joints}, handedness, fresh} for a tracked side, else null. */
  get(handedness) {
    const s = this.sides[handedness];
    if (!s || !s.tracked) return null;
    return { hand: { joints: s.joints }, handedness, fresh: s.fresh };
  }

  /** The wrist pose of a tracked side as arrays ([x,y,z], [w,x,y,z]) or null. */
  wrist(handedness) {
    const s = this.sides[handedness];
    const j = s && s.tracked ? s.joints.wrist : null;
    if (!j) return null;
    return { pos: [j.position.x, j.position.y, j.position.z],
             quat: [j.quaternion.w, j.quaternion.x, j.quaternion.y, j.quaternion.z],
             fresh: s.fresh };
  }
}
