// pointer.js - far interaction: point and select, the Quest's native model.
//
// Every XR input source has a target ray. Controllers select with the
// trigger; bare hands select with a thumb-index pinch (the browser fires the
// same `select` event for both). This module casts each allowed ray against
// the current interactives (dock buttons, mode objects), draws a thin beam and
// a cursor only while something is under it, and turns `select` into the
// same activation the poke and the mouse use (main.js onActivate).
//
// WHICH hands may point is a policy passed in by main.js: the rig is worn on
// the right hand, so while the device is linked only the LEFT hand (and any
// controller) may select - a glove hand flexing through a take must never
// press STOP by accident.

import * as THREE from "../../vendor/three.module.js";

const BEAM_MAX = 2.5;                   // m

export class XRPointer {
  constructor(world, { onSelect, allow }) {
    this.world = world;
    this.onSelect = onSelect;
    this.allow = allow || (() => true);
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = BEAM_MAX;
    // metre-sized default thresholds would let every mote field eat the ray
    this.raycaster.params.Points.threshold = 0.012;
    this.raycaster.params.Line.threshold = 0.012;
    this.rays = [];
    this.hoverObj = null;
    this._targets = [];
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    for (let i = 0; i < 2; i++) {
      const c = world.renderer.xr.getController(i);
      c.userData.src = null;
      c.addEventListener("connected", (e) => { c.userData.src = e.data || null; });
      c.addEventListener("disconnected", () => { c.userData.src = null; c.userData.hit = null; });
      c.addEventListener("select", (e) => this._select(c, e.data || c.userData.src));
      world.scene.add(c);
      // beam + cursor live in the scene (not under the controller) so they can
      // stop exactly at the hit point
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      const beam = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0xd9edff, transparent: true, opacity: 0.0, depthWrite: false, toneMapped: false }));
      beam.frustumCulled = false; beam.renderOrder = 30; beam.visible = false;
      world.scene.add(beam);
      const cursor = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.0095, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9,
                                      depthTest: false, depthWrite: false, toneMapped: false }));
      cursor.renderOrder = 31; cursor.visible = false;
      world.scene.add(cursor);
      this.rays.push({ c, beam, cursor });
    }
  }

  _select(c, src) {
    if (!src || !this.allow(src)) return;
    const hit = c.userData.hit;
    if (hit && this.onSelect) this.onSelect(hit.object, hit.point, src);
  }

  /** Per frame while presenting. targets: Object3D[] to cast against. */
  update(targets, camera) {
    this.raycaster.camera = camera;          // sprites need it
    this.hoverObj = null;
    for (const r of this.rays) {
      const src = r.c.userData.src;
      r.c.userData.hit = null;
      const ok = !!src && this.allow(src) && r.c.visible !== false;
      if (!ok) { r.beam.visible = false; r.cursor.visible = false; continue; }
      r.c.updateMatrixWorld();
      this._o.setFromMatrixPosition(r.c.matrixWorld);
      r.c.getWorldQuaternion(this._q);
      this._d.set(0, 0, -1).applyQuaternion(this._q);
      this.raycaster.set(this._o, this._d);
      const hits = targets.length ? this.raycaster.intersectObjects(targets, true) : [];
      const hit = hits.find((h) => h.object.visible !== false) || null;
      const isPad = !!(src.gamepad && !src.hand);
      if (hit) {
        r.c.userData.hit = hit;
        if (!this.hoverObj) this.hoverObj = hit.object;
      }
      // beam: always (faint) for a controller, only on a target for a hand
      const show = !!hit || isPad;
      r.beam.visible = show;
      r.cursor.visible = !!hit;
      if (show) {
        const len = hit ? hit.distance : 0.6;
        const a = r.beam.geometry.attributes.position.array;
        a[0] = this._o.x; a[1] = this._o.y; a[2] = this._o.z;
        a[3] = this._o.x + this._d.x * len; a[4] = this._o.y + this._d.y * len; a[5] = this._o.z + this._d.z * len;
        r.beam.geometry.attributes.position.needsUpdate = true;
        r.beam.material.opacity = hit ? 0.55 : 0.18;
      }
      if (hit) {
        r.cursor.position.copy(hit.point);
        r.cursor.lookAt(camera.position);
      }
    }
    return this.hoverObj;
  }

  hideAll() { for (const r of this.rays) { r.beam.visible = false; r.cursor.visible = false; r.c.userData.hit = null; } }
}
