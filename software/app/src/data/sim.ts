// sim.ts - the synthetic hand, so the app is fully explorable with no device.
//
// This mirrors the repository's own rule for every other surface: everything
// runs end to end on synthetic data, and synthetic data says so. Nothing here
// is a recording of a person; it is a choreography, deterministic in t, so a
// given second always produces the same pose. That determinism is what lets
// the media captures be reproducible frame for frame.
//
// The choreography is written as the ENCODERS would see it: every joint is a
// smooth function of time, PIP leads MCP by a breath the way a real finger
// closes from the tip, abduction narrows as the hand closes, and nothing ever
// moves in a straight line. Curl is 0..1 and maps onto the mechanism's range.
import { FINGERS, type Finger } from '../ui/tokens';
import { emptyFrame, type Frame } from './types';

const TAU = Math.PI * 2;
const LOOP = 32;
/** per-finger lag, in seconds, so every movement runs index to pinky */
const LAG: Record<Finger, number> = { index: 0, middle: 0.14, ring: 0.28, pinky: 0.42 };
/** resting spread of each finger, signed degrees */
const SPREAD: Record<Finger, number> = { index: 1, middle: 0.3, ring: -0.3, pinky: -1 };
/**
 * The resting curl, 0..1. A hand at rest is never flat: the fingers hold a
 * soft cascade, the index the straightest and the pinky the most curled, the
 * shape a hand takes when the tendons are slack. Every movement departs from
 * this and returns to it.
 */
const REST: Record<Finger, number> = { index: 0.04, middle: 0.06, ring: 0.08, pinky: 0.11 };

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
function smoothstep(a: number, b: number, x: number) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** ease in and out between a and b, holding 1 from b to c and easing off to d */
function envelope(x: number, a: number, b: number, c: number, d: number) {
  return smoothstep(a, b, x) * (1 - smoothstep(c, d, x));
}
/** a single soft pulse of unit width starting at 0 */
function pulse(x: number) {
  return x > 0 && x < 1 ? 0.5 - 0.5 * Math.cos(x * TAU) : 0;
}

/**
 * Five movements in a 32 s loop:
 *   0-6    breathing: a slow, shallow open and close, each finger a little behind
 *   6-12   ripple: quick taps, index to pinky and back, like fingers on a table
 *   12-18  bloom: from a loose fist the fingers open one by one and fan wide
 *   18-25  wave: a rolling curl travelling down the hand with a gentle sway
 *   25-32  grasp: everything closes, holds, and lets go slowly
 */
function curlOf(finger: Finger, t: number): { curl: number; ab: number } {
  const x = t % LOOP;
  const lag = LAG[finger];
  const fi = FINGERS.indexOf(finger);

  // breathing runs underneath everything, so the hand is never dead still:
  // the resting cascade, swelling by a few degrees and settling again
  const breath = REST[finger] + 0.05 * (0.5 - 0.5 * Math.cos(((x - lag * 2) / 6) * TAU));

  // ripple: taps outward then back, three passes
  const rip = envelope(x, 5.6, 6.4, 11.6, 12.4);
  let taps = 0;
  for (let k = 0; k < 3; k++) {
    const start = 6.4 + k * 1.8;
    const outward = pulse((x - start - fi * 0.14) / 0.55);
    const back = pulse((x - start - 0.9 - (3 - fi) * 0.14) / 0.55);
    taps = Math.max(taps, outward, back);
  }

  // bloom: closed at 12, opens one finger at a time, fans, then settles
  const bloomIn = smoothstep(11.6, 12.6, x);
  const openAt = 13.2 + fi * 0.55;
  const bloomOpen = smoothstep(openAt, openAt + 1.1, x);
  const bloomOut = 1 - smoothstep(17.2, 18.2, x);
  const fist = bloomIn * (1 - bloomOpen) * bloomOut;
  const fan = envelope(x, 14.4, 15.8, 16.6, 18.0);

  // wave: a travelling pulse, three passes, with a slow sway in abduction
  const wv = envelope(x, 17.8, 18.6, 24.4, 25.2);
  let travel = 0;
  for (let k = 0; k < 3; k++) travel = Math.max(travel, pulse((x - 18.6 - k * 2.0 - lag * 2.4) / 1.3));
  const sway = wv * Math.sin((x - 18.6) * 1.6) * 0.5;

  // grasp: close from the tip, hold, release slowly with a small overshoot
  const gr = envelope(x, 25.2, 26.8, 29.2, 31.6);
  const overshoot = pulse((x - 31.0) / 1.4) * 0.05;
  const graspAmount = 0.84 + fi * 0.03;

  // each movement blends from the rest pose toward its own shape, so the
  // fingers never snap flat between phrases
  const away = Math.max(rip * taps, fist, wv * travel, gr);
  const target = rip * taps * (REST[finger] + 0.5) + fist * 0.8 + wv * travel * (REST[finger] + 0.55) + gr * graspAmount;
  const curl = clamp01(breath * (1 - away) + target - overshoot);

  // abduction: a resting whisper, narrowing as the hand closes, fanning in the bloom
  // at rest the hand lies open on a table: fingers spread wide, a whisper of drift
  const rest = SPREAD[finger] * (13.0 + Math.sin(x * 0.45 + fi) * 0.8);
  const ab = (rest * (1 - curl * 0.8)) + fan * SPREAD[finger] * 2 + sway * 3 * SPREAD[finger];
  return { curl, ab };
}

