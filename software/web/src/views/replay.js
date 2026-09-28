// replay.js - 4D SESSION REPLAY: a recorded take played back as the whole
// arm, in space, inside the room the headset scanned while it was captured.
//
// Four data paths, chosen per take from the columns it actually carries (the
// take_data payload names its columns; nothing here indexes past the frozen
// first 34 by position):
//   body      v16 takes (b_* columns, MOTION_PIPELINE.md s.7): elbow + wrist in
//             the body frame (shoulder origin, Y up) and both segment
//             quaternions. The full arm replays: upper arm, forearm module on
//             its elbow, hand on its wrist, the arm translating with the
//             shoulder. With headset vision in the same take, the body frame
//             is fitted into the room (yaw from the hand quaternions,
//             translation from the wrist positions) and the room scan shows.
//   vision    older AR takes: the headset's wrist pose (px.., pq..) in the
//             room; the forearm follows from the IMUs' hand-vs-forearm angle.
//   inertial  v7 bench takes: the hand IMU's integrated displacement. It is in
//             the IMU's own Z-up world (converted to Y-up here) and hangs off a
//             FIXED anchor - it used to hang off the camera focus, which chased
//             the hand, so the path ran away. Drifts, and says so.
//   orient    no translation at all: the contract's zero-evidence arm (upper
//             arm hanging, forearm pivoting at the elbow), labelled as such.
//
// The rig is the REAL device GLB (mm -> m), articulated by the shared
// kinematics the live twins use, with the same measured wrist pivot.

import * as THREE from "../../vendor/three.module.js";
import { el, clamp, lerp, toast } from "../ui.js";
import { store } from "../store.js";
import { loadHand } from "../twin.js";
import { fingerPose } from "../kinematics.js";
import { sourceBadges } from "../sim_badge.js";
import {
  WRIST_PIVOT_MM, L_FA_M, HAND_PALM_M, qMul, qConj, qRot, qNlerp, qValid, qAxisAngle,
  vAdd, vSub, vLerp, synthBody, wristAnglesDeg, worldZupToBody, yawDeg, D2R,
} from "../arm_model.js";

const FINGERS = ["index", "middle", "ring", "pinky"];
const FLOOR_Y_M = -0.70;                         // body-frame reference floor (as the live twin)
const INERTIAL_ANCHOR = [0, -0.30, 0.26];        // fixed stage point for inertial takes (neutral wrist)

// capture -> replay handoff (module state survives the hash navigation)
let _requestedTake = null;
export function setReplayTake(id) { _requestedTake = id; }

let _styled = false;
function styleOnce() {
  if (_styled) return;
  _styled = true;
  const css = `
  .rp-root { position:fixed; inset:0; background:#0B0E13; color:#C8D4E0; z-index:40;
    font-family:inherit; display:flex; flex-direction:column; }
  .rp-top { display:flex; align-items:center; gap:14px; padding:12px 18px;
    border-bottom:1px solid rgba(140,170,200,0.14); }
  .rp-back { color:#7FA8C8; text-decoration:none; font-size:13px; letter-spacing:0.06em; }
  .rp-back:hover { color:#AECBE4; }
  .rp-title { font-size:13px; letter-spacing:0.12em; text-transform:uppercase; color:#8FA6BA; }
  .rp-title b { color:#E4ECF4; font-weight:650; }
  .rp-chip { font-family:"SF Mono",ui-monospace,monospace; font-size:11px; padding:3px 9px;
    border:1px solid rgba(140,170,200,0.25); border-radius:99px; color:#9FB8CE; }
  .rp-chip.warn { color:#E0A060; border-color:rgba(224,160,96,0.4); }
  .rp-stage { position:relative; flex:1; min-height:0; }
  .rp-stage canvas { display:block; }
  .rp-hud { position:absolute; top:14px; right:16px; text-align:right;
    font-family:"SF Mono",ui-monospace,monospace; font-size:11px; line-height:1.75;
    color:#9FB8CE; pointer-events:none; white-space:pre; }
  .rp-hud b { color:#E4ECF4; font-weight:600; }
  .rp-state { position:absolute; inset:0; display:flex; align-items:center;
    justify-content:center; text-align:center; color:#8FA6BA; font-size:14px; }
  .rp-state .card { max-width:460px; line-height:1.6; background:rgba(16,22,30,0.94); color:#C8D4E0;
    border:1px solid rgba(140,170,200,0.18); border-radius:14px; padding:18px 20px; box-shadow:0 24px 64px rgba(0,0,0,0.45); }
  .rp-pick b { color:#E4ECF4; font-weight:600; text-align:left; min-width:120px; }
  .rp-pick .mono { text-align:left; }
  .rp-state a { color:#7FA8C8; }
  .rp-bottom { border-top:1px solid rgba(140,170,200,0.14); padding:10px 18px 14px;
    display:flex; align-items:center; gap:14px; }
  .rp-btn { background:none; border:1px solid rgba(140,170,200,0.3); color:#C8D4E0;
    border-radius:8px; padding:7px 14px; font-size:13px; cursor:pointer; font-family:inherit; }
  .rp-btn:hover { border-color:#7FA8C8; color:#fff; }
  .rp-btn.primary { border-color:#C9401B; color:#FF7B52; }
  .rp-speed { display:flex; gap:4px; }
  .rp-speed .rp-btn { padding:5px 9px; font-size:11px; font-family:"SF Mono",monospace; }
  .rp-speed .rp-btn.on { background:rgba(201,64,27,0.18); border-color:#C9401B; color:#FF9B7A; }
  .rp-time { font-family:"SF Mono",ui-monospace,monospace; font-size:12px; color:#9FB8CE;
    min-width:118px; text-align:right; }
  .rp-strip { flex:1; height:56px; position:relative; cursor:crosshair; }
  .rp-strip canvas { position:absolute; inset:0; width:100%; height:100%; border-radius:6px; }
  .rp-picker { display:flex; flex-direction:column; gap:8px; margin-top:14px; }
  .rp-pick { background:rgba(140,170,200,0.06); border:1px solid rgba(140,170,200,0.18);
    border-radius:8px; padding:9px 14px; cursor:pointer; color:#C8D4E0; font-size:13px;
    display:flex; gap:12px; align-items:baseline; font-family:inherit; }
  .rp-pick:hover { border-color:#7FA8C8; }
  .rp-pick .mono { font-family:"SF Mono",monospace; font-size:11px; color:#8FA6BA; }
  .rp-top { flex-wrap:wrap; row-gap:8px; }
  .rp-spacer { flex:1; }
  .rp-linkbtn { background:none; border:0; padding:0; color:#7FA8C8; font:inherit; cursor:pointer;
    text-decoration:underline; text-underline-offset:3px; }
  .rp-linkbtn:hover { color:#AECBE4; }
  .rp-top .mock-badge { font-size:10px; padding:4px 10px; }
  @media (max-width:720px) {
    .rp-top { padding:10px 12px; gap:8px; }
    .rp-chip { font-size:10px; }
    .rp-bottom { flex-wrap:wrap; padding:10px 12px 12px; gap:10px; }
    .rp-strip { flex-basis:100%; order:3; }
    .rp-hud { font-size:10px; top:8px; right:10px; }
  }
  `;
  document.head.append(el("style", null, css));
}

