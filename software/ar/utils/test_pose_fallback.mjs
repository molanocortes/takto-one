// test_pose_fallback.mjs - pure-function checks for the AR motion layer.
// Run:  node software/ar/utils/test_pose_fallback.mjs      (Node >= 22)
// Covers what the desktop preview cannot exercise: the XR hand reader's
// stale/grace/handedness logic, the world/body fallback ladder, the body
// anchor solve, the anchor restore/relocate state machine, the chunked env
// upload + late-ack recovery, the replay track builder, the transport pick, and
// the UI layer: recenter math + persistence, the pose lane merge/latency, the
// status/guide words, and the poke / pinch / hold gestures.

// ---- environment shims (before any app import) ------------------------------
let fakeNow = 1000;
globalThis.performance = { now: () => fakeNow };
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
};
globalThis.XRRigidTransform = class {
  constructor(p, o) {
    this.position = p; this.orientation = o;
    this.matrix = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p.x, p.y, p.z, 1]);
  }
};

const pf = await import("../src/world/poseFallback.js");
const { XRHandReader } = await import("../src/input/xrHands.js");
const ra = await import("../src/world/roomAnchor.js");
const env = await import("../src/world/envScan.js");
const tel = await import("../src/telemetry.js");
const rd = await import("../src/modes/replayData.js");
const st = await import("../src/ui/stage.js");
const pl = await import("../src/ui/poseLane.js");
const ux = await import("../src/ui/status.js");
const ge = await import("../src/ui/gestures.js");

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) passes++; else { fails++; console.log("FAIL:", msg); } }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const near3 = (a, b, eps = 1e-6) => a && b && a.every((v, i) => near(v, b[i], eps));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sameRot = (a, b, eps = 1e-5) => near(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]), 1, eps);

// ---- 1. frames ----------------------------------------------------------------
{
  // segment +Z (distal) must be the wrist frame's -Z
  const v = pf.qrot(pf.Q_SEG_TO_WRIST, [0, 0, 1]);
  ok(near3(v, [0, 0, -1]), "Ry(pi) maps segment distal to wrist -Z");
  ok(near3(pf.qrot(pf.Q_SEG_TO_WRIST, [0, 1, 0]), [0, 1, 0]), "dorsal axis kept");
  ok(near3(pf.palmFromWrist([0, 1, 0], pf.Q_ID), [0, 1, -0.035]), "palm is distal (-Z) of the wrist");
  ok(near(pf.twistYaw(pf.yawQuat(1.2)), 1.2), "twistYaw inverts yawQuat");
  const swingTwist = pf.qmul(pf.yawQuat(-0.7), pf.qFromAxisAngle([1, 0, 0], 0.4));
  ok(near(pf.twistYaw(swingTwist), -0.7, 0.08), "twist extraction tolerates swing");
}

// ---- 2. body anchor solve + placement ------------------------------------------
{
  const truth = new pf.BodyAnchor();
  truth.yaw = 2.1; truth.t = [0.4, 1.3, -0.2]; truth.source = "vision";
  const b0 = tel.mockBody(3.0, { calibrated: true });
  const xrPos = truth.point(b0.wrist_m);
  const xrQuat = pf.qmul(truth.quat(b0.hand_quat), pf.Q_SEG_TO_WRIST);
  const a = new pf.BodyAnchor();
  ok(a.solveFromVision(b0, xrPos, xrQuat, 1 / 60, 5), "solve accepts a calibrated body");
  ok(near(pf.wrapPi(a.yaw - 2.1), 0, 1e-6) && near3(a.t, truth.t, 1e-6), "solve recovers yaw + translation");
  const b1 = tel.mockBody(7.5, { calibrated: true });
  const p = a.place(b1), pt = truth.place(b1);
  ok(dist(p.wrist, pt.wrist) < 1e-6 && sameRot(p.wristQuat, pt.wristQuat), "placement of a later pose matches truth");
  ok(dist(p.palm, pf.palmFromWrist(p.wrist, p.wristQuat)) < 1e-9, "palm follows wrist convention");
  ok(p.elbow && Math.abs(dist(p.elbow, p.wrist) - 0.26) < 1e-3, "forearm length preserved (0.26 m)");
  const unc = Object.assign({}, b0, { calibrated: false, provisional: false });
  ok(!pf.bodyUsable(unc), "a body with no neutral at all is not used");
  // desktop default: neutral palm lands at the requested point
  const d = new pf.BodyAnchor();
  d.setDefaultNeutralAt([0.13, 0.88, -0.22]);
  const neutral = { calibrated: true, live: true, wrist_m: [0, -0.30, 0.26], hand_quat: [1, 0, 0, 0], elbow_m: [0, -0.3, 0] };
  ok(dist(d.place(neutral).palm, [0.13, 0.88, -0.22]) < 1e-9, "desktop default puts the neutral palm at rest");
  ok(near3(pf.qrot(d.place(neutral).wristQuat, [0, 0, -1]), [0, 0, -1], 1e-9), "desktop default: fingers point into the screen");
  // head default: shoulder right of and below the head
  const h = new pf.BodyAnchor();
  h.setDefaultFromHead([0, 1.6, 0], [0, -0.2, -1]);
  ok(h.t[0] > 0.1 && h.t[1] < 1.4, "head default: right shoulder below the head");
}

