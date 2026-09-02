// tokens.ts - the app's design system, stated once as data.
//
// The visual language is the DEVICE'S OWN, scaled up. Two things are being
// carried over deliberately, and both have provenance outside this file:
//
//   1. The Rams watch face (firmware/takto_one/watch/face_rams.h) is a strict
//      grid, near-monochrome, with exactly one accent spent on state and
//      nothing decorative in motion. This app obeys the same three rules.
//   2. The white-studio look of the product stills and the film: a pure white
//      stage, a neutral shell reading 228-232 against it, finger links a half
//      step deeper so the lattice separates, dark joint pins peppered through
//      it for legibility, and a motor bank that is true black in every frame.
//      Those numbers live in Studio.tsx; the palette below is their 2D half.
//
// So: warm paper ground, a pure white stage the machine sits on, ink in three
// weights, and ONE accent - the oxide of the lit beat in the TAKTO mark
// (assets/takto_mark.svg). Numerals are monospaced everywhere, without
// exception, because this is an instrument and columns of numbers must align.
import { Platform } from 'react-native';

export const C = {
  /** warm paper: the app ground, never the stage */
  paper: '#EFEDE7',
  paperSunk: '#E7E4DC',
  /** the product stage. Pure white, matching the stills' page. */
  stage: '#FFFFFF',
  card: '#FFFFFF',
  ink: '#171614',
  ink2: '#6B675E',
  ink3: '#A19C90',
  line: 'rgba(23,22,20,0.10)',
  lineSoft: 'rgba(23,22,20,0.055)',
  /** the mark's lit beat. The only accent, spent on state, never on chrome. */
  accent: '#C9401B',
  accentSunk: 'rgba(201,64,27,0.10)',
  accentLine: 'rgba(201,64,27,0.30)',
  /** e-stop and hard faults only */
  stop: '#8E1F12',
} as const;

export const F = {
  ui: Platform.select({
    web: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
    ios: 'System',
    default: 'sans-serif',
  }) as string,
  mono: Platform.select({
    web: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    ios: 'Menlo',
    default: 'monospace',
  }) as string,
};

/** 4pt base unit, the Rams face's own spacing scale. */
export const S = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32, s7: 48 } as const;
export const R = { r1: 10, r2: 16, r3: 22, pill: 999 } as const;

/** Paper casts a shadow, it does not glow. */
export const SHADOW = Platform.select({
  web: { boxShadow: '0 1px 2px rgba(23,22,20,0.04), 0 10px 30px rgba(23,22,20,0.07)' } as any,
  default: {
    shadowColor: '#171614',
    shadowOpacity: 0.10,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  } as any,
});

/** The four instrumented long fingers, in the order the device wires them. */
export const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
export type Finger = (typeof FINGERS)[number];
export const FINGER_LABEL: Record<Finger, string> = {
  index: 'INDEX', middle: 'MIDDLE', ring: 'RING', pinky: 'PINKY',
};
