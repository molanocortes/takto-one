// 31-rams tokens - a Braun instrument panel, in numbers.
//
// Warm grey enamel, printed near-black type, one green LED for "on", one
// red-orange for the needle and the record dot. Nothing is translucent:
// every surface is a material with a top and a side.
import { Platform } from 'react-native';

export const C = {
  panel: '#D9D6CF',        // the enamel
  panelDeep: '#CBC8C1',    // the recess behind the window
  panelEdge: '#B9B6AE',    // the shadow line under a key
  window: '#C8C5BE',       // the tuning window's ground
  key: '#ECEAE5',          // a light key face
  keyDark: '#2B2B2C',      // the power key
  keyDarkEdge: '#111111',
  ink: '#1C1C1B',
  ink2: '#5E5C58',
  ink3: '#8F8C86',
  rule: '#B4B1AA',
  ruleSoft: '#C6C3BC',
  green: '#2E8B57',
  greenGlow: 'rgba(46,139,87,0.45)',
  red: '#E14A26',
  redSoft: 'rgba(225,74,38,0.18)',
  amber: '#D9A21B',
  white: '#F7F6F3',
} as const;

export const F = {
  ui: 'Archivo_400Regular',
  medium: 'Archivo_500Medium',
  semi: 'Archivo_600SemiBold',
  narrow: 'Archivo_400Regular',
};

/** the extrusion under a key: a hard 2px side and a soft fall */
export const KEY_UP = Platform.select({
  web: { boxShadow: `0 2px 0 ${C.panelEdge}, 0 4px 8px rgba(30,30,30,0.16), inset 0 1px 0 rgba(255,255,255,0.85)` } as any,
  default: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3 } as any,
});
export const KEY_DOWN = Platform.select({
  web: { boxShadow: `0 0 0 ${C.panelEdge}, inset 0 2px 3px rgba(0,0,0,0.18)` } as any,
  default: { shadowOpacity: 0 } as any,
});
export const KEY_DARK_UP = Platform.select({
  web: { boxShadow: `0 2px 0 ${C.keyDarkEdge}, 0 5px 10px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.14)` } as any,
  default: { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 4 } as any,
});
/** the window is cut into the panel: shade on its top edge */
export const RECESS = Platform.select({
  web: { boxShadow: 'inset 0 3px 8px rgba(0,0,0,0.22), inset 0 -1px 0 rgba(255,255,255,0.6)' } as any,
  default: {} as any,
});