// ---- 3. world acceptance + ladder -----------------------------------------------
{
  const w = { pos_m: [0.1, 1, -0.3], quat: [1, 0, 0, 0], source: "quest-fused" };
  ok(pf.acceptWorld(w, 100), "quest-fused while we stream");
  ok(!pf.acceptWorld(w, 5000), "quest-fused after we stopped = someone else's (sim fixture)");
  ok(pf.acceptWorld({ ...w, source: "imu-model" }, 8000), "imu-model within the occlusion budget");
  ok(!pf.acceptWorld({ ...w, source: "imu-model" }, 60000), "imu-model too long after our last anchor");
  ok(!pf.acceptWorld({ ...w, source: "imu-model" }, Infinity), "never anchored by this session");
  ok(!pf.acceptWorld({ pos_m: null, quat: null, source: "none" }, 10), "source none");
  const anchor = new pf.BodyAnchor(); anchor.setDefaultNeutralAt([0, 1, -0.3]);
  const body = tel.mockBody(1, { calibrated: true });
  const snap = { world: { ...w, source: "imu-model" }, body, _ageMs: 50 };
  ok(pf.fallbackPose(snap, { msSinceOwnPose: 900, anchor, presenting: true }).source === "world", "ladder: world first");
  ok(pf.fallbackPose(snap, { msSinceOwnPose: 900, anchor, presenting: false }).source === "body", "desktop never trusts world");
  ok(pf.fallbackPose(snap, { msSinceOwnPose: Infinity, anchor, presenting: true }).source === "body", "ladder: body when world is not ours");
  ok(pf.fallbackPose({ ...snap, _ageMs: 5000 }, { anchor }).source === "rest", "stale snapshot -> rest");
  ok(pf.fallbackPose({ ...snap, body: null }, { anchor, msSinceOwnPose: Infinity }).source === "rest", "no body, no world -> rest");
  const fw = pf.fallbackPose(snap, { msSinceOwnPose: 900, anchor, presenting: true });
  ok(fw.elbow && Math.abs(dist(fw.elbow, fw.wrist) - 0.26) < 1e-3, "world pose borrows the body forearm");
}

// ---- 4. XR hand reader: stale joints, grace, handedness -------------------------
{
  const mkPose = (x) => ({ transform: { position: { x, y: 1, z: -0.3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, radius: 0.01 });
  const mkHand = () => ({ get: (n) => ({ name: n }) });
  const right = { hand: mkHand(), handedness: "right" };
  const left = { hand: mkHand(), handedness: "left" };
  let tracked = { right: true, left: true };
  const frame = { getJointPose: (j, _rs) => {
    const side = j.__side;
    return tracked[side] ? mkPose(side === "right" ? 0.2 : -0.2) : null;
  } };
  right.hand.get = (n) => ({ name: n, __side: "right" });
  left.hand.get = (n) => ({ name: n, __side: "left" });
  const session = { inputSources: [left, right] };
  const r = new XRHandReader({ graceMs: 150 });
  r.update(frame, {}, session, 0);
  ok(r.get("right") && r.get("right").hand.joints.wrist.position.x === 0.2, "right hand read with handedness from the input source");
  ok(r.get("left") && r.get("left").hand.joints.wrist.position.x === -0.2, "left hand read");
  tracked.right = false;
  r.update(frame, {}, session, 100);
  ok(r.get("right") && !r.get("right").fresh, "lost for 100 ms: still inside the grace period");
  r.update(frame, {}, session, 400);
  ok(r.get("right") === null, "lost past the grace period: NOT a frozen hand");
  ok(r.wrist("right") === null, "no stale wrist either");
  tracked.right = true;
  r.update(frame, {}, session, 450);
  ok(r.get("right") && r.get("right").fresh, "reacquired");
  r.update(null, null, null, 900);
  ok(r.get("right") === null && r.get("left") === null, "no frame: nothing tracked");
}

// ---- 5. anchor restore -> localize in a LATER frame -> relocation ---------------
{
  const saved = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 2, 1]);
  _ls.set(ra.STORE_KEY, JSON.stringify([{ handle: "h1", matrix: Array.from(saved), envId: "env_0007", savedMs: 1 }]));
  let frameLive = true;
  const anchorSpace = {};
  const session = {
    enabledFeatures: ["anchors"],
    restorePersistentAnchor: async () => { frameLive = false; return { anchorSpace }; },
  };
  const a = new ra.RoomAnchor();
  const okr = await a.restore("h1", session, 0);
  ok(okr && a.state === "localizing", "restore resolves to localizing without touching a frame");
  // yaw 90 deg + translation: anchor now at (3,0,-1)
  const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
  const now = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 3, 0, -1, 1];
  let poseAvail = false;
  const frame = { getPose: (sp) => (sp === anchorSpace && poseAvail ? { transform: { matrix: now } } : null) };
  a.tick(frame, {}, 1000);
  ok(a.state === "localizing", "no pose yet: still localizing");
  poseAvail = true;
  a.tick(frame, {}, 2000);
  ok(a.state === "restored" && a.envId === "env_0007", "localized in a later frame");
  const pSaved = [1, 0, 2];                       // the anchor origin at save time
  ok(near3(ra.applyToPoint(a.relocated, pSaved), [3, 0, -1], 1e-9), "relocation maps the saved anchor onto its pose now");
  const q = ra.quatFromMatrix(a.relocated);
  ok(sameRot(q, pf.yawQuat(Math.PI / 2)) || sameRot(q, pf.yawQuat(-Math.PI / 2)), "relocation rotation is the yaw");
  const b = new ra.RoomAnchor();
  await b.restore("h1", session, 0);
  poseAvail = false;
  b.tick(frame, {}, 20000);
  ok(b.state === "error" && /never localized/.test(b.reason), "never localized -> honest error");
  ok(ra.latestEnvAnchor().envId === "env_0007", "latestEnvAnchor skips unbound anchors");
  void frameLive;
}

