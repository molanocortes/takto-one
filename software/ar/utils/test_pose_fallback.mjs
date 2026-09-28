// test_pose_fallback.mjs - pure-function checks for the AR motion layer.
// Run:  node software/ar/utils/test_pose_fallback.mjs      (Node >= 22)
// Covers what the desktop preview cannot exercise: the XR hand reader's
// stale/grace/handedness logic, the world/body fallback ladder, the body
// anchor solve, the anchor restore/relocate state machine, the chunked env
// upload + late-ack recovery, the replay track builder and the transport pick.

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

console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
