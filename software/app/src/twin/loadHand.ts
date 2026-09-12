// loadHand.ts - one parse of the device's CAD, shared by every surface.
//
// assets/model/zero_hand_full.glb is the repository's own full export of the
// V7 CAD (607k triangles, names and transforms untouched), with smooth normals
// baked in by tools/prep_model.mjs so no device computes them at startup;
// zero_hand.glb is the web-decimated one (143k). A phone gets the decimated
// export by default: at the size the twin is drawn it is indistinguishable,
// and it costs a quarter of the GPU time, which is what keeps the page smooth
// next to the traces. The articulated node names both carry ARE the
// mechanism, so the rig in Hand.tsx binds to them by name and nothing here
// invents geometry.
import { Asset } from 'expo-asset';
import { Platform } from 'react-native';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** which export to load: the full one on a desktop browser, the decimated one on a phone */
export const MODEL: 'full' | 'lite' = Platform.OS === 'web' ? 'full' : 'lite';

/** what the loader is doing, for the screen to say so instead of showing nothing */
export type TwinStatus = { state: 'idle' | 'loading' | 'ready' | 'error'; detail: string };
let status: TwinStatus = { state: 'idle', detail: '' };
const listeners = new Set<() => void>();
function setStatus(s: TwinStatus) { status = s; for (const l of listeners) l(); }
export const twinStatus = {
  get: () => status,
  set: setStatus,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
};

let cached: Promise<GLTF> | null = null;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function readBuffer(uri: string): Promise<ArrayBuffer> {
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${uri}`);
    return await res.arrayBuffer();
  }
  // On a phone the asset is a file:// path (expo-asset copies an embedded
  // Android resource into the cache first), and fetch refuses file://. The
  // file-system module reads it as bytes in native code; the base64 route is
  // the fallback for an older runtime.
  const errors: string[] = [];
  try {
    const FS: any = await import('expo-file-system');
    const buf: ArrayBuffer = await new FS.File(uri).arrayBuffer();
    if (buf && buf.byteLength > 0) return buf;
    errors.push('empty file');
  } catch (e: any) { errors.push(`fs: ${e?.message ?? e}`); }
  try {
    const FS: any = await import('expo-file-system/legacy');
    const b64 = await FS.readAsStringAsync(uri, { encoding: 'base64' });
    return base64ToArrayBuffer(b64);
  } catch (e: any) { errors.push(`legacy: ${e?.message ?? e}`); }
  try {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (e: any) { errors.push(`fetch: ${e?.message ?? e}`); }
  throw new Error(errors.join('; '));
}

export function loadHand(): Promise<GLTF> {
  if (cached) return cached;
  cached = (async () => {
    setStatus({ state: 'loading', detail: 'reading model' });
    const asset = Asset.fromModule(MODEL === 'full'
      ? require('../../assets/model/zero_hand_full.glb')
      : require('../../assets/model/zero_hand.glb'));
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    const buf = await readBuffer(uri);
    setStatus({ state: 'loading', detail: 'parsing model' });
    const loader = new GLTFLoader();
    const gltf = await new Promise<GLTF>((resolve, reject) =>
      loader.parse(buf, '', resolve, reject));
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let g = mesh.geometry as THREE.BufferGeometry;
      if (!g.attributes.normal) {
        // only an export that skipped prep_model.mjs lands here
        g = mergeVertices(g, 1e-5);
        g.computeVertexNormals();
        mesh.geometry = g;
      }
    });
    setStatus({ state: 'ready', detail: '' });
    return gltf;
  })();
  cached.catch((e: any) => {
    // let a later mount try again rather than caching the failure forever
    cached = null;
    setStatus({ state: 'error', detail: String(e?.message ?? e) });
  });
  return cached;
}
