// twin.js - the digital twin, rendered from numbers only.
//
// The same CAD (the console's zero_hand.glb) and the same mechanical model
// (the console's kinematics.js) every other TAKTO surface uses; nothing here
// is tuned by eye. Two modes:
//   /twin?live=1           the Live page: the pose from /ws, twenty times a second
//   /twin?take=<id>        the composer: one frame per plan entry at a fixed
//                          rate, uploaded as PNG so the video composer can
//                          stack it under the camera's picture. Deterministic:
//                          the same take renders the same frames, byte for byte.
import * as THREE from 'three';
import { GLTFLoader } from '/console/vendor/GLTFLoader.js';
import { fingerPose, spoolAngleDeg, SPOOL_STATIONS } from '/console/src/kinematics.js';

const q = new URLSearchParams(location.search);
const LIVE = q.get('live') === '1';
const TAKE = q.get('take');
const W = Number(q.get('w') || (TAKE ? 1080 : 520)), H = Number(q.get('h') || (TAKE ? 960 : 300));
const PART = q.get('part') || 'hand';           // hand | device
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const D2R = Math.PI / 180;
const hud = document.getElementById('hud');

const canvas = document.getElementById('c');
canvas.width = W; canvas.height = H; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: !!TAKE });
renderer.setPixelRatio(TAKE ? 1 : Math.min(2, devicePixelRatio));
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0xF3F2EF, TAKE ? 1 : 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, W / H, 0.1, 60);
// side elevation, the way the bench camera sees the finger: from the thumb
// side, a little above, fingers pointing to the viewer's left
// the CAD frame is kept: +Z distal, +Y dorsal, X across the palm. The camera
// sits on +X, looking along the flexion axis, so the index finger is seen
// from the side with the fingers pointing to the viewer's left: the bench
// camera's own view of the hand on the table
const VIEW = { yaw: Number(q.get('yaw') || 1.32), pitch: Number(q.get('pitch') || 0.22), dist: Number(q.get('dist') || (PART === 'hand' ? 2.7 : 4.2)) };
function aim() {
  const { yaw, pitch, dist } = VIEW;
  camera.position.set(dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw));
  camera.lookAt(0, 0, 0);
}
aim();
const key = new THREE.DirectionalLight(0xFFFDF8, 2.4); key.position.set(-2.2, 7, 3.2); key.castShadow = true;
key.shadow.mapSize.set(1024, 1024); key.shadow.camera.near = 0.5; key.shadow.camera.far = 14;
key.shadow.camera.left = key.shadow.camera.bottom = -2; key.shadow.camera.right = key.shadow.camera.top = 2; key.shadow.bias = -0.0012;
scene.add(key, new THREE.HemisphereLight(0xFFFFFF, 0xD0CEC8, 0.9), new THREE.AmbientLight(0xffffff, 0.32));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.08 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -0.42; floor.receiveShadow = true; scene.add(floor);

const mat = (color, rough, cc = 0) => new THREE.MeshPhysicalMaterial({ color, roughness: rough, metalness: 0, clearcoat: cc, clearcoatRoughness: 0.3 });
const M = { shell: mat(0xF4F3EF, 0.5, 0.35), link: mat(0xEDEBE6, 0.55, 0.25), bank: mat(0x2A2A2E, 0.5), board: mat(0x3A2A4A, 0.6), glass: mat(0x0F1E3A, 0.15, 1.0), spool: mat(0xE8E6E1, 0.6), pin: mat(0x3A3A40, 0.35) };
M.glass.emissive = new THREE.Color(0x1E66E0); M.glass.emissiveIntensity = 0.35;
const FOREARM = new Set(['forearm', 'forearm_cover', 'motors', 'internals', 'screen']);

let rig = null;
new GLTFLoader().load('/console/assets/zero_hand.glb', (gltf) => {
  const model = gltf.scene;
  if (PART === 'hand') {
    const gone = []; model.traverse((o) => { if (FOREARM.has(o.name) || o.name.startsWith('spool_')) gone.push(o); });
    for (const o of gone) o.parent && o.parent.remove(o);
  }
  model.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name;
    o.material = n.startsWith('spool_') ? M.spool : n === 'motors' || n === 'internals' ? M.bank : n === 'screen' ? M.glass : n.endsWith('_enc') ? M.board
      : (n === 'forearm' || n === 'forearm_cover' || n === 'palm') ? M.shell : M.link;
    o.castShadow = o.receiveShadow = true;
  });
  const root = new THREE.Group();
  const box = new THREE.Box3().setFromObject(model);
  const size = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  model.position.sub(box.getCenter(new THREE.Vector3()));
  root.scale.setScalar(1 / size);
  root.add(model);
  root.rotation.set(0, 0, 0);
  scene.add(root);
  const grab = (n) => model.getObjectByName(n);
  const hinge = (o) => (o ? { node: o, base: o.quaternion.clone(), baseZ: o.position.z } : null);
  const slide = (o) => (o ? { node: o, baseZ: o.position.z } : null);
  const fingers = {};
  for (const f of FINGERS) fingers[f] = { abduct: hinge(grab(`${f}_mcp`)), mcpFlex: hinge(grab(`${f}_pip`)), pipFlex: hinge(grab(`${f}_dip`)),
    mcpSlide: slide(grab(`${f}_mcp_slide`)), pipMid: slide(grab(`${f}_pip_mid`)), pipSlide: slide(grab(`${f}_pip_slide`)), dipSlide: slide(grab(`${f}_dip_slide`)) };
  const spools = Object.keys(SPOOL_STATIONS).map((n) => ({ name: n, node: grab(n) })).filter((s) => s.node).map((s) => ({ ...s, base: s.node.quaternion.clone() }));
  rig = { fingers, spools };
  window.__labTwinReady = true;
  if (TAKE) renderTake(); else if (LIVE) live(); else { pose({ index_mcp: 0, index_pip: 25, index_dip: 35 }); renderer.render(scene, camera); }
});

