// materials.ts - the white studio, in numbers.
//
// These values are not taste; they are the measured recipe behind the
// project's FINAL product stills, carried over so the app's twin and the
// photography read as the same object:
//
//   page   pure white, 255
//   shell  neutral white reading 228-232 on the page, R-B spread under 2
//          (the shell is never cream - warmth in earlier renders was a defect)
//   links  a half step deeper than the shell, so the finger lattice separates
//          from the page instead of dissolving into it
//   pins   dark steel, 0.36-0.43. Those dark pins peppered through the lattice
//          are what make the fingers legible white on white
//   bank   true black, in every colourway, always. It anchors the frame.
//
// One casting light, soft, high and to the left. More than one casting light
// smears the ground with overlapping shadows and no key position recovers it.
import * as THREE from 'three';

export const STUDIO = {
  page: '#FFFFFF',
  shell: '#E6E6E6',      // 230, neutral
  link: '#D2D2D2',       // the half step
  pin: '#67676A',        // dark steel
  bank: '#0A0A0A',       // true black
  board: '#37363A',      // the encoder boards
  glass: '#151517',
  /** key light, degrees: azimuth measured from +Z toward +X */
  keyAzimuth: 295,
  keyElevation: 54,
} as const;

const std = (color: string, roughness: number, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness });

export function makeMaterials() {
  return {
    // matte: coat at zero. What reads as beautiful here is tonal restraint,
    // not shine.
    shell: std(STUDIO.shell, 0.68),
    link: std(STUDIO.link, 0.62),
    pin: std(STUDIO.pin, 0.38, 0.55),
    bank: std(STUDIO.bank, 0.52),
    board: std(STUDIO.board, 0.55),
    // the round display: dark glass that lights from within
    glass: Object.assign(std(STUDIO.glass, 0.22, 0.1), {
      emissive: new THREE.Color('#1E5FA8'),
      emissiveIntensity: 0.2,
    }),
  };
}

/**
 * The studio colourway for the dark stage: the WHITE device from the product
 * stills, photographed on black. A satin shell under a thin clearcoat, so
 * it picks up the room as a soft sheen; links a half step deeper so the
 * lattice separates; dark steel pins; the bank true black; the screen
 * glowing blue from within, as on the hero still.
 */
export const STUDIO_DARK = {
  shell: '#D4D4D4',
  link: '#BDBDBF',
  pin: '#4A4B50',
  bank: '#0A0A0A',
  board: '#232326',
  spool: '#D6D6D6',
  glass: '#0E1A2E',
} as const;

const phys = (color: string, roughness: number, metalness = 0, clearcoat = 0, clearcoatRoughness = 0.2) =>
  new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color), roughness, metalness, clearcoat, clearcoatRoughness,
    envMapIntensity: 1,
  });

export function makeGraphiteMaterials(): Materials {
  return {
    shell: phys(STUDIO_DARK.shell, 0.62, 0.0, 0.18, 0.5),
    link: phys(STUDIO_DARK.link, 0.62, 0.0, 0.12, 0.5),
    pin: phys(STUDIO_DARK.pin, 0.3, 0.8, 0.0),
    bank: phys(STUDIO_DARK.bank, 0.5, 0.05, 0.25, 0.4),
    board: phys(STUDIO_DARK.board, 0.5, 0.1),
    glass: Object.assign(phys(STUDIO_DARK.glass, 0.08, 0.2, 1.0, 0.03), {
      emissive: new THREE.Color('#1E66E0'),
      emissiveIntensity: 0.75,
    }),
    spool: phys(STUDIO_DARK.spool, 0.65, 0.0, 0.1, 0.5),
  } as Materials;
}

export type Materials = ReturnType<typeof makeMaterials> & { spool?: THREE.MeshStandardMaterial };

/** Which material a GLB node wears, decided by the node's own name. */
export function materialFor(name: string, m: Materials) {
  // The spool discs are light, riding a black rail: in the product stills the
  // white spools against the black bank are the device's most recognisable
  // detail, so they must not be lumped in with the bank.
  if (name.startsWith('spool_')) return m.spool ?? m.shell;
  if (name === 'motors') return m.bank;
  if (name === 'screen') return m.glass;
  if (name.endsWith('_enc')) return m.board;
  if (name === 'internals') return m.bank;
  if (name === 'forearm' || name === 'forearm_cover' || name === 'palm') return m.shell;
  return m.link;   // every finger member
}

/** Key light position on a unit sphere, from the studio's own angles. */
export function keyDirection(radius: number) {
  const az = (STUDIO.keyAzimuth * Math.PI) / 180;
  const el = (STUDIO.keyElevation * Math.PI) / 180;
  return new THREE.Vector3(
    radius * Math.cos(el) * Math.sin(az),
    radius * Math.sin(el),
    radius * Math.cos(el) * Math.cos(az),
  );
}
