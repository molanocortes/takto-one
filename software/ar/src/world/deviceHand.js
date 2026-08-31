// deviceHand.js - THE digital twin: the newest device CAD (V7), the very same
// articulated zero_hand.glb the web console's twin renders, with the same
// solved joint semantics ported one to one from the web twin driver:
//
//   GLB nodes: palm -> {index,middle,ring,pinky}_{mcp,pip,dip}
//   hinge 1 (*_mcp): MCP ABDUCTION - swings left/right (local Y)
//   hinge 2 (*_pip): MCP FLEXION   - curls (local X)
//   hinge 3 (*_dip): PIP FLEXION   - curls (local X)
//   (no DIP joint on the robot)
//
// Each hinge node's local axis IS the physical hinge, baked by
// Fable/web/tools/build_hand_glb_v7.py, so a joint is one local rotation:
// node.quaternion = baseQuat * rot(axis, angle). The forearm + spool bank
// exist in the GLB but are skipped here for the headset budget.

import * as THREE from "../../vendor/three.module.js";
import { GLTFLoader } from "../../vendor/GLTFLoader.js";
import { toCreasedNormals, mergeVertices, mergeGeometries } from "../../vendor/BufferGeometryUtils.js";
import { makeGlow, glowTexture } from "./materials.js";
import { clamp, Damped } from "../design/motion.js";
import { fingerPose, THUMB_POD_ANCHOR_MM } from "../kinematics.js";   // SHARED with the web twin (byte-identical)

export const FINGERS = ["index", "middle", "ring", "pinky"];
const D2R = Math.PI / 180;

// one GLB parse for the whole app (TWIN mode + the hub hero share it)
const HAND_ASSET_VERSION = 19;   // keep in step with web twin.js (busts HTTP cache on rebuilds)
let _glbPromise = null;
function loadHandGLB() {
  if (!_glbPromise) _glbPromise = new GLTFLoader().loadAsync(`./assets/zero_hand.glb?v=${HAND_ASSET_VERSION}`);
  return _glbPromise;
}
// glTF frame from the builder: y-up, fingers +Z, units mm.
// Real device scale is 0.001; the twin presents at ~1.8x real.
const MODEL_SCALE = 0.0018;

// creased-normal processing is deterministic per source mesh, and the clones
// of one shared GLB parse still point at the ORIGINAL parse geometries - so
// the hub hero and the TWIN rig (two DeviceHand instances) can share ONE
// processed copy per mesh instead of re-deriving and double-uploading ~30
// geometries each (2026-07-30 perf pass).
const _creasedCache = new Map();   // source geometry uuid -> processed geometry
const _foldCache = new Map();      // link node name -> link+encoder merged geometry

// the twelve axle pins are two shapes, not twelve: one per hinge axis. Each
// pin keeps its OWN material (the per-joint glow is a real channel), but the
// geometry is shared (2026-07-30 perf pass).
const _pinGeo = {};
function pinGeometry(axis) {
  if (!_pinGeo[axis]) {
    _pinGeo[axis] = new THREE.CylinderGeometry(2.4, 2.4, axis === "y" ? 14 : 17, 12);
  }
  return _pinGeo[axis];
}

export class DeviceHand {
  constructor(parent, { scale = 1 } = {}) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.group.scale.setScalar(scale);
    this.ready = false;

    // the hand frame the modes pose (palm orientation + position)
    this.handGroup = new THREE.Group();
    this.group.add(this.handGroup);

    this._fingers = {};
    this._damped = {};
    // taus dropped 0.07/0.06 -> 0.045/0.04 with the 60 Hz bridge (2026-07-18
    // latency pass): frames arrive every ~17 ms, so the damping no longer has
    // to bridge 33 ms gaps and the finger->twin lag falls by ~20 ms
    for (const f of FINGERS) {
      this._damped[`${f}_ab`] = new Damped(0, 0.045);
      this._damped[`${f}_mcp`] = new Damped(10, 0.04);
      this._damped[`${f}_pip`] = new Damped(10, 0.04);
    }
    this._qTmp = new THREE.Quaternion();
    this._xAxis = new THREE.Vector3(1, 0, 0);
    this._yAxis = new THREE.Vector3(0, 1, 0);

