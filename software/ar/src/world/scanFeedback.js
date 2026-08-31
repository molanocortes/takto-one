// scanFeedback.js - LOUD, world-space capture feedback (2026-07-20).
//
// The dom-overlay HUD (diagHud.js) may simply not render on-device (dom-overlay
// is an optional feature the headset can decline), and round 1 leaned on it
// anyway. This panel is dom-overlay-INDEPENDENT: a canvas-textured plane in
// WORLD SPACE, lazily following the head at ~1.3 m, always facing the user,
// always on top. It renders the capture story big enough to read across a
// room:
//
//   on AR entry   : "CONNECTED to bridge" vs "NOT CONNECTED - what to do"
//   while scanning: live point count, coverage bar, the one active instruction
//   terminal      : "SAVED - sent to website (env_xxxx)" / "NOTHING CAPTURED:
//                   <honest reason>" / "ERROR: <bridge error verbatim>"
//
// Pure view: it renders envDiag() + transport state and never invents numbers.
// The dom-overlay HUD stays as a bonus layer; this is the one that must work.

import * as THREE from "../../vendor/three.module.js";

const W = 1024, H = 512;              // canvas px
const PANEL_W = 0.78, PANEL_H = 0.39; // meters at ~1.3 m: comfortably legible
const AHEAD = 1.30;                   // meters in front of the head
const LIFT = 0.10;                    // meters above gaze center
const BANNER_S = 8;                   // connection banner dwell after entry / change
const TERMINAL_S = 6;                 // dwell on SAVED / ERROR / EMPTY

const INK = "#EAF4FF", DIM = "#9FB8CE";
const OK = "#5FE6C4", WARN = "#E7B45A", BAD = "#F4776A", AQUA = "#66B8FF";