// ---------------------------------------------------------------------------
// replay rig: the whole device (forearm module + hand) on a faint limb, in
// metres. forearm group = the forearm segment frame (+Z distal); hand group =
// the hand frame, hung at the measured wrist pivot, rotated by inv(Qf)*Qh.
// ---------------------------------------------------------------------------
class ReplayRig {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();                // world
    this.fore = new THREE.Group();                // forearm segment frame (m)
    this.hand = new THREE.Group();                // hand frame, at the wrist pivot
    this.pivot = new THREE.Vector3(...WRIST_PIVOT_MM).multiplyScalar(0.001);
    this.hand.position.copy(this.pivot);
    this.fore.add(this.hand);
    this.root.add(this.fore);
    scene.add(this.root);
    this.ready = false;
    this._q = new THREE.Quaternion();
    this._qf = new THREE.Quaternion();
    this._qh = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._fingers = {};
    // subject lamp: rides the forearm so the device is lit wherever it goes
    const lamp = new THREE.PointLight(0xFFE9CE, 0.45, 3, 2);
    lamp.position.set(0.25, 0.3, 0.1);
    this.fore.add(lamp);
    this._buildLimb();
    loadHand().then((gltf) => this._build(gltf));
    this._buildThumb();
  }

  _build(gltf) {
    const model = gltf.scene.clone(true);
    // bone, not metal: without an environment map a metallic material
    // renders near-black and vanishes into the #0B0E13 stage
    const bone = new THREE.MeshStandardMaterial({
      color: 0xE8E1D0, metalness: 0.1, roughness: 0.5, emissive: 0x3A342A, emissiveIntensity: 0.55 });
    const shell = new THREE.MeshStandardMaterial({
      color: 0x9AA6B4, metalness: 0.15, roughness: 0.55, emissive: 0x1E2630, emissiveIntensity: 0.6 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x0B1016, metalness: 0.0, roughness: 0.15, emissive: 0x2A5E92, emissiveIntensity: 0.35 });
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.name === "screen" ? glass
        : (o.name === "forearm" || o.name === "forearm_cover" || o.name === "motors"
           || o.name === "internals" || o.name.startsWith("spool_")) ? shell : bone;
    });
    const mmF = new THREE.Group(); mmF.scale.setScalar(0.001);
    const mmH = new THREE.Group(); mmH.scale.setScalar(0.001);
    mmH.position.copy(this.pivot).negate();          // hand model hangs from the pivot
    for (const n of ["forearm", "forearm_cover", "motors", "internals", "screen",
                     "spool_a0", "spool_a1", "spool_a2", "spool_a3", "spool_a4",
                     "spool_b0", "spool_b1", "spool_b2", "spool_b3", "spool_b4"]) {
      const o = model.getObjectByName(n);
      if (o) mmF.add(o);
    }
    const palm = model.getObjectByName("palm");
    if (!palm) return;
    mmH.add(palm);
    this.fore.add(mmF);
    this.hand.add(mmH);
    if (this._thumbRoot) palm.add(this._thumbRoot);
    for (const f of FINGERS) {
      const j = (n) => {
        const node = palm.getObjectByName(n);
        return node ? { node, baseQuat: node.quaternion.clone(), baseZ: node.position.z } : null;
      };
      this._fingers[f] = {
        ab: j(`${f}_mcp`), mcp: j(`${f}_pip`), pip: j(`${f}_dip`),
        knuckle: j(`${f}_mcp_slide`),
        mid: j(`${f}_pip_mid`), slide: j(`${f}_pip_slide`), cradle: j(`${f}_dip_slide`),
      };
    }
    this.ready = true;
  }

  // the arm the device is worn on: translucent limb + bone line + joint balls
  _buildLimb() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x9DB6D2, transparent: true, opacity: 0.13,
      roughness: 0.7, depthWrite: false });
    const jm = new THREE.MeshStandardMaterial({ color: 0xB5C9DF, transparent: true, opacity: 0.22,
      roughness: 0.6, depthWrite: false });
    const cyl = (rt, rb) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, 1, 24, 1, true), mat);
      this.scene.add(m);
      return m;
    };
    this.upper = cyl(0.034, 0.040);
    this.foreLimb = cyl(0.024, 0.032);
    const ball = (r) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), jm); this.scene.add(m); return m; };
    this.jS = ball(0.044);
    this.jE = ball(0.034);
    for (const m of [this.upper, this.foreLimb, this.jS, this.jE]) m.visible = false;   // until posed
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    this.bones = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x66B8FF, transparent: true, opacity: 0.6 }));
    this.bones.frustumCulled = false;
    this.bones.visible = false;
    this.scene.add(this.bones);
    this._up = new THREE.Vector3(0, 1, 0);
  }

  _seg(mesh, a, b) {
    if (!a || !b) { mesh.visible = false; return; }
    const d = this._v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length();
    if (len < 1e-5) { mesh.visible = false; return; }
    mesh.visible = true;
    mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(this._up, d.divideScalar(len));
  }

  // vision thumb (2026-07-20): the device GLB has no thumb - the mechanism is
  // thumb-out by scope - but the Quest's hand tracking measures the wearer's
  // thumb ([palmar abduction, MCP flexion, IP flexion]). Rendered as a
  // deliberately SCHEMATIC ghost chain (sapphire, translucent) so it can never
  // be mistaken for device hardware. Hidden whenever the take has no thumb.
  _buildThumb() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x66B8FF, transparent: true, opacity: 0.65,
      emissive: 0x2A5E92, emissiveIntensity: 1.0, roughness: 0.4,
    });
    const seg = (len, r) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
      m.rotation.x = Math.PI / 2;          // capsule Y-axis -> +Z (distal)
      m.position.z = len / 2;
      return m;
    };
    // palm-local mm (the palm node lives inside the mm scaler)
    const root = new THREE.Group();
    root.position.set(36, 0, 44);          // CMC anchor at the palm's thumb edge
    root.rotation.y = 0.9;                 // base direction: mostly +X, part +Z
    this._thumbAb = new THREE.Group();
    this._thumbMcp = new THREE.Group();
    this._thumbMcp.position.z = 44;
    this._thumbIp = new THREE.Group();
    this._thumbIp.position.z = 32;
    this._thumbAb.add(seg(44, 5), this._thumbMcp);
    this._thumbMcp.add(seg(32, 4.4), this._thumbIp);
    this._thumbIp.add(seg(26, 4));
    root.add(this._thumbAb);
    root.visible = false;
    this._thumbRoot = root;
  }

  poseThumb(thumb) {
    if (!this._thumbRoot) return;
    if (!thumb || thumb[0] == null) { this._thumbRoot.visible = false; return; }
    this._thumbRoot.visible = true;
    this._thumbAb.rotation.set(thumb[0] * D2R, 0, 0);
    this._thumbMcp.rotation.set(0, -thumb[1] * D2R, 0);
    this._thumbIp.rotation.set(0, -thumb[2] * D2R, 0);
  }

  /**
   * p = { joints: {finger: [ab, mcp, pip]}, fq, hq (world [w,x,y,z]),
   *       wrist (world m), elbow|null, shoulder|null }
   */
  pose(p) {
    this._qf.set(p.fq[1], p.fq[2], p.fq[3], p.fq[0]);
    this._qh.set(p.hq[1], p.hq[2], p.hq[3], p.hq[0]);
    this.fore.quaternion.copy(this._qf);
    this.hand.quaternion.copy(this._qf).invert().multiply(this._qh);
    // model wrist pivot onto the wrist position
    const rp = this._v.copy(this.pivot).applyQuaternion(this._qf);
    this.fore.position.set(p.wrist[0] - rp.x, p.wrist[1] - rp.y, p.wrist[2] - rp.z);
    this._seg(this.upper, p.shoulder, p.elbow);
    this._seg(this.foreLimb, p.elbow, p.wrist);
    this.jS.visible = !!p.shoulder; if (p.shoulder) this.jS.position.set(...p.shoulder);
    this.jE.visible = !!p.elbow; if (p.elbow) this.jE.position.set(...p.elbow);
    const bp = this.bones.geometry.attributes.position;
    const a = p.shoulder || p.elbow || p.wrist, b = p.elbow || p.wrist;
    bp.setXYZ(0, ...a); bp.setXYZ(1, ...b); bp.setXYZ(2, ...p.wrist);
    bp.needsUpdate = true;
    this.bones.visible = !!p.elbow;
    if (!this.ready) return;
    for (const f of FINGERS) {
      const jf = this._fingers[f], [ab, mcp, pip] = p.joints[f];
      if (!jf || !jf.mcp) continue;
      const set = (bnd, axis, deg) => {
        if (!bnd) return;
        this._q.setFromAxisAngle(axis, deg * D2R);
        bnd.node.quaternion.copy(bnd.baseQuat).multiply(this._q);
      };
      set(jf.ab, ReplayRig._Y, ab);
      set(jf.mcp, ReplayRig._X, mcp);
      set(jf.pip, ReplayRig._X, pip);
      const fp = fingerPose(f, ab, mcp, pip);
      if (jf.knuckle) jf.knuckle.node.position.z = jf.knuckle.baseZ + fp.slideKnuckleMm;
      if (jf.mcp) jf.mcp.node.position.z = jf.mcp.baseZ + fp.slideKnuckleMm;
      if (jf.mid) jf.mid.node.position.z = jf.mid.baseZ + fp.slideMcpMidMm;
      if (jf.slide) jf.slide.node.position.z = jf.slide.baseZ + fp.slideMcpMm;
      if (jf.pip) jf.pip.node.position.z = jf.pip.baseZ + fp.slideMcpMm;
      if (jf.cradle) jf.cradle.node.position.z = jf.cradle.baseZ + fp.slidePipMm;
    }
  }
}
ReplayRig._X = new THREE.Vector3(1, 0, 0);
ReplayRig._Y = new THREE.Vector3(0, 1, 0);