    // ---- materials: the web console's exact recipe (the look he approved) --
    this._matShell = new THREE.MeshPhysicalMaterial({
      color: 0x5a6874, metalness: 0.78, roughness: 0.42,
      clearcoat: 0.4, clearcoatRoughness: 0.45, envMapIntensity: 2.4,
      emissive: 0x1a2430, emissiveIntensity: 0.5,
    });
    this._matDark = new THREE.MeshPhysicalMaterial({
      color: 0x272f3a, metalness: 0.78, roughness: 0.44, envMapIntensity: 1.35,
    });

    loadHandGLB().then((gltf) => {
      // the GLB parse is shared app-wide; each rig articulates its own clone
      const model = gltf.scene.clone(true);

      // the hand only: palm + finger chains (forearm, cover, motors, the spool
      // bank and the internals stay unrendered on the headset budget)
      const palm = model.getObjectByName("palm");
      if (!palm) { console.warn("[twin] palm node missing in zero_hand.glb"); return; }

      // ---- geometry pass (2026-07-30 perf pass) ---------------------------
      // Scoped to the PALM SUBTREE. It used to run over the whole GLB, so the
      // forearm, cover, ten motors, twenty spool discs and the internals stack
      // were all creased and uploaded for a rig that never renders them.
      //
      // 1. creased smooth normals (the look he approved): smooth curved
      //    shading with crisp true edges, no facets under the gloss.
      // 2. RE-INDEX. The builder ships non-indexed geometry and creasing keeps
      //    it that way, so 390 k triangles were carrying 1.17 M vertices -
      //    three per triangle, nothing shared. mergeVertices welds vertices
      //    that agree in position AND normal, so a creased edge stays split
      //    and the shading is unchanged, while the vertex count falls ~80 %
      //    (measured per mesh: palm 240 k -> 60 k, each link ~42 k -> ~8 k).
      //    Triangle count is untouched; vertex bandwidth is the Quest limit.
      const CREASE = THREE.MathUtils.degToRad(32);
      const prep = (src) => {
        let g = _creasedCache.get(src.uuid);
        if (!g) {
          g = mergeVertices(
            toCreasedNormals(src.index ? src.toNonIndexed() : src.clone(), CREASE));
          _creasedCache.set(src.uuid, g);
        }
        return g;
      };
      palm.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry = prep(o.geometry);
        o.material = this._matShell;
        o.castShadow = false; o.receiveShadow = false;
      });

      // 3. fold each static encoder board into the link it rides. palm_enc and
      //    {f}_{mcp,pip}_slide_enc are decoration: no runtime binds them (the
      //    bindings name only *_mcp/_pip/_dip/_slide/_mid) and they never move
      //    relative to their parent, so nine draw calls disappear. Every other
      //    node articulates on its own and MUST stay a separate mesh.
      const encs = [];
      palm.traverse((o) => {
        if (o.isMesh && /_enc$/.test(o.name) && o.children.length === 0) encs.push(o);
      });
      for (const e of encs) {
        const link = e.parent;
        if (!link || !link.isMesh) continue;
        const key = link.name || link.uuid;
        let merged = _foldCache.get(key);
        if (!merged) {
          e.updateMatrix();
          merged = mergeGeometries(
            [link.geometry, e.geometry.clone().applyMatrix4(e.matrix)], false);
          _foldCache.set(key, merged);
        }
        if (merged) { link.geometry = merged; link.remove(e); }
      }

      const scaler = new THREE.Group();
      scaler.scale.setScalar(MODEL_SCALE);
      scaler.add(palm);
      this.handGroup.add(scaler);
      this._palm = palm;

