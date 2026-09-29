// hud.js - the glanceable status HUD and the first-run guide card, in the
// headset. Body-locked with a LAZY follow (ui/stage.js LazyFollow): it rides
// ~24 deg above the gaze but never below eye level (the scene lives at and
// below eye level, the hands below the gaze), 0.6 m out, and only moves when
// the head has turned ~25 deg away, so it never swims while being read.
//
// Text sizing for the Quest 3S (~20 px/deg): the strip is 0.30 m wide at
// 0.6 m (28 deg), its canvas 1024 px wide, i.e. ~36 texture px per degree
// (about 2x the display density, mipmapped). Headline caps ~1 deg, detail
// rows ~0.75 deg: readable at a glance, small in the view.
//
// Pure view: it draws ui/status.js strings. Canvas textures are redrawn only
// when the string key changes (a clock tick at most once a second).

import * as THREE from "../../vendor/three.module.js";
import { LazyFollow, yawFromForward, headingOf } from "./stage.js";
import { statusKey, guideKey } from "./status.js";

const DIST = 0.60;
const W = 1024, SH = 232, GH = 300;
const PW = 0.30;
const TONE = { ok: "#4CC98D", warn: "#E8B14E", bad: "#F4564D", dim: "#8FA3B8", rec: "#F4564D" };
const INK = "#EAF4FF", DIMC = "#9FB3C8";

function makePanel(h) {
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = h;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false,
                                            depthWrite: false, toneMapped: false, opacity: 0 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PW, PW * h / W), mat);
  mesh.renderOrder = 50;
  return { cv, g: cv.getContext("2d"), tex, mat, mesh, key: "" };
}

function pill(g, x, y, text, bg, fg, font) {
  g.font = font;
  const w = g.measureText(text).width + 36;
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(x, y - 30, w, 60, 30); g.fill();
  g.fillStyle = fg; g.textBaseline = "middle";
  g.fillText(text, x + 18, y + 2);
  return x + w;
}

