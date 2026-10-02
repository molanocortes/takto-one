// bake-web-glb.mjs - the website's copy of the hand model, prepared offline.
//
//   node software/web/tools/bake-web-glb.mjs                 (defaults below)
//   node software/web/tools/bake-web-glb.mjs in.glb out.glb
//   npx gltfpack@1.3.0 -i out.glb -o software/web/assets/zero_hand.web.glb \
//       -cc -kn -km -ke -vpf -vp 16 -vn 12
//
// twin.js used to run three's toCreasedNormals over all ~200k triangles on
// every page view: non-indexed first (600k vertices), each corner hashed as a
// string. About 280 ms of main-thread work on an M2 and over a second on a
// phone, sliced across frames but still competing with the visitor's scroll.
// The result never changes, so it is computed here once, with the same code
// the runtime ran (toNonIndexed, then toCreasedNormals at 32 degrees), and
// mergeVertices re-indexes the corners that share a position and a normal.
// A marker node, takto_creased_32, tells twin.js the normals are baked.
//
// gltfpack then compresses it (EXT_meshopt_compression, decoded in twin.js by
// vendor/meshopt_decoder.module.js from the same meshoptimizer release):
//   -kn/-km/-ke  keep every named node, so the rig finds its joints by name
//   -vpf         float positions: no dequantization transforms are inserted
//                on the joint nodes, whose transforms twin.js drives directly
//   -vp 16 -vn 12  precision to spare for the glossy clearcoat reflections
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IN = resolve(process.argv[2] || join(WEB, "assets/zero_hand.glb"));
const OUT = resolve(process.argv[3] || join(tmpdir(), "zero_hand.creased.glb"));
const CREASE_DEG = 32;   // twin.js used THREE.MathUtils.degToRad(32)

const THREE = await import(pathToFileURL(join(WEB, "vendor/three.module.js")).href);
// the vendored addon imports the bare specifier "three" (an import map in the
// browser); point it at the same file for Node
const utilsSrc = readFileSync(join(WEB, "vendor/BufferGeometryUtils.js"), "utf8")
  .replace(/from\s+['"]three['"]/g, `from "${pathToFileURL(join(WEB, "vendor/three.module.js")).href}"`);
const tmp = mkdtempSync(join(tmpdir(), "bake-glb-"));
writeFileSync(join(tmp, "BufferGeometryUtils.mjs"), utilsSrc);
const { toCreasedNormals, mergeVertices } = await import(pathToFileURL(join(tmp, "BufferGeometryUtils.mjs")).href);

// ---- read the GLB ----
const src = readFileSync(IN);
if (src.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB: " + IN);
const jsonLen = src.readUInt32LE(12);
const json = JSON.parse(src.subarray(20, 20 + jsonLen).toString("utf8"));
const binLen = src.readUInt32LE(20 + jsonLen);
const bin = src.subarray(28 + jsonLen, 28 + jsonLen + binLen);
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const TYPES = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
function readAccessor(i) {
  const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
  const T = TYPES[a.componentType], n = a.count * COMPS[a.type];
  if (bv.byteStride && bv.byteStride !== COMPS[a.type] * T.BYTES_PER_ELEMENT) throw new Error("strided accessor " + i);
  const off = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
  return new T(bin.buffer.slice(off, off + n * T.BYTES_PER_ELEMENT));
}

// ---- bake, mesh by mesh ----
const chunks = [], accessors = [], bufferViews = [];
let binOffset = 0;
function push(array, target, type, componentType, extra = {}) {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const pad = (4 - (bytes.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.length, target });
  chunks.push(bytes, Buffer.alloc(pad));
  binOffset += bytes.length + pad;
  accessors.push({ bufferView: bufferViews.length - 1, componentType, count: array.length / COMPS[type], type, ...extra });
  return accessors.length - 1;
}
let vIn = 0, vOut = 0, tris = 0;
for (const mesh of json.meshes) {
  for (const prim of mesh.primitives) {
    if ((prim.mode ?? 4) !== 4) throw new Error("only triangle lists are expected");
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(readAccessor(prim.attributes.POSITION), 3));
    if (prim.indices !== undefined) g.setIndex(new THREE.BufferAttribute(readAccessor(prim.indices), 1));
    vIn += g.attributes.position.count;
    // exactly the runtime's pass, then share the corners that ended up equal
    const creased = toCreasedNormals(g.index ? g.toNonIndexed() : g, THREE.MathUtils.degToRad(CREASE_DEG));
    const out = mergeVertices(creased, Number(process.env.MERGE_TOL || 1e-4));
    const pos = out.attributes.position.array, nor = out.attributes.normal.array;
    const count = out.attributes.position.count;
    vOut += count; tris += out.index.count / 3;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
      if (pos[i + k] < min[k]) min[k] = pos[i + k];
      if (pos[i + k] > max[k]) max[k] = pos[i + k];
    }
    const idx = count < 65536 ? Uint16Array.from(out.index.array) : Uint32Array.from(out.index.array);
    prim.attributes = {
      POSITION: push(Float32Array.from(pos), 34962, "VEC3", 5126, { min, max }),
      NORMAL: push(Float32Array.from(nor), 34962, "VEC3", 5126),
    };
    prim.indices = push(idx, 34963, "SCALAR", idx instanceof Uint16Array ? 5123 : 5125);
  }
}
json.accessors = accessors;
json.bufferViews = bufferViews;
json.buffers = [{ byteLength: binOffset }];
// the marker twin.js looks for (a named node survives gltfpack -kn)
json.nodes.push({ name: `takto_creased_${CREASE_DEG}` });
json.scenes[json.scene || 0].nodes.push(json.nodes.length - 1);
json.asset.extras = { ...(json.asset.extras || {}), takto: { creasedNormalsDeg: CREASE_DEG } };

// ---- write the GLB ----
const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
const binBuf = Buffer.concat(chunks);
const total = 12 + 8 + jsonBuf.length + jsonPad.length + 8 + binBuf.length;
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length + jsonPad.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
writeFileSync(OUT, Buffer.concat([head, jh, jsonBuf, jsonPad, bh, binBuf]));
console.log(`baked ${json.meshes.length} meshes: ${tris} triangles, vertices ${vIn} -> ${vOut} ` +
  `(the runtime pass made ${tris * 3}); ${(total / 1048576).toFixed(2)} MB -> ${OUT}`);
