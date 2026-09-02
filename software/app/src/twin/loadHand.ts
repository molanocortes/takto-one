// loadHand.ts - one parse of the device's CAD, shared by every surface.
//
// assets/model/zero_hand_full.glb is the repository's own full export of the
// V7 CAD (607k triangles, names and transforms untouched); zero_hand.glb is
// the web-decimated one (143k) kept for low-memory devices. The full export
// ships without normals, so they are computed here after welding vertices:
// smooth shading across the shell, which is what the product renders do. The
// articulated node names it carries ARE the mechanism, so the rig in Hand.tsx
// binds to them by name and nothing here invents geometry.
import { Asset } from 'expo-asset';
import { Platform } from 'react-native';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** which export to load; the full one unless a device says otherwise */
export const MODEL: 'full' | 'lite' = 'full';

let cached: Promise<GLTF> | null = null;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = globalThis.atob
    ? globalThis.atob(b64)
    // React Native has no atob in every runtime; Buffer is always present
    : (globalThis as any).Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function readBuffer(uri: string): Promise<ArrayBuffer> {
  // In dev the asset is served over http on every platform, and in a release
  // build it is a file:// path that fetch may refuse; fall back to reading it
  // as base64 through expo-file-system, which works in both cases.
  try {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(String(res.status));
    return await res.arrayBuffer();
  } catch (e) {
    if (Platform.OS === 'web') throw e;
    const FS: any = await import('expo-file-system/legacy').catch(() => import('expo-file-system'));
    const b64 = await FS.readAsStringAsync(uri, { encoding: 'base64' });
    return base64ToArrayBuffer(b64);
  }
}

export function loadHand(): Promise<GLTF> {
  if (cached) return cached;
  cached = (async () => {
    const asset = Asset.fromModule(MODEL === 'full'
      ? require('../../assets/model/zero_hand_full.glb')
      : require('../../assets/model/zero_hand.glb'));
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    const buf = await readBuffer(uri);
    const loader = new GLTFLoader();
    const gltf = await new Promise<GLTF>((resolve, reject) =>
      loader.parse(buf, '', resolve, reject));
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let g = mesh.geometry as THREE.BufferGeometry;
      if (!g.attributes.normal) {
        // weld coincident vertices so the normals average across faces
        g = mergeVertices(g, 1e-5);
        g.computeVertexNormals();
        mesh.geometry = g;
      }
    });
    return gltf;
  })();
  return cached;
}