export class ScanFeedback {
  constructor(scene) {
    this._canvas = document.createElement("canvas");
    this._canvas.width = W; this._canvas.height = H;
    this._g = this._canvas.getContext("2d");
    this._tex = new THREE.CanvasTexture(this._canvas);
    this._tex.colorSpace = THREE.SRGBColorSpace;
    this._mat = new THREE.MeshBasicMaterial({
      map: this._tex, transparent: true, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide, opacity: 0,
    });
    this._mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), this._mat);
    this._mesh.renderOrder = 60;
    this._mesh.visible = false;
    scene.add(this._mesh);
    this._tmp = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._bannerT = 0;                // countdown while the connect banner shows
    this._terminalT = 0;              // countdown after a scan resolves
    this._lastPhase = "idle";
    this._lastConn = null;            // last seen transport connected state
    this._lastKey = "";               // redraw only when the content changes
    this._placed = false;
  }

  /** Call when an XR session starts: the connection state must be the first
   *  thing the owner sees, before any scan is attempted. */
  noteSessionStart() {
    this._bannerT = BANNER_S;
    this._placed = false;
  }

  // ---- drawing --------------------------------------------------------------
  _wrap(g, text, x, y, maxW, lineH, font, color) {
    g.font = font; g.fillStyle = color;
    const words = String(text || "").split(/\s+/);
    let line = "";
    for (const w of words) {
      const probe = line ? line + " " + w : w;
      if (g.measureText(probe).width > maxW && line) {
        g.fillText(line, x, y); y += lineH; line = w;
      } else line = probe;
    }
    if (line) { g.fillText(line, x, y); y += lineH; }
    return y;
  }

  _draw(rows, accent, coverage) {
    const g = this._g;
    g.clearRect(0, 0, W, H);
    // smoked slab + accent edge (matches the capture console aesthetic)
    g.fillStyle = "rgba(6,10,16,0.82)";
    g.beginPath(); g.roundRect(8, 8, W - 16, H - 16, 28); g.fill();
    g.lineWidth = 5; g.strokeStyle = accent;
    g.beginPath(); g.roundRect(8, 8, W - 16, H - 16, 28); g.stroke();

    let y = 118;
    const x = 54, maxW = W - 108;
    // headline: big; body: medium; detail: small
    y = this._wrap(g, rows.head, x, y, maxW, 92, "700 84px system-ui, sans-serif", rows.headColor || INK);
    y += 8;
    if (rows.body) {
      y = this._wrap(g, rows.body, x, y, maxW, 62, "600 52px system-ui, sans-serif", INK);
      y += 6;
    }
    if (rows.detail) {
      y = this._wrap(g, rows.detail, x, y, maxW, 46, "500 38px system-ui, sans-serif", DIM);
    }
    if (coverage != null) {
      // coverage bar along the bottom edge: the honest swept-sector meter
      const bx = 54, bw = W - 108, by = H - 74, bh = 26;
      g.fillStyle = "rgba(140,170,200,0.18)";
      g.beginPath(); g.roundRect(bx, by, bw, bh, 13); g.fill();
      g.fillStyle = coverage > 0.7 ? OK : coverage > 0.35 ? AQUA : WARN;
      g.beginPath(); g.roundRect(bx, by, Math.max(bh, bw * Math.min(1, coverage)), bh, 13); g.fill();
      g.font = "600 34px system-ui, sans-serif"; g.fillStyle = INK;
      g.fillText(`room coverage ${Math.round(coverage * 100)}%`, bx, by - 12);
    }
    this._tex.needsUpdate = true;
  }

  // ---- the state machine: what deserves the user's eyes right now ----------
  _compose(diag) {
    const t = diag.transport || {};
    const phase = diag.phase || "idle";
    const scanActive = phase === "scanning" || phase === "uploading";
    const terminal = phase === "done" || phase === "empty" || phase === "error";

    if (scanActive) {
      if (phase === "uploading") {
        return { rows: { head: "SENDING ROOM…", headColor: AQUA,
          body: `${diag.pts || 0} points · ${diag.tris || 0} triangles`,
          detail: "storing on the host + sending to the website" },
          accent: AQUA, coverage: diag.coverage };
      }
      const noDepth = (diag.depthReason || "").indexOf("no depth API") === 0;
      return { rows: { head: "SCANNING ROOM", headColor: AQUA,
        body: `${diag.pts || 0} pts · ${diag.tris || 0} tris · depth ${diag.depthFrames > 0 ? "LIVE" : (noDepth ? "NOT GRANTED" : "waiting")}`,
        detail: diag.guidance || "look slowly around the room" },
        accent: diag.depthFrames > 0 ? AQUA : WARN, coverage: diag.coverage };
    }
    if (terminal) {
      if (phase === "done") {
        return { rows: { head: "SAVED ✓", headColor: OK,
          body: `${diag.pts || 0} pts / ${diag.tris || 0} tris → sent to website`,
          detail: diag.envId ? `stored as ${diag.envId}` : "" },
          accent: OK, coverage: null };
      }
      if (phase === "error") {
        return { rows: { head: "ERROR", headColor: BAD,
          body: diag.err || "upload failed (no ack from the bridge)",
          detail: "tap scan to retry" }, accent: BAD, coverage: null };
      }
      return { rows: { head: "NOTHING CAPTURED", headColor: WARN,
        body: diag.guidance || "no depth or geometry this sweep",
        detail: "tap scan to retry" }, accent: WARN, coverage: null };
    }
    // idle: the connection banner (entry + state changes)
    if (t.kind === "ws") {
      if (t.connected) {
        return { rows: { head: "CONNECTED ✓", headColor: OK,
          body: "bridge link is live - captures will be saved",
          detail: t.url || "" }, accent: OK, coverage: null };
      }
      return { rows: { head: "CONNECTING…", headColor: WARN,
        body: "reaching the bridge - captures wait for this",
        detail: t.url || "" }, accent: WARN, coverage: null };
    }
    return { rows: { head: "NOT CONNECTED", headColor: BAD,
      body: "no bridge: rooms and takes CANNOT be saved",
      detail: "open the page via https://<PC-IP>:8443/ (it auto-connects), or add ?ws=wss://<PC-IP>:8443/ws" },
      accent: BAD, coverage: null };
  }

  /** Once per frame. diag = envDiag() merged with { transport } (main.js). */
  update(dt, diag, presenting, camera) {
    const phase = diag.phase || "idle";
    if (phase !== this._lastPhase) {
      this._lastPhase = phase;
      if (phase === "done" || phase === "empty" || phase === "error") this._terminalT = TERMINAL_S;
    }
    const conn = (diag.transport && diag.transport.kind === "ws")
      ? !!diag.transport.connected : "mock";
    if (conn !== this._lastConn) {
      this._lastConn = conn;
      if (presenting) this._bannerT = BANNER_S;   // connection changed: say so
    }
    this._bannerT = Math.max(0, this._bannerT - dt);
    this._terminalT = Math.max(0, this._terminalT - dt);

    const scanActive = phase === "scanning" || phase === "uploading";
    const show = presenting && (scanActive || this._terminalT > 0 || this._bannerT > 0);
    this._mesh.visible = show || this._mat.opacity > 0.02;
    this._mat.opacity += ((show ? 1 : 0) - this._mat.opacity) * (1 - Math.exp(-dt * 6));
    if (!this._mesh.visible) return;

    // content (redraw only when it changes; counters tick it naturally).
    // Plain concat, not JSON.stringify: this runs every visible frame.
    const c = this._compose(diag);
    const key = c.rows.head + " " + (c.rows.body || "") + " " + (c.rows.detail || "")
      + " " + c.accent + " " + Math.round((c.coverage || 0) * 50);
    if (key !== this._lastKey) { this._lastKey = key; this._draw(c.rows, c.accent, c.coverage); }

    // lazy-follow placement: ahead of the head, facing it. First placement
    // snaps so the panel never lerps in from the world origin.
    camera.getWorldDirection(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._tmp.copy(camera.position).addScaledVector(this._fwd, AHEAD);
    this._tmp.y = camera.position.y + LIFT;
    if (!this._placed) { this._placed = true; this._mesh.position.copy(this._tmp); }
    else this._mesh.position.lerp(this._tmp, 1 - Math.exp(-dt * 3.5));
    this._mesh.lookAt(camera.position);
  }
}
