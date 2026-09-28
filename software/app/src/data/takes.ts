// takes.ts - the recorded-session format, read straight from the bridge's own
// take_data payload ({id, cols, rows}): the column names travel with the rows,
// so nothing here indexes a row by a hand-counted offset. The three bundled
// samples are the repository's own (software/bridge/samples/), choreographed
// and synthetic by their README's own admission; they use the same column
// layout and are offered only as a clearly labelled offline demo.
//
// Columns read (all optional except t_ms):
//   {f}_mcp / {f}_pip / {f}_dip   abduction / MCP flexion / PIP flexion
//   hq_* fq_*                     legacy tared hand / forearm quaternions
//   b_ex..b_ez b_wx..b_wz         elbow / wrist, metres, body frame (v16)
//   b_fq_* b_hq_*                 forearm / hand segment quaternions (v16)
//   b_cal                         0 none, 1 provisional, 2 calibrated
//   act blend px py pz            activation, assist, headset wrist (metres)
import { FINGERS } from '../ui/tokens';
import { emptyFrame, type Body, type Frame, type Quat, type Vec3 } from './types';
import { armBody, palmOf, wristAngles } from './arm';
import { qnorm, qslerp, vlerp } from './quat';

export type TakeOrigin = 'bridge' | 'sim' | 'demo';

export type Take = {
  id: string;
  title: string;
  note: string;
  env: string | null;
  origin: TakeOrigin;
  durationS: number;
  frames: Frame[];
  /** the rows carry the v16 body columns (b_*) */
  hasBody: boolean;
  /** where the joint columns came from, as the bridge labelled the take */
  jointSource: string | null;
};

export type RawTake = { id: string; env?: string | null; cols: string[]; rows: (number | null)[][]; joint_source?: string };

/** Column name -> index, once per take. */
function indexer(cols: string[]) {
  const ix = new Map(cols.map((c, i) => [c, i]));
  return (name: string) => ix.get(name) ?? -1;
}

const CAL: Body['cal'][] = ['none', 'provisional', 'calibrated'];

export function decodeTake(raw: RawTake, meta: { title: string; note: string; origin: TakeOrigin }): Take {
  const at = indexer(raw.cols ?? []);
  const cell = (row: (number | null)[], i: number) => {
    if (i < 0) return NaN;
    const v = row[i];
    return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
  };
  const tI = at('t_ms');
  const q = (p: string) => ['w', 'x', 'y', 'z'].map((c) => at(`${p}_${c}`));
  const hQ = q('hq'), fQ = q('fq'), bfQ = q('b_fq'), bhQ = q('b_hq');
  const bE = ['b_ex', 'b_ey', 'b_ez'].map(at), bW = ['b_wx', 'b_wy', 'b_wz'].map(at);
  const calI = at('b_cal');
  const pos = ['px', 'py', 'pz'].map(at);
  const emgI = at('act'), blendI = at('blend');
  const jI = FINGERS.map((f) => [at(`${f}_mcp`), at(`${f}_pip`), at(`${f}_dip`)]);

  const readQ = (row: (number | null)[], ix: number[]): Quat | null => {
    const v = ix.map((i) => cell(row, i));
    if (v.some((x) => !Number.isFinite(x)) || Math.hypot(...v) < 1e-6) return null;
    return qnorm(v as Quat);
  };
  const readV = (row: (number | null)[], ix: number[]): Vec3 | null => {
    const v = ix.map((i) => cell(row, i));
    return v.every(Number.isFinite) ? (v as Vec3) : null;
  };

  const t0 = raw.rows.length ? cell(raw.rows[0], tI) || 0 : 0;
  let hasBody = false;
  const frames: Frame[] = [];
  for (const row of raw.rows) {
    const tms = cell(row, tI);
    if (!Number.isFinite(tms)) continue;
    const f = emptyFrame();
    f.t = (tms - t0) / 1000;
    FINGERS.forEach((finger, k) => {
      const [a, m, p] = jI[k].map((i) => cell(row, i));
      f.joints[finger] = { ab: Number.isFinite(a) ? a : 0, mcp: Number.isFinite(m) ? m : 0, pip: Number.isFinite(p) ? p : 0 };
      f.ok[finger] = { ab: Number.isFinite(a), mcp: Number.isFinite(m), pip: Number.isFinite(p) };
    });
    const e = cell(row, emgI);
    f.emg = Number.isFinite(e) ? e : -1;
    const b = cell(row, blendI);
    f.blend = Number.isFinite(b) ? b : 0;
    const hq = readQ(row, hQ), fq = readQ(row, fQ);
    if (hq) f.hand = hq;
    if (fq) f.forearm = fq;
    const P = readV(row, pos);
    if (P) f.pos = P;

    const bfq = readQ(row, bfQ), bhq = readQ(row, bhQ), el = readV(row, bE), wr = readV(row, bW);
    if (bfq && bhq && el && wr) {
      hasBody = true;
      const c = cell(row, calI);
      f.body = {
        origin: 'body', cal: CAL[Number.isFinite(c) ? Math.max(0, Math.min(2, Math.round(c))) : 0], live: true,
        shoulder: [0, 0, 0], elbow: el, wrist: wr, hand: palmOf(wr, bhq),
        forearmQuat: bfq, handQuat: bhq, wristDeg: wristAngles(bfq, bhq),
        posSource: 'take', sinceNeutralS: null, inertialConf: null, still: null,
      };
    } else if (hq && fq) {
      f.body = armBody(fq, hq, { origin: 'legacy', cal: 'none', live: true, posSource: 'take (legacy quats)' });
    }
    frames.push(f);
  }

  return {
    id: raw.id,
    title: meta.title,
    note: meta.note,
    env: raw.env ?? null,
    origin: meta.origin,
    durationS: frames.length ? frames[frames.length - 1].t : 0,
    frames,
    hasBody,
    jointSource: raw.joint_source ?? null,
  };
}