// ---- 6. envScan: chunked upload, socket closed, late ack recovery ---------------
{
  env.resetEnvScan();
  const listeners = [];
  const sent = [];
  let open = true;
  const tele = {
    onSnapshot: (cb) => listeners.push(cb),
    sendRaw: (str) => { if (!open) return false; sent.push(str); return true; },
    send: (m) => sent.push(JSON.stringify(m)),
  };
  const emit = (m) => listeners.forEach((cb) => cb(m));
  env.beginScan();
  for (let i = 0; i < 400 && env.scanState().phase === "scanning"; i++) { fakeNow += 16; env.simScanTick(0.016, tele); }
  ok(env.scanState().phase === "uploading", "sim scan finished into uploading");
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 0));
  ok(sent.length === 1, "upload sent once, after yielding");
  const msg = JSON.parse(sent[0]);
  ok(msg.cmd === "env_save" && msg.source === "sim-desktop" && Array.isArray(msg.points) && msg.points.length === msg.weights.length * 3,
     "chunked serializer produced a valid env_save");
  ok(msg.positions.length === 12 && msg.indices.length === 6, "mesh arrays intact");
  // time out, then the late ack recovers
  const fakeFrame = {}, fakeSession = { inputSources: [] };
  fakeNow += 70000;
  env.updateEnvCapture(fakeFrame, {}, fakeSession, tele, null);
  ok(env.scanState().phase === "error" && /still listening/.test(env.scanState().err), "timeout is an honest, recoverable error");
  emit({ kind: "ack", event: "env_saved", id: "env_0042", tris: 2, pts: 100 });
  ok(env.scanState().phase === "done" && env.scanState().envId === "env_0042", "late env_saved recovers to done");
  ok(env.roomFromEnv("env_0042") !== null, "this session's env is placeable (identity)");
  ok(env.roomFromEnv("env_9999") === null, "an unknown env is not");
  // socket closed at send time -> immediate error, not a silent timeout
  env.beginScan();
  open = false;
  for (let i = 0; i < 400 && env.scanState().phase === "scanning"; i++) { fakeNow += 16; env.simScanTick(0.016, tele); }
  for (let i = 0; i < 50 && env.scanState().phase === "uploading"; i++) await new Promise((r) => setTimeout(r, 0));
  ok(env.scanState().phase === "error" && /NOT sent/.test(env.scanState().err), "closed socket -> immediate honest error");
  // pose stream: linked device + no recording still streams (needs a right hand)
  env.resetEnvScan();
  sent.length = 0; open = true;
  const handPose = { transform: { position: { x: 0.1, y: 1, z: -0.3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } };
  const hand = { get: (n) => ({ n }) };
  const sess2 = { inputSources: [{ hand, handedness: "right" }] };
  const fr2 = { getJointPose: () => handPose };
  env.updateEnvCapture(fr2, {}, sess2, tele, { link: { device: true }, session: { recording: false } });
  const poses = sent.map((x) => JSON.parse(x)).filter((m) => m.cmd === "pose");
  ok(poses.length === 1 && poses[0].hand === "right", "pose streams while linked, not only while recording");
  ok(env.msSinceOwnPose() < 1, "own-pose clock started");
  sent.length = 0;
  fakeNow += 100;
  env.updateEnvCapture(fr2, {}, sess2, tele, { link: { device: false }, session: { recording: false } });
  ok(!sent.some((x) => JSON.parse(x).cmd === "pose"), "no device, no recording: no pose stream");

  // RECENTER after a scan this session: the room stays where it physically is
  env.resetEnvScan();
  open = true; sent.length = 0;
  env.beginScan();
  for (let i = 0; i < 400 && env.scanState().phase === "scanning"; i++) { fakeNow += 16; env.simScanTick(0.016, tele); }
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 0));
  emit({ kind: "ack", event: "env_saved", id: "env_0077", tris: 2, pts: 100 });
  ok(env.roomFromEnv("env_0077") === ra.IDENTITY4 || near3(Array.from(env.roomFromEnv("env_0077")).slice(12, 15), [0, 0, 0]),
     "fresh env: identity before any recenter");
  const table0 = env.sceneObjects().all().find((o) => o.label === "table").pos.slice();
  const A = { yaw: 0, pos: [0, 0, 0] }, B = { yaw: 0.6, pos: [0.25, -0.1, 0.4] };
  const N = st.stageDelta(A, B), O = st.invertMat(N);
  env.applyStageDelta(N, O);
  const table1 = env.sceneObjects().all().find((o) => o.label === "table").pos;
  ok(near3(table1, st.applyMat(N, table0), 1e-9), "scene objects carried into the new stage frame");
  // physically the same point: base = T_A * old = T_B * new
  ok(near3(st.applyMat(st.stageMatrix(A), table0), st.applyMat(st.stageMatrix(B), table1), 1e-9), "…and they did not move in the room");
  const rf = env.roomFromEnv("env_0077");
  ok(rf && near3(st.applyMat(rf, table0), table1, 1e-9), "roomFromEnv maps the scanned env into the new frame");
  // poses streamed after the recenter land in the ENV frame (the old one)
  sent.length = 0; fakeNow += 1000;
  const pNew = [0.1, 1.0, -0.3];
  const fr3 = { getJointPose: () => ({ transform: { position: { x: pNew[0], y: pNew[1], z: pNew[2] }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }) };
  env.updateEnvCapture(fr3, {}, sess2, tele, { link: { device: true }, session: { recording: false } });
  const p3 = sent.map((x) => JSON.parse(x)).filter((m) => m.cmd === "pose")[0];
  ok(p3 && p3.env === "env_0077" && near3(p3.pos, st.applyMat(O, pNew), 2e-4), "post-recenter pose streamed in the scanned env's frame");
  const w = env.worldToRoom({ pos_m: p3.pos, quat: p3.quat, source: "quest-fused" });
  ok(near3(w.pos_m, pNew, 2e-4), "the bridge echo maps back into today's frame");
}