export class StatusHud {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.renderOrder = 50;
    scene.add(this.group);
    this.strip = makePanel(SH);
    this.card = makePanel(GH);
    this.group.add(this.strip.mesh, this.card.mesh);
    // the card hangs just under the strip (toward the gaze)
    this.card.mesh.position.set(0, -(PW * SH / W) / 2 - (PW * GH / W) / 2 - 0.006, 0);
    this.follow = new LazyFollow();
    this.enabled = true;
    this._fwd = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._cardOn = false;
  }

  _drawStrip(v) {
    const { g } = this.strip;
    g.clearRect(0, 0, W, SH);
    g.fillStyle = "rgba(4,8,14,0.84)";
    g.beginPath(); g.roundRect(4, 4, W - 8, SH - 8, 30); g.fill();
    g.lineWidth = 4; g.strokeStyle = TONE[v.link.tone] || TONE.dim;
    g.beginPath(); g.roundRect(4, 4, W - 8, SH - 8, 30); g.stroke();
    // row 1: link word + detail, recording on the right
    const f1 = "700 50px system-ui, -apple-system, sans-serif";
    let x = pill(g, 26, 58, v.link.word, TONE[v.link.tone] || TONE.dim, "#0a0f16", f1);
    if (v.rec) {
      g.font = f1;
      const w = g.measureText(v.rec.text).width + 70;
      const rx = W - 26 - w;
      g.fillStyle = "rgba(244,86,77,0.18)";
      g.beginPath(); g.roundRect(rx, 28, w, 60, 30); g.fill();
      g.fillStyle = TONE.rec; g.beginPath(); g.arc(rx + 30, 58, 13, 0, Math.PI * 2); g.fill();
      g.fillStyle = INK; g.textBaseline = "middle"; g.fillText(v.rec.text, rx + 52, 60);
    } else {
      g.font = "500 36px system-ui, -apple-system, sans-serif";
      g.fillStyle = DIMC; g.textBaseline = "middle";
      g.fillText(v.link.detail || "", x + 20, 60);
    }
    // row 2: sensors + neutral, each with a colored dot
    let sx = 32;
    const f2 = "600 40px system-ui, -apple-system, sans-serif";
    g.font = f2; g.textBaseline = "middle";
    for (const s of [...v.sensors, v.neutral]) {
      g.fillStyle = TONE[s.tone] || TONE.dim;
      g.beginPath(); g.arc(sx + 10, 128, 10, 0, Math.PI * 2); g.fill();
      g.fillStyle = INK;
      g.fillText(s.word, sx + 30, 130);
      sx += 30 + g.measureText(s.word).width + 40;
    }
    // row 3: rates / latency, or a transient note (recenter feedback)
    g.font = "500 34px system-ui, -apple-system, sans-serif";
    g.fillStyle = v.note ? "#66B8FF" : DIMC;
    g.fillText(v.note || v.rate, 32, 190);
    this.strip.tex.needsUpdate = true;
  }

  _wrap(g, text, x, y, maxW, lh, maxLines = 2) {
    const words = String(text || "").split(/\s+/);
    let line = "", n = 0;
    for (const w of words) {
      const probe = line ? line + " " + w : w;
      if (g.measureText(probe).width > maxW && line) {
        g.fillText(line, x, y); y += lh; line = w;
        if (++n >= maxLines) return y;
      } else line = probe;
    }
    if (line) { g.fillText(line, x, y); y += lh; }
    return y;
  }

  _drawCard(c) {
    const { g } = this.card;
    g.clearRect(0, 0, W, GH);
    if (!c) { this.card.tex.needsUpdate = true; return; }
    const accent = TONE[c.tone] || "#66B8FF";
    g.fillStyle = "rgba(4,8,14,0.86)";
    g.beginPath(); g.roundRect(4, 4, W - 8, GH - 8, 30); g.fill();
    g.fillStyle = accent;
    g.beginPath(); g.roundRect(4, 4, 14, GH - 8, 7); g.fill();
    const hasCount = c.countdown !== null && c.countdown !== undefined;
    const maxW = W - 80 - (hasCount ? 230 : 0);
    g.textBaseline = "alphabetic";
    g.font = "600 30px system-ui, -apple-system, sans-serif";
    g.fillStyle = DIMC;
    g.fillText(c.allDone ? "FIRST RUN" : `STEP ${c.index} / ${c.total}`, 44, 52);
    g.font = "700 52px system-ui, -apple-system, sans-serif";
    g.fillStyle = INK;
    g.fillText(c.title, 44, 110);
    g.font = "500 40px system-ui, -apple-system, sans-serif";
    g.fillStyle = INK;
    let y = this._wrap(g, c.text, 44, 166, maxW, 46, 2);
    g.font = "500 30px system-ui, -apple-system, sans-serif";
    g.fillStyle = DIMC;
    this._wrap(g, c.detail, 44, Math.max(y + 4, 222), maxW, 36, 2);
    if (hasCount) {
      const cx = W - 140, cy = GH / 2;
      g.strokeStyle = accent; g.lineWidth = 10;
      g.beginPath(); g.arc(cx, cy, 104, 0, Math.PI * 2); g.stroke();
      g.font = "300 150px system-ui, -apple-system, sans-serif";
      g.fillStyle = INK; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(c.countdown), cx, cy + 8);
      g.textAlign = "left";
    }
    this.card.tex.needsUpdate = true;
  }

  /** Per frame. view: statusView() result (may be the same object for many
   *  frames); card: Guide card or null. */
  update(dt, camera, view, card, show = true) {
    const on = this.enabled && show;
    const k = 1 - Math.exp(-dt * 6);
    this.strip.mat.opacity += ((on ? 1 : 0) - this.strip.mat.opacity) * k;
    const cardOn = on && !!card;
    this.card.mat.opacity += ((cardOn ? 1 : 0) - this.card.mat.opacity) * k;
    this.group.visible = this.strip.mat.opacity > 0.01 || this.card.mat.opacity > 0.01;
    if (!this.group.visible) { this.follow.reset(); return; }
    if (view) {
      const key = statusKey(view);
      if (key !== this.strip.key) { this.strip.key = key; this._drawStrip(view); }
    }
    const ck = guideKey(card);
    if (card && ck !== this.card.key) { this.card.key = ck; this._drawCard(card); }
    this.card.mesh.visible = this.card.mat.opacity > 0.01;

    // lazy follow around the head
    camera.getWorldDirection(this._fwd);
    const h = headingOf([this._fwd.x, this._fwd.y, this._fwd.z]);
    const yaw = h ? yawFromForward(h[0], h[1]) : this.follow.yaw;
    const pitch = Math.asin(Math.max(-1, Math.min(1, this._fwd.y)));
    const f = this.follow.update(yaw, pitch, dt);
    const ce = Math.cos(f.elev);
    this._p.set(-Math.sin(f.yaw) * ce, Math.sin(f.elev), -Math.cos(f.yaw) * ce)
      .multiplyScalar(DIST).add(camera.position);
    this.group.position.copy(this._p);
    this.group.lookAt(camera.position);
  }
}
