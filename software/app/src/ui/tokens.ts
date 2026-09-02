// tokens.ts - the app's design system, stated once as data.
//
// The companion is a dark, cinematic instrument: the machine sits in a lit
// studio that fades to black, and everything you read sits on frosted glass
// over that stage. Type is Inter, set tight at display sizes and tabular for
// every numeral. There is ONE accent, the oxide of the lit beat in the TAKTO
// mark, and it is spent on state and primary action only: a live channel, a
// value at its limit, the one button that starts something.
import { Platform } from 'react-native';

export const C = {
  /** the ground under everything: near-black, a hair warm */
  bg: '#0A0A0B',
  bg2: '#121214',
  /** the studio the machine stands in: lit at the top, dark at the feet */
  stageTop: '#232428',
  stageMid: '#111214',
  stageBot: '#0A0A0B',
  /** frosted glass, the only surface text sits on */
  glass: 'rgba(255,255,255,0.07)',
  glassStrong: 'rgba(255,255,255,0.11)',
  glassLine: 'rgba(255,255,255,0.12)',
  glassLineStrong: 'rgba(255,255,255,0.22)',
  /** the sheet: near-black glass */
  sheet: 'rgba(12,12,13,0.62)',
  /** a solid card for when glass is not over anything */
  card: '#161719',
  cardRaised: '#1D1E21',
  /** paper white for the primary control and the inverted pill */
  white: '#F5F5F3',
  ink: '#0E0E10',
  /** text */
  t1: '#F3F3F1',
  t2: 'rgba(243,243,241,0.62)',
  t3: 'rgba(243,243,241,0.36)',
  t4: 'rgba(243,243,241,0.20)',
  /** the accent: the mark's lit beat, brightened one step for a dark ground */
  accent: '#FF5B2E',
  accentDeep: '#C9401B',
  accentGlow: 'rgba(255,91,46,0.28)',
  accentSoft: 'rgba(255,91,46,0.14)',
  /** live link */
  live: '#4ADE80',
  liveSoft: 'rgba(74,222,128,0.16)',
  /** faults only */
  stop: '#FF3B30',
} as const;

/** Inter, loaded by expo-font under these names on every platform. */
export const F = {
  light: 'Inter_300Light',
  ui: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semi: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
};

/** Resolve a weight to the font family that carries it on native. */
export function fontFor(weight: string | number | undefined): string {
  const w = Number(weight ?? 400);
  if (w >= 700) return F.bold;
  if (w >= 600) return F.semi;
  if (w >= 500) return F.medium;
  if (w <= 300) return F.light;
  return F.ui;
}

/** 4pt base unit. */
export const S = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 20, s6: 24, s7: 32, s8: 48 } as const;
export const R = { r1: 12, r2: 18, r3: 24, r4: 32, pill: 999 } as const;

export const SHADOW = Platform.select({
  web: { boxShadow: '0 20px 60px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.35)' } as any,
  default: {
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 30,
    shadowOffset: { width: 0, height: 16 }, elevation: 12,
  } as any,
});

/** The lift under a piece of liquid glass: soft, wide, never a hard drop. */
export const LIFT = Platform.select({
  web: { boxShadow: '0 12px 32px rgba(0,0,0,0.38), 0 1px 2px rgba(0,0,0,0.3)' } as any,
  default: {
    shadowColor: '#000', shadowOpacity: 0.38, shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 }, elevation: 8,
  } as any,
});

export const GLOW = Platform.select({
  web: { boxShadow: '0 0 0 1px rgba(255,91,46,0.35), 0 10px 40px rgba(255,91,46,0.30)' } as any,
  default: {
    shadowColor: C.accent, shadowOpacity: 0.55, shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 }, elevation: 10,
  } as any,
});

/** The four instrumented long fingers, in the order the device wires them. */
export const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
export type Finger = (typeof FINGERS)[number];
export const FINGER_LABEL: Record<Finger, string> = {
  index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky',
};
export const FINGER_SHORT: Record<Finger, string> = {
  index: 'IND', middle: 'MID', ring: 'RNG', pinky: 'PNK',
};
