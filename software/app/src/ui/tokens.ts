// tokens.ts - the app's design system, stated once as data.
//
// The instrument is a light one: a warm-grey page, ink in three weights,
// monospaced capitals for every label, one light-weight sans for the big
// numerals, and three signal colours that belong to the telemetry traces and
// nothing else. The machine is rendered white on the page, as in the stills.
export const C = {
  page: '#F2F2F2',
  tile: '#F7F7F7',
  tileActive: '#FAFAFA',
  tileLine: '#E6E6E6',
  line: '#E4E4E4',
  white: '#FFFFFF',
  ink: '#161616',
  ink2: '#6E6E6E',
  ink3: '#9A9A9A',
  green: '#3FA34D',
  greenSoft: '#E7F3E9',
  blue: '#3B82F6',
  orange: '#F59E0B',
  red: '#E5484D',
} as const;

/** Inter for words and numerals, JetBrains Mono for every label. */
export const F = {
  light: 'Inter_300Light',
  ui: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semi: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMed: 'JetBrainsMono_500Medium',
};

export function fontFor(weight: string | number | undefined): string {
  const w = Number(weight ?? 400);
  if (w >= 700) return F.bold;
  if (w >= 600) return F.semi;
  if (w >= 500) return F.medium;
  if (w <= 300) return F.light;
  return F.ui;
}

/** 4pt base unit. The page gutter is 26pt, measured from the reference. */
export const S = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 20, s6: 24, s7: 32, s8: 48, gutter: 26 } as const;
export const R = { r1: 8, r2: 10, r3: 14, pill: 999 } as const;

/** The four instrumented long fingers, in the order the device wires them. */
export const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
export type Finger = (typeof FINGERS)[number];
export const FINGER_LABEL: Record<Finger, string> = {
  index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky',
};