const qq = new THREE.Quaternion(), AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);
function pose(joints) {
  if (!rig) return;
  const poses = {};
  for (const f of FINGERS) {
    const p = fingerPose(f, joints[`${f}_mcp`] ?? 0, joints[`${f}_pip`] ?? 8, joints[`${f}_dip`] ?? 8);
    poses[f] = p;
    const r = rig.fingers[f];
    if (r.abduct) { qq.setFromAxisAngle(AY, p.ab * D2R); r.abduct.node.quaternion.copy(r.abduct.base).multiply(qq); }
    if (r.mcpFlex) { qq.setFromAxisAngle(AX, p.mcp * D2R); r.mcpFlex.node.quaternion.copy(r.mcpFlex.base).multiply(qq); r.mcpFlex.node.position.z = r.mcpFlex.baseZ + p.slideKnuckleMm; }
    if (r.pipFlex) { qq.setFromAxisAngle(AX, p.pip * D2R); r.pipFlex.node.quaternion.copy(r.pipFlex.base).multiply(qq); r.pipFlex.node.position.z = r.pipFlex.baseZ + p.slideMcpMm; }
    if (r.mcpSlide) r.mcpSlide.node.position.z = r.mcpSlide.baseZ + p.slideKnuckleMm;
    if (r.pipMid) r.pipMid.node.position.z = r.pipMid.baseZ + p.slideMcpMidMm;
    if (r.pipSlide) r.pipSlide.node.position.z = r.pipSlide.baseZ + p.slideMcpMm;
    if (r.dipSlide) r.dipSlide.node.position.z = r.dipSlide.baseZ + p.slidePipMm;
  }
  for (const s of rig.spools) { const deg = spoolAngleDeg(s.name, poses); if (Number.isFinite(deg)) { qq.setFromAxisAngle(AY, deg * D2R); s.node.quaternion.copy(s.base).multiply(qq); } }
}

// ---- live: the Live page's small twin ---------------------------------------
function live() {
  let joints = { index_mcp: 0, index_pip: 8, index_dip: 8 };
  let src = '';
  const connect = () => {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = (e) => {
      const S = JSON.parse(e.data); const d = S.device, t = S.tracker;
      if (d.connected && d.mcp !== null && d.pip !== null) { joints = { index_mcp: d.ab || 0, index_pip: d.mcp, index_dip: d.pip }; src = 'DEVICE ENCODERS'; }
      else if (t.found) { joints = { index_mcp: 0, index_pip: t.mcp, index_dip: t.pip }; src = 'CAMERA'; }
      else src = 'NO SOURCE';
    };
    ws.onclose = () => setTimeout(connect, 800);
  };
  connect();
  const loop = () => { pose(joints); renderer.render(scene, camera); hud.innerHTML = `<b>TWIN</b> · ${src} · MCP ${Number(joints.index_pip).toFixed(0)}° PIP ${Number(joints.index_dip).toFixed(0)}°`; requestAnimationFrame(loop); };
  loop();
}

// ---- take: render the plan, upload every frame -------------------------------
async function renderTake() {
  const source = q.get('source') || 'device';
  const r = await fetch(`/api/takes/${TAKE}/twin_plan?source=${source}&fps=30`);
  if (!r.ok) { hud.innerHTML = `<b>TWIN</b> · ${(await r.json()).detail || r.statusText}`; return; }
  const plan = await r.json();
  const n = plan.frames.length;
  for (let i = 0; i < n; i++) {
    const f = plan.frames[i];
    pose({ index_mcp: f.index_mcp, index_pip: f.index_pip, index_dip: f.index_dip });
    renderer.render(scene, camera);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    await fetch(`/api/takes/${TAKE}/twin/${f.idx}`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-T-Ns': String(f.t_ns) }, body: blob });
    if (i % 5 === 0) hud.innerHTML = `<b>RENDERING TWIN</b> · ${TAKE} · ${source} · ${i + 1} / ${n}`;
  }
  hud.innerHTML = `<b>DONE</b> · ${n} frames rendered for ${TAKE} · close this tab`;
  window.__labTwinDone = true;
}
