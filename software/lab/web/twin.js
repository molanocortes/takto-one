// twin.js - the digital twin, drawn as a kinematic figure.
//
// The same CAD (the console's zero_hand.glb) and the same mechanical model
// (the console's kinematics.js) every other TAKTO surface uses; nothing here
// is tuned by eye. It is drawn the way a mechanism is drawn in a paper: a
// light grey solid with its feature edges inked, the index finger as the
// subject and the rest of the hand faded, the joint chain with its rotation
// axes, the flexion angles as arcs with their values, a 10 mm grid and an
// axes triad for scale. Two modes:
//   /twin?live=1           the console's Figure 3: the pose from /ws
//   /twin?take=<id>        the composer: one frame per plan entry, uploaded
//                          as PNG; deterministic, the same take renders the
//                          same frames byte for byte.
import * as THREE from 'three';
import { GLTFLoader } from '/console/vendor/GLTFLoader.js';
import { fingerPose, spoolAngleDeg, SPOOL_STATIONS } from '/console/src/kinematics.js';

const q = new URLSearchParams(location.search);
const LIVE = q.get('live') === '1';
const TAKE = q.get('take');
const W = Number(q.get('w') || (TAKE ? 1080 : 560)), H = Number(q.get('h') || (TAKE ? 960 : 300));
const PART = q.get('part') || 'hand';           // hand | device
const SUBJECT = q.get('finger') || 'index';
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const D2R = Math.PI / 180;
const C = { blue: 0x0072BD, orange: 0xD95319, yellow: 0xEDB120, purple: 0x7E2F8E, green: 0x77AC30 };   // MATLAB
const hud = document.getElementById('hud');