// ---- 7. replay track -------------------------------------------------------------
{
  const meta = tel.makeMockTakeMeta("t1", "x", 6);
  const payload = tel.makeMockTakeData(meta);
  const parsed = rd.parseTake(payload);
  ok(parsed && parsed.frames.length === 300, "mock take parsed by column name");
  const track = rd.buildTrack(parsed, {});
  ok(track.hasVision && track.hasBody && !track.bodyOnly, "vision + body take");
  const firstBody = track.frames.findIndex((f) => f.src === "body");
  ok(firstBody > 0, "body rows follow the vision rows");
  const handover = dist(track.frames[firstBody - 1].pos, track.frames[firstBody].pos);
  ok(handover < 0.02, `vision -> body handover is continuous (${(handover * 1000).toFixed(1)} mm)`);
  // body rows land where the recording's anchor would have put them
  const truth = new pf.BodyAnchor(); truth.setDefaultNeutralAt([0.13, 0.88, -0.22]);
  const lastB = parsed.frames[parsed.frames.length - 1].body;
  ok(dist(track.frames[track.frames.length - 1].pos, truth.place(lastB).wrist) < 1e-3, "occluded stretch placed under the solved take anchor");
  const smp = rd.sampleTrack(track, 1234);
  ok(smp.pos && smp.segQuat && Number.isFinite(smp.joints.index_pip), "interpolated sample");
  // body-only take goes under the LIVE anchor
  const bodyOnly = { cols: payload.cols, rows: payload.rows.map((r) => { const c = r.slice(); for (const n of ["px", "py", "pz", "pq_w", "pq_x", "pq_y", "pq_z"]) c[payload.cols.indexOf(n)] = null; return c; }) };
  const live = new pf.BodyAnchor(); live.setDefaultNeutralAt([0, 1, -0.4]);
  const tb = rd.buildTrack(rd.parseTake(bodyOnly), { liveAnchor: live });
  ok(tb.bodyOnly && tb.frames.every((f) => f.inRoom && f.src === "body"), "body-only take placed under the live anchor");
  const m = rd.recentreMatrix(track, 0, -0.45);
  ok(Number.isFinite(m[12]) && m[13] === 0, "recentring keeps heights");
  ok(rd.parseTake({ cols: ["x"], rows: [[1]] }) === null && rd.parseTake(null) === null, "unusable payloads rejected");
}

// ---- 8. transport choice ---------------------------------------------------------
{
  _ls.clear();
  ok(tel.chooseTransport("?mock=1", "http:", "h").kind === "mock", "?mock=1");
  ok(tel.chooseTransport("", "http:", "h").kind === "mock", "plain http -> simulator (badged)");
  const w = tel.chooseTransport("?ws=wss://10.0.0.2:8765/ws", "https:", "h");
  ok(w.kind === "ws" && w.url === "wss://10.0.0.2:8765/ws", "?ws= used");
  const r = tel.chooseTransport("", "http:", "h");
  ok(r.kind === "ws" && r.reason === "remembered ?ws=", "?ws= remembered");
  ok(tel.chooseTransport("?mock=1", "http:", "h").kind === "mock", "?mock=1 beats the remembered bridge");
  tel.chooseTransport("?ws=off", "http:", "h");
  ok(tel.chooseTransport("", "http:", "h").kind === "mock", "?ws=off forgets it");
  ok(tel.chooseTransport("", "https:", "pc:8443").url === "wss://pc:8443/ws", "https default: same-origin tunnel");
  ok(tel.chooseTransport("?mock=0", "http:", "h").url === "ws://localhost:8765/ws", "?mock=0 -> local bridge");
}

