// twin.js - the live 3D digital twin, built from the device's real CAD.
// Geometry: app/assets/zero_hand.glb, produced by tools/build_hand_glb_v7.py from
// the V7 CAD exports, then web-decimated by tools/decimate_hand_glb.py
// (614k -> 154k tris; names/hierarchy/transforms untouched, gated by
// tools/verify_hand_glb.py). Articulated nodes: palm -> {index,middle,ring,
// pinky}_{mcp,pip,dip}, plus forearm + spool bank. Each hinge node's local X
// is its physical hinge axis, so flexion is a single local rotation.

import * as THREE from "../vendor/three.module.js";
import { GLTFLoader } from "../vendor/GLTFLoader.js";
import { toCreasedNormals } from "../vendor/BufferGeometryUtils.js";
import { clamp, lerp, reducedMotion } from "./ui.js";
import { getTheme } from "./theme.js";
import { fingerPose, spoolAngleDeg, SPOOL_STATIONS, THUMB_POD_ANCHOR_MM } from "./kinematics.js";
import { fitSphereDistance } from "./camera_framing.js";
import { WRIST_PIVOT_MM, NEUTRAL_WRIST_M, synthBody, qValid } from "./arm_model.js";

const FINGERS = ["index", "middle", "ring", "pinky"];
// Mechanism DOF per finger, palm outward: MCP abduction (left/right),
// MCP flexion (up/down), PIP flexion (up/down). No DIP joint. The telescopic
// sliding members and spool rotations come from the SHARED kinematic model
// (kinematics.js): rotations AND translations both, per the real mechanism.
const D2R = Math.PI / 180;
const MODEL_SCALE = 0.013;          // mm -> scene units (device ~4.4 units long)
const ARM_S = MODEL_SCALE * 1000;   // m -> scene units (13 units per metre)
// "arm in space" stage (MOTION_PIPELINE.md section 7): the body frame is
// drawn in scene units with the NEUTRAL wrist at the scene origin, so a
// neutral arm sits exactly where the pinned twin always stood.
const FLOOR_Y_M = -0.70;            // reference grid, below a hanging arm + hand
const VIEW_KEY = "takto.twin.view"; // remembered "arm" | "hand" choice
// Behind the wearer's right shoulder, looking forward along the arm (body +Z):
// the twin turns the way the wearer sees their own arm turn. [2026-09-29] The
// first framing (yaw -1.2) sat at the wearer's right, slightly IN FRONT and
// looking back: a roll made clockwise looked counterclockwise on screen.
const ARM_FRAMING = { yaw: Math.PI + 0.8, pitch: 0.62, dist: 12.5 };
const FINGER_GHOST_OPACITY = 0.26;  // a finger whose encoder channel is dead

const HAND_ASSET_VERSION = 20;   // bump when zero_hand.glb is rebuilt (busts HTTP
                                 // cache) - AND update the <link rel="preload">
                                 // in index.html, which carries the same ?v=

let _gltfPromise = null;
// exported for the replay surface: ONE cached parse of the hand GLB serves the
// live twin AND replay rigs (same version, no cache-buster drift)
export function loadHand() {
  if (!_gltfPromise) {
    const loader = new GLTFLoader();
    _gltfPromise = loader.loadAsync(
      new URL(`../assets/zero_hand.glb?v=${HAND_ASSET_VERSION}`, import.meta.url).href);
  }
  return _gltfPromise;
}

function radialTexture(stops) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const glowDiscTexture = () => radialTexture([
  [0, "rgba(47,118,191,0.24)"], [0.45, "rgba(47,118,191,0.05)"], [1, "rgba(47,118,191,0)"]]);
const shadowDiscTexture = () => radialTexture([
  [0, "rgba(22,24,28,0.30)"], [0.55, "rgba(22,24,28,0.09)"], [1, "rgba(22,24,28,0)"]]);

