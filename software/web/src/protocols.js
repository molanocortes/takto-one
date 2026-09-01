// protocols.js - the therapy content behind #/guided, and the ONLY place it
// is defined. Every pose here comes from published hand-rehabilitation
// literature; nothing is invented for the demo. Sources are cited per protocol
// (full references in web/GUIDED_PROTOCOLS.md).
//
// HONESTY (hard rule, mirrors the site's compliance line): TAKTO ONE is a
// RESEARCH PROTOTYPE, not a certified medical device. These sequences are
// implemented FROM the literature as a movement guide; they are not a
// prescription, they do not diagnose, and nothing here claims an outcome.
// The UI carries that sentence where the patient can read it.
//
// WHAT THE DEVICE CAN SEE, and therefore what a pose may specify: three
// encoders per finger = MCP abduction (signed), MCP flexion, PIP flexion.
// There is NO DIP encoder (the mechanism is three-hinge per finger) and NO
// thumb sensor in the built device, so:
//   - poses are expressed in {ab, mcp, pip} degrees only;
//   - the classic gliding positions that differ ONLY at the DIP (straight
//     fist vs full fist) are still distinct here at the MCP/PIP, and the
//     copy never claims we measure the DIP;
//   - the thumb is out of scope and no exercise scores it.
// Joint limits come from kinematics.js (MCP 90, PIP 110, abduction +-16).

export const FINGERS = ["index", "middle", "ring", "pinky"];

// tolerance bands (deg): inside NEAR = counted as reached for that joint.
// Generous on purpose - a person in therapy is not a servo, and a target that
// only a perfect hand can hit is a target that teaches failure.
export const TOL = { mcp: 18, pip: 22, ab: 9 };

// A pose = per-joint target in degrees, applied to every long finger unless a
// per-finger override is given. `weight` lets an exercise say which joints it
// is actually about (0 = not scored, e.g. abduction during a fist).
const pose = (mcp, pip, ab = 0, weight = { mcp: 1, pip: 1, ab: 0 }) =>
  ({ mcp, pip, ab, weight });

// ---------------------------------------------------------------------------
// P1 - TENDON GLIDING (Wehbe & Hunter 1985, Part I + Part II)
// Part II found straight-fist, hook and full-fist to give maximum DIFFERENTIAL
// gliding of the superficialis and profundus tendons relative to each other,
// to the sheath and to bone; the sequence below is that classic series with
// the intermediate tabletop position. Rozmaryn et al. (1998) used a nerve- and
// tendon-gliding program of this family as conservative management in carpal
// tunnel syndrome.
// ---------------------------------------------------------------------------
const TENDON_GLIDE = {
  id: "tendon-glide",
  name: "Tendon gliding",
  why: "Moves the flexor tendons through their full excursion, one position at a time.",
  cite: "Wehbe & Hunter 1985 (I + II); Rozmaryn et al. 1998",
  minutes: 6,
  exercises: [
    {
      id: "straight",
      name: "Open hand",
      cue: "Open your hand. Fingers straight and relaxed.",
      target: pose(0, 0),
      reps: 4, holdS: 3, restS: 6,
    },
    {
      id: "tabletop",
      name: "Tabletop",
      cue: "Bend the big knuckles. Keep the fingers themselves straight.",
      target: pose(80, 0),
      reps: 5, holdS: 3, restS: 8,
    },
    {
      id: "straight-fist",
      name: "Straight fist",
      cue: "Curl the middle joints down. Keep the fingertips long.",
      target: pose(80, 95),
      reps: 5, holdS: 3, restS: 8,
    },
    {
      id: "hook-fist",
      name: "Hook fist",
      cue: "Straighten the big knuckles, curl the rest. Like a claw.",
      target: pose(10, 100),
      reps: 5, holdS: 3, restS: 8,
    },
    {
      id: "full-fist",
      name: "Full fist",
      cue: "Close everything gently into a full fist.",
      target: pose(85, 105),
      reps: 5, holdS: 3, restS: 10,
    },
  ],
};

