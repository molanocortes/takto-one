// passthrough.js - the AR session and the stage. In XR this renders over the
// real room (alpha-clear passthrough, immersive-ar). On desktop it renders a
// believable stand-in for a dim, real room (visible walls, a warm desk) so the
// palette is tuned against reality, not against black. One lighting model,
// calm exposure, ACES.

import * as THREE from "../../vendor/three.module.js";

export const DESK_Y = 0.75;               // desk surface height [m], local-floor

// The stand-in room the experience is TUNED against. The device lives in a
// normally-lit room (daylight), so "bright" is the default and the truth;
// ?room=dim keeps the old evening mood for comparison only.
const ROOMS = {
  bright: {
    skyLo: [0.36, 0.38, 0.41], skyHi: [0.66, 0.70, 0.76],
    win: [0.22, 0.24, 0.26], lamp: [0.10, 0.07, 0.04],
    key: 1.5, fill: 0.7, amb: 0.95, exposure: 1.0,
    envLo: [0.30, 0.32, 0.35], envHi: [0.62, 0.66, 0.72],
    wood: "#4a3a2c",
  },
  dim: {
    skyLo: [0.052, 0.055, 0.062], skyHi: [0.135, 0.150, 0.172],
    win: [0.10, 0.12, 0.14], lamp: [0.085, 0.055, 0.028],
    key: 1.1, fill: 0.45, amb: 0.5, exposure: 1.05,
    envLo: [0.05, 0.055, 0.062], envHi: [0.16, 0.18, 0.21],
    wood: "#2b211a",
  },
};

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: "high-performance",
      preserveDrawingBuffer: true,   // stills must capture cleanly (verification)
    });
    const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
    this.room = ROOMS[params.get("room")] || ROOMS.bright;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.room.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setFoveation(1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.02, 40);

    // the desk anchor: everything world-locked hangs off this
    this.anchor = new THREE.Group();
    this.anchor.position.set(0, DESK_Y, -0.55);
    this.scene.add(this.anchor);

    // lighting: calm PBR from a small prefiltered environment + a warm key
    this._buildEnvironment();
    this.key = new THREE.DirectionalLight(0xfff0dd, this.room.key);
    this.key.position.set(0.7, 1.9, 0.5);
    this.scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0x9fc4d8, this.room.fill);
    this.fill.position.set(-0.8, 1.0, -0.4);
    this.scene.add(this.fill);
    this.ambient = new THREE.AmbientLight(0x8a94a2, this.room.amb * 0.7);
    this.scene.add(this.ambient);
    // the soft sky/ground wrap that makes glass and bone feel lit by a room
    this.hemi = new THREE.HemisphereLight(0xdfe9f4, 0x8a7357, this.room.amb * 0.75);
    this.scene.add(this.hemi);

    // world-brighten hook (RHYTHM streaks lift this, eases back)
    this._brighten = 0;

    this.isXR = false;
    this._deskStandIn = null;
    this._camDrift = { t: 0 };
    // THE STAGE (ui/stage.js): where the canonical layout sits in the room.
    // XR: an offset reference space off local-floor. Desktop: the simulated
    // head and the stand-in room are carried by its inverse, which is exactly
    // what the offset space does to the headset's poses.
    this.stage = { yaw: 0, pos: [0, 0, 0] };
    this._stageInv = new THREE.Matrix4();
    this._m = new THREE.Matrix4();
    this._baseRef = null;              // local-floor as granted (XR only)
    // desktop head simulation (verification of recenter): turn + stand up
    this.simHead = { yaw: 0, stand: 0 };
    this._buildDesktopStandIn();
    this._setDesktopCamera();

    addEventListener("resize", () => {
      if (this.renderer.xr.isPresenting) return;
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  // a small procedural environment for PBR reflections: a dim room gradient
  // with a bright window and a warm lamp, prefiltered by PMREM.
  _buildEnvironment() {
    const R = this.room;
    const envScene = new THREE.Scene();
    const grad = new THREE.Mesh(
      new THREE.SphereGeometry(10, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          uLo: { value: new THREE.Vector3(...R.envLo) },
          uHi: { value: new THREE.Vector3(...R.envHi) },
        },
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec3 vP; uniform vec3 uLo; uniform vec3 uHi;
          void main(){
            float h = normalize(vP).y * 0.5 + 0.5;
            gl_FragColor = vec4(mix(uLo, uHi, pow(h, 1.3)), 1.0);
          }`,
      })
    );
    envScene.add(grad);
    const blob = (color, x, y, z, s) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(s, 12, 8),
        new THREE.MeshBasicMaterial({ color }));
      m.position.set(x, y, z);
      envScene.add(m);
    };
    blob(0xf2f7fb, -3, 4, -2, 1.6);       // a bright window
    blob(0xe8c49a, 3.5, 1.8, 2.5, 1.1);   // a warm lamp
    blob(0xc5d2dc, 0, 5, 3, 1.0);         // ceiling bounce
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
  }

  // desktop stand-in for the real room: a dim but VISIBLE room and a warm
  // wooden desk, so contrast is earned the way it must be over passthrough.
  // Hidden entirely in XR, where the real room shows through.
  _buildDesktopStandIn() {
    const g = new THREE.Group();

    // room: vertical gradient with a window glow left, a warm lamp right;
    // bright by default, because the real room is bright
    const R = this.room;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(14, 32, 20),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false,
        uniforms: {
          uLo: { value: new THREE.Vector3(...R.skyLo) },
          uHi: { value: new THREE.Vector3(...R.skyHi) },
          uWin: { value: new THREE.Vector3(...R.win) },
          uLamp: { value: new THREE.Vector3(...R.lamp) },
        },
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec3 vP;
          uniform vec3 uLo; uniform vec3 uHi; uniform vec3 uWin; uniform vec3 uLamp;
          void main(){
            vec3 d = normalize(vP);
            float h = d.y * 0.5 + 0.5;
            vec3 base = mix(uLo, uHi, pow(h,1.35));
            float win = pow(max(0.0, dot(d, normalize(vec3(-0.75, 0.25, -0.5)))), 6.0);
            base += uWin * win;
            float lamp = pow(max(0.0, dot(d, normalize(vec3(0.8, 0.1, 0.4)))), 8.0);
            base += uLamp * lamp;
            gl_FragColor = vec4(base, 1.0);
          }`,
      })
    );
    sky.renderOrder = -10;
    g.add(sky);

    // the desk: warm wood with a soft grain running across it, at DESK_Y
    const grain = this._woodTexture();
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.024, 1.15),
      new THREE.MeshStandardMaterial({
        map: grain, color: 0xffffff, roughness: 0.55, metalness: 0.04,
        envMapIntensity: 0.9,
      })
    );
    desk.position.set(0, DESK_Y - 0.013, -0.5);
    g.add(desk);

    this._deskStandIn = g;
    g.matrixAutoUpdate = false;        // placed by the stage inverse (setStage)
    this.scene.add(g);
  }

  /** The stand-in desk top as a horizontal plane in ROOM (base) coordinates,
   *  for the desktop recenter (the headset reports real planes instead). */
  get simTablePlane() {
    return { y: DESK_Y, label: "table",
             poly: [[-0.95, -1.075], [0.95, -1.075], [0.95, 0.075], [-0.95, 0.075]] };
  }

  /** Apply a stage {yaw, pos} (canonical -> local-floor). */
  setStage(stage) {
    this.stage = { yaw: stage.yaw, pos: stage.pos.slice() };
    this._stageInv.makeRotationY(stage.yaw).setPosition(stage.pos[0], stage.pos[1], stage.pos[2]).invert();
    if (this._deskStandIn) this._deskStandIn.matrix.copy(this._stageInv);
    if (this._baseRef && this.renderer.xr.isPresenting && typeof XRRigidTransform !== "undefined") {
      const h = stage.yaw / 2;
      const t = new XRRigidTransform({ x: stage.pos[0], y: stage.pos[1], z: stage.pos[2] },
                                     { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) });
      this.renderer.xr.setReferenceSpace(this._baseRef.getOffsetReferenceSpace(t));
    }
  }

  /** local-floor as granted by the session (poses read here are in ROOM
   *  coordinates, before the stage). Null off-XR. */
  get baseRef() { return this._baseRef; }

  // desktop: the simulated head pose in ROOM coordinates -> the camera in the
  // canonical frame (carried by the stage inverse, like the XR offset space)
  _placeDesktopCamera(px, py, pz, lx, ly, lz) {
    const sh = this.simHead;
    const hy = py + sh.stand * 0.50;
    // look direction turned by the simulated head yaw about the head
    const dx = lx - px, dz = lz - pz;
    const c = Math.cos(sh.yaw), s = Math.sin(sh.yaw);
    this.camera.position.set(px, hy, pz);
    this.camera.lookAt(px + c * dx + s * dz, ly + sh.stand * 0.35, pz - s * dx + c * dz);
    this.camera.updateMatrix();
    this._m.multiplyMatrices(this._stageInv, this.camera.matrix);
    this._m.decompose(this.camera.position, this.camera.quaternion, this.camera.scale);
  }

  // procedural walnut: quiet horizontal grain, low contrast (seeded)
  _woodTexture() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 512;
    const c = cv.getContext("2d");
    c.fillStyle = this.room.wood;
    c.fillRect(0, 0, 512, 512);
    let s = 20260702;
    const rnd = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 90; i++) {
      const y = rnd() * 512, w = 40 + rnd() * 240, a = 0.028 + rnd() * 0.05;
      const warm = rnd() > 0.5;
      c.strokeStyle = warm ? `rgba(94,68,48,${a})` : `rgba(20,14,10,${a})`;
      c.lineWidth = 0.6 + rnd() * 2.2;
      c.beginPath();
      c.moveTo(-20, y);
      c.bezierCurveTo(170, y + (rnd() - 0.5) * 18, 340, y + (rnd() - 0.5) * 18, 532, y + (rnd() - 0.5) * 12);
      c.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  // a narrow window needs a longer seat so the composition still fits
  get _aspectBack() { return this.camera.aspect < 1.1 ? 0.34 : 0; }

  _setDesktopCamera() {
    // a seated view over the desk, slightly above and back, gazing at the anchor
    this._placeDesktopCamera(0, DESK_Y + 0.36, 0.14 + this._aspectBack, 0, DESK_Y + 0.13, -0.55);
  }

  // slow drift so preview stills have life and parallax can be judged
  updateDesktopCamera(t, dt) {
    if (this.renderer.xr.isPresenting) return;
    const d = this._camDrift; d.t += dt;
    const sway = Math.sin(d.t * 0.11) * 0.03;
    const bob = Math.sin(d.t * 0.16 + 1.2) * 0.010;
    this._placeDesktopCamera(sway * 1.4, DESK_Y + 0.36 + bob,
      0.14 + this._aspectBack + Math.sin(d.t * 0.07) * 0.02, sway * 0.3, DESK_Y + 0.13, -0.55);
  }

  // RHYTHM streaks brighten the whole room; eases back on its own
  brighten(amount = 0.12) { this._brighten = Math.min(0.5, this._brighten + amount); }
  update(dt) {
    this._brighten *= Math.exp(-dt / 2.2);
    const b = this._brighten;
    this.ambient.intensity = this.room.amb + b * 1.0;
    this.key.intensity = this.room.key + b * 0.5;
  }

  async enterXR(session) {
    this.isXR = true;
    if (this._deskStandIn) this._deskStandIn.visible = false;
    this.renderer.xr.setFramebufferScaleFactor(0.9);
    this.renderer.xr.setReferenceSpaceType("local-floor");
    await this.renderer.xr.setSession(session);
    // the granted local-floor, kept as the base every stage is offset from
    this._baseRef = this.renderer.xr.getReferenceSpace();
    // comfort: hold the Quest 3S at 72 Hz (headroom) rather than letting the
    // browser pick 90/120 Hz; fixed foveation is already at maximum (1)
    try {
      const rates = session.supportedFrameRates;
      if (rates && typeof session.updateTargetFrameRate === "function" &&
          Array.prototype.indexOf.call(rates, 72) >= 0) {
        session.updateTargetFrameRate(72).catch(() => {});
      }
    } catch (_) { /* optional API */ }
    this.setStage(this.stage);
  }
  exitXR() {
    this.isXR = false;
    this._baseRef = null;
    if (this._deskStandIn) this._deskStandIn.visible = true;
    this._setDesktopCamera();
  }
}