const canvas = document.getElementById('c');
canvas.width = W; canvas.height = H; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: !!TAKE });
renderer.setPixelRatio(TAKE ? 1 : Math.min(2, devicePixelRatio));
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0xFFFFFF, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(24, W / H, 0.05, 60);
// the CAD frame is kept: +Z distal, +Y dorsal, X across the palm. The camera
// sits near +X, looking along the flexion axis, so the index finger is seen
// from the side with the fingers pointing to the viewer's left: the bench
// camera's own view of the hand on the table.
// distance follows the canvas aspect: a wide strip (the console's Figure 3)
// needs a closer camera than the portrait panel of the composed video
const aspect = W / H;
const VIEW = { yaw: Number(q.get('yaw') || 1.28), pitch: Number(q.get('pitch') || 0.26), dist: Number(q.get('dist') || (PART === 'hand' ? 2.9 : 4.4) * (aspect > 1.4 ? 0.72 : 1)) };
window.__twin = { VIEW, camera, scene, renderer };
function aim() {
  const { yaw, pitch, dist } = VIEW;
  camera.position.set(dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw));
  const t = VIEW.target || new THREE.Vector3(0, -0.05, 0);
  camera.position.add(t);
  camera.lookAt(t);
}
aim();
scene.add(new THREE.HemisphereLight(0xffffff, 0xbfbfbf, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(-1.5, 3, 2.5); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(2, 1, -2); scene.add(fill);

// ---- text labels as sprites, in the page's mono face -----------------------
function label(text, px = 26, color = '#000') {
  const c = document.createElement('canvas'); const ctx = c.getContext('2d');
  ctx.font = `${px}px "LM Mono", Menlo, monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + 16, h = px + 14;
  c.width = w * 2; c.height = h * 2; ctx.scale(2, 2);
  ctx.font = `${px}px "LM Mono", Menlo, monospace`; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.fillStyle = color; ctx.fillText(text, 8, h / 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const k = 0.00125 * Math.max(0.8, Math.min(2.2, 1000 / W));
  sp.scale.set(w * k, h * k, 1); sp.renderOrder = 10; sp.userData.text = text;
  return sp;
}
function setLabel(sp, text) {
  if (sp.userData.text === text) return;
  const fresh = label(text); sp.material.map.dispose(); sp.material.map = fresh.material.map; sp.scale.copy(fresh.scale); sp.userData.text = text;
}

let rig = null, sizeMm = 1;
const mats = { face: new THREE.MeshStandardMaterial({ color: 0xE9E9E9, roughness: 0.95, metalness: 0 }),
  faceDim: new THREE.MeshStandardMaterial({ color: 0xF0F0F0, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false }),
  edge: new THREE.LineBasicMaterial({ color: 0x1A1A1A }), edgeDim: new THREE.LineBasicMaterial({ color: 0x1A1A1A, transparent: true, opacity: 0.18 }) };
const FOREARM = new Set(['forearm', 'forearm_cover', 'motors', 'internals', 'screen']);

new GLTFLoader().load('/console/assets/zero_hand.glb', (gltf) => {
  const model = gltf.scene;
  if (PART === 'hand') {
    const gone = []; model.traverse((o) => { if (FOREARM.has(o.name) || o.name.startsWith('spool_')) gone.push(o); });
    for (const o of gone) o.parent && o.parent.remove(o);
  }
  // the subject finger is every node under its abduction hinge
  const subj = new Set(); const subjRoot = model.getObjectByName(`${SUBJECT}_mcp`);
  if (subjRoot) subjRoot.traverse((o) => subj.add(o));
  const meshes = []; model.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    const isSubj = subj.has(o);
    o.material = isSubj ? mats.face : mats.faceDim;
    o.renderOrder = isSubj ? 2 : 1;
    // feature edges, the inked lines of a technical drawing
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28), isSubj ? mats.edge : mats.edgeDim);
    e.renderOrder = isSubj ? 3 : 1; o.add(e);
  }
  const root = new THREE.Group();
  const box = new THREE.Box3().setFromObject(model);
  sizeMm = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  const centre = box.getCenter(new THREE.Vector3());
  model.position.sub(centre);
  root.scale.setScalar(1 / sizeMm);
  root.add(model); scene.add(root);
  // a 10 mm grid on the table plane (the model's underside), the axes triad
  // of the CAD frame beside it, and the scale stated
  const gridY = (box.min.y - centre.y) / sizeMm - 0.01;
  const gridSpan = 1.8, cells = Math.round(gridSpan * sizeMm / 10);
  const grid = new THREE.GridHelper(gridSpan, cells, 0xB8B8B8, 0xE4E4E4); grid.position.y = gridY; scene.add(grid);
  const tri = new THREE.Vector3(-0.55, gridY, 0.62);
  const triad = new THREE.AxesHelper(0.2); triad.position.copy(tri); scene.add(triad);
  const lx = label('x', 20, '#B00'), ly = label('y', 20, '#080'), lz = label('z', 20, '#00B');
  lx.position.copy(tri).add(new THREE.Vector3(0.26, 0, 0)); ly.position.copy(tri).add(new THREE.Vector3(0, 0.26, 0)); lz.position.copy(tri).add(new THREE.Vector3(0, 0, 0.26)); scene.add(lx, ly, lz);
  const scale = label('grid 10 mm', 18); scale.position.set(0.55, gridY, 0.75); scene.add(scale);
  const grab = (n) => model.getObjectByName(n);
  const hinge = (o) => (o ? { node: o, base: o.quaternion.clone(), baseZ: o.position.z } : null);
  const slide = (o) => (o ? { node: o, baseZ: o.position.z } : null);
  const fingers = {};
  for (const f of FINGERS) fingers[f] = { abduct: hinge(grab(`${f}_mcp`)), mcpFlex: hinge(grab(`${f}_pip`)), pipFlex: hinge(grab(`${f}_dip`)),
    mcpSlide: slide(grab(`${f}_mcp_slide`)), pipMid: slide(grab(`${f}_pip_mid`)), pipSlide: slide(grab(`${f}_pip_slide`)), dipSlide: slide(grab(`${f}_dip_slide`)) };
  const spools = Object.keys(SPOOL_STATIONS).map((n) => ({ name: n, node: grab(n) })).filter((s) => s.node).map((s) => ({ ...s, base: s.node.quaternion.clone() }));
  rig = { fingers, spools, model };
  buildOverlay();
  // aim the camera at the subject finger: the midpoint of its MCP hinge and
  // its tip at the open pose, so the finger is the centre of the figure
  pose({});
  { const r = rig.fingers[SUBJECT]; if (r && r.mcpFlex && r.dipSlide) { const a = r.mcpFlex.node.getWorldPosition(new THREE.Vector3()), b = r.dipSlide.node.getWorldPosition(new THREE.Vector3()); VIEW.target = a.add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, -0.07, 0)); aim(); } }
  window.__labTwinReady = true;
  if (TAKE) renderTake(); else if (LIVE) live(); else { pose({ index_mcp: 0, index_pip: 25, index_dip: 35 }); draw(); }
});

// ---- the kinematic overlay: chain, axes, arcs, labels ------------------------
const ovl = {};
function buildOverlay() {
  const g = new THREE.Group(); scene.add(g); ovl.group = g;
  const mk = (n, color, dashed = false) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.03, gapSize: 0.02, depthTest: false }) : new THREE.LineBasicMaterial({ color, depthTest: false });
    const l = new THREE.Line(geo, m); l.renderOrder = 8; g.add(l); return l; };
  ovl.chain = tube(C.blue); ovl.axAb = tube(C.purple); ovl.axMcp = tube(C.orange); ovl.axPip = tube(C.orange);
  ovl.arcMcp = tube(C.orange); ovl.arcPip = tube(C.orange);
  ovl.refMcp = mk(2, C.orange, true); ovl.refPip = mk(2, C.orange, true);
  ovl.joints = [0, 1, 2, 3].map(() => { const s = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), new THREE.MeshBasicMaterial({ color: C.blue, depthTest: false })); s.renderOrder = 9; g.add(s); return s; });
  ovl.lMcp = label('θMCP = 0.0°'); ovl.lPip = label('θPIP = 0.0°'); ovl.lAb = label('abd 0.0°', 22); g.add(ovl.lMcp, ovl.lPip, ovl.lAb);
}
const _v = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), n: new THREE.Vector3(), u: new THREE.Vector3(), w: new THREE.Vector3() };
function tube(color) { const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color, depthTest: false })); m.renderOrder = 8; m.userData.tube = true; ovl.group.add(m); return m; }
function setTube(mesh, pts, radius = 0.0045) {
  if (pts.length < 2) { mesh.visible = false; return; }
  mesh.visible = true;
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);
  const g = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 2), radius, 6, false);
  mesh.geometry.dispose(); mesh.geometry = g;
}
function setLine(line, pts) {
  if (line.userData.tube) return setTube(line, pts); const a = line.geometry.attributes.position; pts.forEach((p, i) => a.setXYZ(i, p.x, p.y, p.z)); a.needsUpdate = true; line.geometry.setDrawRange(0, pts.length); if (line.material.isLineDashedMaterial) line.computeLineDistances(); }
function arc(line, centre, from, to, r, deg) {
  // from/to: unit directions; the arc sweeps from `from` toward `to` by deg
  _v.n.crossVectors(from, to); if (_v.n.lengthSq() < 1e-9) { line.geometry.setDrawRange(0, 0); return; } _v.n.normalize();
  const pts = []; const N = 24; const rad = deg * D2R;
  for (let i = 0; i <= N; i++) { const t = rad * i / N; _v.u.copy(from).multiplyScalar(Math.cos(t)); _v.w.crossVectors(_v.n, from).multiplyScalar(Math.sin(t)); pts.push(new THREE.Vector3().copy(centre).add(_v.u.add(_v.w).multiplyScalar(r))); }
  setTube(line, pts, 0.0035);
}
function updateOverlay(p) {
  if (!rig || !ovl.group || !p) return;
  const r = rig.fingers[SUBJECT]; if (!r || !r.abduct || !r.mcpFlex || !r.pipFlex) return;
  const P = (node, out) => node.getWorldPosition(out);
  const dir = (node, axis, out) => { out.copy(axis).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion())).normalize(); return out; };
  const pAb = P(r.abduct.node, _v.a).clone(), pMcp = P(r.mcpFlex.node, _v.b).clone(), pPip = P(r.pipFlex.node, _v.c).clone();
  const pTip = r.dipSlide ? P(r.dipSlide.node, _v.d).clone() : pPip.clone();
  // the chain: MCP pivot, PIP hinge, fingertip cradle; the palm anchor behind
  const palmDir = dir(r.abduct.node, new THREE.Vector3(0, 0, 1), new THREE.Vector3());
  const pPalm = pMcp.clone().addScaledVector(palmDir, -0.22);
  setTube(ovl.chain, [pPalm, pMcp, pPip, pTip], 0.004);
  [pPalm, pMcp, pPip, pTip].forEach((pt, i) => ovl.joints[i].position.copy(pt));
  ovl.joints[0].visible = false;
  // rotation axes through the hinges: local X of the flexion hinges, local Y of the abduction axle
  const axLen = 0.1;
  const xMcp = dir(r.mcpFlex.node, new THREE.Vector3(1, 0, 0), new THREE.Vector3()), xPip = dir(r.pipFlex.node, new THREE.Vector3(1, 0, 0), new THREE.Vector3());
  const yAb = dir(r.abduct.node, new THREE.Vector3(0, 1, 0), new THREE.Vector3());
  setLine(ovl.axMcp, [pMcp.clone().addScaledVector(xMcp, -axLen), pMcp.clone().addScaledVector(xMcp, axLen)]);
  setLine(ovl.axPip, [pPip.clone().addScaledVector(xPip, -axLen), pPip.clone().addScaledVector(xPip, axLen)]);
  setLine(ovl.axAb, [pAb.clone().addScaledVector(yAb, -axLen), pAb.clone().addScaledVector(yAb, axLen)]);
  // arcs: from the extended direction (the previous link) to the actual next link
  const dMcp = pPip.clone().sub(pMcp).normalize(), dPip = pTip.clone().sub(pPip).normalize();
  const rArc = 0.105;
  setLine(ovl.refMcp, [pMcp.clone(), pMcp.clone().addScaledVector(palmDir, rArc * 1.35)]);
  setLine(ovl.refPip, [pPip.clone(), pPip.clone().addScaledVector(dMcp, rArc * 1.35)]);
  arc(ovl.arcMcp, pMcp, palmDir, dMcp, rArc, Math.max(0.5, p.mcp));
  arc(ovl.arcPip, pPip, dMcp, dPip, rArc, Math.max(0.5, p.pip));
  setLabel(ovl.lMcp, `θMCP = ${p.mcp.toFixed(1)}°`); ovl.lMcp.position.copy(pMcp).add(new THREE.Vector3(0, 0.2, 0.02));
  setLabel(ovl.lPip, `θPIP = ${p.pip.toFixed(1)}°`); ovl.lPip.position.copy(pPip).add(new THREE.Vector3(0, -0.2, 0.04));
  setLabel(ovl.lAb, `abd ${p.ab.toFixed(1)}°`); ovl.lAb.position.copy(pAb).add(new THREE.Vector3(0, -0.2, -0.12));
}

const qq = new THREE.Quaternion(), AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);
let lastPose = null;
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
  scene.updateMatrixWorld(true);
  lastPose = poses[SUBJECT];
  updateOverlay(lastPose);
}
function draw() { renderer.render(scene, camera); }
function hudText(src) {
  const p = lastPose; if (!p) return '';
  return `<b>TWIN</b> ${src ? '· ' + src : ''} · θMCP ${p.mcp.toFixed(1)}° θPIP ${p.pip.toFixed(1)}° abd ${p.ab.toFixed(1)}° · slides knuckle ${p.slideKnuckleMm.toFixed(1)} mm, link ${p.slideMcpMm.toFixed(1)} mm, tip ${p.slidePipMm.toFixed(1)} mm · spools ${p.spoolMcpDeg.toFixed(0)}° / ${p.spoolPipDeg.toFixed(0)}°`;
}

// ---- live: the console's Figure 3 -----------------------------------------------
function live() {
  let joints = { index_mcp: 0, index_pip: 8, index_dip: 8 }, src = '';
  const connect = () => {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = (e) => {
      const S = JSON.parse(e.data); const d = S.device, t = S.tracker;
      if (d.connected && d.mcp !== null && d.pip !== null) { joints = { index_mcp: d.ab || 0, index_pip: d.mcp, index_dip: d.pip }; src = 'device encoders'; }
      else if (t.found) { joints = { index_mcp: 0, index_pip: t.mcp, index_dip: t.pip }; src = 'camera'; }
      else src = 'no source';
    };
    ws.onclose = () => setTimeout(connect, 800);
  };
  connect();
  const loop = () => { pose(joints); draw(); hud.innerHTML = hudText(src); requestAnimationFrame(loop); };
  loop();
}

// ---- take: render the plan, upload every frame ------------------------------------
async function renderTake() {
  const source = q.get('source') || 'device';
  const r = await fetch(`/api/takes/${TAKE}/twin_plan?source=${source}&fps=30`);
  if (!r.ok) { hud.innerHTML = `<b>TWIN</b> · ${(await r.json()).detail || r.statusText}`; return; }
  const plan = await r.json(); const n = plan.frames.length;
  await document.fonts.ready;
  for (let i = 0; i < n; i++) {
    const f = plan.frames[i];
    pose({ index_mcp: f.index_mcp, index_pip: f.index_pip, index_dip: f.index_dip }); draw();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    await fetch(`/api/takes/${TAKE}/twin/${f.idx}`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-T-Ns': String(f.t_ns) }, body: blob });
    if (i % 5 === 0) hud.innerHTML = `<b>RENDERING TWIN</b> · ${TAKE} · ${source} · ${i + 1} / ${n}`;
  }
  hud.innerHTML = `<b>DONE</b> · ${n} frames rendered for ${TAKE} · close this tab`;
  window.__labTwinDone = true;
}