// ---- 9. stage: recenter math, planes, persistence, lazy follow ------------------
{
  const D = st.CANON_DESK;
  // seated, facing -Z: the desk point lands REACH ahead and BELOW_EYE under the eyes
  let s1 = st.solveStage({ head: { pos: [0, 1.2, 0], fwd: [0, -0.3, -1] } });
  ok(near(s1.yaw, 0, 1e-9) && near3(s1.desk, [0, 1.2 - st.BELOW_EYE_M, -st.REACH_M], 1e-9), "head-only recenter: desk ahead + below the eyes");
  ok(near3(st.applyMat(st.stageMatrix(s1), D), s1.desk, 1e-9), "the canonical desk point maps onto the solved desk");
  // facing +X (turned 90 deg right): yaw -pi/2, desk along +X
  const s2 = st.solveStage({ head: { pos: [1, 1.6, 2], fwd: [1, 0, 0] } });
  ok(near(s2.yaw, -Math.PI / 2, 1e-9) && near3(s2.desk, [1 + st.REACH_M, 1.35, 2], 1e-9), "facing +X: yaw -90 deg, desk along +X");
  ok(near3(st.rotY(s2.yaw, [0, 0, -1]), [1, 0, 0], 1e-9), "canonical forward (-Z) becomes the gaze heading");
  // straight down: no heading, the previous yaw is kept
  const s3 = st.solveStage({ head: { pos: [0, 1.2, 0], fwd: [0, -1, 0] }, prevYaw: 0.7 });
  ok(near(s3.yaw, 0.7, 1e-9), "looking straight down keeps the previous heading");
  // table plane in band is used; standing over a low table floats at chest height
  const s4 = st.solveStage({ head: { pos: [0, 1.2, 0], fwd: [0, 0, -1] }, tableY: 0.74 });
  ok(near(s4.desk[1], 0.74, 1e-9) && s4.source === "table", "a table plane sets the desk height");
  const tbl = { y: 0.74, poly: [[-0.6, -1], [0.6, -1], [0.6, -0.2], [-0.6, -0.2]], label: "table" };
  ok(st.pickTableY([tbl], [0, -0.45], 1.2) === 0.74, "table under the target is picked");
  ok(st.pickTableY([tbl], [0, -0.45], 1.65) === null, "standing (0.9 m above it): not used, float at chest height");
  ok(st.pickTableY([tbl], [1.5, -0.45], 1.2) === null, "a table far from the target is ignored");
  ok(st.pickTableY([tbl], [0.7, -0.45], 1.2) === 0.74, "slight overhang past the edge still counts");
  ok(st.pickTableY([{ y: 0.02, poly: tbl.poly }], [0, -0.45], 1.2) === null, "the floor is never the table");
  const two = [{ y: 0.9, poly: tbl.poly, label: "" }, { y: 0.74, poly: tbl.poly, label: "desk" }];
  ok(st.pickTableY(two, [0, -0.45], 1.2) === 0.74, "a labelled desk wins over an unlabelled shelf");
  // an offered hand sets reach (clamped) and height
  const s5 = st.solveStage({ head: { pos: [0, 1.2, 0], fwd: [0, 0, -1] }, hand: [0.1, 0.95, -0.9] });
  ok(near(s5.reach, st.HAND_REACH_MAX, 1e-9) && near(s5.desk[1], 0.87, 1e-9) && s5.source === "hand", "hand recenter: reach clamped, height from the hand");
  // matrices
  const S = { yaw: 0.8, pos: [0.3, -0.2, 1.1] };
  const back = st.stageFromMatrix(st.stageMatrix(S));
  ok(near(back.yaw, S.yaw, 1e-9) && near3(back.pos, S.pos, 1e-12), "stage <-> matrix round trip");
  const A = { yaw: -0.4, pos: [1, 0, 0] }, B = { yaw: 1.3, pos: [-0.5, 0.2, 0.7] };
  const pA = [0.2, 0.9, -0.5], pB = st.applyMat(st.stageDelta(A, B), pA);
  ok(near3(st.applyMat(st.stageMatrix(A), pA), st.applyMat(st.stageMatrix(B), pB), 1e-12), "stageDelta keeps the physical point");
  const mid = st.lerpStage({ yaw: 3.0, pos: [0, 0, 0] }, { yaw: -3.0, pos: [1, 1, 1] }, 0.5);
  ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.3 && near3(mid.pos, [0.5, 0.5, 0.5]), "glide takes the short way round");
  // per-room persistence against an anchor
  const anchorBase = st.stageMatrix({ yaw: 0.3, pos: [2, 0, -1] });
  const G = st.stageInAnchor(S, anchorBase);
  const R = st.stageFromAnchor(G, anchorBase);
  ok(near(R.yaw, S.yaw, 1e-9) && near3(R.pos, S.pos, 1e-9), "stage in anchor frame round trip");
  // next session: local-floor moved (anchor now elsewhere in base); the stage follows the anchor
  const move = st.stageMatrix({ yaw: -1.1, pos: [0.4, 0, 0.9] });
  const anchorBase2 = st.mulMat(move, anchorBase);
  const R2 = st.stageFromAnchor(G, anchorBase2);
  const deskRoom1 = st.applyMat(st.stageMatrix(S), D);
  const deskRoom2 = st.applyMat(st.stageMatrix(R2), D);
  ok(near3(deskRoom2, st.applyMat(move, deskRoom1), 1e-9), "restored stage puts the desk back at the same spot of the room");
  const anchorCanon = st.invertMat(st.stageMatrix(S));   // anchor at the base origin, read in the offset space
  ok(near3(Array.from(st.anchorToBase(S, anchorCanon)).slice(12, 15), [0, 0, 0], 1e-12), "offset-space anchor pose carried back to base");
  ok(st.saveRoomStage("h-1", G, 5) && st.loadRoomStage("h-1") && near(st.loadRoomStage("h-1")[12], G[12], 1e-5), "room stage persisted per anchor handle");
  ok(st.loadRoomStage("nope") === null, "unknown room: nothing stored");
  // lazy follow: stays inside the dead zone, re-targets beyond it
  const lf = new st.LazyFollow();
  lf.update(0, 0, 0.016);
  for (let i = 0; i < 60; i++) lf.update(0.3, 0, 0.016);           // 17 deg: inside the cone
  ok(near(lf.yaw, 0, 1e-9), "lazy follow ignores a small head turn");
  for (let i = 0; i < 120; i++) lf.update(0.8, 0, 0.016);          // 46 deg: re-target
  ok(Math.abs(lf.yaw - 0.8) < 0.01, "lazy follow re-centres after a big turn");
  ok(lf.update(0.8, -1.2, 0.016) && lf.elev >= lf.minElev - 1e-9, "elevation clamped when looking down");
  // the body anchor rides a recenter
  const ba = new pf.BodyAnchor();
  ba.setDefaultNeutralAt([0.1, 0.9, -0.3]);
  const body = { live: true, calibrated: true, wrist_m: [0.05, -0.3, 0.26], hand_quat: [1, 0, 0, 0] };
  const w0 = ba.place(body).wrist;
  const Na = st.stageDelta(A, B), dd = st.stageFromMatrix(Na);
  ba.applyYawTranslate(dd.yaw, dd.pos);
  const w1 = ba.place(body).wrist;
  ok(near3(st.applyMat(st.stageMatrix(A), w0), st.applyMat(st.stageMatrix(B), w1), 1e-9), "body anchor keeps the wrist where it physically is");
}

