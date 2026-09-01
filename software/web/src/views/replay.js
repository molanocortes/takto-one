// replay.js - 4D SESSION REPLAY: a recorded take played back inside the
// environment the Quest 3S scanned while it was captured.
//
// The stage combines two data products in ONE coordinate space (the headset's
// local-floor space, meters, y-up):
//   1. the ENVIRONMENT: the Quest's own scene-reconstruction mesh, uploaded by
//      the AR client (bridge env library), rendered as a measured wireframe;
//   2. the TRAJECTORY + articulation: the take's replay rows (bridge-side
//      sample log): wrist 6-DoF pose from the headset's hand tracking, plus
//      the device's 12 joints / IMU quats / crown / EMG per tick.
// The hand model is the REAL device GLB (real scale: mm -> m), articulated by
// the same shared kinematics the live twins use. Takes recorded without AR
// have no trajectory: the hand then plays at a pedestal anchor, oriented by
// its own IMU - honest fallback, clearly labelled ORIENTATION ONLY.
//
// Aesthetic: scientific instrument. Near-black stage, cyan-ink wireframe
// room, oxide trajectory with a progress head, monospace HUD, a timeline
// scrubber with the flexion/effort traces drawn from the actual rows.

import * as THREE from "../../vendor/three.module.js";
import { el, clamp, lerp } from "../ui.js";
import { store } from "../store.js";
import { loadHand } from "../twin.js";
import { fingerPose } from "../kinematics.js";