      // joint bindings + glowing axle pins, exactly like the web twin
      for (const f of FINGERS) {
        const bind = (nodeName, axis) => {
          const node = palm.getObjectByName(nodeName);
          if (!node) return null;
          const ringMat = new THREE.MeshStandardMaterial({
            color: 0x0a1a33, emissive: 0x7fb2ff, emissiveIntensity: 0.3,
            roughness: 0.35, metalness: 0.2,
          });
          const pin = new THREE.Mesh(pinGeometry(axis), ringMat);
          if (axis === "x") pin.rotation.z = Math.PI / 2;
          node.add(pin);
          return { node, baseQuat: node.quaternion.clone(), baseZ: node.position.z, ringMat };
        };
        // telescopic sliding members (prismatic pairs): local +Z slides,
        // driven by the same shared kinematic model as the web twin
        const bindSlide = (nodeName) => {
          const node = palm.getObjectByName(nodeName);
          return node ? { node, baseZ: node.position.z } : null;
        };
        this._fingers[f] = {
          abduct: bind(`${f}_mcp`, "y"),
          mcpFlex: bind(`${f}_pip`, "x"),      // rides the knuckle joint block
          pipFlex: bind(`${f}_dip`, "x"),
          mcpSlide: bindSlide(`${f}_mcp_slide`),  // knuckle block (MCP pivot)
          pipMid: bindSlide(`${f}_pip_mid`),
          pipSlide: bindSlide(`${f}_pip_slide`),
          dipSlide: bindSlide(`${f}_dip_slide`),
        };
      }

      // the status jewel on the palm plate (activation made visible)
      this._jewel = new THREE.Mesh(
        new THREE.SphereGeometry(3.2, 20, 16),
        new THREE.MeshStandardMaterial({
          color: 0x0d2247, emissive: 0x7fb2ff, emissiveIntensity: 0.8, roughness: 0.3,
        })
      );
      this._jewel.position.set(0, 10.5, 30);
      palm.add(this._jewel);

      // thumb-tip IMU pod, same semantics as the web twin: orientation = the
      // exact tared measurement in the hand frame (snap.thumb.rel_quat);
      // anchor = the shared presentational spot (kinematics.js). Hidden until
      // the tip sensor actually reports.
      {
        const pod = new THREE.Group();
        pod.add(new THREE.Mesh(new THREE.BoxGeometry(9, 3.2, 12),
          new THREE.MeshStandardMaterial({
            color: 0x0d2247, emissive: 0x7fb2ff, emissiveIntensity: 0.45,
            roughness: 0.3, metalness: 0.3,
          })));
        const distal = new THREE.Mesh(
          new THREE.CylinderGeometry(0.9, 0.9, 10, 8),
          new THREE.MeshStandardMaterial({ color: 0x112233, emissive: 0x7fb2ff, emissiveIntensity: 0.9 }));
        distal.rotation.x = Math.PI / 2;
        distal.position.z = 8.5;
        const dorsal = new THREE.Mesh(
          new THREE.CylinderGeometry(0.9, 0.9, 6, 8),
          new THREE.MeshStandardMaterial({ color: 0x332211, emissive: 0xffb155, emissiveIntensity: 0.8 }));
        dorsal.position.y = 4.5;
        pod.add(distal, dorsal);
        pod.position.set(THUMB_POD_ANCHOR_MM.x, THUMB_POD_ANCHOR_MM.y, THUMB_POD_ANCHOR_MM.z);
        pod.visible = false;
        palm.add(pod);
        this._thumbPod = pod;
      }

