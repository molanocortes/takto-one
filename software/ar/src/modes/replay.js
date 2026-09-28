// replay.js - play a recorded take back IN THE ROOM.
//
// The take comes from the bridge ({cmd:"take_data", id} -> {kind:"take_data",
// cols, rows}); the list of takes arrives unasked as {kind:"takes"} (on join
// and after every stop), kept by main.js and read through ctx.takes().
// replayData.js (pure) turns rows into a track: vision rows are their own
// truth, occluded rows are placed from the body model under an anchor solved
// from the vision rows, body-only takes go under the live wearer's shoulder.
//
// In the room: the device CAD hand at real scale follows the recorded wrist,
// its fingers driven by the recorded joint channels; the whole wrist path is a
// faint line; a timeline ribbon (coloured by where each moment's pose came
// from: aqua vision, amber body model, grey none) with a playhead; play/pause
// and restart. If the take carries an env that belongs to THIS room (scanned
// this session, or a restored + localized anchor), the recorded point cloud is
// fetched (env_get) and drawn in place. Otherwise the take is recentred on the
// desk and labelled "unanchored" - never silently mis-placed.
//
// Desktop: click a take / play / restart / the ribbon; keys: space play-pause,
// arrows seek (left/right) and pick a take (up/down).

import * as THREE from "../../vendor/three.module.js";
import { Mode, makeWord, tagRoot, keyOf } from "./common.js";
import { makeCounter } from "./rhythm.js";
import { DeviceHand } from "../world/deviceHand.js";
import { makeGlow, makeRingSprite, makeStageDisc } from "../world/materials.js";
import { AQUA, AQUA_HALO, AMBER, OK } from "../design/palette.js";
import { clamp, Breath } from "../design/motion.js";
import { parseTake, buildTrack, sampleTrack, recentreMatrix } from "./replayData.js";
import { roomFromEnv } from "../world/envScan.js";
import { applyToPoint, quatFromMatrix, IDENTITY4 } from "../world/roomAnchor.js";
import { qmul } from "../world/poseFallback.js";

const ANCHOR = new THREE.Vector3(0, 0.75, -0.55);
const ROWS = 5;
const RIB_W = 0.46, RIB_H = 0.045;
const REQ_TIMEOUT_MS = 8000;
const TWIN_PRESENT = 1.8;            // DeviceHand's MODEL_SCALE presents at 1.8x real
const CLOUD_MAX = 60000;

