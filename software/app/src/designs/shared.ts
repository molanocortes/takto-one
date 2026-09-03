// shared.ts - what every design reads from the feed, computed once, here.
//
// The data path is not forked. A design owns how a number is DRAWN; the
// numbers themselves, the joint names, the limits and the feed badge text
// all come from this file so that twenty designs make one claim.
import { Platform } from 'react-native';
import { FINGERS, type Finger } from '../ui/tokens';
import type { Frame } from '../data/types';
import type { session } from '../data/session';
type Session = typeof session;

export type ScreenKey = 'welcome' | 'live' | 'replay' | 'data';

/** The three joints per finger, in the mechanism's own names, with their limits. */
export const JOINTS = [
  { key: 'ab' as const, short: 'ABD', name: 'MCP abduction', wire: 'mcp', max: 16, signed: true },
  { key: 'mcp' as const, short: 'MCP', name: 'MCP flexion', wire: 'pip', max: 90, signed: false },
  { key: 'pip' as const, short: 'PIP', name: 'PIP flexion', wire: 'dip', max: 110, signed: false },
];
export type JointKey = (typeof JOINTS)[number]['key'];

export const FINGER_NAME: Record<Finger, string> = { index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' };
export const FINGER_ROMAN: Record<Finger, string> = { index: 'II', middle: 'III', ring: 'IV', pinky: 'V' };
export const FINGER_NUM: Record<Finger, string> = { index: '1', middle: '2', ring: '3', pinky: '4' };

export const RATES = [
  { what: 'This app', rate: '60 Hz', note: 'what you are watching' },
  { what: 'Firmware stream', rate: '50 Hz', note: 'the serial line default' },
  { what: 'Control loop', rate: '2 kHz', note: 'on the Teensy, next to the actuator' },
  { what: 'On-device capture', rate: 'unbound', note: 'the SD log is not tied to any of these' },
];

export type Stats = {
  /** mean of every live flexion joint, degrees */
  mean: number;
  /** the most flexed finger and its angle */
  peakFinger: Finger; peak: number;
  liveJoints: number;
  /** 0..1 activation, or -1 when absent */
  emg: number;
  blend: number;
  blendWord: 'Transparent' | 'Blended' | 'Assisted';
  /** per finger, mean flexion 0..1 of range */
  curl: Record<Finger, number>;
};

export function stats(frame: Frame): Stats {
  let sum = 0, n = 0, liveJoints = 0, peakFinger: Finger = 'index', peak = -1;
  const curl = {} as Record<Finger, number>;
  for (const f of FINGERS) {
    const p = frame.joints[f], ok = frame.ok[f];
    let s = 0, k = 0;
    if (ok.mcp) { sum += p.mcp; n++; s += p.mcp / 90; k++; }
    if (ok.pip) { sum += p.pip; n++; s += p.pip / 110; k++; }
    curl[f] = k ? Math.max(0, Math.min(1, s / k)) : 0;
    liveJoints += (ok.ab ? 1 : 0) + (ok.mcp ? 1 : 0) + (ok.pip ? 1 : 0);
    const m = Math.max(ok.mcp ? p.mcp : -1, ok.pip ? p.pip : -1);
    if (m > peak) { peak = m; peakFinger = f; }
  }
  const blend = Math.max(0, Math.min(1, frame.blend));
  return {
    mean: n ? sum / n : 0, peakFinger, peak: Math.max(0, peak), liveJoints,
    emg: frame.emg < 0 ? -1 : Math.max(0, Math.min(1, frame.emg)), blend,
    blendWord: blend < 0.15 ? 'Transparent' : blend > 0.85 ? 'Assisted' : 'Blended', curl,
  };
}

/** The feed badge, worded once. Every design shows it on every screen. */
export function feedWord(s: Session): { word: string; live: boolean; detail: string } {
  if (s.link.kind === 'bridge') return { word: s.link.live ? 'Bridge' : s.link.label.toLowerCase(), live: s.link.live, detail: s.link.detail };
  if (s.link.kind === 'take') return { word: 'Replay', live: false, detail: 'recorded session' };
  return { word: 'Synthetic feed', live: false, detail: 'no device attached' };
}

export function fmtDeg(v: number, on: boolean, signed = false, digits = 0) {
  if (!on) return '–';
  return `${signed && v > 0 ? '+' : ''}${v.toFixed(digits)}°`;
}
export function clock(t: number, tenths = true) {
  const mm = Math.floor(t / 60), ss = t - mm * 60;
  return `${mm}:${tenths ? ss.toFixed(1).padStart(4, '0') : Math.floor(ss).toString().padStart(2, '0')}`;
}

/** Web-only URL switches, read once. Native gets the defaults. */
export function urlParams(): { screen: ScreenKey | null; detail: boolean; design: string | null } {
  if (Platform.OS === 'web' && typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search);
    const scr = q.get('screen');
    return {
      screen: scr === 'welcome' || scr === 'live' || scr === 'replay' || scr === 'data' ? scr : null,
      detail: q.get('detail') === '1',
      design: q.get('design'),
    };
  }
  return { screen: null, detail: false, design: null };
}

/** A 0..1 history ring for effort, kept per design instance. */
export class History {
  values: number[] = [];
  constructor(public cap = 120) {}
  push(v: number) { if (v >= 0) { this.values.push(v); if (this.values.length > this.cap) this.values.shift(); } }
}

/** effort samples of a take, n of them */
export function effortTrace(frames: { emg: number }[], n = 64) {
  const step = Math.max(1, Math.floor(frames.length / n));
  return frames.filter((_, i) => i % step === 0).map((f) => Math.max(0, f.emg));
}
/** mean flexion samples of a take, n of them, 0..1 */
export function flexTrace(frames: Frame[], n = 64) {
  const step = Math.max(1, Math.floor(frames.length / n));
  return frames.filter((_, i) => i % step === 0).map((f) => stats(f).mean / 100);
}