const FINGERS = ["index", "middle", "ring", "pinky"];
const D2R = Math.PI / 180;

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
  .rp-state .card { max-width:420px; line-height:1.6; }
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
  `;
  document.head.append(el("style", null, css));
}

// ---------------------------------------------------------------------------
// replay rig: the device-hand GLB articulated from a row (subset of the live
// twin driver: palm subtree only, real scale, shared kinematics for slides)
// ---------------------------------------------------------------------------
class ReplayHand {
  constructor(scene) {
    this.group = new THREE.Group();       // world pose (meters)
    this.inner = new THREE.Group();       // mm -> m
    this.inner.scale.setScalar(0.001);
    this.group.add(this.inner);
    scene.add(this.group);
    this.ready = false;
    this._q = new THREE.Quaternion();
    this._fingers = {};
    // subject lamp: rides the wrist so the hand is lit wherever the
    // trajectory takes it (the stage key light alone left it silhouetted)
    const lamp = new THREE.PointLight(0xFFE9CE, 0.35, 3, 2);
    lamp.position.set(0.2, 0.3, 0.2);
    this.group.add(lamp);
    loadHand().then((gltf) => {
      const model = gltf.scene.clone(true);
      // bone, not metal: without an environment map a metallic material
      // renders near-black and vanishes into the #0B0E13 stage
      const mat = new THREE.MeshStandardMaterial({
        color: 0xE8E1D0, metalness: 0.1, roughness: 0.5,
        emissive: 0x3A342A, emissiveIntensity: 0.55,
      });
      model.traverse((o) => { if (o.isMesh) o.material = mat; });
      const palm = model.getObjectByName("palm");
      if (!palm) return;
      this.inner.add(palm);
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
    });
    this._buildThumb();
  }

  // vision thumb (2026-07-20): the device GLB has no thumb - the mechanism is
  // thumb-out by scope - but the Quest's hand tracking measures the wearer's
  // thumb ([palmar abduction, MCP flexion, IP flexion], take cols 34-36).
  // Rendered as a deliberately SCHEMATIC ghost chain (sapphire, translucent)
  // so it can never be mistaken for device hardware: fingers = device GLB,
  // thumb = vision overlay. Hidden whenever the take has no thumb data.
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
    // model frame: +Z distal, +Y dorsal, +X thumb side; mm (inner is mm -> m).
    // Anchor measured against the GLB palm bbox (x -28..38, z 26..166,
    // index_mcp at z~70): CMC sits proximal of the knuckle line on the +X edge.
    const root = new THREE.Group();
    root.position.set(36, 0, 44);          // CMC anchor at the palm's thumb edge
    root.rotation.y = 0.9;                 // base direction: mostly +X, part +Z
    this._thumbAb = new THREE.Group();     // palmar abduction: about local X
    this._thumbMcp = new THREE.Group();
    this._thumbMcp.position.z = 44;        // end of the metacarpal segment
    this._thumbIp = new THREE.Group();
    this._thumbIp.position.z = 32;         // end of the proximal segment
    this._thumbAb.add(seg(44, 5), this._thumbMcp);
    this._thumbMcp.add(seg(32, 4.4), this._thumbIp);
    this._thumbIp.add(seg(26, 4));
    root.add(this._thumbAb);
    root.visible = false;
    this._thumbRoot = root;
    this.inner.add(root);
  }

  /** thumb = [abDeg, mcpDeg, ipDeg] from Quest vision, or null (hidden). */
  poseThumb(thumb) {
    if (!this._thumbRoot) return;
    if (!thumb || thumb[0] == null) { this._thumbRoot.visible = false; return; }
    this._thumbRoot.visible = true;
    // SEPARATE AXES (2026-07-20): palmar abduction lifts the chain out of the
    // palm plane (local X: +Z distal -> -Y palmar); flexion sweeps it across
    // the palm toward the fingers (local Y). The old build put all three on
    // X, so thumb abduction rendered as curl.
    this._thumbAb.rotation.set(thumb[0] * D2R, 0, 0);
    this._thumbMcp.rotation.set(0, -thumb[1] * D2R, 0);
    this._thumbIp.rotation.set(0, -thumb[2] * D2R, 0);
  }

  /** joints = {finger: [abDeg, mcpDeg, pipDeg]}; pos meters or null; quat [w,x,y,z]. */
  pose(joints, pos, quat) {
    if (pos) this.group.position.set(pos[0], pos[1], pos[2]);
    if (quat) this.group.quaternion.set(quat[1], quat[2], quat[3], quat[0]);
    if (!this.ready) return;
    for (const f of FINGERS) {
      const jf = this._fingers[f], [ab, mcp, pip] = joints[f];
      if (!jf || !jf.mcp) continue;
      const set = (b, axis, deg) => {
        if (!b) return;
        this._q.setFromAxisAngle(axis, deg * D2R);
        b.node.quaternion.copy(b.baseQuat).multiply(this._q);
      };
      set(jf.ab, ReplayHand._Y, ab);
      set(jf.mcp, ReplayHand._X, mcp);
      set(jf.pip, ReplayHand._X, pip);
      const p = fingerPose(f, ab, mcp, pip);
      // same slide rig as the live twin: knuckle block + MCP hinge migrate on
      // the palm rail, PIP hinge rides the telescoping link
      if (jf.knuckle) jf.knuckle.node.position.z = jf.knuckle.baseZ + p.slideKnuckleMm;
      if (jf.mcp) jf.mcp.node.position.z = jf.mcp.baseZ + p.slideKnuckleMm;
      if (jf.mid) jf.mid.node.position.z = jf.mid.baseZ + p.slideMcpMidMm;
      if (jf.slide) jf.slide.node.position.z = jf.slide.baseZ + p.slideMcpMm;
      if (jf.pip) jf.pip.node.position.z = jf.pip.baseZ + p.slideMcpMm;
      if (jf.cradle) jf.cradle.node.position.z = jf.cradle.baseZ + p.slidePipMm;
    }
  }
}
ReplayHand._X = new THREE.Vector3(1, 0, 0);
ReplayHand._Y = new THREE.Vector3(0, 1, 0);

// column indices (must match the bridge's ROW_COLS - verified by the >=34
// guard below and the ecosystem test J5). The first 34 columns are frozen;
// 2026-07-20 appended thumb_abd/thumb_mcp/thumb_ip (34 -> 37), located at
// runtime from the payload's own cols array so older takes keep playing.
const COLS = { t: 0, joints: 1, hq: 13, fq: 17, tq: 21, blend: 25, act: 26, px: 27, pq: 30 };

export function mountReplay(rootHost) {
  styleOnce();
  const cleanups = [];
  const root = el("div", { class: "rp-root" });

  const title = el("span", { class: "rp-title" }, "Session replay");
  const chipEnv = el("span", { class: "rp-chip" }, "-");
  const chipMode = el("span", { class: "rp-chip" }, "-");
  const chipHand = el("span", { class: "rp-chip" }, "-");
  const top = el("div", { class: "rp-top" },
    el("a", { class: "rp-back", href: "#/capture" }, "← Capture"),
    title, chipEnv, chipMode, chipHand);

  const stage = el("div", { class: "rp-stage" });
  const hud = el("div", { class: "rp-hud" });
  const stateHost = el("div");
  stage.append(hud, stateHost);

  const btnPlay = el("button", { class: "rp-btn primary" }, "Play");
  const timeEl = el("span", { class: "rp-time" }, "0.00 / 0.00 s");
  const speeds = [0.5, 1, 2].map((s) =>
    el("button", { class: "rp-btn" + (s === 1 ? " on" : ""), "data-s": s }, s + "×"));
  const strip = el("div", { class: "rp-strip" });
  const stripCanvas = el("canvas");
  strip.append(stripCanvas);
  const bottom = el("div", { class: "rp-bottom" },
    btnPlay, el("span", { class: "rp-speed" }, ...speeds), strip, timeEl);

  root.append(top, stage, bottom);
  rootHost.append(root);

  const showState = (html) => {
    stateHost.innerHTML = "";
    stateHost.append(el("div", { class: "rp-state" }, el("div", { class: "card" }, html)));
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
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);

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
  // to the hand every frame (see loop): the subject frames itself, the room
  // is context - without this the 10 cm hand is a few px in a 6 m room
  let yaw = -0.7, pitch = 0.42, dist = 0.7;
  const focus = new THREE.Vector3(0, 0.8, -0.6);
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
    dist = clamp(dist * (1 + e.deltaY * 0.0012), 0.3, 9);
    applyCam();
  }, { passive: false });

  const hand = new ReplayHand(scene);

  // ---- data --------------------------------------------------------------
  let rows = null, envMeta = null, takeMeta = null, hasTraj = false;
  let jointSource = null;
  let thumbIx = -1, hasThumb = false;   // thumb cols located from the payload
  let inerIx = -1, confIx = -1;         // inertial translation cols, likewise
  let trajSource = null;                // "vision" | "inertial" | null

  // ONE place that answers "where was the hand in this row", so the two
  // translation sources cannot drift apart across the five call sites that ask.
  //   vision   metres, absolute, in the headset's local-floor space
  //   inertial millimetres of DISPLACEMENT, so it is converted and hung off the
  //            stage focus - it has no absolute origin to be placed at
  function rowPos(r) {
    if (trajSource === "vision") {
      return r[COLS.px] == null ? null
        : [r[COLS.px], r[COLS.px + 1], r[COLS.px + 2]];
    }
    if (trajSource === "inertial" && inerIx >= 0 && r[inerIx] != null) {
      return [focus.x + r[inerIx] / 1000, focus.y + r[inerIx + 1] / 1000,
              focus.z + r[inerIx + 2] / 1000];
    }
    return null;
  }
  let t0 = 0, t1 = 1, T = 0, playing = false, speed = 1;
  let trajLine = null, headDot = null;

  const fmt = (ms) => ((ms - t0) / 1000).toFixed(2);
  const updateChips = () => {
    chipEnv.textContent = envMeta
      ? `env ${envMeta.name}` +
        (envMeta.pts ? ` · ${envMeta.pts} pts` : "") +
        (envMeta.tris ? ` · ${envMeta.tris} tris` : "")
      : "no environment";
    chipEnv.classList.toggle("warn", !envMeta);
    // Which translation the stage is drawing, never just "it moves". Vision is
    // absolute; inertial is dead reckoning and has to say so on the face of it,
    // or a drifting trajectory reads as a measured one.
    chipMode.textContent = trajSource === "vision" ? "6-DoF · headset vision"
      : trajSource === "inertial" ? "6-DoF · inertial (drifts)"
      : "orientation only";
    chipMode.classList.toggle("warn", trajSource !== "vision");
    // honesty chip: where the finger-joint columns came from (bridge label);
    // "+thumb" = the take carries vision thumb columns (schematic overlay)
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
      const r0 = rows.find((r) => rowPos(r));
      if (r0) org = rowPos(r0);
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
    cleanups.push(() => { scene.remove(pts); geo.dispose(); cloudMat.dispose(); cloudMat = null; });
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
      cleanups.push(() => { scene.remove(wire, pts); geo.dispose(); });
    }
  }

  function buildTraj() {
    const P = [];
    for (const r of rows) { const p = rowPos(r); if (p) P.push(p[0], p[1], p[2]); }
    if (P.length < 6) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    const dim = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x7a4030, transparent: true, opacity: 0.5 }));
    trajLine = new THREE.Line(geo.clone(), new THREE.LineBasicMaterial({ color: 0xc9401b }));
    trajLine.geometry.setDrawRange(0, 0);
    scene.add(dim, trajLine);
    headDot = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xff7b52 }));
    scene.add(headDot);
    cleanups.push(() => scene.remove(dim, trajLine, headDot));
  }

  // strip: mean flexion (oxide), activation (honey), pose presence (cyan tick)
  function drawStrip(playX) {
    const c = stripCanvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = strip.clientWidth || 400, h = strip.clientHeight || 56;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(140,170,200,0.06)";
    g.fillRect(0, 0, w, h);
    if (!rows) return;
    const n = rows.length;
    const flexAt = (r) => {
      let s = 0;
      for (let k = 0; k < 4; k++) s += r[COLS.joints + k * 3 + 1] + r[COLS.joints + k * 3 + 2];
      return s / (8 * 100);                    // 0..1 over the 90/110 stops
    };
    g.strokeStyle = "#C9401B"; g.lineWidth = 1.4; g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w, y = h - 4 - flexAt(rows[i]) * (h - 12);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.strokeStyle = "rgba(192,131,39,0.8)"; g.lineWidth = 1; g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w, y = h - 4 - rows[i][COLS.act] * (h - 12);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.fillStyle = "rgba(95,138,168,0.5)";
    for (let i = 0; i < n; i += 2) {
      if (rowPos(rows[i])) g.fillRect((i / (n - 1)) * w, h - 3, 1.5, 3);
    }
    g.fillStyle = "#E4ECF4";
    g.fillRect(playX * w - 0.75, 0, 1.5, h);
  }

  // ---- playback ----------------------------------------------------------
  const rowAt = (t) => {
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid][COLS.t] < t) lo = mid + 1; else hi = mid;
    }
    return Math.max(0, lo - 1);
  };
  const nlerp = (a, b, k) => {
    let d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
    const s = d < 0 ? -1 : 1;
    const out = [0, 1, 2, 3].map((i) => lerp(a[i], s * b[i], k));
    const n = Math.hypot(...out) || 1;
    return out.map((v) => v / n);
  };

  function applyT() {
    if (!rows) return;
    T = clamp(T, t0, t1);
    const i = rowAt(T), a = rows[i], b = rows[Math.min(i + 1, rows.length - 1)];
    const span = Math.max(1, b[COLS.t] - a[COLS.t]);
    const k = clamp((T - a[COLS.t]) / span, 0, 1);
    const joints = {};
    FINGERS.forEach((f, fi) => {
      const j = COLS.joints + fi * 3;
      joints[f] = [lerp(a[j], b[j], k), lerp(a[j+1], b[j+1], k), lerp(a[j+2], b[j+2], k)];
    });
    // vision thumb columns (located from the payload's cols; may be absent)
    let thumb = null;
    if (thumbIx >= 0) {
      if (a[thumbIx] != null && b[thumbIx] != null) {
        thumb = [0, 1, 2].map((d) => lerp(a[thumbIx + d], b[thumbIx + d], k));
      } else if (a[thumbIx] != null) {
        thumb = a.slice(thumbIx, thumbIx + 3);
      }
    }
    hand.poseThumb(thumb);
    let pos = null, quat = null;
    const pa = rowPos(a), pb = rowPos(b);
    // Orientation comes from the headset only when the headset is also supplying
    // the position; on the inertial path the hand IMU's own quaternion is the
    // right (and only) answer, and it is the better one anyway.
    const visionPose = trajSource === "vision";
    if (pa && pb) {
      pos = [0, 1, 2].map((d) => lerp(pa[d], pb[d], k));
      quat = visionPose
        ? nlerp(a.slice(COLS.pq, COLS.pq + 4), b.slice(COLS.pq, COLS.pq + 4), k)
        : nlerp(a.slice(COLS.hq, COLS.hq + 4), b.slice(COLS.hq, COLS.hq + 4), k);
    } else if (pa) {
      pos = pa;
      quat = visionPose ? a.slice(COLS.pq, COLS.pq + 4) : a.slice(COLS.hq, COLS.hq + 4);
    } else {
      pos = [focus.x, focus.y, focus.z];        // pedestal anchor: IMU orientation only
      quat = nlerp(a.slice(COLS.hq, COLS.hq + 4), b.slice(COLS.hq, COLS.hq + 4), k);
    }
    hand.pose(joints, pos, quat);
    if (headDot && pos) headDot.position.set(pos[0], pos[1], pos[2]);
    if (trajLine) {
      let count = 0;
      for (let r = 0; r <= i; r++) if (rowPos(rows[r])) count++;
      trajLine.geometry.setDrawRange(0, count);
    }
    const p = (T - t0) / Math.max(1, t1 - t0);
    drawStrip(p);
    timeEl.textContent = `${fmt(T)} / ${fmt(t1)} s`;
    const mean = FINGERS.reduce((s, f) => s + joints[f][1], 0) / 4;
    hud.textContent =
      `t      ${fmt(T)} s\n` +
      `MCP    ${mean.toFixed(1)} deg mean\n` +
      `crown  ${(lerp(a[COLS.blend], b[COLS.blend], k) * 100).toFixed(0)} % assist\n` +
      `EMG    ${(lerp(a[COLS.act], b[COLS.act], k) * 100).toFixed(0)} %\n` +
      (pa
        ? `pos    ${pos.map((v) => v.toFixed(2)).join("  ")} m` +
          (trajSource === "inertial"
            ? `\nsource inertial, drifts` +
              (confIx >= 0 && a[confIx] != null
                ? ` (conf ${(+a[confIx]).toFixed(2)})` : "")
            : "\nsource headset vision")
        : `pos    - (orientation only)`);
  }

  let last = performance.now(), raf = null, lastTick = 0;
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
    if (rows) {                                // follow-cam: glide onto the hand
      focus.lerp(hand.group.position, Math.min(1, dt * 0.004));
      applyCam();
    }
    if (cloudMat) {                            // the room remembering itself
      const k = clamp((now - revealT0) / 3400, 0, 1);
      cloudMat.uniforms.uReveal.value = 1 - Math.pow(1 - k, 2.2);   // fast in, soft settle
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
    playing = !playing;
    btnPlay.textContent = playing ? "Pause" : "Play";
  });
  for (const b of speeds) b.addEventListener("click", () => {
    speed = +b.dataset.s;
    speeds.forEach((x) => x.classList.toggle("on", x === b));
  });
  const seek = (e) => {
    const r = strip.getBoundingClientRect();
    T = t0 + clamp((e.clientX - r.left) / r.width, 0, 1) * (t1 - t0);
    applyT();
  };
  strip.addEventListener("pointerdown", (e) => { seek(e); strip.setPointerCapture(e.pointerId); });
  strip.addEventListener("pointermove", (e) => { if (e.buttons) seek(e); });

  // ---- load flow ---------------------------------------------------------
  function loadTake(id) {
    clearState();
    showState(el("span", null, "Loading take ", el("b", null, id), " ..."));
    takeMeta = store.lastTakes.find((t) => t.id === id) || { id };
    let offErr = null;
    const offTd = store.onKind("take_data", (m) => {
      if (m.id !== id) return;
      offTd(); if (offErr) offErr();
      // >= 34: the first 34 columns are frozen; newer takes append thumb cols
      if (!m.rows || !m.rows.length || (m.cols || []).length < 34) {
        showState("This take has no replay rows (recorded before the 4D update).");
        return;
      }
      rows = m.rows;
      t0 = rows[0][COLS.t]; t1 = rows[rows.length - 1][COLS.t]; T = t0;
      thumbIx = (m.cols || []).indexOf("thumb_abd");
      hasThumb = thumbIx >= 0 && rows.some((r) => r[thumbIx] != null);
      // Translation source. The headset's vision is authoritative when present:
      // it is absolute and does not drift. Without it, a v7 take carries the
      // integrated inertial displacement, which is what finally lets a
      // bench-recorded take show the hand MOVING rather than just rotating in
      // place. It drifts, so it is only ever the fallback, and the chip says so.
      inerIx = (m.cols || []).indexOf("ihx");
      confIx = (m.cols || []).indexOf("i_conf");
      const hasVision = rows.some((r) => r[COLS.px] != null);
      const hasInertial = inerIx >= 0 && rows.some((r) => r[inerIx] != null);
      trajSource = hasVision ? "vision" : (hasInertial ? "inertial" : null);
      hasTraj = trajSource != null;
      jointSource = m.joint_source || takeMeta.joint_source || null;
      buildTraj();
      title.innerHTML = "";
      title.append("Session replay · ", el("b", null, `${takeMeta.task || id}`));
      const envId = m.env || takeMeta.env;
      if (envId) {
        const offEnv = store.onKind("env", (em) => {
          if (em.id !== envId) return;
          offEnv();
          envMeta = store.lastEnvs.find((x) => x.id === envId) ||
                    { id: envId, name: em.name, tris: (em.indices || []).length / 3,
                      pts: (em.points || []).length / 3 };
          buildEnv(em);
          updateChips();
        });
        cleanups.push(offEnv);
        store.send({ cmd: "env_get", id: envId });
      }
      updateChips();
      clearState();
      applyT();
    });
    cleanups.push(offTd);
    // the bridge answers a missing per-take data file with an ERROR ack, which
    // never reaches onKind("take_data"); without this the card said
    // "Loading take ..." forever with no feedback at all
    offErr = store.onAck((a) => {
      if (a.event !== "error" || a.id !== id) return;
      offTd(); offErr();
      showState("No replay data for this take (" + (a.error || "unknown error") + ").");
    });
    cleanups.push(offErr);
    store.send({ cmd: "take_data", id });
  }

  function offerPicker() {
    const withData = store.lastTakes.filter((t) => t.has_data);
    if (!withData.length) {
      showState(el("span", null,
        "No replayable takes yet. Record one from ", el("a", { href: "#/capture" }, "Capture"),
        " (with the bridge running); AR recordings also carry the room scan + trajectory."));
      return;
    }
    stateHost.innerHTML = "";
    stateHost.append(el("div", { class: "rp-state" },
      el("div", { class: "card" },
        el("div", { style: "margin-bottom:4px" }, "Pick a recording to replay:"),
        el("div", { class: "rp-picker" },
          ...withData.slice(0, 6).map((t) => {
            const b = el("button", { class: "rp-pick" },
              el("b", null, t.task || t.id),
              // a take with only inertial translation still moves through space,
              // so calling it "orient." would send the reader past the one
              // recording that has what they are looking for
              el("span", { class: "mono" },
                `${t.duration_s}s · ${t.traj ? "6-DoF" : t.traj_inertial ? "6-DoF inertial" : "orient."}` +
                ` · ${t.env || "no env"}`));
            b.addEventListener("click", () => loadTake(t.id));
            return b;
          })))));
  }

  if (!store.live) {
    // never a dead end: one click connects to the default bridge, URL prefilled
    const connect = el("button", { class: "rp-btn primary", style: "margin-top:10px" },
      "Connect to bridge (ws://localhost:8765/ws)");
    connect.addEventListener("click", () => {
      const u = new URL(location.href);
      u.searchParams.set("ws", "ws://localhost:8765/ws");
      location.href = u.toString();
    });
    showState(el("span", null,
      "Replay needs the live bridge - this page is on SIMULATED data.",
      el("br"), "Start it with Fable/ar/run_quest_stack.sh (or bridge-sim), then:",
      el("br"), connect));
  } else if (_requestedTake) {
    const id = _requestedTake;
    _requestedTake = null;
    loadTake(id);
  } else if (store.lastTakes.length) {
    offerPicker();
  } else {
    const offT = store.onTakes(() => { offT(); offerPicker(); });
    cleanups.push(offT);
  }

  // deterministic test hook (same spirit as __zeroStep): seek + inspect
  window.__replay = {
    seek: (sec) => { T = t0 + sec * 1000; applyT(); },
    state: () => ({ loaded: !!rows, rows: rows ? rows.length : 0, t: (T - t0) / 1000,
      dur: (t1 - t0) / 1000, hasTraj, trajSource, env: envMeta ? envMeta.id : null,
      cloud: !!cloudMat, cloudPts: envMeta ? (envMeta.pts || 0) : 0,
      reveal: cloudMat ? cloudMat.uniforms.uReveal.value : 0,
      jointSource, hasThumb, thumbVisible: !!(hand._thumbRoot && hand._thumbRoot.visible),
      handReady: hand.ready, handPos: hand.group.position.toArray() }),
    load: (id) => loadTake(id),
  };

  return () => {
    for (const fn of cleanups.splice(0)) { try { fn(); } catch {} }
    renderer.dispose();
    delete window.__replay;
    root.remove();
  };
}