// ---- 10. pose lane: merge, fallback, latency -------------------------------------
{
  const snap = { kind: "snap", t_ms: 100, link: { device: true }, body: { calibrated: false, provisional: true, live: true,
    wrist_m: [0, 0, 0], hand_quat: [1, 0, 0, 0], quality: { since_neutral_s: 3 } },
    joints: [{ id: "index_mcp", deg: 5, ok: true }, { id: "thumb_mcp", deg: 12, ok: true }] };
  const pose = { kind: "pose", t: 140, seq: 7, rx: 1000, tx: 1003, cal: 2, live: true,
    e: [0, -0.3, 0], w: [0, -0.3, 0.26], h: [0, -0.29, 0.31], fq: [1, 0, 0, 0], hq: [0.9, 0.1, 0, 0],
    wd: [10, -2, 3], j: [7, null, 30, 1, 2, 3, 4, 5, 6, 7, 8, 9], tq: null };
  ok(pl.poseUsable(pose) && !pl.poseUsable({ kind: "snap" }), "pose usability gate");
  const m = pl.mergePose(snap, pose);
  ok(m !== snap && snap.body.provisional === true, "merge never mutates the snap");
  ok(m.body.calibrated === true && m.body.provisional === false && near3(m.body.wrist_m, pose.w) && m.body.hand_quat === pose.hq,
     "body block takes the pose (cal 2 = calibrated)");
  ok(m.body.quality.since_neutral_s === 3 && m.link.device === true, "fields the pose lacks keep the snap's");
  ok(m.body.wrist_deg.flex === 10 && m.t_ms === 140, "wrist degrees + device clock from the pose");
  const jm = Object.fromEntries(m.joints.map((j) => [j.id, j]));
  ok(jm.index_mcp.deg === 7 && jm.index_pip.ok === false && jm.index_dip.deg === 30 && jm.pinky_dip.deg === 9, "joints in JOINT order, null = not live");
  ok(jm.thumb_mcp && jm.thumb_mcp.deg === 12, "non-lane joints kept");
  const lane = new pl.PoseLane({ staleMs: 250 });
  for (let i = 0; i < 100; i++) lane.push({ ...pose, seq: i, rx: 5000 + i * 10, tx: 5000 + i * 10 + 3 }, 5000 + i * 10 + 15, 10 * i);
  let stt = lane.stats(990);
  ok(stt.active && stt.rateHz >= 99 && stt.bridgeMs === 3 && stt.synced && stt.netMs === 12 && stt.totalMs === 15, "100 Hz, bridge 3 ms + net 12 ms");
  lane.push({ ...pose, seq: 105, rx: 6100, tx: 6103 }, 6115, 1000);
  ok(lane.dropped === 5, "sequence gaps counted as drops");
  ok(!lane.push({ ...pose, seq: 104 }, 6120, 1001), "a stale (older seq) pose is ignored");
  ok(!lane.active(1300) && lane.stats(1300).rateHz === 0, "no pose for 300 ms: lane inactive (snap fallback)");
  const off = new pl.PoseLane();
  for (let i = 0; i < 10; i++) off.push({ ...pose, seq: i, rx: 1000 + i, tx: 1003 + i }, 90000 + i, i);
  ok(off.stats(10).synced === false && off.stats(10).netMs === null && off.stats(10).bridgeMs === 3, "clocks disagree: no invented network latency");
  const rm = new pl.RateMeter();
  for (let i = 0; i < 60; i++) rm.note(i * 16.7);
  ok(rm.hz(1000) >= 59, "snap rate meter");
}

