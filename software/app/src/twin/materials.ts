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

const satin = (color: string, roughness: number, metalness = 0, clearcoat = 0) =>
  new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color), roughness, metalness, clearcoat, clearcoatRoughness: 0.3,
  });

export type MaterialSet = {
  shell: THREE.MeshPhysicalMaterial; link: THREE.MeshPhysicalMaterial; pin: THREE.MeshPhysicalMaterial;
  bank: THREE.MeshPhysicalMaterial; board: THREE.MeshPhysicalMaterial; glass: THREE.MeshPhysicalMaterial;
};

export function makeMaterials(): MaterialSet {
  return {
    // satin under a thin clearcoat: the soft ridge highlight of a photographed
    // product, not a flat matte swatch.
    shell: satin(STUDIO.shell, 0.46, 0, 0.55),
    link: satin(STUDIO.link, 0.42, 0, 0.4),
    pin: satin(STUDIO.pin, 0.32, 0.55, 0.2),
    bank: satin(STUDIO.bank, 0.4, 0, 0.35),
    board: satin(STUDIO.board, 0.45, 0, 0.2),
    // the round display: dark glass that lights from within
    glass: Object.assign(satin(STUDIO.glass, 0.15, 0.1, 0.8), {
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

export type Materials = MaterialSet & { spool?: THREE.MeshStandardMaterial };

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
export type Look =
  | 'studio' | 'graphite' | 'clay' | 'ceramic' | 'ink' | 'xray'
  | 'bone' | 'terracotta' | 'sage' | 'slate' | 'midnight' | 'oxide'
  | 'xray-amber' | 'xray-white' | 'xray-solid' | 'frost' | 'blueprint' | 'chalk'
  | 'cobalt' | 'plum' | 'forest' | 'copper' | 'sand' | 'coral' | 'teal' | 'lilac' | 'olive' | 'charcoal' | 'ivory' | 'rose';
export const LOOKS: Look[] = [
  'studio', 'graphite', 'clay', 'ceramic', 'ink', 'xray',
  'bone', 'terracotta', 'sage', 'slate', 'midnight', 'oxide',
  'xray-amber', 'xray-white', 'xray-solid', 'frost', 'blueprint', 'chalk',
  'cobalt', 'plum', 'forest', 'copper', 'sand', 'coral', 'teal', 'lilac', 'olive', 'charcoal', 'ivory', 'rose',
];

/** one matte tone for the whole device, an optional second for the spools and the pins */
function matte(body: string, spools = body, pins = body, screen = body, glow?: string): Materials {
  const m = (k: string) => phys(k, 0.92, 0, 0, 1);
  return {
    shell: m(body), link: m(shade(body, 0.03)), pin: m(pins), bank: m(shade(body, -0.16)),
    board: m(shade(body, -0.16)),
    glass: Object.assign(m(screen), { emissive: new THREE.Color(glow ?? '#000000'), emissiveIntensity: glow ? 0.5 : 0 }),
    spool: m(spools),
  } as Materials;
}
/** lighten (+) or darken (-) a hex colour by a fraction */
function shade(hex: string, f: number) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 }; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + f)));
  return '#' + c.getHexString();
}
/** additive glass in one tint, the pins and spools brighter so the joints read */
function xray(tint: string, bright: string, solidSpools = false): Materials {
  return {
    shell: basic(tint, 0.10), link: basic(shade(tint, 0.15), 0.16), pin: basic(bright, 0.35),
    bank: basic(shade(tint, -0.15), 0.18), board: basic(shade(tint, 0.2), 0.25),
    glass: Object.assign(std(bright, 0.2), { emissive: new THREE.Color(bright), emissiveIntensity: 1.2, transparent: true, opacity: 0.85 }),
    spool: solidSpools ? phys('#E6E6E6', 0.6, 0, 0.15, 0.5) : basic(shade(tint, 0.3), 0.3),
  } as unknown as Materials;
}

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
    case 'bone': return matte('#E3DED2', '#EFEBE1', '#5A5650', '#1C1B19', '#1E66E0');
    case 'terracotta': return matte('#B8654A', '#E9D9C7', '#3D2A22', '#2A1F1B', '#FF8A5B');
    case 'sage': return matte('#8FA08C', '#E6EAE0', '#3C463A', '#1E231E', '#CFE8C8');
    case 'slate': return matte('#4B5560', '#C9CED4', '#1E2328', '#14171A', '#7FB0FF');
    case 'midnight': return matte('#2A3450', '#9AA8C4', '#111624', '#0A0D14', '#4F8DFF');
    case 'oxide': return matte('#C9401B', '#F1E9E0', '#2A1F1B', '#1A1210', '#FFB199');
    case 'chalk': return matte('#F2F1EC', '#F7F6F2', '#3A3936', '#1E1E1C', '#1E66E0');
    case 'cobalt': return matte('#2F4FBF', '#C9D4F5', '#111A3A', '#0A0F22', '#8FB3FF');
    case 'plum': return matte('#4A2B4F', '#D8C6DB', '#1E1020', '#150B17', '#C88FD1');
    case 'forest': return matte('#2E4A3A', '#C7D6CB', '#12201A', '#0B1510', '#8FD1A8');
    case 'copper': return matte('#9A5A3A', '#EAD6C8', '#3A2218', '#241510', '#FFB088');
    case 'sand': return matte('#D3C2A6', '#EFE7D8', '#4A4034', '#2A241C', '#FFD9A6');
    case 'coral': return matte('#E5715F', '#F6DAD3', '#4A2420', '#2A1512', '#FFB0A3');
    case 'teal': return matte('#2E7C86', '#C9E4E7', '#10343A', '#0A2226', '#8FE0EA');
    case 'lilac': return matte('#9A8FC4', '#E4E0F2', '#3A3452', '#221E32', '#D3C9FF');
    case 'olive': return matte('#7A7A4E', '#E1E1CC', '#33331E', '#1F1F12', '#D6D68F');
    case 'charcoal': return matte('#3A3B3E', '#C6C7CA', '#141516', '#0C0C0D', '#7FB0FF');
    case 'ivory': return matte('#F0E9D8', '#F8F4EA', '#4A4538', '#2A2720', '#1E66E0');
    case 'rose': return matte('#C97A8C', '#F3DCE2', '#4A2A32', '#2A171C', '#FFB7C6');
    case 'frost': return {
      // milk glass: the shell lets a little light through, the bank stays dark
      shell: Object.assign(phys('#F4F4F4', 0.35, 0, 0.6, 0.3), { transparent: true, opacity: 0.72 }),
      link: Object.assign(phys('#E4E4E6', 0.4, 0, 0.4, 0.4), { transparent: true, opacity: 0.8 }),
      pin: phys('#3A3B40', 0.3, 0.9), bank: phys('#0A0A0A', 0.45, 0.05, 0.3, 0.3),
      board: phys('#232326', 0.5, 0.1),
      glass: Object.assign(phys('#0E1A2E', 0.05, 0.2, 1, 0.02), { emissive: new THREE.Color('#1E66E0'), emissiveIntensity: 0.8 }),
      spool: phys('#EDEDED', 0.5, 0, 0.3, 0.4),
    } as Materials;
    case 'blueprint': return xray('#2456C8', '#DCE8FF', false);
    case 'xray-amber': return xray('#C86A1E', '#FFE2B8', false);
    case 'xray-white': return xray('#9A9A9A', '#FFFFFF', false);
    case 'xray-solid': return xray('#4F8DFF', '#FFFFFF', true);
    case 'xray': return {
      // additive glass: the mechanism seen through itself
      shell: basic('#4F8DFF', 0.10), link: basic('#7FB0FF', 0.16), pin: basic('#FFFFFF', 0.35),
      bank: basic('#2A5BD6', 0.18), board: basic('#9CC4FF', 0.25),
      glass: Object.assign(std('#BFDBFF', 0.2), { emissive: new THREE.Color('#8FC0FF'), emissiveIntensity: 1.2, transparent: true, opacity: 0.85 }),
      spool: basic('#CFE2FF', 0.3),
    } as unknown as Materials;
  }
}
