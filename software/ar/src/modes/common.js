// common.js - small shared pieces for the modes: the one-word label, root
// tagging for raycasts, and a tiny base class for the mode contract.
//
// S5 legibility: text renders SOLID (normal blending, near-white ink) over a
// soft dark backing pill, so it reads over a bright real room. Additive text
// disappears in daylight passthrough; ink on smoked glass never does.

import * as THREE from "../../vendor/three.module.js";
import { CSS } from "../design/palette.js";

// a single word, beautifully set: ink on a whisper of smoked glass
export function makeWord(text, {
  color = CSS.ink, size = 0.20, weight = 420, px = 56,
  backing = true, glowColor = CSS.aquaHalo,
} = {}) {
  const cv = document.createElement("canvas");
  cv.width = 1024; cv.height = 160;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, cv.width, cv.height);
  g.font = `${weight} ${px}px system-ui, -apple-system, sans-serif`;
  g.textBaseline = "middle";
  // manual letter-spacing for the quiet, expensive look
  const gap = px * 0.62;
  const chars = [...text.toLowerCase()];
  let w = 0;
  for (const ch of chars) w += g.measureText(ch).width + gap;
  w -= gap;
  // the backing pill: soft dark glass behind the ink
  if (backing && w > 0) {
    const padX = px * 0.9, padY = px * 0.62;
    const x0 = (cv.width - w) / 2 - padX, y0 = cv.height / 2 - padY;
    const bw = w + padX * 2, bh = padY * 2, r = bh / 2;
    g.fillStyle = CSS.backing;
    g.beginPath();
    g.moveTo(x0 + r, y0);
    g.arcTo(x0 + bw, y0, x0 + bw, y0 + bh, r);
    g.arcTo(x0 + bw, y0 + bh, x0, y0 + bh, r);
    g.arcTo(x0, y0 + bh, x0, y0, r);
    g.arcTo(x0, y0, x0 + bw, y0, r);
    g.fill();
  }
  // a faint halo under the ink keeps the luminous voice
  g.shadowColor = glowColor; g.shadowBlur = px * 0.35;
  g.fillStyle = color;
  let x = (cv.width - w) / 2;
  for (const ch of chars) {
    g.fillText(ch, x, cv.height / 2 + 2);
    x += g.measureText(ch).width + gap;
  }
  g.shadowBlur = 0;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, opacity: 0,
    depthWrite: false, depthTest: false, toneMapped: false,
  });
  const s = new THREE.Sprite(mat);
  s.renderOrder = 8;
  s.scale.set(size, size * (cv.height / cv.width), 1);
  return s;
}

// tag every descendant so a raycast hit resolves to a named root
export function tagRoot(obj, key) {
  obj.traverse((o) => { o.userData.arKey = key; });
  obj.userData.arKey = key;
}
export const keyOf = (obj) => (obj ? obj.userData.arKey : null);

// mode contract: enter() / update(dt, snap, t) / exit(); interactives for the
// pointer; onHover / onSelect from the manager.
export class Mode {
  constructor(ctx) {
    this.ctx = ctx;                       // { world, hand, audio, tele, switchTo, snap }
    this.group = new THREE.Group();
    this.group.visible = false;
    ctx.world.scene.add(this.group);
    this.interactives = [];
    this.active = false;
  }
  enter() { this.group.visible = true; this.active = true; }
  exit() { this.group.visible = false; this.active = false; }
  update(_dt, _snap, _t) {}
  onHover(_obj) {}
  onSelect(_obj) {}
}