// a world-fixed reference grid (same idea as the live twin's floor)
function makeGrid(size = 6) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uCenter: { value: new THREE.Vector2() }, uFade: { value: 1.6 } },
    vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec2 uCenter; uniform float uFade; varying vec3 vW;
      float gl(vec2 c) { vec2 d = abs(fract(c - 0.5) - 0.5) / fwidth(c); return 1.0 - min(min(d.x, d.y), 1.0); }
      void main() {
        vec2 c = vW.xz / 0.1;
        float g = max(gl(c) * 0.5, gl(c / 5.0));
        float fade = 1.0 - smoothstep(uFade * 0.3, uFade, length(vW.xz - uCenter));
        float a = g * fade * 0.28;
        if (a < 0.003) discard;
        gl_FragColor = vec4(0.40, 0.60, 0.80, a);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  m.rotation.x = -Math.PI / 2;
  return m;
}

export function mountReplay(rootHost) {
  styleOnce();
  const cleanups = [];
  const root = el("div", { class: "rp-root" });

  const title = el("span", { class: "rp-title" }, "Session replay");
  const chipEnv = el("span", { class: "rp-chip" }, "-");
  const chipMode = el("span", { class: "rp-chip" }, "-");
  const chipHand = el("span", { class: "rp-chip" }, "-");
  const chipCal = el("span", { class: "rp-chip" }, "-");
  chipCal.style.display = "none";
  const [simBadge, linkBadge] = sourceBadges(cleanups);
  const fileInput = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
  const btnOpen = el("button", { class: "rp-btn", type: "button",
    title: "Replay a take file from disk (a take_data JSON, e.g. software/bridge/samples or an export from Capture)" }, "Open file…");
  btnOpen.addEventListener("click", () => fileInput.click());
  const btnPick = el("button", { class: "rp-btn", type: "button" }, "Takes");
  btnPick.addEventListener("click", () => { playing = false; btnPlay.textContent = "Play"; offerPicker(true); });
  const top = el("div", { class: "rp-top" },
    el("a", { class: "rp-back", href: "#/capture" }, "← Capture"),
    title, chipEnv, chipMode, chipHand, chipCal,
    el("span", { class: "rp-spacer" }), simBadge, linkBadge, btnPick, btnOpen, fileInput);

  const stage = el("div", { class: "rp-stage" });
  const hud = el("div", { class: "rp-hud" });
  const stateHost = el("div");
  stage.append(hud, stateHost);

  const btnPlay = el("button", { class: "rp-btn primary" }, "Play");
  const timeEl = el("span", { class: "rp-time" }, "0.00 / 0.00 s");
  const speeds = [0.25, 0.5, 1, 2].map((s) =>
    el("button", { class: "rp-btn" + (s === 1 ? " on" : ""), "data-s": s }, s + "×"));
  const strip = el("div", { class: "rp-strip" });
  const stripCanvas = el("canvas");
  strip.append(stripCanvas);
  const bottom = el("div", { class: "rp-bottom" },
    btnPlay, el("span", { class: "rp-speed" }, ...speeds), strip, timeEl);

  root.append(top, stage, bottom);
  rootHost.append(root);

  const showState = (content) => {
    stateHost.innerHTML = "";
    stateHost.append(el("div", { class: "rp-state" }, el("div", { class: "card" }, content)));
  };
  const clearState = () => { stateHost.innerHTML = ""; };

  // ---- three stage -------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x0b0e13);
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b0e13, 6, 14);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 60);

  scene.add(new THREE.AmbientLight(0x8090a8, 1.1));
  const key = new THREE.DirectionalLight(0xdde8ff, 1.6);
  key.position.set(2, 4, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7FD4FF, 0.9);   // cool edge, lifts the silhouette
  rim.position.set(-2, 1.5, -3);
  scene.add(rim);

  const resize = () => {
    const w = stage.clientWidth || 800, h = stage.clientHeight || 500;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // world-size -> pixel-size factor for the cloud points (fov 50 deg)
    if (cloudMat) cloudMat.uniforms.uScale.value = h / (2 * Math.tan(0.4363));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  cleanups.push(() => ro.disconnect());

  // orbit: drag = yaw/pitch about the focus, wheel = dolly. The focus GLIDES
  // to the arm every frame (see loop). Positions never depend on the focus, so
  // the glide cannot feed back into the path (the old inertial runaway).
  let yaw = -1.15, pitch = 0.32, dist = 1.25;
  const focus = new THREE.Vector3(0, -0.2, 0.2);
  const focusGoal = new THREE.Vector3(0, -0.2, 0.2);
  const applyCam = () => {
    camera.position.set(
      focus.x + dist * Math.cos(pitch) * Math.sin(yaw),
      focus.y + dist * Math.sin(pitch),
      focus.z + dist * Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(focus);
  };
  applyCam();
  let drag = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!drag) return;
    yaw -= (e.clientX - drag.x) * 0.005;
    pitch = clamp(pitch + (e.clientY - drag.y) * 0.004, -0.2, 1.35);
    drag = { x: e.clientX, y: e.clientY };
    applyCam();
  });
  renderer.domElement.addEventListener("pointerup", () => { drag = null; });
  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    dist = clamp(dist * (1 + e.deltaY * 0.0012), 0.25, 9);
    applyCam();
  }, { passive: false });

  const rig = new ReplayRig(scene);
  const grid = makeGrid();
  scene.add(grid);
  grid.visible = false;

  // ---- data --------------------------------------------------------------
  let rows = null, cols = null, ix = {}, envMeta = null, takeMeta = null;
  let jointSource = null, hasThumb = false;
  let mode = null;                      // "body" | "vision" | "inertial" | "orient"
  let bodyToWorld = null;               // {q (yaw), t} when the body frame is fitted into the room
  let loadToken = 0;                    // a newer load wins over a late answer
  const sceneExtras = [];               // per-take objects, removed on the next load

  const col = (r, name) => (ix[name] != null ? r[ix[name]] : null);
  const vec = (r, a, b, c) => {
    const x = col(r, a), y = col(r, b), z = col(r, c);
    return x == null || y == null || z == null ? null : [x, y, z];
  };
  const quat = (r, w, x, y, z) => qValid([col(r, w), col(r, x), col(r, y), col(r, z)]);
  const applyBW = (p) => {
    if (!p || !bodyToWorld) return p;
    return vAdd(qRot(bodyToWorld.q, p), bodyToWorld.t);
  };
  const applyBWq = (q) => (bodyToWorld ? qMul(bodyToWorld.q, q) : q);

  // ONE place that answers "where is the arm in this row", for every call site
  // (pose, trajectory, strip ticks, cloud origin), so the paths cannot drift.
  function armAt(r) {
    const fq0 = quat(r, "fq_w", "fq_x", "fq_y", "fq_z") || [1, 0, 0, 0];
    const hq0 = quat(r, "hq_w", "hq_x", "hq_y", "hq_z") || fq0;
    if (mode === "body") {
      const fq = quat(r, "b_fq_w", "b_fq_x", "b_fq_y", "b_fq_z") || fq0;
      const hq = quat(r, "b_hq_w", "b_hq_x", "b_hq_y", "b_hq_z") || hq0;
      const elbow = vec(r, "b_ex", "b_ey", "b_ez");
      const wrist = vec(r, "b_wx", "b_wy", "b_wz");
      if (!wrist) return null;
      return { fq: applyBWq(fq), hq: applyBWq(hq), wrist: applyBW(wrist), elbow: applyBW(elbow),
               shoulder: applyBW([0, 0, 0]), rawF: fq, rawH: hq };
    }
    if (mode === "vision") {
      const px = vec(r, "px", "py", "pz");
      const pq = quat(r, "pq_w", "pq_x", "pq_y", "pq_z");
      if (!px || !pq) return null;
      // the headset gives the hand; the IMUs give the hand-vs-forearm angle
      const fq = qMul(qMul(pq, qConj(hq0)), fq0);
      const elbow = vSub(px, qRot(fq, [0, 0, L_FA_M]));
      return { fq, hq: pq, wrist: px, elbow, shoulder: null, rawF: fq0, rawH: hq0 };
    }
    if (mode === "inertial") {
      const d = vec(r, "ihx", "ihy", "ihz");
      if (!d) return null;
      // hand displacement in the IMU's Z-up world, mm -> body Y-up, m, off a FIXED anchor
      const wrist = vAdd(INERTIAL_ANCHOR, worldZupToBody(d).map((v) => v / 1000));
      return { fq: fq0, hq: hq0, wrist, elbow: vSub(wrist, qRot(fq0, [0, 0, L_FA_M])),
               shoulder: null, rawF: fq0, rawH: hq0 };
    }
    const sb = synthBody(fq0, hq0);
    return { fq: fq0, hq: hq0, wrist: sb.wrist_m, elbow: sb.elbow_m, shoulder: sb.shoulder_m, rawF: fq0, rawH: hq0 };
  }
  const handOf = (a) => vAdd(a.wrist, qRot(a.hq, HAND_PALM_M));

  let t0 = 0, t1 = 1, T = 0, playing = false, speed = 1;
  let trajLine = null, headDot = null, trajIdx = null;

  const fmt = (ms) => ((ms - t0) / 1000).toFixed(2);
  const updateChips = () => {
    const needsEnv = mode === "vision" || (mode === "body" && bodyToWorld);
    chipEnv.textContent = envMeta
      ? `env ${envMeta.name}` + (envMeta.pts ? ` · ${envMeta.pts} pts` : "") + (envMeta.tris ? ` · ${envMeta.tris} tris` : "")
      : takeMeta && takeMeta.env && !needsEnv ? "room not anchored (no headset pose)"
      : "no environment";
    chipEnv.classList.toggle("warn", !envMeta);
    // which translation the stage is drawing, never just "it moves"
    chipMode.textContent = mode === "body"
      ? (bodyToWorld ? "arm · body model, fitted to headset vision" : "arm · body model")
      : mode === "vision" ? "6-DoF · headset vision"
      : mode === "inertial" ? "6-DoF · inertial (drifts)"
      : "orientation only · arm synthesised";
    chipMode.classList.toggle("warn", mode === "inertial" || mode === "orient");
    chipHand.textContent = (jointSource === "quest-hand" ? "hand · Quest vision"
      : jointSource === "encoders" ? "hand · encoders"
      : jointSource === "sim" ? "hand · sim" : "hand · unlabelled")
      + (hasThumb ? " +thumb" : "");
    chipHand.classList.toggle("warn", jointSource === "sim" || !jointSource);
  };

  // the void becomes the room: the scanned cloud blooms outward from the
  // take's first wrist position - a wavefront of light re-drawing the space
  // the recording happened in. Height grades the ink (floor deep, structures
  // bright); each point's opacity is its OBSERVATION COUNT (how many depth
  // samples confirmed that surface) - honest confidence, not decoration.
  let cloudMat = null, revealT0 = 0;
  function buildCloud(env) {
    const n = env.points.length / 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(env.points, 3));
    const w = new Float32Array(n);
    const src = env.weights || [];
    for (let i = 0; i < n; i++) w[i] = Math.min(1, (src[i] || 1) / 6);
    geo.setAttribute("aW", new THREE.BufferAttribute(w, 1));
    // reveal origin: where the hand's story starts (fallback: stage focus)
    let org = [focus.x, focus.y, focus.z];
    if (rows) {
      for (const r of rows) { const a = armAt(r); if (a) { org = a.wrist; break; } }
    }
    let maxD = 0.5;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(env.points[i * 3] - org[0], env.points[i * 3 + 1] - org[1],
                           env.points[i * 3 + 2] - org[2]);
      if (d > maxD) maxD = d;
    }
    cloudMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uReveal: { value: 0 },
        uMaxD: { value: maxD },
        uOrigin: { value: new THREE.Vector3(org[0], org[1], org[2]) },
        uScale: { value: 400 },
      },
      vertexShader: `
        attribute float aW;
        uniform float uReveal; uniform float uMaxD; uniform vec3 uOrigin; uniform float uScale;
        varying float vA; varying float vFlash; varying float vH;
        void main() {
          float d = distance(position, uOrigin);
          float front = uReveal * (uMaxD + 0.6);
          vA = smoothstep(front, front - 0.55, d) * (0.30 + 0.60 * aW);
          vFlash = exp(-pow((front - d) / 0.30, 2.0)) * step(d, front);
          vH = position.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp((0.009 + 0.007 * aW + 0.012 * vFlash) * uScale / max(0.2, -mv.z), 1.0, 7.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA; varying float vFlash; varying float vH;
        void main() {
          if (vA + vFlash < 0.01) discard;
          vec2 c = gl_PointCoord - 0.5;
          float m = 1.0 - smoothstep(0.30, 0.5, length(c));
          float h = clamp(vH / 2.1, 0.0, 1.0);
          vec3 low = vec3(0.149, 0.275, 0.420);   // deep sapphire ink (floor)
          vec3 mid = vec3(0.400, 0.722, 1.000);   // #66B8FF sapphire
          vec3 hi  = vec3(0.847, 0.925, 1.000);   // pale ceiling light
          vec3 col = h < 0.5 ? mix(low, mid, h * 2.0) : mix(mid, hi, h * 2.0 - 1.0);
          col = mix(col, vec3(1.0, 0.95, 0.85), vFlash);   // warm wavefront
          gl_FragColor = vec4(col, m * min(1.0, vA + vFlash));
        }`,
    });
    const pts = new THREE.Points(geo, cloudMat);
    pts.frustumCulled = false;
    scene.add(pts);
    revealT0 = performance.now();
    resize();                       // seat uScale for the new material
    sceneExtras.push(() => { scene.remove(pts); geo.dispose(); if (cloudMat) cloudMat.dispose(); cloudMat = null; });
  }

  function buildEnv(env) {
    const hasCloud = env.points && env.points.length >= 3;
    if (hasCloud) buildCloud(env);
    if (env.positions && env.positions.length && env.indices && env.indices.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(env.positions, 3));
      geo.setIndex(env.indices);
      // with a cloud present the mesh recedes to a faint structural drawing
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x3d6e8f, transparent: true,
          opacity: hasCloud ? 0.14 : 0.34 }));
      scene.add(wire);
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        color: 0x5f8aa8, size: 0.012, transparent: true,
        opacity: hasCloud ? 0.10 : 0.24 }));
      scene.add(pts);
      sceneExtras.push(() => { scene.remove(wire, pts); geo.dispose(); });
    }
  }


  function buildTraj() {
    const P = [];
    trajIdx = new Int32Array(rows.length);
    const step = rows.length > 1600 ? 2 : 1;
    for (let i = 0; i < rows.length; i++) {
      if (i % step === 0) {
        const a = armAt(rows[i]);
        if (a) { const h = handOf(a); P.push(h[0], h[1], h[2]); }
      }
      trajIdx[i] = P.length / 3;
    }
    if (P.length < 6) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    const dim = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x7a4030, transparent: true, opacity: 0.5 }));
    trajLine = new THREE.Line(geo.clone(), new THREE.LineBasicMaterial({ color: 0xc9401b }));
    trajLine.geometry.setDrawRange(0, 0);
    scene.add(dim, trajLine);
    headDot = new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xff7b52 }));
    scene.add(headDot);
    sceneExtras.push(() => { scene.remove(dim, trajLine, headDot); geo.dispose(); trajLine = null; headDot = null; });
  }

  // strip: mean flexion (oxide), activation (honey), pose presence (cyan tick)
  function drawStrip(playX) {
    const c = stripCanvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = strip.clientWidth || 400, h = strip.clientHeight || 56;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(140,170,200,0.06)";
    g.fillRect(0, 0, w, h);
    if (!rows) return;
    const n = rows.length;
    const every = Math.max(1, Math.floor(n / (w * 1.5)));
    const flexAt = (r) => {
      let s = 0;
      for (const f of FINGERS) s += (col(r, `${f}_pip`) || 0) + (col(r, `${f}_dip`) || 0);
      return s / (8 * 100);                    // 0..1 over the 90/110 stops
    };
    g.strokeStyle = "#C9401B"; g.lineWidth = 1.4; g.beginPath();
    for (let i = 0; i < n; i += every) {
      const x = (i / (n - 1)) * w, y = h - 4 - clamp(flexAt(rows[i]), 0, 1) * (h - 12);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    if (ix.act != null) {
      g.strokeStyle = "rgba(192,131,39,0.8)"; g.lineWidth = 1; g.beginPath();
      for (let i = 0; i < n; i += every) {
        const x = (i / (n - 1)) * w, y = h - 4 - clamp(col(rows[i], "act") || 0, 0, 1) * (h - 12);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    if (trajIdx) {
      g.fillStyle = "rgba(95,138,168,0.5)";
      for (let i = 1; i < n; i += every * 2) {
        if (trajIdx[i] > trajIdx[Math.max(0, i - every * 2)] || i < every * 2) g.fillRect((i / (n - 1)) * w, h - 3, 1.5, 3);
      }
    }
    g.fillStyle = "#E4ECF4";
    g.fillRect(playX * w - 0.75, 0, 1.5, h);
  }

  // ---- playback ----------------------------------------------------------
  const rowAt = (t) => {
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid][0] < t) lo = mid + 1; else hi = mid;
    }
    return Math.max(0, lo - 1);
  };
  const lerpCol = (a, b, k, name) => {
    const x = col(a, name), y = col(b, name);
    return x == null ? y : y == null ? x : lerp(x, y, k);
  };

  let lastArm = null;
  function applyT() {
    if (!rows) return;
    T = clamp(T, t0, t1);
    const i = rowAt(T), a = rows[i], b = rows[Math.min(i + 1, rows.length - 1)];
    const span = Math.max(1, b[0] - a[0]);
    const k = clamp((T - a[0]) / span, 0, 1);
    const joints = {};
    for (const f of FINGERS) {
      joints[f] = [lerpCol(a, b, k, `${f}_mcp`) || 0, lerpCol(a, b, k, `${f}_pip`) || 0, lerpCol(a, b, k, `${f}_dip`) || 0];
    }
    let thumb = null;
    if (hasThumb && col(a, "thumb_abd") != null) {
      thumb = ["thumb_abd", "thumb_mcp", "thumb_ip"].map((n) => lerpCol(a, b, k, n));
    }
    rig.poseThumb(thumb);
    const A = armAt(a), B = armAt(b) || A;
    if (A) {
      const arm = {
        joints,
        fq: qNlerp(A.fq, B.fq, k), hq: qNlerp(A.hq, B.hq, k),
        wrist: vLerp(A.wrist, B.wrist, k),
        elbow: A.elbow && B.elbow ? vLerp(A.elbow, B.elbow, k) : A.elbow,
        shoulder: A.shoulder && B.shoulder ? vLerp(A.shoulder, B.shoulder, k) : A.shoulder,
        rawF: qNlerp(A.rawF, B.rawF, k), rawH: qNlerp(A.rawH, B.rawH, k),
      };
      rig.pose(arm);
      lastArm = arm;
      const hp = handOf(arm);
      if (headDot) headDot.position.set(hp[0], hp[1], hp[2]);
      // follow: mostly the hand, some forearm (and the shoulder when known)
      focusGoal.set(hp[0] * 0.6 + arm.wrist[0] * 0.2, hp[1] * 0.6 + arm.wrist[1] * 0.2, hp[2] * 0.6 + arm.wrist[2] * 0.2);
      const e = arm.elbow || arm.wrist;
      focusGoal.x += e[0] * 0.2; focusGoal.y += e[1] * 0.2; focusGoal.z += e[2] * 0.2;
      grid.material.uniforms.uCenter.value.set(hp[0], hp[2]);
    }
    if (trajLine && trajIdx) trajLine.geometry.setDrawRange(0, trajIdx[i]);
    const p = (T - t0) / Math.max(1, t1 - t0);
    drawStrip(p);
    timeEl.textContent = `${fmt(T)} / ${fmt(t1)} s`;
    const mean = FINGERS.reduce((s, f) => s + joints[f][1], 0) / 4;
    const wa = lastArm ? wristAnglesDeg(lastArm.rawF, lastArm.rawH) : null;
    const hp = lastArm ? handOf(lastArm) : null;
    const src = mode === "body" ? (bodyToWorld ? "body model, in the room" : "body model")
      : mode === "vision" ? "headset vision"
      : mode === "inertial" ? "inertial, drifts" + (col(a, "i_conf") != null ? ` (conf ${(+col(a, "i_conf")).toFixed(2)})` : "")
      : "none (orientation only)";
    hud.textContent =
      `t      ${fmt(T)} s\n` +
      `MCP    ${mean.toFixed(1)} deg mean\n` +
      (wa ? `wrist  flex ${wa.flex.toFixed(0)}  dev ${wa.dev.toFixed(0)}  pro ${wa.pro.toFixed(0)} deg\n` : "") +
      (ix.blend != null ? `crown  ${((lerpCol(a, b, k, "blend") || 0) * 100).toFixed(0)} % assist\n` : "") +
      (ix.act != null ? `EMG    ${((lerpCol(a, b, k, "act") || 0) * 100).toFixed(0)} %\n` : "") +
      (hp && mode !== "orient" ? `hand   ${hp.map((v) => v.toFixed(2)).join("  ")} m\n` : "") +
      `source ${src}`;
  }

  let last = performance.now(), raf = null, lastTick = 0, focusInit = false;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    lastTick = performance.now();
    const dt = Math.min(100, now - last);
    last = now;
    if (playing && rows) {
      T += dt * speed;
      if (T >= t1) { T = t0; }                 // loop like a lab video
      applyT();
    }
    if (rows) {                                // follow-cam: glide onto the arm
      if (!focusInit) { focus.copy(focusGoal); focusInit = true; }
      focus.lerp(focusGoal, 1 - Math.exp(-dt / 280));
      applyCam();
    }
    if (cloudMat) {                            // the room remembering itself
      const kk = clamp((now - revealT0) / 3400, 0, 1);
      cloudMat.uniforms.uReveal.value = 1 - Math.pow(1 - kk, 2.2);   // fast in, soft settle
    }
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(loop);
  cleanups.push(() => cancelAnimationFrame(raf));
  // hidden/headless tabs never fire RAF (throttled): keep the stage alive at
  // ~30 Hz so playback + the reveal stay verifiable off-screen (same fallback
  // pattern as the AR app's main loop). Never runs while RAF is healthy.
  const rafGuard = setInterval(() => {
    if (performance.now() - lastTick > 250) { cancelAnimationFrame(raf); loop(performance.now()); }
  }, 33);
  cleanups.push(() => clearInterval(rafGuard));

  btnPlay.addEventListener("click", () => {
    if (!rows) return;
    playing = !playing;
    btnPlay.textContent = playing ? "Pause" : "Play";
  });
  for (const b of speeds) b.addEventListener("click", () => {
    speed = +b.dataset.s;
    speeds.forEach((x) => x.classList.toggle("on", x === b));
  });
  const seek = (e) => {
    if (!rows) return;
    const r = strip.getBoundingClientRect();
    T = t0 + clamp((e.clientX - r.left) / r.width, 0, 1) * (t1 - t0);
    applyT();
  };
  strip.addEventListener("pointerdown", (e) => { seek(e); strip.setPointerCapture(e.pointerId); });
  strip.addEventListener("pointermove", (e) => { if (e.buttons) seek(e); });
  const onKey = (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === " ") { e.preventDefault(); btnPlay.click(); }
    else if (rows && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      T += (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1000 : 100);
      applyT();
    }
  };
  document.addEventListener("keydown", onKey);
  cleanups.push(() => document.removeEventListener("keydown", onKey));

  // ---- take data -> stage ------------------------------------------------
  // Fit the body frame into the room from the rows that carry both: yaw from
  // the headset's hand orientation vs the body-model hand (circular mean of
  // the heading difference), translation from the wrist positions.
  function fitBodyToRoom() {
    let sx = 0, sy = 0, n = 0;
    for (const r of rows) {
      const pq = quat(r, "pq_w", "pq_x", "pq_y", "pq_z"), bh = quat(r, "b_hq_w", "b_hq_x", "b_hq_y", "b_hq_z");
      if (!pq || !bh) continue;
      const a = yawDeg(qMul(pq, qConj(bh))) * D2R;
      sx += Math.cos(a); sy += Math.sin(a); n++;
    }
    if (n < 5) return null;
    const q = qAxisAngle([0, 1, 0], Math.atan2(sy, sx));
    const t = [0, 0, 0];
    let m = 0;
    for (const r of rows) {
      const px = vec(r, "px", "py", "pz"), bw = vec(r, "b_wx", "b_wy", "b_wz");
      if (!px || !bw) continue;
      const d = vSub(px, qRot(q, bw));
      t[0] += d[0]; t[1] += d[1]; t[2] += d[2]; m++;
    }
    if (!m) return null;
    return { q, t: t.map((v) => v / m) };
  }

  function resetStage() {
    for (const fn of sceneExtras.splice(0)) { try { fn(); } catch (_) {} }
    rows = null; cols = null; ix = {}; envMeta = null; trajIdx = null; bodyToWorld = null;
    lastArm = null; focusInit = false; playing = false; btnPlay.textContent = "Play";
    chipCal.style.display = "none";
  }

  function useData(m, meta) {
    const token = ++loadToken;
    resetStage();
    if (!m || !Array.isArray(m.rows) || !m.rows.length || !Array.isArray(m.cols) || m.cols.length < 13) {
      showState("This take has no replay rows (recorded before the 4D update).");
      return false;
    }
    cols = m.cols;
    cols.forEach((c, i) => { ix[c] = i; });
    if (ix.t_ms == null) ix.t_ms = 0;
    rows = m.rows.filter((r) => Array.isArray(r) && Number.isFinite(r[0])).sort((p, q) => p[0] - q[0]);
    if (rows.length < 2) { rows = null; showState("This take has too few rows to replay."); return false; }
    takeMeta = meta || { id: m.id || "file" };
    t0 = rows[0][0]; t1 = rows[rows.length - 1][0]; T = t0;
    hasThumb = ix.thumb_abd != null && rows.some((r) => r[ix.thumb_abd] != null);
    const hasBody = ix.b_wx != null && rows.some((r) => r[ix.b_wx] != null);
    const hasVision = ix.px != null && rows.some((r) => r[ix.px] != null);
    const hasInertial = ix.ihx != null && rows.some((r) => r[ix.ihx] != null);
    mode = hasBody ? "body" : hasVision ? "vision" : hasInertial ? "inertial" : "orient";
    if (mode === "body" && hasVision) bodyToWorld = fitBodyToRoom();
    jointSource = m.joint_source || takeMeta.joint_source || null;
    // calibration state of a body take: the b_cal column (0 none, 1 provisional, 2 calibrated)
    if (mode === "body" && ix.b_cal != null) {
      let worst = 2;
      for (const r of rows) { const c = r[ix.b_cal]; if (c != null && c < worst) worst = c; }
      chipCal.style.display = "";
      chipCal.textContent = worst >= 2 ? "neutral · calibrated" : worst === 1 ? "neutral · provisional" : "neutral · none";
      chipCal.classList.toggle("warn", worst < 2);
    }
    // stage: the body frame has a reference floor; the room brings its own
    const inRoom = mode === "vision" || (mode === "body" && bodyToWorld);
    grid.visible = true;
    grid.position.y = inRoom ? 0.001 : FLOOR_Y_M;   // room floor, or the body-frame reference floor
    yaw = inRoom ? -0.7 : -1.15; pitch = inRoom ? 0.42 : 0.32;
    dist = mode === "body" || mode === "orient" ? 1.25 : 0.9;
    buildTraj();
    title.innerHTML = "";
    title.append("Session replay · ", el("b", null, `${takeMeta.task || takeMeta.id || "take"}`));
    const envId = m.env || takeMeta.env;
    if (envId && inRoom) {
      const cached = m._env;
      const onEnv = (em) => {
        if (token !== loadToken) return;
        envMeta = store.lastEnvs.find((x) => x.id === envId) ||
                  { id: envId, name: em.name, tris: (em.indices || []).length / 3,
                    pts: (em.points || []).length / 3 };
        buildEnv(em);
        updateChips();
      };
      if (cached) onEnv(cached);
      else {
        const offEnv = store.onKind("env", (em) => { if (em.id === envId) { offEnv(); onEnv(em); } });
        sceneExtras.push(offEnv);
        store.send({ cmd: "env_get", id: envId });
      }
    }
    updateChips();
    clearState();
    applyT();
    playing = true;
    btnPlay.textContent = "Pause";
    return true;
  }

  function loadTake(id) {
    resetStage();
    showState(el("span", null, "Loading take ", el("b", null, id), " …"));
    const meta = store.lastTakes.find((t) => t.id === id) || { id };
    const token = ++loadToken;
    store.requestTakeData(id).then((m) => {
      if (token !== loadToken) return;
      useData(m, meta);
    }, (e) => {
      if (token !== loadToken) return;
      showState(el("span", null, `No replay data for ${id} (${e.message}). `,
        el("br"), "You can also open a take file from disk: ", openLink()));
    });
  }

  const openLink = () => {
    const a = el("button", { class: "rp-linkbtn", type: "button" }, "Open file…");
    a.addEventListener("click", () => fileInput.click());
    return a;
  };
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    try {
      const m = JSON.parse(await f.text());
      const meta = { id: m.id || f.name.replace(/\.json$/i, ""), task: (m.meta && m.meta.task) || f.name, env: m.env,
                     joint_source: m.joint_source };
      if (useData(m, meta)) toast(`Replaying ${f.name}`, { tone: "ok" });
    } catch (e) {
      toast("Not a take file: " + e.message, { tone: "warn" });
    }
  });

  const fmtKind = (t) => t.body ? "arm (body model)" : t.traj ? "6-DoF" : t.traj_inertial ? "6-DoF inertial" : "orient.";
  function offerPicker(force = false) {
    const withData = store.lastTakes.filter((t) => t.has_data);
    if (!withData.length) {
      showState(el("span", null,
        store.sourceKind === "pending" ? "Looking for the bridge…"
          : "No replayable takes in the library yet. Record one from ",
        store.sourceKind === "pending" ? null : el("a", { href: "#/capture" }, "Capture"),
        store.sourceKind === "pending" ? null : ", import one from the device SD card, or ",
        store.sourceKind === "pending" ? null : openLink()));
      return;
    }
    if (rows && !force) return;
    stateHost.innerHTML = "";
    stateHost.append(el("div", { class: "rp-state" },
      el("div", { class: "card" },
        el("div", { style: "margin-bottom:4px" }, "Pick a recording to replay:"),
        el("div", { class: "rp-picker" },
          ...withData.slice(0, 10).map((t) => {
            const b = el("button", { class: "rp-pick" },
              el("b", null, t.task || t.id),
              el("span", { class: "mono" },
                `${t.id} · ${t.duration_s}s · ${fmtKind(t)}` + (t.source === "sd" ? " · SD" : "") +
                ` · ${t.env || "no env"}`));
            b.addEventListener("click", () => loadTake(t.id));
            return b;
          })),
        el("div", { style: "margin-top:12px;font-size:12px" }, "or ", openLink()))));
  }

  function start() {
    if (_requestedTake) {
      const id = _requestedTake;
      _requestedTake = null;
      loadTake(id);
    } else offerPicker();
  }
  // library pushes (initial sync, a take sealed or imported elsewhere) refresh
  // the picker while nothing is playing; a source switch starts over
  cleanups.push(store.onTakes(() => { if (!rows) start(); }));
  cleanups.push(store.onSource(() => { if (!rows) offerPicker(); }));
  start();

  // deterministic test hook (same spirit as __zeroStep): seek + inspect
  window.__replay = {
    seek: (sec) => { T = t0 + sec * 1000; applyT(); },
    pause: () => { playing = false; btnPlay.textContent = "Play"; },
    state: () => ({ loaded: !!rows, rows: rows ? rows.length : 0, cols: cols ? cols.length : 0,
      t: (T - t0) / 1000, dur: (t1 - t0) / 1000, mode, fitted: !!bodyToWorld,
      env: envMeta ? envMeta.id : null, cloud: !!cloudMat, cloudPts: envMeta ? (envMeta.pts || 0) : 0,
      reveal: cloudMat ? cloudMat.uniforms.uReveal.value : 0,
      jointSource, hasThumb, thumbVisible: !!(rig._thumbRoot && rig._thumbRoot.visible),
      rigReady: rig.ready, wrist: lastArm ? lastArm.wrist : null, elbow: lastArm ? lastArm.elbow : null,
      shoulder: lastArm ? lastArm.shoulder : null, focus: focus.toArray() }),
    load: (id) => loadTake(id),
    loadData: (m, meta) => useData(m, meta || { id: m.id || "data", task: m.id }),
  };

  return () => {
    for (const fn of sceneExtras.splice(0)) { try { fn(); } catch {} }
    for (const fn of cleanups.splice(0)) { try { fn(); } catch {} }
    renderer.dispose();
    delete window.__replay;
    root.remove();
  };
}