// ---------------------------------------------------------------------------
// P2 - ACTIVE RANGE OF MOTION
// Graded, repetitive active motion of the affected hand, self-administered:
// the dosing model shown effective for the upper limb in the GRASP randomized
// trial (Harris et al. 2009). Here it is composite flexion/extension plus the
// abduction the device can measure at every MCP.
// ---------------------------------------------------------------------------
const ACTIVE_ROM = {
  id: "active-rom",
  name: "Range of motion",
  why: "Takes each joint through as much motion as it has today, gently and often.",
  cite: "Harris et al. 2009 (GRASP), graded repetitive dosing",
  minutes: 5,
  exercises: [
    {
      id: "composite-open",
      name: "Full open",
      cue: "Open as wide as is comfortable.",
      target: pose(0, 0),
      reps: 5, holdS: 2, restS: 6,
    },
    {
      id: "composite-close",
      name: "Full close",
      cue: "Close slowly, as far as it goes today.",
      target: pose(85, 105),
      reps: 6, holdS: 2, restS: 8,
    },
    {
      id: "spread",
      name: "Finger spread",
      cue: "Fingers straight, then spread them apart.",
      // Abduction IS the exercise here, so it carries the weight and gets a
      // TIGHT band: the whole envelope is only +-16 deg, so the default 9 deg
      // tolerance would score an unspread hand at ~0.95 (measured). The MIDDLE
      // finger is excluded from abduction scoring on anatomy, not convenience:
      // it is the axis the others spread away from and barely abducts.
      // The device measures signed abduction at every MCP (+ = thumb side).
      tol: { ab: 5 },
      target: {
        mcp: 0, pip: 0, ab: 0, weight: { mcp: 0.2, pip: 0.2, ab: 1 },
        perFinger: {
          index: { ab: 14 }, middle: { ab: 0, weight: { ab: 0 } },
          ring: { ab: -8 }, pinky: { ab: -15 },
        },
      },
      reps: 5, holdS: 3, restS: 8,
    },
  ],
};

// ---------------------------------------------------------------------------
// P3 - GENTLE START (a short first session)
// Not a separate clinical protocol: a SHORTER dose of the same literature
// poses, for a first session or a stiff day. Labelled as such in the UI.
// ---------------------------------------------------------------------------
const GENTLE = {
  id: "gentle",
  name: "Gentle start",
  why: "A short first session: three positions, few repetitions, long rests.",
  cite: "A reduced dose of the tendon-gliding sequence above",
  minutes: 3,
  exercises: [
    { id: "straight", name: "Open hand", cue: "Open your hand. Fingers straight and relaxed.",
      target: pose(0, 0), reps: 3, holdS: 3, restS: 8 },
    { id: "tabletop", name: "Tabletop", cue: "Bend the big knuckles. Keep the fingers themselves straight.",
      target: pose(80, 0), reps: 3, holdS: 3, restS: 10 },
    { id: "full-fist", name: "Full fist", cue: "Close everything gently into a full fist.",
      target: pose(85, 105), reps: 3, holdS: 3, restS: 10 },
  ],
};

export const PROTOCOLS = [GENTLE, TENDON_GLIDE, ACTIVE_ROM];
export const getProtocol = (id) => PROTOCOLS.find((p) => p.id === id) || PROTOCOLS[0];

/** Per-finger target angles for an exercise: {finger: {ab, mcp, pip}}. */
export function targetJoints(ex) {
  const t = ex.target, out = {};
  for (const f of FINGERS) {
    const o = (t.perFinger && t.perFinger[f]) || {};
    out[f] = { ab: o.ab ?? t.ab, mcp: o.mcp ?? t.mcp, pip: o.pip ?? t.pip };
  }
  return out;
}

/**
 * Score the live hand against an exercise's target, from the MEASURED joint
 * angles. Returns {match 0..1, perFinger {f: 0..1}, worst: {finger, joint}}.
 *
 * A joint scores 1.0 inside its tolerance band and falls off linearly to 0 at
 * three times the band, so being far away still reads as progress rather than
 * a flat zero - the difference between "keep going" and "nothing is happening".
 * Channels the bridge marked not-ok are SKIPPED, never counted as 0 deg: on a
 * bench where only one finger has magnets fitted, counting the dead channels
 * would make a perfect pose score ~25 %.
 */
export function scorePose(ex, joints, okIds) {
  const tgt = targetJoints(ex), w = ex.target.weight || { mcp: 1, pip: 1, ab: 0 };
  const tol = { ...TOL, ...(ex.tol || {}) };
  const perFinger = {};
  let num = 0, den = 0, worst = null, worstErr = -1;
  for (const f of FINGERS) {
    let fNum = 0, fDen = 0;
    const fw = (ex.target.perFinger && ex.target.perFinger[f] || {}).weight || {};
    for (const j of ["ab", "mcp", "pip"]) {
      const weight = fw[j] ?? w[j] ?? 0;
      if (weight <= 0) continue;
      const id = `${f}_${j === "ab" ? "mcp" : j === "mcp" ? "pip" : "dip"}`;   // encoder ids
      if (okIds && !okIds.has(id)) continue;                 // channel not live
      const have = joints[id];
      if (have == null) continue;
      const err = Math.abs(have - tgt[f][j]);
      const band = tol[j];
      const s = err <= band ? 1 : Math.max(0, 1 - (err - band) / (band * 2));
      fNum += s * weight; fDen += weight;
      if (err - band > worstErr) { worstErr = err - band; worst = { finger: f, joint: j, err }; }
    }
    if (fDen > 0) { perFinger[f] = fNum / fDen; num += fNum; den += fDen; }
  }
  return { match: den > 0 ? num / den : 0, perFinger, worst, live: den > 0 };
}

/** Encoder ids the bridge currently reports as ok (magnet fitted + reading). */
export function liveJointIds(snap) {
  const s = new Set();
  if (snap && snap.joints) for (const j of snap.joints) if (j.ok) s.add(j.id);
  return s;
}
