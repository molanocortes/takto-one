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

/**
 * Rendering looks, for exploring how the machine should read on black.
 * Each is a complete material set; the lighting rig is shared and each look
 * carries the exposure it wants.
 */
export type Look = 'studio' | 'graphite' | 'clay' | 'ceramic' | 'ink' | 'xray';
export const LOOKS: Look[] = ['studio', 'graphite', 'clay', 'ceramic', 'ink', 'xray'];

const basic = (color: string, opacity: number) =>
  new THREE.MeshBasicMaterial({
    color: new THREE.Color(color), transparent: true, opacity, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });

export function makeLookMaterials(look: Look): Materials {
  switch (look) {
    case 'studio': return makeGraphiteMaterials();
    case 'graphite': return {
      shell: phys('#2B2C30', 0.5, 0.05, 0.35, 0.3),
      link: phys('#3A3B40', 0.5, 0.08, 0.25, 0.3),
      pin: phys('#9A9CA2', 0.35, 0.6),
      bank: phys('#050505', 0.45, 0.05, 0.3, 0.3),
      board: phys('#1E1E21', 0.5, 0.1),
      glass: Object.assign(phys('#0B0B0D', 0.1, 0.2, 1, 0.03), { emissive: new THREE.Color('#FF5B2E'), emissiveIntensity: 0.9 }),
      spool: phys('#D9D9D9', 0.6, 0, 0.1, 0.5),
    } as Materials;
    case 'clay': {
      // one tone, no black, no gloss: the form and nothing else
      const c = (k: string) => phys(k, 0.9, 0, 0, 1);
      return {
        shell: c('#C9C6C0'), link: c('#BDBAB4'), pin: c('#8F8C86'), bank: c('#A8A5A0'),
        board: c('#A8A5A0'), glass: Object.assign(c('#B5B2AC'), { emissive: new THREE.Color('#000000'), emissiveIntensity: 0 }),
        spool: c('#D2CFC9'),
      } as Materials;
    }
    case 'ceramic': return {
      // glazed white: strong clearcoat, the room mirrored in every curve
      shell: phys('#E8E8E8', 0.25, 0, 1, 0.08),
      link: phys('#D6D6D8', 0.3, 0, 1, 0.1),
      pin: phys('#3A3B40', 0.3, 0.9),
      bank: phys('#0A0A0A', 0.3, 0.1, 1, 0.1),
      board: phys('#232326', 0.5, 0.1),
      glass: Object.assign(phys('#0E1A2E', 0.05, 0.2, 1, 0.02), { emissive: new THREE.Color('#1E66E0'), emissiveIntensity: 0.8 }),
      spool: phys('#EDEDED', 0.3, 0, 1, 0.1),
    } as Materials;
    case 'ink': return {
      // the inverse: black satin device, white spools, the accent screen
      shell: phys('#141416', 0.55, 0.05, 0.3, 0.4),
      link: phys('#1E1F22', 0.55, 0.05, 0.2, 0.4),
      pin: phys('#C8CACF', 0.35, 0.7),
      bank: phys('#0A0A0A', 0.5, 0.05, 0.2, 0.4),
      board: phys('#2A2A2E', 0.5, 0.1),
      glass: Object.assign(phys('#0B0B0D', 0.1, 0.2, 1, 0.03), { emissive: new THREE.Color('#FF5B2E'), emissiveIntensity: 1.1 }),
      spool: phys('#E6E6E6', 0.6, 0, 0.15, 0.5),
    } as Materials;
    case 'xray': return {
      // additive glass: the mechanism seen through itself
      shell: basic('#4F8DFF', 0.10), link: basic('#7FB0FF', 0.16), pin: basic('#FFFFFF', 0.35),
      bank: basic('#2A5BD6', 0.18), board: basic('#9CC4FF', 0.25),
      glass: Object.assign(std('#BFDBFF', 0.2), { emissive: new THREE.Color('#8FC0FF'), emissiveIntensity: 1.2, transparent: true, opacity: 0.85 }),
      spool: basic('#CFE2FF', 0.3),
    } as unknown as Materials;
  }
}
