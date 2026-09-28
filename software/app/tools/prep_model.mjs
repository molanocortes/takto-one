// prep_model.mjs - weld the full CAD export and bake smooth normals into it,
// once, here, so no phone has to do it at startup. The result replaces
// assets/model/zero_hand_full.glb; names and transforms are untouched.
//
//   node tools/prep_model.mjs [in.glb] [out.glb]
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// GLTFExporter reads its own binary output back through FileReader, which
// Node does not have; this is the four lines of it the exporter uses.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((r) => { this.result = r; this.onloadend?.(); }); }
    readAsDataURL(blob) { blob.arrayBuffer().then((r) => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(r).toString('base64'); this.onloadend?.(); }); }
  };
}

const inFile = process.argv[2] ?? 'assets/model/zero_hand_full.glb';
const outFile = process.argv[3] ?? inFile;
const buf = fs.readFileSync(inFile);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));

let before = 0, after = 0, welded = 0;
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  let g = o.geometry;
  before += g.attributes.position.count;
  if (!g.attributes.normal) {
    g = mergeVertices(g, 1e-5);   // the same tolerance the app used at runtime
    g.computeVertexNormals();
    o.geometry = g;
    welded++;
  }
  after += o.geometry.attributes.position.count;
});

const out = await new Promise((res, rej) => new GLTFExporter().parse(gltf.scene, res, rej, { binary: true, onlyVisible: false }));
fs.writeFileSync(outFile, Buffer.from(out));

// prove the file round-trips: every node the rig binds to must still be there
const check = await new Promise((res, rej) => new GLTFLoader().parse(out, '', res, rej));
const names = new Set(); check.scene.traverse((o) => names.add(o.name));
const need = ['forearm', 'palm', 'screen', 'motors', 'index_mcp', 'index_pip', 'index_dip', 'index_mcp_slide', 'index_pip_mid', 'index_pip_slide', 'index_dip_slide', 'pinky_dip_slide'];
const missing = need.filter((n) => !names.has(n));
let noNormal = 0; check.scene.traverse((o) => { if (o.isMesh && !o.geometry.attributes.normal) noNormal++; });
console.log(JSON.stringify({ inFile, outFile, welded, vertsBefore: before, vertsAfter: after, bytes: out.byteLength, nodes: names.size, missing, noNormal }));
if (missing.length || noNormal) process.exit(1);
