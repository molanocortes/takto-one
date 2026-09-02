// takes.ts - the recorded-session format, read straight from the device's own
// take files. The three bundled samples are the repository's own
// (software/bridge/samples/), choreographed and synthetic by their README's
// own admission, and they use the real column layout, so a take recorded by
// the device drops in unchanged.
import { FINGERS, type Finger } from '../ui/tokens';
import { emptyFrame, type Frame, type Quat } from './types';

export type Take = {
  id: string;
  title: string;
  note: string;
  env: string | null;
  durationS: number;
  frames: Frame[];
};

type RawTake = { id: string; env?: string; cols: string[]; rows: number[][] };

/** Column name -> index, once per take. */
function indexer(cols: string[]) {
  const ix = new Map(cols.map((c, i) => [c, i]));
  return (name: string) => ix.get(name) ?? -1;
}

export function decodeTake(raw: RawTake, title: string, note: string): Take {
  const at = indexer(raw.cols);
  const tI = at('t_ms');
  const q = (p: string): number[] => ['w', 'x', 'y', 'z'].map((c) => at(`${p}q_${c}`));
  const hQ = q('h'), fQ = q('f');
  const pos = ['px', 'py', 'pz'].map((c) => at(c));
  const emgI = at('act'), blendI = at('blend');

  const frames: Frame[] = raw.rows.map((row) => {
    const f = emptyFrame();
    f.t = (row[tI] ?? 0) / 1000;
    for (const finger of FINGERS) {
      // wire names: _mcp = abduction, _pip = MCP flexion, _dip = PIP flexion
      f.joints[finger].ab = row[at(`${finger}_mcp`)] ?? 0;
      f.joints[finger].mcp = row[at(`${finger}_pip`)] ?? 0;
      f.joints[finger].pip = row[at(`${finger}_dip`)] ?? 0;
    }
    f.emg = emgI >= 0 ? (row[emgI] ?? 0) : -1;
    f.blend = blendI >= 0 ? (row[blendI] ?? 0) : 0;
    f.hand = hQ.map((i) => (i >= 0 ? row[i] : 0)) as Quat;
    f.forearm = fQ.map((i) => (i >= 0 ? row[i] : 0)) as Quat;
    if (pos.every((i) => i >= 0)) f.pos = pos.map((i) => row[i]) as [number, number, number];
    return f;
  });

  return {
    id: raw.id,
    title,
    note,
    env: raw.env ?? null,
    durationS: frames.length ? frames[frames.length - 1].t : 0,
    frames,
  };
}

/** Linear sample at an arbitrary time; joint angles interpolate honestly. */
export function sampleTake(take: Take, t: number): Frame {
  const fr = take.frames;
  if (!fr.length) return emptyFrame();
  const clamped = Math.max(0, Math.min(take.durationS, t));
  // frames are evenly spaced in these takes; bisect anyway so an uneven
  // recording from real hardware still plays at the right speed
  let lo = 0, hi = fr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid].t <= clamped) lo = mid; else hi = mid;
  }
  const a = fr[lo], b = fr[hi];
  const span = b.t - a.t;
  const k = span > 1e-6 ? (clamped - a.t) / span : 0;
  const out = emptyFrame();
  out.t = clamped;
  for (const finger of FINGERS) {
    const pa = a.joints[finger], pb = b.joints[finger];
    out.joints[finger] = {
      ab: pa.ab + (pb.ab - pa.ab) * k,
      mcp: pa.mcp + (pb.mcp - pa.mcp) * k,
      pip: pa.pip + (pb.pip - pa.pip) * k,
    };
  }
  out.emg = a.emg + (b.emg - a.emg) * k;
  out.blend = a.blend + (b.blend - a.blend) * k;
  out.hand = a.hand;
  out.forearm = a.forearm;
  if (a.pos && b.pos) out.pos = a.pos.map((v, i) => v + (b.pos![i] - v) * k) as [number, number, number];
  return out;
}

/** The takes that ship with the app, decoded once. */
export function bundledTakes(): Take[] {
  return [
    decodeTake(require('../../assets/takes/take_demo_signature.json'),
      'Signature', 'A figure-eight flight with rolling supination'),
    decodeTake(require('../../assets/takes/take_demo_grasp.json'),
      'Grasp', 'Approach, pre-shape, staggered close, carry, release'),
    decodeTake(require('../../assets/takes/take_demo_cascade.json'),
      'Cascade', 'Three rolling finger waves, index to pinky'),
  ];
}