// ---- 11. status HUD words + first-run guide --------------------------------------
{
  const live = { link: { device: true }, _ageMs: 20, body: { calibrated: true, provisional: false, live: true, quality: { since_neutral_s: 10 } },
    health: [{ stream: "imu", detail: "main 2/2 · 3/3" }, { stream: "link", detail: "teensy" }],
    joints: ["index", "middle", "ring", "pinky"].flatMap((f) => ["mcp", "pip", "dip"].map((s, i) => ({ id: `${f}_${s}`, deg: 0, ok: !(f === "ring" && i === 0) }))),
    session: { recording: true, elapsed_ms: 75000 } };
  const ws = { kind: "ws", connected: true, simulated: false, url: "ws://x" };
  let v = ux.statusView({ transport: ws, snap: live, lane: { active: true, rateHz: 100, bridgeMs: 2, netMs: 9, totalMs: 11 }, snapHz: 60, fps: 72 });
  ok(v.link.word === "LIVE" && v.link.tone === "ok", "LIVE with a device");
  ok(v.rec && v.rec.text === "REC 1:15", "recording timer");
  ok(v.sensors[0].word === "IMU 2/2" && v.sensors[1].word === "ENC 11/12" && v.sensors[1].tone === "warn", "IMU from health, encoders from joints");
  ok(v.neutral.word === "neutral ✓" && v.rate === "pose 100 Hz · 11 ms · 72 fps", "neutral + rate line");
  ok(ux.statusView({ transport: { kind: "mock", simulated: true }, snap: live }).link.word === "SIMULATED", "SIMULATED");
  ok(ux.statusView({ transport: { kind: "ws", connected: false, url: "ws://y" }, snap: null }).link.word === "OFFLINE", "OFFLINE");
  ok(ux.statusView({ transport: ws, snap: { ...live, link: { device: false } } }).link.word === "NO DEVICE", "NO DEVICE");
  ok(ux.statusView({ transport: ws, snap: { ...live, health: [{ stream: "link", detail: "sim" }] } }).link.word === "BRIDGE SIM", "bridge --sim is not LIVE");
  ok(ux.statusView({ transport: ws, snap: { ...live, _ageMs: 5000 } }).link.word === "STALLED", "a silent bridge is not LIVE");
  ok(ux.statusView({ transport: ws, snap: { ...live, body: { provisional: true } } }).neutral.tone === "warn", "provisional neutral warns");
  v = ux.statusView({ transport: ws, snap: live, lane: { active: false }, snapHz: 58 });
  ok(/snap 58 Hz \(no pose lane\)/.test(v.rate), "old bridge: snap rate, lane absence said");
  v = ux.statusView({ transport: ws, snap: { ...live, link: { device: true, latency_ms: { median: 1.4, p95: 3 } } }, lane: { active: false }, snapHz: 60 });
  ok(/bridge 1 ms/.test(v.rate), "the bridge's own link.latency_ms {median} shown when our lane is off");
  const mw = pl.mergePose({ kind: "snap", body: { wrist_deg: { flex: 1, dev: 2, pro: 3 } } }, { kind: "pose", hq: [1, 0, 0, 0], wd: [null, null, null] });
  ok(mw.body.wrist_deg.flex === 1, "null wrist degrees on the wire keep the snap's");
  v = ux.statusView({ transport: ws, snap: live, lane: { active: false }, snapHz: 58 });
  ok(ux.statusKey(v) === ux.statusKey(ux.statusView({ transport: ws, snap: live, lane: { active: false }, snapHz: 58 })), "stable key (redraw only on change)");

  const g = new ux.Guide();
  const off = { kind: "ws", connected: false, url: "ws://pc:8765/ws" };
  let c = g.update(0.2, { transport: off, snap: null, neutral: {} });
  ok(c.id === "connect" && c.tone === "bad" && /Waiting/.test(c.text), "guide 1: connect");
  const linked = { link: { device: true }, body: { provisional: true, calibrated: false, live: true } };
  c = g.update(0.2, { transport: ws, snap: linked, neutral: {} });
  ok(c.id === "calibrate" && /Provisional/.test(c.text), "guide 2: calibrate (provisional)");
  c = g.update(0.2, { transport: ws, snap: linked, neutral: { phase: "countdown", t: 2.6, ageS: 0.1 } });
  ok(c.countdown === 3 && c.tone === "warn", "countdown number comes from the bridge ack");
  c = g.update(0.2, { transport: ws, snap: linked, neutral: { phase: "hold", t: 1, ageS: 0.1 } });
  ok(c.countdown === null && /Hold still/.test(c.text), "hold phase");
  c = g.update(0.2, { transport: ws, snap: linked, neutral: { phase: "done", ageS: 1 } });
  ok(/Calibrated/.test(c.title), "done flash");
  c = g.update(0.2, { transport: ws, snap: linked, neutral: { phase: null, ageS: 9 }, mode: "atelier" });
  ok(c.id === "twin", "guide 3: twin (calibration sticky once done)");
  for (let i = 0; i < 30; i++) c = g.update(0.2, { transport: ws, snap: linked, neutral: {}, mode: "twin", deviceDriven: true });
  ok(c.id === "record", "5 s in the twin -> guide 4: record");
  c = g.update(0.2, { transport: ws, snap: linked, neutral: {}, recordedTake: true });
  ok(c.id === "replay", "a take -> guide 5: replay");
  c = g.update(0.2, { transport: ws, snap: linked, neutral: {}, replayLoaded: true });
  ok(c.allDone, "all set");
  for (let i = 0; i < 30; i++) c = g.update(0.2, { transport: ws, snap: linked, neutral: {} });
  ok(c === null, "the guide then gets out of the way");
  const g2 = new ux.Guide(); g2.hidden = true;
  ok(g2.update(0.1, { transport: ws, snap: linked, neutral: { phase: "countdown", t: 1, ageS: 0 } }).countdown === 1, "a hidden guide still shows a running countdown");
  ok(g2.update(0.1, { transport: ws, snap: linked, neutral: {} }) === null, "hidden guide otherwise silent");
}