/** the frame as the encoders would report it, at time t */
export function simFrame(t: number): Frame {
  const f = emptyFrame();
  f.t = t;
  const x = t % LOOP;
  let meanCurl = 0;
  for (const finger of FINGERS) {
    // PIP leads MCP by a breath: the tip curls first, the knuckle follows
    const tip = curlOf(finger, t + 0.10);
    const base = curlOf(finger, t);
    f.joints[finger].pip = tip.curl * 100;
    f.joints[finger].mcp = base.curl * 84;
    f.joints[finger].ab = base.ab;
    meanCurl += (tip.curl + base.curl) / 2;
  }
  meanCurl /= 4;

  // activation leads the joints, the way measured intent leads a real grasp
  let lead = 0;
  for (const finger of FINGERS) lead += curlOf(finger, t + 0.24).curl;
  lead /= 4;
  f.emg = clamp01(lead * 0.92 + 0.03);

  const gr = envelope(x, 25.2, 26.8, 29.2, 31.6);
  f.blend = 0.3 + gr * 0.45;

  // housekeeping, as slow drifts around a plausible operating point. The
  // motor load follows effort; the rest breathe on their own periods.
  f.telemetry = {
    tempC: 36.4 + 0.5 * Math.sin(t / 41) + 0.25 * Math.sin(t / 7.3) + 0.12 * Math.sin(t * 1.7) + 0.08 * Math.sin(t * 3.1 + 1) + f.emg * 0.3,
    load: clamp01(0.55 + f.emg * 0.3 + 0.05 * Math.sin(t / 3.1) + 0.03 * Math.sin(t * 2.3) + 0.02 * Math.sin(t * 4.1 + 2)),
    accuracyMm: 0.9 + 0.06 * Math.sin(t / 5.7) + 0.03 * Math.sin(t / 1.9) + 0.02 * Math.sin(t * 2.9) + 0.015 * Math.sin(t * 5.3 + 1),
    responseMs: 118 + 6 * Math.sin(t / 4.3) + 3 * Math.sin(t / 1.3) + 2 * Math.sin(t * 2.1) + 1.5 * Math.sin(t * 3.7 + 2) + f.emg * 4,
    battery: 0.86 - (t / 3600) * 0.08,
    minutesLeft: Math.max(0, 154 - t / 60 * 1.4),
    health: 0.98 - 0.01 * (0.5 - 0.5 * Math.cos(t / 23)) - 0.003 * Math.sin(t * 0.9) - 0.002 * Math.sin(t * 1.9 + 1) - 0.001 * Math.sin(t * 3.3),
  };
  // the whole hand rolls a little with the wave and settles at rest
  const roll = Math.sin(x * 0.2) * 0.05 + envelope(x, 17.8, 18.6, 24.4, 25.2) * Math.sin((x - 18.6) * 1.6) * 0.06;
  f.hand = [Math.cos(roll / 2), 0, 0, Math.sin(roll / 2)];
  void meanCurl;
  return f;
}
