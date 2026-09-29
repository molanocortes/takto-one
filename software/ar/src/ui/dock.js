// dock.js - the action dock: the core actions as real buttons you can press.
//
// Six round buttons (4.8 cm faces, >= 3 cm targets) on a small panel at the
// left of the scene, facing the user: hub, twin, calibrate, record/stop,
// replay (next take while replaying), recenter. Every button answers three
// ways: a bare-hand POKE (the index tip crosses its face; see gestures.js),
// a RAY select (left-hand pinch or controller trigger, ui/pointer.js), and on
// the desktop a mouse click or keyboard shortcut (main.js). Hover grows the
// face and lights its rim, a press pushes it in and flashes; disabled buttons
// dim and say why in their label.
//
// The panel lives in the canonical stage frame (ui/stage.js), so it moves
// with a recenter and never has to be found again. The face textures are
// redrawn only when a label/state changes.

import * as THREE from "../../vendor/three.module.js";
import { PokeState, POKE } from "./gestures.js";

const FACE_R = 0.024;                  // 4.8 cm face
const COL_DX = 0.068, ROW_DY = 0.084;  // pitch (label under each face)
const INK = "#EAF4FF", DIM = "#8FA3B8";
const TONES = { idle: "#66B8FF", ok: "#4CC98D", warn: "#E7B45A", rec: "#F4564D", off: "#56606c" };

// canonical placement: left of the hub heroes, clear of their reach zones and
// of the capture console, facing the eyes a recenter puts at CANON_HEAD
export const DOCK_POS = [-0.44, 0.90, -0.34];
export const CANON_HEAD = [0, 1.0, -0.10];

function drawIcon(g, icon, c, r, color) {
  g.save();
  g.translate(c, c);
  g.fillStyle = color; g.strokeStyle = color;
  g.lineWidth = r * 0.12; g.lineCap = "round"; g.lineJoin = "round";
  const s = r * 0.42;
  switch (icon) {
    case "record": g.beginPath(); g.arc(0, 0, s * 0.8, 0, Math.PI * 2); g.fill(); break;
    case "stop": g.beginPath(); g.roundRect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4, s * 0.18); g.fill(); break;
    case "replay": case "next":
      g.beginPath(); g.moveTo(-s * 0.55, -s * 0.8); g.lineTo(s * 0.85, 0); g.lineTo(-s * 0.55, s * 0.8); g.closePath(); g.fill();
      if (icon === "next") { g.fillRect(s * 0.9, -s * 0.8, s * 0.22, s * 1.6); }
      break;
    case "hub":
      g.beginPath(); g.moveTo(-s, -s * 0.05); g.lineTo(0, -s * 0.95); g.lineTo(s, -s * 0.05); g.stroke();
      g.beginPath(); g.moveTo(-s * 0.7, -s * 0.2); g.lineTo(-s * 0.7, s * 0.8); g.lineTo(s * 0.7, s * 0.8); g.lineTo(s * 0.7, -s * 0.2); g.stroke();
      break;
    case "exit":
      g.beginPath(); g.moveTo(-s * 0.7, -s * 0.7); g.lineTo(s * 0.7, s * 0.7); g.moveTo(s * 0.7, -s * 0.7); g.lineTo(-s * 0.7, s * 0.7); g.stroke();
      break;
    case "twin": // an open hand: palm + four fingers + thumb
      g.beginPath(); g.roundRect(-s * 0.55, -s * 0.05, s * 1.1, s * 0.85, s * 0.25); g.fill();
      for (let i = 0; i < 4; i++) { const x = -s * 0.45 + i * s * 0.3; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, -s * (0.75 + (i === 1 || i === 2 ? 0.2 : 0))); g.stroke(); }
      g.beginPath(); g.moveTo(-s * 0.5, s * 0.35); g.lineTo(-s * 0.95, -s * 0.1); g.stroke();
      break;
    case "calibrate": // a level: horizon line + bubble
      g.beginPath(); g.moveTo(-s, 0); g.lineTo(s, 0); g.stroke();
      g.beginPath(); g.arc(0, 0, s * 0.42, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(0, -s * 0.85); g.lineTo(0, -s * 0.55); g.moveTo(0, s * 0.55); g.lineTo(0, s * 0.85); g.stroke();
      break;
    case "recenter": // crosshair
      g.beginPath(); g.arc(0, 0, s * 0.62, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(-s, 0); g.lineTo(-s * 0.3, 0); g.moveTo(s * 0.3, 0); g.lineTo(s, 0);
      g.moveTo(0, -s); g.lineTo(0, -s * 0.3); g.moveTo(0, s * 0.3); g.lineTo(0, s); g.stroke();
      g.beginPath(); g.arc(0, 0, s * 0.12, 0, Math.PI * 2); g.fill();
      break;
    default: break;
  }
  g.restore();
}