// ---- 12. gestures: poke, two-hand pinch hold, held button, debounce -----------
{
  const p = new ge.PokeState();
  ok(p.update([0, 0, 0.05]) === null && p.armed, "approach from the front arms");
  ok(p.update([0.005, 0, 0.02]) === null, "not yet at the surface");
  ok(p.update([0.005, 0, 0.004]) === "press", "crossing the face presses");
  ok(p.update([0.005, 0, -0.01]) === null, "resting inside does not repeat");
  p.update([0, 0, 0.05]);
  ok(p.update([0, 0, 0.0]) === "press", "backing off re-arms");
  const q = new ge.PokeState();
  q.update([0, 0, -0.03]);
  ok(q.update([0, 0, 0.0]) === null, "coming from behind never presses");
  const r = new ge.PokeState();
  r.update([0.05, 0, 0.05]);
  ok(r.update([0.05, 0, 0.0]) === null, "outside the face radius never presses");
  const ph = new ge.PinchHold({ holdS: 1.0 });
  let fired = 0;
  for (let i = 0; i < 70; i++) if (ph.update(1 / 60, 0.012, 0.015)) fired++;
  ok(fired === 1 && ph.progress === 1, "both pinched 1 s: fires once");
  const ph2 = new ge.PinchHold({ holdS: 1.0 });
  for (let i = 0; i < 30; i++) ph2.update(1 / 60, 0.012, 0.015);
  for (let i = 0; i < 20; i++) ph2.update(1 / 60, 0.028, 0.015);   // loosened, still under the open threshold
  let f2 = false;
  for (let i = 0; i < 15 && !f2; i++) f2 = ph2.update(1 / 60, 0.012, 0.015);
  ok(f2, "hysteresis: a loosening pinch keeps the timer");
  const ph4 = new ge.PinchHold({ holdS: 1.0 });
  for (let i = 0; i < 50; i++) ph4.update(1 / 60, 0.012, 0.015);
  ph4.update(1 / 60, 0.05, 0.015);                                 // opened: restart
  ok(ph4.progress === 0, "an opened pinch restarts the hold");
  const ph3 = new ge.PinchHold({ holdS: 1.0 });
  for (let i = 0; i < 70; i++) ph3.update(1 / 60, 0.012, null);
  ok(ph3.progress === 0, "one hand only: nothing");
  const hb = new ge.HoldButton(0.6);
  let hf = 0;
  for (let i = 0; i < 60; i++) if (hb.update(1 / 60, true)) hf++;
  ok(hf === 1, "held button fires once");
  hb.update(1 / 60, false);
  ok(hb.progress === 0, "released: re-armed");
  const db = new ge.Debounce(350);
  ok(db.ok("x", 0) && !db.ok("x", 100) && db.ok("y", 100) && db.ok("x", 400), "one activation per target per window");
}

console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