// ONE twin for the whole app. The WebGL context, environment bake, and the
// 165k-triangle model upload happen exactly once per session; navigating
// between surfaces just re-parents the canvas and retargets the camera.
// That removes the mount hitch that made surface transitions feel laggy.
let _shared = null;

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Twin {
  static acquire(container, opts = {}) {
    if (!_shared) _shared = new Twin(container, opts);
    else _shared._attach(container, opts);
    window.__twin = _shared;   // test hook (screenshot verification, like __zeroStep)
    return _shared;
  }

  constructor(container, opts = {}) {
    this._fingers = {};     // finger -> { abduct, mcpFlex, pipFlex } joint bindings
    this._reveal = this._revealT = 1;   // 1 = full assembly, 0 = the hand alone
    this._cover = this._coverT = 1;     // 1 = forearm cover on, 0 = interior exposed
    this._focus = this._focusT = 0;     // 0..1 bone-white lift on motors/internals/screen
    this._dragging = false;
    this._manualCameraUntil = 0;
    this._autoFrameNext = 0;
    this._frameBounds = new THREE.Box3();
    this._frameSphere = new THREE.Sphere();
    this._t = 0;
    this._disposed = false;
    // view: "arm" = the arm in space (body frame, translating, limb + grid),
    // "hand" = the classic pinned twin (orientation only). Only surfaces that
    // pass armView:true offer the arm; the choice is remembered.
    let v = null;
    try { v = localStorage.getItem(VIEW_KEY); } catch (_) {}
    this._view = v === "hand" ? "hand" : "arm";
    this._armK = 0;                     // 0 = pinned placement, 1 = body placement (eased)
    this._camByView = {};               // per-view yaw/pitch/dist the user left behind
    this._follow = new THREE.Vector3();
    this._followInit = false;
    this._vA = new THREE.Vector3(); this._vB = new THREE.Vector3(); this._vC = new THREE.Vector3();
    this._qA = new THREE.Quaternion(); this._qB = new THREE.Quaternion();
    this._trailT = 0;
    this._armInfo = null;               // what the last arm frame drew (for HUDs / tests)
    this._qTmp = new THREE.Quaternion();
    this._xAxis = new THREE.Vector3(1, 0, 0);
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._zAxis = new THREE.Vector3(0, 0, 1);
    // Per-joint LOCAL rotation axis. If the twin bends the wrong way, flip these
    // to _xAxis / _yAxis / _zAxis until flexion curls the finger toward the palm
    // and abduction splays it sideways. (Verify by flexing the real finger.)
    this._axAbduct  = this._yAxis;   // MCP abduction: sideways splay (verified correct)
    this._axMcpFlex = this._xAxis;   // MCP flexion: +X curls toward the palm (frozen; verified by injection test)
    this._axPipFlex = this._xAxis;   // PIP flexion: +X (same curl sense as the MCP)
    this.container = container;
    this.opts = {};
    this._build();
    this._bind();
    this._attach(container, opts);
    // deferLoad (entry hero): kick the GLB parse at idle, AFTER the hero
    // words have painted - the words are the page's LCP and must never sit
    // behind 11 MB of geometry in the critical path. The <link rel=preload>
    // keeps the network warm either way, so the real delay is one beat.
    const kick = () => loadHand().then((gltf) => { if (!this._disposed) this._buildRig(gltf); });
    if (opts.deferLoad && "requestIdleCallback" in window) requestIdleCallback(kick, { timeout: 1200 });
    else kick();
  }

  // re-parent the canvas and retarget the camera for a new surface
  _attach(container, opts = {}) {
    this.container = container;
    this.opts = Object.assign(
      // spin: horizontal-drag yaw only (no pitch, no wheel) - the landing page
      // mode, where the page must keep scrolling normally over the canvas
      { orbit: true, spin: false, idle: true, idleSpin: false, autoFrame: false,
        yaw: -0.55, pitch: 0.32, dist: 4.6, targetX: 0, targetY: 0.05,
        targetZ: 0.1, reveal: 1 },
      opts
    );
    container.append(this.renderer.domElement);
    const interactive = this.opts.orbit || this.opts.spin;
    this.renderer.domElement.style.pointerEvents = interactive ? "auto" : "none";
    this.renderer.domElement.style.cursor = interactive ? "grab" : "";
    // spin-only: vertical touch pans keep scrolling the page, horizontal
    // drags come to us; full orbit owns the gesture entirely
    this.renderer.domElement.style.touchAction = this.opts.orbit ? "none" : (this.opts.spin ? "pan-y" : "");
    this._yaw = this._tyaw = this.opts.yaw;
    this._pitch = this._tpitch = this.opts.pitch;
    this._dist = this._tdist = this.opts.dist;
    // The aim point is damped exactly like the eye. Auto framing only adjusts
    // aim + distance; it never changes the user's yaw or pitch.
    this._aimX = this.opts.targetX;
    this._aimY = this.opts.targetY;
    this._aimZ = this.opts.targetZ;
    this._frameBase = {
      dist: this.opts.dist, x: this.opts.targetX, y: this.opts.targetY,
      z: this.opts.targetZ,
    };
    this._manualCameraUntil = 0;
    this._autoFrameNext = 0;
    // screen insets (px) covered by floating UI: the camera centres the twin in
    // what is left. A surface that sets none gets the whole canvas.
    this._insT = { left: 0, right: 0, top: 0, bottom: 0 };
    if (!this._ins) this._ins = { ...this._insT };
    this._frameBaseView = { yaw: this.opts.yaw, pitch: this.opts.pitch, dist: this.opts.dist };
    this._camByView = {};
    this._followInit = false;
    this._armZoomManual = false;
    if (this._armActive()) {
      const f = { ...ARM_FRAMING, ...(this.opts.armFraming || {}) };
      this._yaw = this._tyaw = f.yaw;
      this._pitch = this._tpitch = f.pitch;
      this._dist = this._tdist = f.dist;
    }
    this._armK = this._armActive() ? 1 : 0;   // a surface lands on its view, no ease on mount
    this.setReveal(this.opts.reveal, true);
    this.setCover(this.opts.cover ?? 1, true);   // non-story surfaces: closed machine
    this.setFocus(this.opts.focus ?? 0, true);
    this.setEmphasis({});
    this._ro.disconnect();
    this._ro.observe(container);
    this._resize();
  }

  _build() {
    const w = this.container.clientWidth || 600, h = this.container.clientHeight || 420;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);   // fill-rate cap: full-screen stages at retina were the frame budget
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.26;
    this.renderer.domElement.className = "twin-canvas";

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 60);

    // environment: a small procedural studio for the metal to live in
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene();
    env.background = new THREE.Color(0xAAB7C5);   // neutral studio tone
    const strip = (sw, sh, color, intensity, pos) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(sw, sh),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide })
      );
      m.position.set(...pos);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    strip(14, 6, 0xDCE6F0, 5.2, [0, 9, 2]);      // neutral top key
    strip(10, 7, 0xB9C7D5, 2.4, [-10, 2, -3]);   // neutral fill
    strip(10, 7, 0x8CA0B7, 2.8, [10, 3, 2]);     // restrained cool side
    strip(12, 9, 0x9BAABA, 1.8, [0, -8, 4]);     // neutral floor bounce
    this.scene.environment = pmrem.fromScene(env, 0.06).texture;
    pmrem.dispose();

    // lights
    const key = new THREE.DirectionalLight(0xeaf2ff, 3.0);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const rim = new THREE.PointLight(0xc7d7e7, 20, 22);
    rim.position.set(-3.6, 1.8, -3.6);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0x9FC5E8, 5, 14);
    warm.position.set(2.2, -1.6, 2.8);
    this.scene.add(warm);
    const back = new THREE.DirectionalLight(0x7fa8d8, 0.9);
    back.position.set(-2, 2.5, -5);
    this.scene.add(back);
    const fill = new THREE.AmbientLight(0x7E8FA3, 1.25);
    this.scene.add(fill);
    this._rim = rim;

    // materials
    // The light scene retains its case/machine contrast.  Dark mode instead
    // uses one quiet graphite material across the assembly: no bright inverse,
    // no warm reflected colours and no competing visual gradients.
    const MONO = {
      color: 0x17181B, metalness: 0.1, roughness: 0.55,
      clearcoat: 0.25, clearcoatRoughness: 0.35, envMapIntensity: 0.6,
    };
    this._matShell = new THREE.MeshPhysicalMaterial({ ...MONO });
    this._matDark = new THREE.MeshPhysicalMaterial({ ...MONO });
    // spools: emissive is BONE at zero intensity, so the Drive story step's
    // spool emphasis reads as a white lift instead of the old oxide glow
    this._matSpool = new THREE.MeshPhysicalMaterial({
      ...MONO, emissive: 0xEDE8DC, emissiveIntensity: 0,
    });
    // cover + focus targets get their own instances: the cover fades out at
    // the "brain on the wrist" story step, and the focus targets (motors,
    // internals, screen) lerp toward bone white - the "some white" of the
    // monochrome scheme appears exactly when the site wants you to look
    this._matCover = new THREE.MeshPhysicalMaterial({ ...MONO });
    this._matMotors = new THREE.MeshPhysicalMaterial({
      ...MONO, emissive: 0xEDE8DC, emissiveIntensity: 0,
    });
    this._matInternals = new THREE.MeshPhysicalMaterial({
      ...MONO, emissive: 0xEDE8DC, emissiveIntensity: 0,
    });
    // the twelve AS5600 encoder boards (*_enc nodes): case-toned accents on
    // the machine - white sensors on the black hand, ink on the bone hand
    this._matEnc = new THREE.MeshPhysicalMaterial({ ...MONO, roughness: 0.45 });
    this._cBlack = new THREE.Color(0x17181B);   // ink: machine (light) / case (dark)
    this._cBone = new THREE.Color(0xE8EBEF);    // case (light) / machine (dark), neutral for a white page
    this._cGraphite = new THREE.Color(0x18212C);
    this._cFocusDark = new THREE.Color(0x173B61);
    this._cBody = this._cBlack.clone();         // the machine's current tone
    this._cCase = this._cBone.clone();          // the case's current tone (opposite)
    this.setTheme(getTheme());
    this._onTheme = (e) => this.setTheme(e.detail);
    window.addEventListener("zero:theme", this._onTheme);
    // the GC9A01 display face: black glass, unmistakably a screen. Near-black
    // base + hard clearcoat reflection separates it from the satin case, and a
    // whisper of cold emissive keeps it reading "powered" from any angle.
    this._matScreen = new THREE.MeshPhysicalMaterial({
      color: 0x05070a, metalness: 0.0, roughness: 0.12,
      clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 2.4,
      emissive: 0x0a1420, emissiveIntensity: 0.55,
    });

    // rig root: forearm frame contains the hand frame (relative wrist rotation)
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.forearmGroup = new THREE.Group();
    this.handGroup = new THREE.Group();
    this.forearmGroup.add(this.handGroup);
    this.root.add(this.forearmGroup);

    // stage: a soft contact shadow grounds the machine, the glow gives it life
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 2.3),
      new THREE.MeshBasicMaterial({ map: shadowDiscTexture(), transparent: true, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, -1.52, -0.3);
    this.scene.add(shadow);
    this._shadow = shadow;
    const disc = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: glowDiscTexture(), transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -1.5;
    this.scene.add(disc);
    this._disc = disc;

    this._buildArmStage();

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.container);
  }

  // The "arm in space" stage: a faint limb (upper arm shoulder -> elbow,
  // forearm elbow -> wrist, joint balls), the bone line, a short hand trail,
  // and a world-fixed reference grid below the arm, so shoulder motion and
  // arm translation read at a glance. All of it is quiet by design: the
  // device stays the subject; this is the ruler it moves against.
  _buildArmStage() {
    const st = this.armStage = new THREE.Group();
    st.visible = false;
    this.scene.add(st);
    const limbMat = this._matLimb = new THREE.MeshStandardMaterial({
      color: 0x8FA6BF, roughness: 0.65, metalness: 0.0, transparent: true, opacity: 0.2,
      depthWrite: false,
    });
    const jointMat = this._matJoint = new THREE.MeshStandardMaterial({
      color: 0x8FA6BF, roughness: 0.5, metalness: 0.0, transparent: true, opacity: 0.32,
      depthWrite: false,
    });
    // unit-length cylinders along +Y, scaled/oriented per frame
    const cyl = (rTop, rBot) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, 1, 28, 1, true), limbMat);
      m.renderOrder = 1;
      st.add(m);
      return m;
    };
    this._limbUpper = cyl(0.034 * ARM_S, 0.040 * ARM_S);   // elbow end narrower
    this._limbFore = cyl(0.024 * ARM_S, 0.032 * ARM_S);    // wrist end narrower
    const ball = (r) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), jointMat);
      m.renderOrder = 1;
      st.add(m);
      return m;
    };
    this._jShoulder = ball(0.044 * ARM_S);
    this._jElbow = ball(0.034 * ARM_S);
    // the bones: shoulder -> elbow -> wrist, a crisp accent line inside the limb
    const boneGeo = new THREE.BufferGeometry();
    boneGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    this._bones = new THREE.Line(boneGeo, new THREE.LineBasicMaterial({
      color: 0x2F76BF, transparent: true, opacity: 0.55, depthWrite: false }));
    this._bones.frustumCulled = false;
    st.add(this._bones);
    // hand trail: the last ~3 s of the palm centre, fading with age
    const N = this._trailN = 96;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    tg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(N * 4), 4));
    this._trail = new THREE.Line(tg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false }));
    this._trail.frustumCulled = false;
    this._trailPts = [];
    st.add(this._trail);
    // world-fixed reference grid (lines from world position, faded radially
    // around the followed point: an "infinite" floor that never swims)
    const gridMat = this._matGrid = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color(0x16181C) },
        uAccent: { value: new THREE.Color(0x2F76BF) },
        uOpacity: { value: 0.22 },
        uCell: { value: 0.1 * ARM_S },                 // 10 cm cells
        uCenter: { value: new THREE.Vector2(0, 0) },
        uFade: { value: 1.1 * ARM_S },                 // fades out ~1.1 m from the hand
      },
      vertexShader: `
        varying vec3 vW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform vec3 uAccent; uniform float uOpacity;
        uniform float uCell; uniform vec2 uCenter; uniform float uFade;
        varying vec3 vW;
        float gridLine(vec2 c) {
          vec2 d = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          return 1.0 - min(min(d.x, d.y), 1.0);
        }
        void main() {
          vec2 c = vW.xz / uCell;
          float minor = gridLine(c) * 0.55;
          float major = gridLine(c / 5.0);
          float g = max(minor, major);
          float r = length(vW.xz - uCenter);
          float fade = 1.0 - smoothstep(uFade * 0.35, uFade, r);
          // the body's sagittal line (x = shoulder) in accent: "forward" reads
          float axis = 1.0 - min(abs(vW.x) / fwidth(vW.x), 1.0);
          vec3 col = mix(uColor, uAccent, axis);
          float a = max(g, axis * 0.9) * fade * uOpacity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(col, a);
        }`,
    });
    const grid = this._grid = new THREE.Mesh(new THREE.PlaneGeometry(4 * ARM_S, 4 * ARM_S), gridMat);
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = (FLOOR_Y_M - NEUTRAL_WRIST_M[1]) * ARM_S;
    grid.renderOrder = 0;
    st.add(grid);
    this._applyArmTheme();
  }

  _applyArmTheme() {
    if (!this._matLimb) return;
    const dark = this._theme === "dark";
    this._matLimb.color.setHex(dark ? 0x9DB6D2 : 0x7E95AE);
    this._matLimb.opacity = dark ? 0.16 : 0.2;
    this._matJoint.color.setHex(dark ? 0xB5C9DF : 0x7E95AE);
    this._bones.material.color.setHex(dark ? 0x5BA8F5 : 0x2F76BF);
    this._matGrid.uniforms.uColor.value.setHex(dark ? 0xCCDCF0 : 0x16181C);
    this._matGrid.uniforms.uAccent.value.setHex(dark ? 0x5BA8F5 : 0x2F76BF);
    this._matGrid.uniforms.uOpacity.value = dark ? 0.2 : 0.22;
    this._trailColor = dark ? [0.36, 0.66, 0.96] : [0.18, 0.46, 0.75];
  }

  _armActive() { return !!(this.opts && this.opts.armView) && this._view === "arm"; }

  /** "arm" | "hand" for this surface (a surface without armView is always "hand"). */
  get view() { return this.opts && this.opts.armView ? this._view : "hand"; }

  /** Switch between the arm in space and the classic pinned hand; remembered. */
  setView(v) {
    v = v === "hand" ? "hand" : "arm";
    if (v === this._view) return;
    this._camByView[this._view] = { yaw: this._tyaw, pitch: this._tpitch, dist: this._tdist };
    this._view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch (_) {}
    if (!this.opts.armView) return;
    const f = this._camByView[v] ||
      (v === "arm" ? { ...ARM_FRAMING, ...(this.opts.armFraming || {}) } : this._frameBaseView);
    this._tyaw = f.yaw; this._tpitch = f.pitch; this._tdist = f.dist;
    if (v === "hand") {
      this.opts.targetX = this._frameBase.x;
      this.opts.targetY = this._frameBase.y;
      this.opts.targetZ = this._frameBase.z;
    }
    this._followInit = false;
    this._armZoomManual = false;
    this._trailPts.length = 0;
    this._manualCameraUntil = 0;
    this._autoFrameNext = 0;
  }

  /** Snapshot of what the arm stage drew last frame (tests, HUDs). */
  armInfo() { return this._armInfo; }

  async _buildRig(gltf) {
    const model = gltf.scene.clone(true);

    // creased smooth normals: curved surfaces shade smoothly (no visible
    // facets under the gloss) while true mechanical edges past the crease
    // angle stay crisp. Replaces the old flat-normal "CAD facet" look.
    // TIME-BOXED: the crease pass over the 165k-triangle model used to run
    // as ONE ~280 ms main-thread task - a guaranteed scroll hitch wherever
    // the GLB happened to finish loading. Processing per-mesh in ~8 ms
    // slices keeps every frame under budget; the rig simply becomes ready
    // a few frames later, which nothing can see (it fades in regardless).
    const CREASE = THREE.MathUtils.degToRad(32);
    const meshes = [];
    model.traverse((o) => { if (o.isMesh) meshes.push(o); });
    // yield to the frame loop; the timeout fallback keeps a hidden tab
    // (rAF throttled to nothing) from stalling the rig forever
    const yieldSlice = () => new Promise((r) => {
      requestAnimationFrame(() => r()); setTimeout(r, 80);
    });
    let sliceT0 = performance.now();
    for (const o of meshes) {
      if (performance.now() - sliceT0 > 8) { await yieldSlice(); sliceT0 = performance.now(); }
      if (this._disposed) return;
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      o.geometry = toCreasedNormals(g, CREASE);
      if (o.name.startsWith("spool_")) o.material = this._matSpool;
      else if (o.name === "screen") { o.material = this._matScreen; this._screenMesh = o; }
      else if (o.name === "forearm_cover") o.material = this._matCover;
      else if (o.name === "motors") o.material = this._matMotors;
      else if (o.name === "internals") o.material = this._matInternals;
      else if (o.name === "forearm") o.material = this._matDark;
      else if (o.name.endsWith("_enc")) o.material = this._matEnc;   // AS5600 boards
      else o.material = this._matShell;
    }

    const grab = (name) => model.getObjectByName(name);
    const scaler = new THREE.Group();
    scaler.scale.setScalar(MODEL_SCALE);
    const handScaler = scaler.clone();

    const forearm = grab("forearm"), palm = grab("palm");
    // ten individual spool stations (spool_a0..b4), each with its origin on
    // the spool axis so a local-Y rotation IS the physical spool rotation
    this._spools = Object.keys(SPOOL_STATIONS)
      .map((n) => ({ name: n, node: grab(n) }))
      .filter((s) => s.node)
      .map((s) => ({ ...s, baseQuat: s.node.quaternion.clone() }));
    scaler.add(forearm, ...this._spools.map((s) => s.node));
    const screen = grab("screen");            // display glass (absent in old drops)
    if (screen) scaler.add(screen);
    // story nodes (GLB v12+): the removable cover, the motor bank, and the
    // Teensy/PCB internals - all optional so older drops still load
    const cover = grab("forearm_cover"), motors = grab("motors"), internals = grab("internals");
    for (const n of [cover, motors, internals]) if (n) scaler.add(n);
    this._coverMesh = cover || null;
    handScaler.add(palm);
    this.forearmGroup.add(scaler);
    this.handGroup.add(handScaler);

    // Anatomical wrist pivot: the hand must rotate about the WRIST, not the
    // model origin, so wrist articulation also TRANSLATES the hand exactly as
    // the real one moves (IMUs converge when the wrist flexes). The pivot is
    // the measured one (arm_model.js WRIST_PIVOT_MM, derived from the bridge's
    // lever arms and the GLB), no longer the hand's bounding box, which put it
    // ~27 mm too far toward the fingers.
    this._wristPivot = new THREE.Vector3(...WRIST_PIVOT_MM).multiplyScalar(MODEL_SCALE);
    this.handGroup.position.copy(this._wristPivot);
    handScaler.position.copy(this._wristPivot).negate();  // identity pose unchanged

    // dead-channel ghosting: every mesh of each finger (the abduction node's
    // whole subtree), so a finger whose encoder is dead reads as absent
    this._fingerMeshes = {};
    this._fingerGhost = {};
    this._matGhost = new THREE.MeshStandardMaterial({
      color: 0x9AA7B6, roughness: 0.6, metalness: 0, transparent: true,
      opacity: FINGER_GHOST_OPACITY, depthWrite: false,
    });
    for (const f of FINGERS) {
      const n = palm.getObjectByName(`${f}_mcp`);
      const list = [];
      if (n) n.traverse((o) => { if (o.isMesh) list.push({ mesh: o, mat: o.material }); });
      this._fingerMeshes[f] = list;
      this._fingerGhost[f] = false;
    }

    // forearm reveal rig: the hero can open on the hand alone and let the
    // forearm + spool bank (and the display glass riding it) arrive on scroll
    this._forearmParts = [forearm, screen, cover, motors, internals,
      ...this._spools.map((s) => s.node)]
      .filter(Boolean).map((mesh) => ({ mesh, baseZ: mesh.position.z }));
    // apply the CURRENT reveal state synchronously: this build now yields to
    // the frame loop (time-boxed slices + async compile below), so frames
    // render before _rigReady - without this, the forearm bank flashed in
    // for a beat on a reveal-0 hero before its scroll cue
    {
      const f = this._reveal, cov = this._cover;
      const slide = (1 - f) * 95;
      const op = clamp((f - 0.08) / 0.72, 0, 1);
      for (const p of this._forearmParts) {
        p.mesh.visible = f > 0.02;
        p.mesh.position.z = p.baseZ - slide;
      }
      if (this._coverMesh) this._coverMesh.visible = f > 0.02 && cov > 0.02;
      this._matDark.transparent = this._matSpool.transparent = this._matScreen.transparent =
        this._matMotors.transparent = this._matInternals.transparent = op < 1;
      this._matDark.opacity = this._matSpool.opacity = this._matScreen.opacity =
        this._matMotors.opacity = this._matInternals.opacity = op;
      this._matCover.transparent = op * cov < 1;
      this._matCover.opacity = op * cov;
    }

    // The mechanism's joint order, palm outward (per the device's design):
    //   hinge 1 (GLB node *_mcp): MCP ABDUCTION - swings left/right (local Y)
    //   hinge 2 (GLB node *_pip): MCP FLEXION   - curls up/down (local X)
    //   hinge 3 (GLB node *_dip): PIP FLEXION   - curls up/down (local X)
    // There is no DIP joint on the robot.
    this._fingers = {};
    for (const f of FINGERS) {
      const mkMat = () => new THREE.MeshStandardMaterial({
        color: 0x2A1A12, emissive: 0xC9401B, emissiveIntensity: 0.3, roughness: 0.35, metalness: 0.2,
      });
      const bind = (nodeName, axis) => {
        const node = palm.getObjectByName(nodeName);
        if (!node) return null;
        const ringMat = mkMat();
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, axis === "y" ? 14 : 17, 14), ringMat);
        if (axis === "x") pin.rotation.z = Math.PI / 2;   // cylinder axis is Y by default
        pin.visible = false;   // owner-directed 2026-07-18: no orange axle pins on the hand
        node.add(pin);
        return { node, baseQuat: node.quaternion.clone(), baseZ: node.position.z, ringMat };
      };
      // telescopic sliding members: pure prismatic children (local +Z slide)
      const bindSlide = (nodeName) => {
        const node = palm.getObjectByName(nodeName);
        return node ? { node, baseZ: node.position.z } : null;
      };
      this._fingers[f] = {
        abduct: bind(`${f}_mcp`, "y"),     // vertical axle: left/right swing
        mcpFlex: bind(`${f}_pip`, "x"),    // this hinge RIDES the knuckle block
        pipFlex: bind(`${f}_dip`, "x"),    // this hinge RIDES the distal member
        mcpSlide: bindSlide(`${f}_mcp_slide`),  // knuckle joint block (MCP pivot)
        pipMid: bindSlide(`${f}_pip_mid`),      // centre member: slides s/2
        pipSlide: bindSlide(`${f}_pip_slide`),  // distal member: slides s
        dipSlide: bindSlide(`${f}_dip_slide`),  // fingertip cradle pair
      };
    }

    // status jewel on the palm plate (owner-directed 2026-07-18: hidden with
    // the rest of the orange indicator geometry; activation lives in the UI)
    const jewel = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0x3A1408, emissive: 0xC9401B, emissiveIntensity: 0.8, roughness: 0.3 })
    );
    jewel.position.set(0, 10.5, 30);
    jewel.visible = false;
    palm.add(jewel);
    this._jewel = jewel;

    // thumb-tip IMU pod: pure SENSING (the mechanism is thumb-out by scope;
    // the wearer's thumb tip carries a third BNO085). The pod's orientation
    // is the exact tared measurement in the hand frame (snap.thumb.rel_quat);
    // its anchor point is the documented presentational spot on the thumb
    // side (kinematics.js THUMB_POD_ANCHOR_MM). Hidden until the sensor
    // actually reports - absent is honestly absent.
    {
      const pod = new THREE.Group();
      const podMat = new THREE.MeshStandardMaterial({
        color: 0x3A1408, emissive: 0xC9401B, emissiveIntensity: 0.45,
        roughness: 0.3, metalness: 0.3,
      });
      pod.add(new THREE.Mesh(new THREE.BoxGeometry(9, 3.2, 12), podMat));
      const distal = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 0.9, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x331408, emissive: 0xC9401B, emissiveIntensity: 0.9 }));
      distal.rotation.x = Math.PI / 2;      // along +Z: the tip's distal axis
      distal.position.z = 8.5;
      const dorsal = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 0.9, 6, 8),
        new THREE.MeshStandardMaterial({ color: 0x332608, emissive: 0xC08327, emissiveIntensity: 0.8 }));
      dorsal.position.y = 4.5;              // along +Y: the tip's dorsal axis
      pod.add(distal, dorsal);
      pod.position.set(THUMB_POD_ANCHOR_MM.x, THUMB_POD_ANCHOR_MM.y, THUMB_POD_ANCHOR_MM.z);
      pod.visible = false;   // owner-directed 2026-07-18: stays hidden even when
      palm.add(pod);         // the tip sensor reports (orange geometry removed)
      this._thumbPod = pod;
    }

    // The round display used to read as a dark hole: near-black glass, a whisper
    // of emissive, no texture. It now carries the device's REAL UI, drawn by
    // device_screen.js (the renderer the operator console uses), so the twin
    // shows a powered screen. The GLB disc ships without UVs, so planar ones are
    // generated from local x/z (the disc lies in XZ; Y is its 0.8 mm thickness).
    if (this._screenMesh) {
      try {
        const g = this._screenMesh.geometry;
        if (!g.attributes.uv) {
          g.computeBoundingBox();
          const bb = g.boundingBox, pos = g.attributes.position;
          const sx = (bb.max.x - bb.min.x) || 1, sz = (bb.max.z - bb.min.z) || 1;
          const uv = new Float32Array(pos.count * 2);
          for (let i = 0; i < pos.count; i++) {
            uv[i * 2] = (pos.getX(i) - bb.min.x) / sx;
            uv[i * 2 + 1] = 1 - (pos.getZ(i) - bb.min.z) / sz;
          }
          g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        }
        const { DeviceScreen } = await import("./device_screen.js");
        const cv = document.createElement("canvas");
        cv.width = cv.height = 512;
        const ds = new DeviceScreen(cv);
        ds.render({ face: "home", mode: "home", live: true }, 0);
        const tex = new THREE.CanvasTexture(cv);
        if (THREE.SRGBColorSpace && "colorSpace" in tex) tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
        this._screenTex = tex;
        this._screenDraw = (st, t) => { ds.render(st, t); tex.needsUpdate = true; };
        this._matScreen.map = tex;
        this._matScreen.emissiveMap = tex;
        this._matScreen.color.setHex(0x0B0E14);
        // lit from the first frame, not only while the story's focus cue runs
        this._matScreen.emissive.setHex(0xffffff);
        this._matScreen.emissiveIntensity = 1.05;
        this._matScreen.roughness = 0.16;
        this._matScreen.needsUpdate = true;
      } catch (e) { /* no face available: the plain glass material still renders */ }
    }

    this._qf = new THREE.Quaternion();
    this._qh = new THREE.Quaternion();
    this._q = new THREE.Quaternion();
    // GPU warm-up, in two acts. Without it, the FIRST SCROLL paid a one-time
    // hitch: the forearm bank's vertex buffers only uploaded when it became
    // visible, and the fade materials' transparent=true variants compiled
    // synchronously at the same moment (three keys programs on transparency).
    // 1) flip the fade materials to their transparent variants and let
    //    compileAsync link EVERY program in parallel, off the hot path;
    // 2) draw the whole model once at opacity zero - nothing shows, the
    //    buffers land now - then restore and let the reveal branch re-apply.
    {
      const prev = this._forearmParts.map((p) => p.mesh.visible);
      const mats = [this._matDark, this._matSpool, this._matScreen,
        this._matMotors, this._matInternals, this._matCover];
      const prevMat = mats.map((m) => [m.transparent, m.opacity]);
      for (const p of this._forearmParts) p.mesh.visible = false;
      for (const m of mats) { m.transparent = true; m.opacity = 0; }
      try { await this.renderer.compileAsync(this.scene, this.camera); } catch {}
      if (this._disposed) return;
      // upload ONE part per slice (each drawn alone at opacity 0): on slow
      // CPUs the all-at-once warm draw was itself a >1 s block
      for (const p of this._forearmParts) {
        p.mesh.visible = true;
        this.renderer.render(this.scene, this.camera);
        p.mesh.visible = false;
        await yieldSlice();
        if (this._disposed) return;
      }
      // restore honest visibility, then link the opaque variants too (the
      // fade ends at opacity 1; compile() traverses invisible objects)
      this._forearmParts.forEach((p, i) => { p.mesh.visible = prev[i]; });
      for (const m of mats) { m.transparent = false; m.opacity = 1; }
      try { await this.renderer.compileAsync(this.scene, this.camera); } catch {}
      if (this._disposed) return;
      mats.forEach((m, i) => { m.transparent = prevMat[i][0]; m.opacity = prevMat[i][1]; });
    }
    this._revealDirty = true;
    this._focusDirty = true;
    this._rigReady = true;
  }

  _bind() {
    // bound once; every handler gates on the CURRENT surface's orbit option
    const c = this.renderer.domElement;
    c.addEventListener("pointerdown", (e) => {
      if (!this.opts.orbit && !this.opts.spin) return;
      this._dragging = true; this._px = e.clientX; this._py = e.clientY;
      // Smart framing must yield while the user is orbiting, but a long
      // cooldown made the cockpit appear broken: every exploratory drag kept
      // resetting a 2 s timer.  The drag itself is the real lock; on release
      // we give the user's view a brief beat, then smoothly reacquire the rig.
      this._manualCameraUntil = performance.now();
      c.setPointerCapture(e.pointerId);
      c.style.cursor = "grabbing";
    });
    c.addEventListener("pointermove", (e) => {
      if (!this._dragging) return;
      this._tyaw += (e.clientX - this._px) * 0.006;
      if (this.opts.orbit) {   // spin mode is yaw-only: a simple turntable
        this._tpitch = clamp(this._tpitch + (e.clientY - this._py) * 0.005, -0.15, 1.38);
      }
      this._px = e.clientX; this._py = e.clientY;
      this._manualCameraUntil = performance.now();
    });
    const up = () => {
      this._dragging = false;
      this._manualCameraUntil = performance.now() + 350;
      this._autoFrameNext = 0;          // calculate a fresh fit immediately after the grace period
      if (this.opts.orbit || this.opts.spin) c.style.cursor = "grab";
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("dblclick", () => { if (this.opts.orbit) this.recenter(); });
    c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", (e) => {
      if (!this.opts.orbit) return;
      e.preventDefault();
      this._tdist = clamp(this._tdist + e.deltaY * 0.004, 3.0, this._armActive() ? 22 : Math.max(9.5, this.opts.autoFrameMaxDist || 0));
      if (this._armActive()) this._armZoomManual = true;
      this._manualCameraUntil = performance.now() + 450;
      this._autoFrameNext = 0;
    }, { passive: false });
  }

  _resize() {
    if (this._disposed || !this.container) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w < 2 || h < 2) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this._autoFrameNext = 0;            // aspect changes need a new sphere fit, not a stale distance
  }

  // sm = store.smooth; call every animation frame
  render(sm, dt = 16) {
    if (this._disposed || !this.container || !this.renderer.domElement.isConnected) return;
    this._t += dt / 1000;
    const t = this._t;

    if (this._rigReady) {
      // forearm reveal + cover: fade + a slide along the arm axis, softly damped
      if (this._reveal !== this._revealT || this._cover !== this._coverT || this._revealDirty) {
        const kk = 1 - Math.exp(-dt / 160);
        this._reveal = lerp(this._reveal, this._revealT, kk);
        this._cover = lerp(this._cover, this._coverT, kk);
        if (Math.abs(this._reveal - this._revealT) < 0.002) this._reveal = this._revealT;
        if (Math.abs(this._cover - this._coverT) < 0.002) this._cover = this._coverT;
        this._revealDirty = this._reveal !== this._revealT || this._cover !== this._coverT;
        const f = this._reveal, cov = this._cover;
        const slide = (1 - f) * 95;                     // mm, drifts down the arm
        const op = clamp((f - 0.08) / 0.72, 0, 1);
        for (const p of this._forearmParts) {
          p.mesh.visible = f > 0.02;
          p.mesh.position.z = p.baseZ - slide;
        }
        // the cover can lift away independently ("A brain on the wrist")
        if (this._coverMesh) this._coverMesh.visible = f > 0.02 && cov > 0.02;
        this._matDark.transparent = this._matSpool.transparent = this._matScreen.transparent =
          this._matMotors.transparent = this._matInternals.transparent = op < 1;
        this._matDark.opacity = this._matSpool.opacity = this._matScreen.opacity =
          this._matMotors.opacity = this._matInternals.opacity = op;
        this._matCover.transparent = op * cov < 1;
        this._matCover.opacity = op * cov;
      }
      // Story focus stays sapphire on a dark page, never bleaching the twin.
      if (this._focus !== this._focusT || this._focusDirty) {
        this._focus = lerp(this._focus, this._focusT, 1 - Math.exp(-dt / 140));
        if (Math.abs(this._focus - this._focusT) < 0.004) this._focus = this._focusT;
        this._focusDirty = this._focus !== this._focusT;
        const F = this._focus;
        for (const m of [this._matMotors, this._matInternals]) {
          // In dark mode this is a subdued sapphire cue, not a white glow.
          m.emissiveIntensity = 0.25 * F;
        }
        const screenFocus = this._theme === "dark" ? this._cFocusDark : this._cBone;
        if (this._matScreen.emissiveMap) {
          // a lit screen: emissive stays WHITE so the mapped UI shows its own
          // colours; the story's focus cue rides intensity, not hue
          this._matScreen.emissive.setHex(0xffffff);
          this._matScreen.emissiveIntensity = 1.05 + F * 0.55;
        } else {
          this._matScreen.emissive.setHex(0x0a1420).lerp(screenFocus, F);
          this._matScreen.emissiveIntensity = 0.55 + F * 0.7;
        }
      }
      const em = this._emph || { pins: 1, jewel: 1, spools: 1 };
      const setJoint = (j, axis, deg, glow01) => {
        if (!j) return;
        this._qTmp.setFromAxisAngle(axis, deg * D2R);
        j.node.quaternion.copy(j.baseQuat).multiply(this._qTmp);
        j.ringMat.emissiveIntensity = (0.22 + clamp(glow01, 0, 1) * 1.15) * em.pins;
      };
      // one shared kinematic model drives rotations, telescopic slides, and
      // spool angles (kinematics.js: exact slide law + as-built spool law)
      const poses = this._poses || (this._poses = {});
      for (const f of FINGERS) {
        const jf = this._fingers[f];
        if (!jf) continue;
        // channel semantics match the mechanism's chain, palm outward: the
        // {f}_mcp encoder is hinge 1 = MCP ABDUCTION (signed deg, + = toward
        // the thumb side), {f}_pip is hinge 2 = MCP flexion, {f}_dip is
        // hinge 3 = PIP flexion. Every DOF the device senses drives its node.
        const p = fingerPose(f, sm.joints[`${f}_mcp`], sm.joints[`${f}_pip`], sm.joints[`${f}_dip`]);
        poses[f] = p;
        setJoint(jf.abduct, this._axAbduct, p.ab, Math.abs(p.ab) / 12);
        setJoint(jf.mcpFlex, this._axMcpFlex, p.mcp, (p.mcp - 8) / 52);
        setJoint(jf.pipFlex, this._axPipFlex, p.pip, (p.pip - 8) / 52);
        // the prismatic pairs: the knuckle joint block slides distally on the
        // palm-side rail, carrying the MCP flexion pivot with it (rotation
        // point stays aligned with the anatomy); the two-stage link along the
        // proximal phalanx extends by s (centre member s/2), carrying the PIP
        // hinge outward; the fingertip cradle extends on the single distal pair
        if (jf.mcpSlide) jf.mcpSlide.node.position.z = jf.mcpSlide.baseZ + p.slideKnuckleMm;
        if (jf.mcpFlex) jf.mcpFlex.node.position.z = jf.mcpFlex.baseZ + p.slideKnuckleMm;
        if (jf.pipMid) jf.pipMid.node.position.z = jf.pipMid.baseZ + p.slideMcpMidMm;
        if (jf.pipSlide) jf.pipSlide.node.position.z = jf.pipSlide.baseZ + p.slideMcpMm;
        if (jf.pipFlex) jf.pipFlex.node.position.z = jf.pipFlex.baseZ + p.slideMcpMm;
        if (jf.dipSlide) jf.dipSlide.node.position.z = jf.dipSlide.baseZ + p.slidePipMm;
      }
      // thumb-tip pod: orientation still tracks the measurement, but the pod
      // stays invisible (owner-directed; flip pod.visible to re-enable)
      if (this._thumbPod && sm.thumbRel) {
        const th = sm.thumbRel;
        this._thumbPod.quaternion.set(th[1], th[2], th[3], th[0]);
      }
      // motor digital twin: each spool station turns by exactly the angle
      // that produces the tendon displacement (control state wins when the
      // host reports motors; else derived from the encoder joint angles)
      if (this._spools) {
        const md = this._motorsDeg || (this._motorsDeg = {});
        // surfaces that synthesise their own frame state (mirror) may carry no
        // motors map at all; `id in undefined` threw every frame there
        const motors = sm.motors || {};
        for (const id in md) if (!(id in motors)) delete md[id];  // vanished motor: stop driving its spool
        for (const id in motors) md[id] = motors[id].pos;
        for (const s of this._spools) {
          this._qTmp.setFromAxisAngle(this._yAxis, spoolAngleDeg(s.name, poses, md) * D2R);
          s.node.quaternion.copy(s.baseQuat).multiply(this._qTmp);
        }
      }
      // dead encoder channels: ghost the whole finger (the store already holds
      // its joints at a relaxed neutral instead of the bridge's 0.0 zero-fill)
      if (this._fingerMeshes) {
        const ok = sm.jointOk || {};
        for (const f of FINGERS) {
          const dead = ok[`${f}_mcp`] === false || ok[`${f}_pip`] === false || ok[`${f}_dip`] === false;
          if (dead === this._fingerGhost[f]) continue;
          this._fingerGhost[f] = dead;
          for (const m of this._fingerMeshes[f]) m.mesh.material = dead ? this._matGhost : m.mat;
        }
      }

      this._poseArm(sm, dt);
      const a = sm.activation.level || 0;
      this._jewel.material.emissiveIntensity = (0.5 + a * 2.6) * em.jewel;
      // Spool emphasis remains a restrained material cue, never a light bloom.
      const spoolLift = clamp((em.spools - 1) * 0.045, 0, 0.4);
      this._matSpool.emissiveIntensity = spoolLift;
      this._disc.material.opacity = 0.12 + a * 0.16;
      this._rim.intensity = 22 + a * 18;
    }

    // idle float (the pinned hand only: the arm in space is measured position,
    // and a decorative bob there would read as motion that never happened)
    const armK = this._armK;
    if (this.opts.idle && !reducedMotion()) {
      this.root.position.y = Math.sin(t * 0.6) * 0.045 * (1 - armK);
      this.root.rotation.z = Math.sin(t * 0.4) * 0.012 * (1 - armK);
      if (!this._dragging && this.opts.idleSpin) this._tyaw += dt * 0.000045;
    } else {
      this.root.position.y = 0;
      this.root.rotation.z = 0;
    }

    // Smart framing is deliberately opt-in for the live cockpit. At 10 Hz it
    // measures the articulated device (including fingertip geometry), aims at
    // its centre, and computes the distance needed to contain its bounding
    // sphere in the narrower screen dimension. A manual orbit/zoom suspends
    // these updates; yaw and pitch are never touched, so the camera does not
    // wrestle control away from the operator.
    const frameNow = performance.now();
    if (this._armActive() && this._armInfo) {
      // arm in space: the aim FOLLOWS the arm (mostly the hand, some elbow and
      // shoulder so the limb stays readable), eased on its own slower filter so
      // the camera glides rather than chases. The user's orbit and zoom stay
      // theirs; only the aim point moves.
      const fk = this._followInit ? 1 - Math.exp(-dt / 320) : 1;
      this._follow.lerp(this._armInfo.focus, fk);
      this.opts.targetX = this._follow.x;
      this.opts.targetY = this._follow.y;
      this.opts.targetZ = this._follow.z;
      // distance: fit a sphere holding the hand (plus the device's reach), the
      // wrist, the elbow and the lower half of the upper arm, so the hand never
      // leaves the frame; a manual zoom (wheel) takes over until the view resets
      if (!this._armZoomManual && frameNow >= this._autoFrameNext) {
        this._autoFrameNext = frameNow + 100;
        const i = this._armInfo, f = this._follow;
        // room-fixed: frame the arm's reach envelope (forward, down and to the
        // side of the shoulder: 0.62 m around the aim), never the current pose,
        // so the distance does not breathe with the motion either
        let r = this.opts.armFollow ? 0 : 0.62 * ARM_S;
        const reach = (p, pad) => {
          const NW = NEUTRAL_WRIST_M;
          const dx = (p[0] - NW[0]) * ARM_S - f.x, dy = (p[1] - NW[1]) * ARM_S - f.y, dz = (p[2] - NW[2]) * ARM_S - f.z;
          r = Math.max(r, Math.hypot(dx, dy, dz) + pad * ARM_S);
        };
        if (this.opts.armFollow) {
        reach(i.hand, 0.06);
        reach(i.tip, 0.04);
        reach(i.wrist, 0.05);
        reach(i.elbow, 0.05);
        reach(i.shoulder.map((v, k) => (v + i.elbow[k]) / 2), 0.03);
        }
        const fv = this._freeView();
        const d = fitSphereDistance(r, fv.fov, fv.aspect,
          { margin: 1.14, min: 6.5, max: 22, fallback: this._tdist });
        this._tdist = this._followInit ? lerp(this._tdist, d, 0.35) : d;
        if (!this._followInit) this._dist = d;
      }
      this._followInit = true;
    } else if (this.opts.autoFrame && this._rigReady && !this._dragging &&
        frameNow >= this._manualCameraUntil && frameNow >= this._autoFrameNext) {
      this._autoFrameNext = frameNow + 100;
      this.root.updateMatrixWorld(true);
      this._frameBounds.setFromObject(this.root);
      if (!this._frameBounds.isEmpty()) {
        this._frameBounds.getBoundingSphere(this._frameSphere);
        const base = this._frameBase;
        const shift = this.opts.autoFrameMaxTargetShift ?? 2.4;
        const centre = this._frameSphere.center;
        this.opts.targetX = clamp(centre.x, base.x - shift, base.x + shift);
        this.opts.targetY = clamp(centre.y, base.y - shift, base.y + shift);
        this.opts.targetZ = clamp(centre.z, base.z - shift, base.z + shift);
        const fv = this._freeView();
        this._tdist = fitSphereDistance(
          this._frameSphere.radius, fv.fov, fv.aspect,
          { margin: this.opts.autoFrameMargin ?? 1.16,
            min: this.opts.autoFrameMinDist ?? Math.max(3, base.dist * 0.76),
            max: this.opts.autoFrameMaxDist ?? Math.min(9.5, base.dist * 1.48),
            fallback: this._tdist }
        );
      }
    }

    // camera: damped orbit. EVERY degree of freedom rides the SAME filter -
    // eye AND aim point. They used to disagree: yaw/pitch/dist eased over
    // ~120 ms while targetY/targetZ were written straight through by
    // setFraming, so a scroll-driven camera move swung the lens ahead of the
    // body and the machine swam and sheared inside the frame. One k, one
    // motion.
    const k = 1 - Math.exp(-dt / 120);
    this._yaw = lerp(this._yaw, this._tyaw, k);
    this._pitch = lerp(this._pitch, this._tpitch, k);
    this._dist = lerp(this._dist, this._tdist, k);
    this._aimX = lerp(this._aimX, this.opts.targetX, k);
    this._aimY = lerp(this._aimY, this.opts.targetY, k);
    this._aimZ = lerp(this._aimZ, this.opts.targetZ, k);
    this._applyInsets(k);
    const cy = Math.cos(this._pitch), sy = Math.sin(this._pitch);
    this.camera.position.set(
      this._aimX + Math.sin(this._yaw) * cy * this._dist,
      sy * this._dist + this._aimY,
      this._aimZ + Math.cos(this._yaw) * cy * this._dist
    );
    this.camera.lookAt(this._aimX, this._aimY, this._aimZ);

    this.renderer.render(this.scene, this.camera);
  }

  // Place forearm + hand. Two placements, eased into each other by _armK:
  //   pinned (hand view, every non-arm surface): orientation only, the wrist
  //     pivot stays put and the forearm swings about it;
  //   body (arm view): the body model, contract section 7. The forearm module
  //     is oriented by forearm_quat and translated so the model's wrist pivot
  //     sits on wrist_m (so it pivots about the ELBOW, the wrist riding its
  //     sphere), the hand turns about the wrist by inv(Qf)*Qh, and the whole
  //     arm moves through space with the body model. Without a bridge body
  //     block the contract's zero-evidence arm is synthesised (upper arm
  //     hanging): no shoulder motion, and armInfo says so.
  _poseArm(sm, dt) {
    const armOn = this._armActive();
    const goal = armOn ? 1 : 0;
    this._armK = Math.abs(goal - this._armK) < 0.002 ? goal : lerp(this._armK, goal, 1 - Math.exp(-dt / 260));
    const k = this._armK;

    const b = sm.body;
    const fq = (b && b.forearmQuat) || sm.forearmQuat;
    const hq = (b && b.handQuat) || sm.handQuat;
    this._qf.set(fq[1], fq[2], fq[3], fq[0]);
    this._qh.set(hq[1], hq[2], hq[3], hq[0]);
    this.forearmGroup.quaternion.copy(this._qf);
    // hand relative to the forearm. The bridge's rel.quat is mounting-corrected
    // and projected onto the anatomical wrist envelope; with a body model the
    // two body quaternions are the truth (the bridge derives rel from them).
    if (!b && sm.wristQuat) {
      const wr = sm.wristQuat;
      this._q.set(wr[1], wr[2], wr[3], wr[0]);
    } else {
      this._q.copy(this._qf).invert().multiply(this._qh);
    }
    this.handGroup.quaternion.copy(this._q);
    // The wrist pivot is a mechanical connection, so it stays attached to
    // the forearm. Rotating the hand about this pivot already produces the
    // real distal side-to-side displacement (rel.pos_mm is telemetry, not a
    // free translational wrist DoF).
    this.handGroup.position.copy(this._wristPivot);

    // pinned: forearmGroup.position = P - Qf*P keeps the pivot P fixed
    const rotP = this._vB.copy(this._wristPivot).applyQuaternion(this._qf);
    const pinned = this._vA.copy(this._wristPivot).sub(rotP);
    if (k <= 0) {
      this.forearmGroup.position.copy(pinned);
      if (this.armStage.visible) this.armStage.visible = false;
      this._disc.visible = true;
      if (this._shadowHome) {
        this._shadow.position.copy(this._shadowHome);
        this._shadow.scale.setScalar(1);
        this._shadow.material.opacity = 1;
      }
      this._armInfo = null;
      return;
    }

    let B = b;
    if (!B) {
      const sb = synthBody(qValid(fq) || [1, 0, 0, 0], qValid(hq) || [1, 0, 0, 0]);
      B = { shoulder: sb.shoulder_m, elbow: sb.elbow_m, wrist: sb.wrist_m, hand: sb.hand_m,
            synthetic: true, posSource: "arm" };
    }
    const NW = NEUTRAL_WRIST_M;
    const toS = (p, out) => out.set((p[0] - NW[0]) * ARM_S, (p[1] - NW[1]) * ARM_S, (p[2] - NW[2]) * ARM_S);
    const vS = toS(B.shoulder, this._vS || (this._vS = new THREE.Vector3()));
    const vE = toS(B.elbow, this._vE || (this._vE = new THREE.Vector3()));
    const vW = toS(B.wrist, this._vW || (this._vW = new THREE.Vector3()));
    const vH = toS(B.hand, this._vH || (this._vH = new THREE.Vector3()));
    // body placement: model wrist pivot onto wrist_m
    const placed = this._vC.copy(vW).sub(rotP);
    this.forearmGroup.position.lerpVectors(pinned, placed, k);

    const st = this.armStage;
    st.visible = true;
    const up = this._yAxis;
    const seg = (mesh, a, c) => {
      const d = this._vP || (this._vP = new THREE.Vector3());
      d.subVectors(c, a);
      const len = d.length();
      if (len < 1e-6) { mesh.visible = false; return; }
      mesh.visible = true;
      mesh.position.addVectors(a, c).multiplyScalar(0.5);
      mesh.scale.set(1, len, 1);
      mesh.quaternion.setFromUnitVectors(up, d.divideScalar(len));
    };
    seg(this._limbUpper, vS, vE);
    seg(this._limbFore, vE, vW);
    this._jShoulder.position.copy(vS);
    this._jElbow.position.copy(vE);
    const dark = this._theme === "dark";
    this._matLimb.opacity = (dark ? 0.12 : 0.15) * k;
    this._matJoint.opacity = (dark ? 0.2 : 0.24) * k;
    this._bones.material.opacity = 0.55 * k;
    const bp = this._bones.geometry.attributes.position;
    bp.setXYZ(0, vS.x, vS.y, vS.z); bp.setXYZ(1, vE.x, vE.y, vE.z); bp.setXYZ(2, vW.x, vW.y, vW.z);
    bp.needsUpdate = true;

    // trail: the palm centre, sampled at ~30 Hz, the newest opaque
    this._trailT += dt;
    if (this._trailT >= 33) {
      this._trailT = 0;
      this._trailPts.push(vH.x, vH.y, vH.z);
      if (this._trailPts.length > this._trailN * 3) this._trailPts.splice(0, 3);
    }
    {
      const n = this._trailPts.length / 3;
      const pos = this._trail.geometry.attributes.position, col = this._trail.geometry.attributes.color;
      const c = this._trailColor || [0.18, 0.46, 0.75];
      for (let i = 0; i < n; i++) {
        pos.setXYZ(i, this._trailPts[i * 3], this._trailPts[i * 3 + 1], this._trailPts[i * 3 + 2]);
        col.setXYZW(i, c[0], c[1], c[2], Math.pow((i + 1) / n, 1.6) * 0.75 * k);
      }
      pos.needsUpdate = col.needsUpdate = true;
      this._trail.geometry.setDrawRange(0, n);
    }

    // grid under the followed point; lines are world-fixed (shader), so moving
    // the plane only moves the fade window, never the lines
    const gy = (FLOOR_Y_M - NW[1]) * ARM_S;
    // aim: mostly the hand (between palm centre and fingertips), some elbow and
    // shoulder so the limb reads; the fingertips sit ~0.1 m past the palm centre
    const vT = this._vT || (this._vT = new THREE.Vector3());
    vT.subVectors(vH, vW).multiplyScalar(1.6).add(vH);
    // [2026-09-29] ROOM-FIXED aim by default: halfway between the shoulder and
    // the neutral wrist (the scene origin). A camera that follows the hand
    // cancels exactly the translation this stage exists to show - the hand
    // stayed centred and only the grid slid. opts.armFollow keeps the old
    // hand-following aim for close-up work.
    const focus = this._vF || (this._vF = new THREE.Vector3());
    if (this.opts.armFollow) {
      focus.set(0, 0, 0).addScaledVector(vS, 0.1).addScaledVector(vE, 0.15)
        .addScaledVector(vH, 0.35).addScaledVector(vT, 0.4);
    } else {
      focus.copy(vS).multiplyScalar(0.5);
    }
    this._grid.position.set(focus.x, gy, focus.z);
    this._matGrid.uniforms.uCenter.value.set(vH.x, vH.z);
    this._matGrid.uniforms.uOpacity.value = (dark ? 0.2 : 0.22) * k;
    // the contact shadow drops onto the grid straight below the hand: its
    // spread + fade encode height, which is what makes vertical motion legible
    if (this._shadow) {
      if (!this._shadowHome) this._shadowHome = this._shadow.position.clone();
      const h = Math.max(0, vH.y - gy);
      this._vP.set(vH.x, gy + 0.01, vH.z - 0.15);
      this._shadow.position.lerpVectors(this._shadowHome, this._vP, k);
      this._shadow.scale.setScalar(lerp(1, 0.55 + h * 0.06, k));
      this._shadow.material.opacity = lerp(1, clamp(1.05 - h * 0.07, 0.25, 1), k);
    }
    this._disc.visible = k < 0.98;

    this._armInfo = {
      synthetic: !!B.synthetic, posSource: B.posSource || "arm",
      shoulder: B.shoulder, elbow: B.elbow, wrist: B.wrist, hand: B.hand,
      tip: [0, 1, 2].map((i) => B.hand[i] + (B.hand[i] - B.wrist[i]) * 1.6),
      focus, k,
    };
  }

  /** Screen insets (px) covered by floating panels. The projection centre
   *  moves to the middle of the free area and the auto-fit sizes the twin for
   *  it, so opening or hiding a panel glides the twin rather than covering it. */
  setInsets({ left = 0, right = 0, top = 0, bottom = 0 } = {}) {
    const n = (v) => Math.max(0, Number(v) || 0);
    this._insT = { left: n(left), right: n(right), top: n(top), bottom: n(bottom) };
    this._autoFrameNext = 0;
  }

  // the free area as a camera: vertical fov and aspect of the uncovered region
  _freeView() {
    const W = this.container ? this.container.clientWidth : 0;
    const H = this.container ? this.container.clientHeight : 0;
    const i = this._insT || { left: 0, right: 0, top: 0, bottom: 0 };
    const wf = W - i.left - i.right, hf = H - i.top - i.bottom;
    if (!(W > 2 && H > 2 && wf > 80 && hf > 80)) return { fov: this.camera.fov, aspect: this.camera.aspect };
    const v = this.camera.fov * Math.PI / 180;
    const fov = 2 * Math.atan(Math.tan(v / 2) * hf / H) * 180 / Math.PI;
    return { fov, aspect: wf / hf };
  }

  _applyInsets(k) {
    const W = this.container ? this.container.clientWidth : 0;
    const H = this.container ? this.container.clientHeight : 0;
    if (!(W > 2 && H > 2)) return;
    const a = this._ins, b = this._insT;
    let moved = false;
    for (const key of ["left", "right", "top", "bottom"]) {
      const v = Math.abs(b[key] - a[key]) < 0.5 ? b[key] : lerp(a[key], b[key], k);
      if (v !== a[key]) { a[key] = v; moved = true; }
    }
    const dx = (a.left - a.right) / 2, dy = (a.top - a.bottom) / 2;
    const key = `${W}x${H}:${dx.toFixed(1)},${dy.toFixed(1)}`;
    if (!moved && key === this._insKey) return;
    this._insKey = key;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(W, H, -dx, -dy, W, H);
    this.camera.updateProjectionMatrix();
  }

  /** Camera presets, named from the wearer's side of the arm:
   *  wearer = behind the right shoulder, looking along the arm (the twin
   *  turns the way the wearer sees their own arm turn); side = from the
   *  wearer's right; top = from above, forward up the screen; front = facing
   *  the wearer (a mirror: rotations read reversed, as in any mirror). */
  cameraPreset(name) {
    const arm = this._armActive();
    const P = {
      wearer: arm ? { yaw: ARM_FRAMING.yaw, pitch: ARM_FRAMING.pitch } : { yaw: Math.PI + 0.9, pitch: 0.78 },
      side:   { yaw: -Math.PI / 2, pitch: 0.22 },
      top:    { yaw: Math.PI, pitch: 1.36 },
      front:  { yaw: 0.45, pitch: 0.34 },
    }[name];
    if (!P) return false;
    this._tyaw = this._yaw + wrapPi(P.yaw - this._yaw);    // turn the short way round
    this._tpitch = P.pitch;
    this.recenter();
    return true;
  }

  /** Drop any manual zoom and re-fit on the next frame. */
  recenter() {
    this._armZoomManual = false;
    this._manualCameraUntil = 0;
    this._autoFrameNext = 0;
  }

  setFraming({ yaw, pitch, dist, targetX, targetY, targetZ } = {}) {
    if (yaw != null) this._tyaw = yaw;
    if (pitch != null) this._tpitch = pitch;
    if (dist != null) this._tdist = dist;
    if (targetX != null) this.opts.targetX = targetX;
    if (targetY != null) this.opts.targetY = targetY;
    if (targetZ != null) this.opts.targetZ = targetZ;
  }

  // forearm reveal: 0 = the hand alone, 1 = the full assembly. The change
  // eases in render; pass snap=true to land it instantly (e.g. before the
  // first paint, so a hand-only hero never flashes the forearm).
  setReveal(f, snap = false) {
    this._revealT = clamp(f, 0, 1);
    if (snap) this._reveal = this._revealT;
    this._revealDirty = true;   // guarantees one apply pass even after a snap
  }

  // Light mode follows the two-tone physical reference.  Dark mode is
  // intentionally monochrome graphite so that the page reads as one calm
  // black instrument, with sapphire reserved for the display and focus state.
  setTheme(t) {
    this._theme = t === "dark" ? "dark" : "light";
    const dark = this._theme === "dark";
    this._cBody.copy(dark ? this._cGraphite : this._cBlack);
    this._cCase.copy(dark ? this._cGraphite : this._cBone);
    for (const m of [this._matShell, this._matSpool, this._matMotors, this._matInternals]) {
      if (m) { m.color.copy(this._cBody); m.envMapIntensity = dark ? 0.18 : 0.6; }
    }
    // case tone: cradle + cover + the AS5600 encoder boards (white sensors
    // on the black hand, ink sensors on the bone hand)
    for (const m of [this._matDark, this._matCover, this._matEnc]) {
      if (m) { m.color.copy(this._cCase); m.envMapIntensity = dark ? 0.18 : 0.6; }
    }
    for (const m of [this._matSpool, this._matMotors, this._matInternals]) {
      m.emissive.copy(dark ? this._cFocusDark : this._cBone);
    }
    this._applyArmTheme();
    this._focusDirty = true;   // re-apply the focus lift on the new base
  }

  // forearm cover: 1 = closed machine, 0 = interior exposed (the "brain on
  // the wrist" story step). Eases like the reveal; snap lands it instantly.
  setCover(k, snap = false) {
    this._coverT = clamp(k, 0, 1);
    if (snap) this._cover = this._coverT;
    this._revealDirty = true;
  }

  // story focus 0..1: motors + internals lift toward bone white and the
  // display wakes, so the page can point at the inside of the machine.
  setFocus(w, snap = false) {
    this._focusT = clamp(w, 0, 1);
    if (snap) this._focus = this._focusT;
    this._focusDirty = true;   // guarantees one apply pass even after a snap
  }

  // scroll-story emphasis: multiply the glow of one subsystem (pins = joint
  // axles, jewel = intent, spools = drive bank). Values ease back via render.
  setEmphasis({ pins = 1, jewel = 1, spools = 1 } = {}) {
    this._emph = { pins, jewel, spools };
  }

  // land the camera on its targets immediately (used by the story test hook)
  snapFraming() {
    this._yaw = this._tyaw;
    this._pitch = this._tpitch;
    this._dist = this._tdist;
    this._aimX = this.opts.targetX;
    this._aimY = this.opts.targetY;
    this._aimZ = this.opts.targetZ;
  }

  // Views call this on unmount. The shared GL context, environment, and
  // model stay warm; only the canvas leaves the DOM until the next acquire.
  dispose() {
    this._ro.disconnect();
    this.renderer.domElement.remove();
    this.container = null;
  }
}