function lerpBody(a: Body, b: Body, k: number): Body {
  const fq = qslerp(a.forearmQuat, b.forearmQuat, k);
  const hq = qslerp(a.handQuat, b.handQuat, k);
  const wrist = vlerp(a.wrist, b.wrist, k);
  return {
    ...a,
    elbow: vlerp(a.elbow, b.elbow, k),
    wrist,
    hand: palmOf(wrist, hq),
    forearmQuat: fq,
    handQuat: hq,
    wristDeg: wristAngles(fq, hq),
  };
}

/** Sample at an arbitrary time: joints lerp, orientations slerp. */
export function sampleTake(take: Take, t: number): Frame {
  const fr = take.frames;
  if (!fr.length) return emptyFrame();
  const clamped = Math.max(0, Math.min(take.durationS, t));
  // bisect: a recording from real hardware is not evenly spaced
  let lo = 0, hi = fr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid].t <= clamped) lo = mid; else hi = mid;
  }
  const a = fr[lo], b = fr[hi];
  const span = b.t - a.t;
  const k = span > 1e-6 ? Math.max(0, Math.min(1, (clamped - a.t) / span)) : 0;
  const out = emptyFrame();
  out.t = clamped;
  for (const finger of FINGERS) {
    const pa = a.joints[finger], pb = b.joints[finger];
    out.joints[finger] = {
      ab: pa.ab + (pb.ab - pa.ab) * k,
      mcp: pa.mcp + (pb.mcp - pa.mcp) * k,
      pip: pa.pip + (pb.pip - pa.pip) * k,
    };
    out.ok[finger] = a.ok[finger];
  }
  out.emg = a.emg < 0 || b.emg < 0 ? a.emg : a.emg + (b.emg - a.emg) * k;
  out.blend = a.blend + (b.blend - a.blend) * k;
  out.hand = qslerp(a.hand, b.hand, k);
  out.forearm = qslerp(a.forearm, b.forearm, k);
  out.body = a.body && b.body ? lerpBody(a.body, b.body, k) : a.body;
  if (a.pos && b.pos) out.pos = vlerp(a.pos, b.pos, k);
  return out;
}

let bundled: Take[] | null = null;
/** The demo takes that ship with the app, decoded once. Synthetic. */
export function bundledTakes(): Take[] {
  if (bundled) return bundled;
  const demo = (raw: RawTake, title: string, note: string) => decodeTake(raw, { title, note, origin: 'demo' });
  bundled = [
    demo(require('../../assets/takes/take_demo_signature.json'), 'Signature', 'A figure-eight flight with rolling supination'),
    demo(require('../../assets/takes/take_demo_grasp.json'), 'Grasp', 'Approach, pre-shape, staggered close, carry, release'),
    demo(require('../../assets/takes/take_demo_cascade.json'), 'Cascade', 'Three rolling finger waves, index to pinky'),
  ];
  return bundled;
}
