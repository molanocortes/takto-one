// loadHand.ts - one parse of the device's CAD, shared by every surface.
//
// assets/model/zero_hand.glb is the repository's own web-decimated export of
// the V7 CAD (614k -> 154k triangles, names and transforms untouched). The
// articulated node names it carries ARE the mechanism, so the rig in Hand.tsx
// binds to them by name and nothing here invents geometry.
import { Asset } from 'expo-asset';
import { Platform } from 'react-native';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
    const asset = Asset.fromModule(require('../../assets/model/zero_hand.glb'));
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    const buf = await readBuffer(uri);
    const loader = new GLTFLoader();
    return await new Promise<GLTF>((resolve, reject) =>
      loader.parse(buf, '', resolve, reject));
  })();
  return cached;
}