class DockButton {
  constructor(id) {
    this.id = id;
    this.group = new THREE.Group();
    // face
    this._cv = document.createElement("canvas"); this._cv.width = this._cv.height = 256;
    this._tex = new THREE.CanvasTexture(this._cv);
    this._tex.colorSpace = THREE.SRGBColorSpace; this._tex.anisotropy = 4;
    this.face = new THREE.Mesh(new THREE.CircleGeometry(FACE_R, 40),
      new THREE.MeshBasicMaterial({ map: this._tex, transparent: true, depthWrite: false, toneMapped: false }));
    this.face.renderOrder = 20;
    this.face.userData.dockId = id;
    this.group.add(this.face);
    // label
    this._lcv = document.createElement("canvas"); this._lcv.width = 512; this._lcv.height = 112;
    this._ltex = new THREE.CanvasTexture(this._lcv);
    this._ltex.colorSpace = THREE.SRGBColorSpace; this._ltex.anisotropy = 4;
    this.label = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.08 * 112 / 512),
      new THREE.MeshBasicMaterial({ map: this._ltex, transparent: true, depthWrite: false, toneMapped: false }));
    this.label.position.set(0, -FACE_R - 0.0135, 0);
    this.label.renderOrder = 20;
    this.label.userData.dockId = id;
    this.group.add(this.label);
    this.poke = new PokeState();
    this.state = { icon: id, text: id, tone: "idle", enabled: true, active: false };
    this._key = "";
    this.hover = 0;          // eased 0..1
    this.flash = 0;          // seconds left
    this.rayHover = false;
  }
  set(st) {
    Object.assign(this.state, st);
    const s = this.state;
    const key = [s.icon, s.text, s.tone, s.enabled, s.active].join("|");
    if (key === this._key) return;
    this._key = key;
    this._draw();
  }
  _draw() {
    const s = this.state, g = this._cv.getContext("2d"), C = 128;
    const col = s.enabled ? (TONES[s.tone] || TONES.idle) : TONES.off;
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = s.active ? "rgba(40,16,16,0.94)" : "rgba(8,13,22,0.92)";
    g.beginPath(); g.arc(C, C, 124, 0, Math.PI * 2); g.fill();
    g.lineWidth = 12; g.strokeStyle = col;
    g.beginPath(); g.arc(C, C, 116, 0, Math.PI * 2); g.stroke();
    drawIcon(g, s.icon, C, 124, s.enabled ? (s.active ? TONES.rec : INK) : DIM);
    this._tex.needsUpdate = true;
    const l = this._lcv.getContext("2d");
    l.clearRect(0, 0, 512, 112);
    l.fillStyle = "rgba(3,7,14,0.9)";
    l.beginPath(); l.roundRect(4, 6, 504, 100, 50); l.fill();
    // fit: a long label ("record ·off") shrinks instead of clipping
    let px = 64;
    l.font = `600 ${px}px system-ui, -apple-system, sans-serif`;
    while (l.measureText(s.text).width > 470 && px > 36) { px -= 4; l.font = `600 ${px}px system-ui, -apple-system, sans-serif`; }
    l.textAlign = "center"; l.textBaseline = "middle";
    l.fillStyle = s.enabled ? INK : DIM;
    l.fillText(s.text, 256, 58);
    this._ltex.needsUpdate = true;
  }
}

