// objects.js - loads the six premium glTF meshes and re-skins them to the
// palette. The assets are authored in named parts and each part gets its
// proper voice: *_core / *_glow / *_mark parts become emitted aqua light,
// *_bezel / *_collar parts become brushed titanium, and the body becomes
// obsidian glass with a fresnel rim so it reads as a hologram over reality.

import * as THREE from "../../vendor/three.module.js";
import { GLTFLoader } from "../../vendor/GLTFLoader.js";
import { luminousGlass, boneStone, titanium, fresnelShell } from "./materials.js";
import { AQUA, AQUA_DEEP, OBSIDIAN } from "../design/palette.js";

// one shared loader + cache of raw scenes
const _loader = new GLTFLoader();
const _cache = new Map();

function loadRaw(name) {
  if (_cache.has(name)) return _cache.get(name);
  const p = new Promise((resolve, reject) => {
    _loader.load(`./assets/${name}.glb`, (g) => resolve(g.scene), undefined, reject);
  });
  _cache.set(name, p);
  return p;
}

function cloneMeshes(scene) {
  const root = scene.clone(true);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  return { root, meshes };
}

// normalize: center on origin, scale so the largest dimension = size.
// mode "base": sit on y=0. mode "center": centered.
function normalize(root, size, mode = "center") {
  const box = new THREE.Box3().setFromObject(root);
  const dim = new THREE.Vector3();
  box.getSize(dim);
  const s = size / Math.max(dim.x, dim.y, dim.z, 1e-6);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const wrap = new THREE.Group();
  root.position.sub(center).multiplyScalar(s);
  root.scale.setScalar(s);
  if (mode === "base") root.position.y += (dim.y * s) / 2;
  wrap.add(root);
  return wrap;
}

// obsidian glass body: near-black, light lives inside it
export function glassSkin(opts = {}) {
  return luminousGlass({
    color: opts.color ?? OBSIDIAN,
    emissive: opts.emissive ?? AQUA,
    emissiveIntensity: opts.emissiveIntensity ?? 0.06,
    roughness: opts.roughness ?? 0.06,
    transmission: opts.transmission ?? 0.55,
    thickness: opts.thickness ?? 0.04,
  });
}

// emitted-light accent: additive light carried inside the glass. depthTest is
// off so the light reads through the body (the hologram trick, not physics).
export function accentSkin(color = AQUA, opacity = 0.5) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  });
}

const ACCENT_RE = /(core|glow|mark)$/i;
const BEZEL_RE = /(bezel|collar|rim|frame)$/i;

/**
 * Load one named asset re-skinned.
 * skin: "glass" (per-part treatment) | "bone" | "titanium" | material instance
 * Returns { group, meshes, body, accents, bezels, shells }.
 */
export async function loadObject(name, {
  size = 0.1, sit = "center", skin = "glass",
  emissive = AQUA, emissiveIntensity = 0.06,
  accentColor = AQUA, accentOpacity = 0.5,
  rim = true,
} = {}) {
  const scene = await loadRaw(name);
  const { root, meshes } = cloneMeshes(scene);

  let body = null;
  const accents = [], bezels = [], shells = [];

  if (skin === "glass") {
    body = glassSkin({ emissive, emissiveIntensity });
    for (const m of meshes) {
      if (ACCENT_RE.test(m.name)) {
        const a = accentSkin(accentColor, accentOpacity);
        m.material = a; m.renderOrder = 6;
        accents.push(a);
      } else if (BEZEL_RE.test(m.name)) {
        const b = titanium();
        m.material = b;
        bezels.push(b);
      } else {
        m.material = body;
        if (rim) {
          const { shell, mat } = fresnelShell(m);
          m.add(shell);
          shells.push(mat);
        }
      }
      m.castShadow = false; m.receiveShadow = false;
    }
  } else {
    let material;
    if (skin === "bone") material = boneStone();
    else if (skin === "titanium") material = titanium();
    else material = skin;
    body = material;
    for (const m of meshes) { m.material = material; m.castShadow = false; m.receiveShadow = false; }
  }

  const group = normalize(root, size, sit);
  return { group, meshes, body, accents, bezels, shells, materials: [body] };
}