      this.ready = true;
    });

    // a soft star at the wrist grounds the floating hand
    this._wristGlow = makeGlow(0xffb155, 0.022, 0.7, { depthTest: false });
    this._wristGlow.material.map = glowTexture(128, 0, 0.16);
    this._wristGlow.renderOrder = 7;
    this.handGroup.add(this._wristGlow);
  }

  /**
   * pose the twin.
   *  pos/quat: world hand pose (applied to the hand frame)
   *  jointsById: { index_mcp: deg, index_pip: deg, index_dip: deg, ... }
   *    named by encoder position along the chain, palm outward:
   *    *_mcp = MCP abduction (signed), *_pip = MCP flexion, *_dip = PIP flexion.
   *  activation01: the effort channel, shown by the palm jewel
   *  thumbRelQuat: optional [w,x,y,z] thumb-tip pose in the hand frame
   *    (snap.thumb.rel_quat); null/omitted hides the tip-sensor pod
   */
  pose(pos, quat, jointsById, activation01, dt, thumbRelQuat = null) {
    this.handGroup.position.copy(pos);
    this.handGroup.quaternion.copy(quat);
    if (!this.ready) return;

    const setJoint = (j, axis, deg, glow01) => {
      if (!j) return;
      this._qTmp.setFromAxisAngle(axis, deg * D2R);
      j.node.quaternion.copy(j.baseQuat).multiply(this._qTmp);
      j.ringMat.emissiveIntensity = 0.22 + clamp(glow01, 0, 1) * 1.15;
    };
    for (const f of FINGERS) {
      const jf = this._fingers[f];
      if (!jf) continue;
      // channel semantics match the mechanism's chain, palm outward:
      // {f}_mcp = MCP ABDUCTION (signed deg, + toward the thumb side),
      // {f}_pip = MCP flexion, {f}_dip = PIP flexion. The shared kinematic
      // model (kinematics.js, same file the web twin uses) supplies the
      // clamped rotations AND the telescopic slide of the prismatic pairs.
      const abIn = this._damped[`${f}_ab`].step(jointsById[`${f}_mcp`] ?? 0, dt);
      const mcpIn = this._damped[`${f}_mcp`].step(jointsById[`${f}_pip`] ?? 8, dt);
      const pipIn = this._damped[`${f}_pip`].step(jointsById[`${f}_dip`] ?? 8, dt);
      const p = fingerPose(f, abIn, mcpIn, pipIn);
      setJoint(jf.abduct, this._yAxis, p.ab, Math.abs(p.ab) / 12);
      setJoint(jf.mcpFlex, this._xAxis, p.mcp, (p.mcp - 8) / 52);
      setJoint(jf.pipFlex, this._xAxis, p.pip, (p.pip - 8) / 52);
      if (jf.mcpSlide) jf.mcpSlide.node.position.z = jf.mcpSlide.baseZ + p.slideKnuckleMm;
      if (jf.mcpFlex) jf.mcpFlex.node.position.z = jf.mcpFlex.baseZ + p.slideKnuckleMm;
      if (jf.pipMid) jf.pipMid.node.position.z = jf.pipMid.baseZ + p.slideMcpMidMm;
      if (jf.pipSlide) jf.pipSlide.node.position.z = jf.pipSlide.baseZ + p.slideMcpMm;
      if (jf.pipFlex) jf.pipFlex.node.position.z = jf.pipFlex.baseZ + p.slideMcpMm;
      if (jf.dipSlide) jf.dipSlide.node.position.z = jf.dipSlide.baseZ + p.slidePipMm;
    }
    if (this._jewel) this._jewel.material.emissiveIntensity = 0.5 + clamp(activation01 || 0, 0, 1) * 2.6;
    if (this._thumbPod) {
      this._thumbPod.visible = !!thumbRelQuat;
      if (thumbRelQuat) {
        this._thumbPod.quaternion.set(
          thumbRelQuat[1], thumbRelQuat[2], thumbRelQuat[3], thumbRelQuat[0]);
      }
    }
  }

  update(t) {
    const br = 0.5 + 0.5 * Math.sin(t * 0.7);
    this._wristGlow.material.opacity = 0.55 + br * 0.25;
  }
}
