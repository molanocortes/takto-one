// sim.ts - the synthetic hand, so the app is fully explorable with no device.
//
// This mirrors the repository's own rule for every other surface: everything
// runs end to end on synthetic data, and synthetic data says so. Nothing here
// is a recording of a person; it is a choreography, deterministic in t, so a
// given second always produces the same pose. That determinism is what lets
// the media captures be reproducible frame for frame.
import { FINGERS, type Finger } from '../ui/tokens';
import { emptyFrame, type Frame } from './types';

const TAU = Math.PI * 2;
/** per-finger phase offset: the wave runs index to pinky */
const PHASE: Record<Finger, number> = { index: 0, middle: 0.16, ring: 0.32, pinky: 0.48 };

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * A 24 s loop in four movements, so a screenshot taken at any moment lands on
 * a pose worth looking at:
 *   0-7 s    breathing idle, the hand barely open and closed
 *   7-13 s   a rolling wave, index to pinky
 *   13-19 s  a full grasp, held, then released
 *   19-24 s  return to idle, abduction fanning once
 */
export function simFrame(t: number): Frame {
  const f = emptyFrame();
  f.t = t;
  const loop = t % 24;

  const wave = smoothstep(6.6, 7.4, loop) * (1 - smoothstep(12.6, 13.4, loop));
  const grasp = smoothstep(13.2, 15.0, loop) * (1 - smoothstep(17.6, 19.0, loop));
  const fan = smoothstep(19.4, 20.6, loop) * (1 - smoothstep(22.0, 23.2, loop));
  const idle = 1 - Math.max(wave, grasp);

  let effort = 0;
  for (const finger of FINGERS) {
    const ph = PHASE[finger];
    // idle: a slow, shallow breath, each finger a little behind the last
    const breath = (Math.sin((loop / 7) * TAU - ph * 1.5) * 0.5 + 0.5) * 0.18 + 0.06;
    // wave: a travelling pulse
    const wavePos = ((loop - 7) / 1.5 - ph * 2.2) % 2.4;
    const pulse = wavePos > 0 && wavePos < 1 ? Math.sin(wavePos * Math.PI) : 0;
    // grasp: everything closes together, pinky slightly further
    const close = 0.86 + (finger === 'pinky' ? 0.08 : finger === 'ring' ? 0.04 : 0);

    const curl = idle * breath + wave * (breath + pulse * 0.82) + grasp * close;
    const c = Math.max(0, Math.min(1, curl));

    f.joints[finger].mcp = c * 82;
    f.joints[finger].pip = c * 96;
    // abduction: a single deliberate fan, plus a whisper of drift at idle
    const spread = { index: 1, middle: 0.35, ring: -0.35, pinky: -1 }[finger];
    f.joints[finger].ab = fan * spread * 13 + idle * Math.sin(loop * 0.6 + ph * 3) * 0.8;
    effort = Math.max(effort, c);
  }

  // Activation leads the joints, the way measured intent leads a real grasp.
  const lead = simCurl(t + 0.22);
  f.emg = Math.max(0, Math.min(1, lead * 0.9 + 0.03));
  f.blend = 0.35 + grasp * 0.4;
  const roll = Math.sin(loop * 0.26) * 0.06;
  f.hand = [Math.cos(roll / 2), 0, 0, Math.sin(roll / 2)];
  return f;
}

/** mean flexion 0..1, the scalar the effort channel follows */
function simCurl(t: number) {
  const fr = simFrameRaw(t);
  let s = 0;
  for (const finger of FINGERS) s += fr.joints[finger].pip / 96;
  return s / 4;
}

// simFrame without the EMG lead, to break the recursion
function simFrameRaw(t: number): Frame {
  const loop = t % 24;
  const f = emptyFrame();
  const wave = smoothstep(6.6, 7.4, loop) * (1 - smoothstep(12.6, 13.4, loop));
  const grasp = smoothstep(13.2, 15.0, loop) * (1 - smoothstep(17.6, 19.0, loop));
  const idle = 1 - Math.max(wave, grasp);
  for (const finger of FINGERS) {
    const ph = PHASE[finger];
    const breath = (Math.sin((loop / 7) * TAU - ph * 1.5) * 0.5 + 0.5) * 0.18 + 0.06;
    const wavePos = ((loop - 7) / 1.5 - ph * 2.2) % 2.4;
    const pulse = wavePos > 0 && wavePos < 1 ? Math.sin(wavePos * Math.PI) : 0;
    const close = 0.86 + (finger === 'pinky' ? 0.08 : finger === 'ring' ? 0.04 : 0);
    const c = Math.max(0, Math.min(1, idle * breath + wave * (breath + pulse * 0.82) + grasp * close));
    f.joints[finger].pip = c * 96;
  }
  return f;
}