function fmt(s) {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export class Replay extends Mode {
  constructor(ctx) {
    super(ctx);
    this.group.position.copy(ANCHOR);
    // room-space content (the recorded path lives in local-floor metres)
    this.room = new THREE.Group();
    this.room.visible = false;
    ctx.world.scene.add(this.room);
    this._breath = new Breath(0.12);
    this._track = null;
    this._take = null;               // meta of the loaded take
    this._M = IDENTITY4;             // take frame -> room
    this._placement = "";
    this._t = 0;                     // playback time [ms]
    this._playing = false;
    this._pending = null;            // {id, t0} awaiting take_data
    this._envPending = null;
    this._status = "";
    this._sel = 0;
    this._tmp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._build();
    ctx.tele.onSnapshot((m) => this._onMessage(m));
    this._bindKeys();
  }

  _build() {
    const g = this.group;
    const stage = makeStageDisc(0.40);
    stage.position.set(0, 0.001, 0.02);
    g.add(stage);

    this._title = makeCounter({ px: 40, size: 0.26, color: "rgba(217,237,255,0.98)" });
    this._title.spr.position.set(0, 0.36, -0.08);
    g.add(this._title.spr);
    this._statusUI = makeCounter({ px: 30, size: 0.30, color: "rgba(231,180,90,0.98)" });
    this._statusUI.spr.position.set(0, 0.315, -0.08);
    g.add(this._statusUI.spr);

    // the take list (reach / click a row to load it)
    this._rows = [];
    for (let i = 0; i < ROWS; i++) {
      const row = makeCounter({ px: 32, size: 0.24, color: "rgba(196,216,236,0.95)" });
      row.spr.position.set(-0.36, 0.25 - i * 0.052, -0.02);
      tagRoot(row.spr, `take:${i}`);
      g.add(row.spr);
      this.interactives.push(row.spr);
      this._rows.push(row);
    }

    // play / pause and restart lights
    const mkButton = (key, x, word, color) => {
      const grp = new THREE.Group();
      const core = makeGlow(color, 0.028, 0.5);
      const ring = makeRingSprite(AQUA_HALO, 0.042, 0.4);
      ring.material.depthTest = false; ring.renderOrder = 7;
      grp.add(core, ring);
      grp.position.set(x, 0.06, 0.13);
      tagRoot(grp, key);
      g.add(grp);
      this.interactives.push(grp);
      const w = makeWord(word, { size: 0.10 });
      w.position.set(x, 0.112, 0.13);
      g.add(w);
      return { grp, core, ring, word: w };
    };
    this._play = mkButton("play", 0.07, "play", AQUA);
    this._pauseWord = makeWord("pause", { size: 0.10 });
    this._pauseWord.position.copy(this._play.word.position);
    g.add(this._pauseWord);
    this._restart = mkButton("restart", -0.09, "restart", AQUA);

    // the timeline ribbon, standing at the desk front, tilted to the user
    this._ribCanvas = document.createElement("canvas");
    this._ribCanvas.width = 1024; this._ribCanvas.height = 64;
    this._ribTex = new THREE.CanvasTexture(this._ribCanvas);
    this._ribTex.colorSpace = THREE.SRGBColorSpace;
    const rib = new THREE.Mesh(new THREE.PlaneGeometry(RIB_W, RIB_H),
      new THREE.MeshBasicMaterial({ map: this._ribTex, transparent: true, depthWrite: false,
                                    toneMapped: false, side: THREE.DoubleSide }));
    rib.position.set(0, 0.19, 0.10);
    rib.rotation.x = -0.35;
    rib.renderOrder = 7;
    tagRoot(rib, "ribbon");
    g.add(rib);
    this.interactives.push(rib);
    this._rib = rib;
    const head = new THREE.Mesh(new THREE.PlaneGeometry(0.004, RIB_H * 1.5),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95,
                                    depthTest: false, toneMapped: false }));
    head.renderOrder = 8;
    head.position.z = 0.002;
    rib.add(head);
    this._head = head;
    this._timeUI = makeCounter({ px: 30, size: 0.22, color: "rgba(217,237,255,0.95)" });
    this._timeUI.spr.position.set(0, 0.235, 0.10);
    g.add(this._timeUI.spr);
    this._drawRibbon();

    // ---- room content ---------------------------------------------------------
    // the device CAD hand at REAL scale (DeviceHand presents at 1.8x)
    this._hand = new DeviceHand(this.room, { scale: 1 / TWIN_PRESENT });
    this._handGlow = makeGlow(AMBER, 0.03, 0.0, { depthTest: false });
    this._handGlow.renderOrder = 7;
    this.room.add(this._handGlow);
    this._pathGeo = new THREE.BufferGeometry();
    this._path = new THREE.Line(this._pathGeo, new THREE.LineBasicMaterial({
      color: AQUA, transparent: true, opacity: 0.45, depthWrite: false }));
    this._path.frustumCulled = false;
    this.room.add(this._path);
    this._cloudGeo = new THREE.BufferGeometry();
    this._cloud = new THREE.Points(this._cloudGeo, new THREE.PointsMaterial({
      color: 0x9fd4ff, size: 0.012, transparent: true, opacity: 0.55, depthWrite: false,
      sizeAttenuation: true }));
    this._cloud.frustumCulled = false;
    this._cloud.visible = false;
    this.room.add(this._cloud);
    this._light = new THREE.PointLight(0xeaf3ff, 1.6, 1.4, 1.6);
    this.room.add(this._light);
  }

  _bindKeys() {
    addEventListener("keydown", (ev) => {
      if (!this.active) return;
      if (ev.key === " ") { this._toggle(); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") this._seek(this._t + 1000);
      else if (ev.key === "ArrowLeft") this._seek(this._t - 1000);
      else if (ev.key === "ArrowDown") this._pick(this._sel + 1);
      else if (ev.key === "ArrowUp") this._pick(this._sel - 1);
    });
  }

  _list() {
    const all = (this.ctx.takes && this.ctx.takes()) || [];
    return all.filter((t) => t && t.id && t.has_data !== false).slice(0, ROWS);
  }

  enter() {
    super.enter();
    this.room.visible = true;
    this.ctx.audio.setBedLevel(0.6, 2.5);
    this.ctx.hand.setHalo(false);
    this.ctx.hand.setAura(false);
    // arrive playing the newest take (the demo flow: stop a take, open replay)
    const list = this._list();
    if (list.length && (!this._take || this._take.id !== list[0].id)) this._load(list[0], 0);
    else if (!list.length) this._status = "no takes yet - record one in capture";
  }

  exit() {
    super.exit();
    this.room.visible = false;
    this._playing = false;
  }

  _pick(i) {
    const list = this._list();
    if (!list.length) return;
    i = (i + list.length) % list.length;
    this._load(list[i], i);
  }

  _load(meta, sel) {
    this._sel = sel;
    this._take = meta;
    this._track = null;
    this._playing = false;
    this._cloud.visible = false;
    this._pending = { id: meta.id, t0: performance.now() };
    this._status = "loading " + meta.id + "…";
    this.ctx.tele.send({ cmd: "take_data", id: meta.id });
  }

  _onMessage(m) {
    if (!m || typeof m.kind !== "string") return;
    if (m.kind === "take_data" && this._pending && m.id === this._pending.id) {
      this._pending = null;
      this._ingest(m);
    } else if (m.kind === "env" && this._envPending && m.id === this._envPending.id) {
      const M = this._envPending.M;
      this._envPending = null;
      this._showCloud(m, M);
    } else if (m.kind === "ack" && m.event === "error") {
      if (this._pending && m.id === this._pending.id) {
        this._pending = null;
        this._status = "no replay data for " + m.id;
      } else if (this._envPending && m.id === this._envPending.id) {
        this._envPending = null;
        this._status = (this._status ? this._status + " · " : "") + "room not on the bridge";
      }
    }
  }

  _ingest(payload) {
    const parsed = parseTake(payload);
    if (!parsed) { this._status = "take has no usable rows"; return; }
    const hand = this.ctx.hand;
    // body-only takes need a live anchor; seed a default when none exists yet
    if (!hand.bodyAnchor.valid) {
      const p = hand.restPos;
      hand.bodyAnchor.setDefaultNeutralAt([p.x, p.y, p.z]);
    }
    const track = buildTrack(parsed, { liveAnchor: hand.bodyAnchor });
    if (!track || !track.frames.some((f) => f.pos)) {
      this._status = "take has no wrist path (orientation-only)";
      this._track = track; this._M = IDENTITY4;
      this._placement = "";
      this._drawRibbon();
      return;
    }
    const envId = payload.env || (this._take && this._take.env) || null;
    const presenting = this.ctx.world.renderer.xr.isPresenting;
    let M = null, placement;
    if (track.bodyOnly) { M = IDENTITY4; placement = "body model · your shoulder now"; }
    else if (envId && (M = roomFromEnv(envId))) placement = "anchored to " + envId;
    else if (!presenting) { M = IDENTITY4; placement = "desktop · recorded frame"; }
    else { M = recentreMatrix(track, 0, ANCHOR.z + 0.1); placement = "unanchored · recentred on the desk"; }
    this._M = M;
    this._qM = quatFromMatrix(M);
    this._placement = placement;
    this._track = track;
    this._t = 0;
    this._playing = true;
    // the whole path, in the room
    const pts = [];
    for (const f of track.frames) if (f.pos) pts.push(...this._toRoom(f.pos, f.inRoom));
    this._pathGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this._pathGeo.computeBoundingSphere();
    this._drawRibbon();
    const nV = track.frames.filter((f) => f.src === "vision").length;
    const nB = track.frames.filter((f) => f.src === "body").length;
    this._status = `${placement} · vision ${Math.round(100 * nV / track.frames.length)}% · body ${Math.round(100 * nB / track.frames.length)}%`;
    // the recorded room, only when it belongs to THIS room
    if (envId && roomFromEnv(envId)) {
      this._envPending = { id: envId, M: roomFromEnv(envId) };
      this.ctx.tele.send({ cmd: "env_get", id: envId });
    }
  }

  _toRoom(p, inRoom) { return inRoom ? p : applyToPoint(this._M, p); }

  _showCloud(envMsg, M) {
    let src = Array.isArray(envMsg.points) && envMsg.points.length ? envMsg.points : envMsg.positions;
    if (!Array.isArray(src) || src.length < 3) return;
    const n = Math.min(CLOUD_MAX, Math.floor(src.length / 3));
    const step = Math.max(1, Math.floor(src.length / 3 / n));
    const out = new Float32Array(n * 3);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const j = i * step * 3;
      const p = applyToPoint(M, [src[j], src[j + 1], src[j + 2]]);
      out[k++] = p[0]; out[k++] = p[1]; out[k++] = p[2];
    }
    this._cloudGeo.setAttribute("position", new THREE.BufferAttribute(out, 3));
    this._cloudGeo.computeBoundingSphere();
    this._cloud.visible = true;
    this._status = (this._status ? this._status + " · " : "") + `room ${envMsg.id} ✓`;
  }

  _drawRibbon() {
    const cv = this._ribCanvas, g = cv.getContext("2d");
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = "rgba(3,7,14,0.88)";
    g.beginPath(); g.roundRect(0, 0, cv.width, cv.height, 24); g.fill();
    const tr = this._track;
    if (tr && tr.frames.length && tr.durationMs > 0) {
      const col = { vision: "#66B8FF", body: "#FFB155", none: "#56606c" };
      const W = cv.width - 24;
      let x0 = 12, prev = tr.frames[0].src, prevT = 0;
      const flush = (tEnd, src) => {
        const xa = 12 + (prevT / tr.durationMs) * W, xb = 12 + (tEnd / tr.durationMs) * W;
        g.fillStyle = col[src] || col.none;
        g.fillRect(xa, 18, Math.max(1, xb - xa), 28);
        x0 = xb;
      };
      for (const f of tr.frames) {
        if (f.src !== prev) { flush(f.t, prev); prev = f.src; prevT = f.t; }
      }
      flush(tr.durationMs, prev);
      void x0;
    } else {
      g.fillStyle = "#2a3440"; g.fillRect(12, 18, cv.width - 24, 28);
    }
    this._ribTex.needsUpdate = true;
  }

  _toggle() {
    if (!this._track) { this._pick(this._sel); return; }
    if (!this._playing && this._t >= this._track.durationMs) this._t = 0;
    this._playing = !this._playing;
    this.ctx.audio.bell(4, this._playing ? 1 : 0, { gain: 0.10 });
  }

  _seek(tMs) {
    if (!this._track) return;
    this._t = clamp(tMs, 0, this._track.durationMs);
  }

  // ribbon point (world) -> playback time
  _seekToPoint(pWorld) {
    if (!this._track || !pWorld) return;
    this._tmp.copy(pWorld);
    this._rib.worldToLocal(this._tmp);
    this._seek((this._tmp.x / RIB_W + 0.5) * this._track.durationMs);
  }

  onHover(obj) { this._hover = keyOf(obj); }

  onSelect(obj, point) {
    const key = keyOf(obj);
    if (!key) return;
    if (key.startsWith("take:")) this._pick(parseInt(key.slice(5), 10));
    else if (key === "play") this._toggle();
    else if (key === "restart") { this._t = 0; this._playing = !!this._track; }
    else if (key === "ribbon") this._seekToPoint(point || this.ctx.hand.tips.index);
  }

  update(dt, snap, t) {
    const presenting = this.ctx.world.renderer.xr.isPresenting;
    const bb = this._breath.at(t);
    if (this._pending && performance.now() - this._pending.t0 > REQ_TIMEOUT_MS) {
      this._status = "no answer from the bridge for " + this._pending.id;
      this._pending = null;
    }
    const list = this._list();
    // the library can arrive after entering (a bridge that just connected)
    if (!this._take && !this._pending && list.length) this._load(list[0], 0);
    this._title.set(this._take ? `replay · ${this._take.task || this._take.id}` : "replay");
    this._title.spr.material.opacity = 0.95;
    this._statusUI.set(this._status || "");
    this._statusUI.spr.material.opacity += ((this._status ? 0.95 : 0) - this._statusUI.spr.material.opacity) * (1 - Math.exp(-dt * 5));
    for (let i = 0; i < ROWS; i++) {
      const tk = list[i], row = this._rows[i];
      const on = this._take && tk && tk.id === this._take.id;
      row.set(tk ? `${on ? "▶ " : ""}${(tk.task || tk.id).slice(0, 22)} · ${fmt(tk.duration_s || 0)}${tk.traj ? "" : " · no path"}` : "");
      const hov = this._hover === `take:${i}`;
      row.spr.material.opacity = tk ? (on ? 1 : 0.7) + (hov ? 0.2 : 0) : 0;
    }

    // XR scrub: the index tip on the ribbon drags the playhead
    if (presenting && this._track) {
      this._tmp.copy(this.ctx.hand.tips.index);
      this._rib.worldToLocal(this._tmp);
      if (Math.abs(this._tmp.x) < RIB_W / 2 && Math.abs(this._tmp.y) < RIB_H && Math.abs(this._tmp.z) < 0.035) {
        this._seek((this._tmp.x / RIB_W + 0.5) * this._track.durationMs);
      }
    }

    const tr = this._track;
    if (tr && this._playing) {
      this._t += dt * 1000;
      if (this._t > tr.durationMs) this._t = 0;       // loop: a demo keeps playing
    }
    const dur = tr ? tr.durationMs : 0;
    const frac = dur > 0 ? this._t / dur : 0;
    this._head.position.x = (frac - 0.5) * RIB_W;
    let srcWord = "";
    if (tr) {
      const s = sampleTrack(tr, this._t);
      srcWord = s.src;
      if (s.pos) {
        const inRoom = tr.frames[s.index].inRoom;
        const p = this._toRoom(s.pos, inRoom);
        // orientation: segment frame (the CAD twin's), rotated take -> room
        const q = inRoom ? s.segQuat : qmul(this._qM, s.segQuat);
        this._q.set(q[1], q[2], q[3], q[0]);
        // the CAD palm origin sits ~2 cm distal of the wrist pivot
        this._tmp.set(0, 0, 0.02).applyQuaternion(this._q).add(new THREE.Vector3(p[0], p[1], p[2]));
        this._hand.group.visible = true;
        this._hand.pose(this._tmp.multiplyScalar(TWIN_PRESENT), this._q, s.joints,
                        0.2 + 0.2 * bb, dt, null);
        this._hand.update(t);
        this._handGlow.position.set(p[0], p[1], p[2]);
        this._handGlow.material.opacity = 0.55 + 0.25 * bb;
        this._light.position.set(p[0] + 0.25, p[1] + 0.35, p[2] + 0.25);
      } else {
        this._hand.group.visible = false;
        this._handGlow.material.opacity = 0;
      }
    } else {
      this._hand.group.visible = false;
      this._handGlow.material.opacity = 0;
    }
    this._timeUI.set(tr ? `${fmt(this._t / 1000)} / ${fmt(dur / 1000)}${srcWord ? " · " + srcWord : ""}` : "");
    this._timeUI.spr.material.opacity = tr ? 0.95 : 0;

    // buttons breathe; the play word swaps with the state
    const hov = this._hover;
    for (const b of [this._play, this._restart]) {
      const k = b === this._play ? "play" : "restart";
      b.ring.scale.setScalar(0.042 * (1 + bb * 0.12 + (hov === k ? 0.3 : 0)));
      b.core.material.opacity = 0.45 + bb * 0.3;
      b.ring.material.opacity = 0.45 + (hov === k ? 0.3 : 0);
    }
    this._play.core.material.color.setHex(this._playing ? OK : AQUA);
    this._play.word.material.opacity = this._playing ? 0 : 0.9;
    this._pauseWord.material.opacity = this._playing ? 0.9 : 0;
    this._restart.word.material.opacity = 0.8;
    this._path.material.opacity = 0.3 + 0.15 * bb;

    if (!presenting) this.ctx.hand.rest();
  }
}