export class Dock {
  /** specs: [{id, icon, text}] in reading order (2 columns). */
  constructor(scene, specs) {
    this.group = new THREE.Group();
    this.group.position.set(DOCK_POS[0], DOCK_POS[1], DOCK_POS[2]);
    this.group.lookAt(CANON_HEAD[0], CANON_HEAD[1], CANON_HEAD[2]);   // the face looks at the eyes
    scene.add(this.group);
    // a quiet backing plate so the panel reads as one object over a busy room
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(COL_DX * 2 + 0.03, ROW_DY * 3 + 0.02),
      new THREE.MeshBasicMaterial({ color: 0x03070e, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
    plate.position.set(0, -0.012, -0.004);
    plate.renderOrder = 19;
    this.group.add(plate);
    this.buttons = [];
    this.byId = {};
    specs.forEach((sp, i) => {
      const b = new DockButton(sp.id);
      const col = i % 2, row = Math.floor(i / 2);
      b.group.position.set((col - 0.5) * COL_DX, (1 - row) * ROW_DY, 0);
      b.set({ icon: sp.icon || sp.id, text: sp.text || sp.id });
      this.group.add(b.group);
      this.buttons.push(b);
      this.byId[sp.id] = b;
    });
    this.hitMeshes = [];
    for (const b of this.buttons) this.hitMeshes.push(b.face, b.label);
    this._inv = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this.hoverAny = false;
    this.hoverStarts = [];
    this.visible = true;
  }

  set(id, st) { const b = this.byId[id]; if (b) b.set(st); }
  idOf(obj) { return obj && obj.userData ? obj.userData.dockId || null : null; }

  /** Is this world point near the panel (so reach selection elsewhere should
   *  ignore that tip)? */
  near(pWorld) {
    this._v.copy(pWorld);
    this.group.worldToLocal(this._v);
    return Math.abs(this._v.x) < COL_DX + 0.04 && this._v.y > -ROW_DY * 2 - 0.04 &&
           this._v.y < ROW_DY + 0.05 && this._v.z < 0.10 && this._v.z > -0.06;
  }

  /**
   * Per frame. tips: world-space index tips allowed to press (Vector3[]).
   * rayHoverId: the button a pointer ray is on (or null). Returns the ids
   * pressed this frame by a poke.
   */
  update(dt, tips, rayHoverId) {
    const pressed = [];
    this.hoverStarts.length = 0;
    this.group.visible = this.visible;
    if (!this.visible) return pressed;
    this.group.updateMatrixWorld();
    this.hoverAny = false;
    const lp = [0, 0, 0];
    for (const b of this.buttons) {
      // the button's local frame: its face is the XY plane, +Z toward the user
      this._inv.copy(b.group.matrixWorld).invert();
      let fired = null, anyHover = false, depth = 0;
      // one PokeState per button, fed the nearest allowed tip
      let best = null, bestR = Infinity;
      for (const tip of tips) {
        this._v.copy(tip).applyMatrix4(this._inv);
        const r = Math.hypot(this._v.x, this._v.y) + Math.max(0, this._v.z) * 0.5;
        if (r < bestR) { bestR = r; best = [this._v.x, this._v.y, this._v.z]; }
      }
      if (best) { lp[0] = best[0]; lp[1] = best[1]; lp[2] = best[2]; }
      const ev = b.poke.update(best ? lp : null);
      if (ev === "press" && b.state.enabled) fired = b.id;
      anyHover = b.poke.hover; depth = b.poke.depth;
      b.rayHover = rayHoverId === b.id;
      const want = (anyHover || b.rayHover) && b.state.enabled ? 1 : 0;
      if (anyHover) this.hoverAny = true;
      // a hover that just began (poke or ray): main.js answers with a soft tick
      const hNow = (anyHover || b.rayHover) && b.state.enabled;
      if (hNow && !b._wasHover) this.hoverStarts.push(b.id);
      b._wasHover = hNow;
      b.hover += (want - b.hover) * (1 - Math.exp(-dt * 14));
      if (fired) { pressed.push(fired); b.flash = 0.22; }
      b.flash = Math.max(0, b.flash - dt);
      const push = Math.max(depth * (anyHover ? 1 : 0), b.flash > 0 ? 0.8 : 0);
      b.face.position.z = -0.006 * push;
      b.face.scale.setScalar(1 + 0.12 * b.hover - 0.05 * push);
      b.face.material.opacity = b.state.enabled ? 0.9 + 0.1 * b.hover : 0.45;
      b.face.material.color.setScalar(1 + (b.flash > 0 ? 0.6 * (b.flash / 0.22) : 0) + 0.15 * b.hover);
      b.label.material.opacity = b.state.enabled ? 0.8 + 0.2 * b.hover : 0.5;
    }
    return pressed;
  }

  /** Visual press (for ray / mouse / key presses, which bypass the poke). */
  flash(id) { const b = this.byId[id]; if (b) b.flash = 0.22; }
}

export { FACE_R, POKE };
