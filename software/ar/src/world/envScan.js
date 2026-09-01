// envScan.js - the Quest side of 4D replay (see web DATA_CONTRACT, 2026-07-18/19).
//
// Three jobs, all anchored in the SAME reference space (local-floor) so the
// bridge's environment library and take trajectories share coordinates:
//   1. SCAN a POINT CLOUD: consume the WebXR depth-sensing stream (the session
//      negotiates it in main.js; before 2026-07-19 nothing ever called
//      frame.getDepthInformation, so the depth data was requested and thrown
//      away). Sparse per-frame samples of the depth map are unprojected into
//      local-floor and accumulated in a voxel-averaged grid. Each voxel keeps
//      a running MEAN position and an OBSERVATION COUNT - a real measurement
//      of how many independent stereo-depth samples confirmed that surface,
//      which becomes the per-point confidence attribute (RGB is impossible in
//      WebXR, so confidence + height carry the stylization instead).
//   2. SCAN the MESH backbone: the scene-reconstruction mesh (mesh-detection,
//      Space Setup) and the plane-detection fallback, harvested in chunks as
//      before. The cloud is the primary product; the mesh is structure.
//   3. POSE: while recording, stream the WRIST 6-DoF pose (right hand - the
//      rig is worn there) at <= 30 Hz, tagged with the scanned env id, PLUS
//      the four fingers' [abduction, MCP, PIP] angles measured from the
//      headset's own hand-tracking joints. The bridge decides precedence
//      honestly (real encoders > Quest vision > sim) and labels the take.
//
// CRASH HISTORY (2026-07-19): the old build harvested the whole room mesh
// SYNCHRONOUSLY on the first recording frame - tens of thousands of vertices,
// each with three toFixed() allocations, then a multi-MB JSON.stringify, all
// inside one XR animation frame. On a real headset that stalled the frame hard
// enough to look like a crash and could drop the socket. The scan is now
// CHUNKED across frames (small vertex + depth-sample budgets per frame), so it
// never stalls, and it reports progress the whole way. The depth harvest obeys
// the same law: a bounded sample count per frame, no per-sample allocation.
//
// Requires the session created with optionalFeatures including
// "depth-sensing", "mesh-detection", "plane-detection", "hand-tracking" and
// (since 2026-07-30) "anchors". Everything degrades honestly: no depth and no
// meshes and no planes -> phase "empty" (take replays orientation-only); no
// wrist -> no poses; no anchors -> the room is captured but cannot relocate,
// and says so.
//
// 2026-07-30, SEMANTICS + ANCHOR (see ROOMSCAN-EVALUATION.md). Two things the
// runtime was already handing us and this file was discarding:
//   - `mesh.semanticLabel` / `plane.semanticLabel`: harvested into a
//     SceneObjectRegistry (world/sceneObjects.js) so the room is a list of
//     LABELLED boxes, not just triangles. This is what lets a take say the
//     index finger touched the TABLE.
//   - anchoring: a WebXR persistent anchor is dropped at scan start
//     (world/roomAnchor.js) and shipped with the upload, so the same room can
//     be relocated in a later session instead of drifting with local-floor.
// Both ideas are ported from QuestRoomScan (MIT, Arghya Sur); the reconstruction
// pipeline it wraps them in is deliberately not adopted.

import { SceneObjectRegistry, harvestSceneObjects, resetSceneObjectIds }
  from "./sceneObjects.js";
import { RoomAnchor, tagAnchorEnv, latestAnchor } from "./roomAnchor.js";

const ENV_TRI_BUDGET = 90000;    // stay under the bridge's 120k cap with margin
const POSE_PERIOD_MS = 33;       // ~30 Hz wrist stream
const VERTS_PER_FRAME = 9000;    // chunk cap: how many mesh verts we transform / frame
const PLATEAU_MS = 2200;         // finish a scan when growth stops this long
const SCAN_MAX_MS = 25000;       // hard cap on one scan (ms) - a slow room sweep
const NOTHING_MAX_MS = 9000;     // give up early when NOTHING is arriving at all
const UPLOAD_TIMEOUT_MS = 8000;  // give up waiting for the env_saved ack

// ---- point cloud (depth-sensing) -------------------------------------------
const VOX_M = 0.025;             // voxel edge: 2.5 cm - fine enough for furniture
const MAX_POINTS = 60000;        // accumulation cap (bridge accepts up to 120k)
const DEPTH_SAMPLES_PER_FRAME = 224;   // sparse grid samples consumed per frame
const DEPTH_MIN_M = 0.25;        // stereo depth is garbage nearer than this
const DEPTH_MAX_M = 4.0;         // ...and noise-limited beyond this on the 3S
const VOX_HALF = 512;            // voxel key range: +-12.8 m about the origin
const W_MAX = 250;               // observation count saturates here
const DEPTH_GRID_COLS = 16, DEPTH_GRID_ROWS = 14;   // sparse sample grid (=224)

// module-level env id (learned from the bridge ack), read by the pose stream
let _envId = null;
let _envName = "";
let _wasRecording = false;
let _lastPoseTx = 0;
let _ackHooked = false;

// ---- diagnostics: make the silent paths speak (2026-07-20) ------------------
// Every reason a depth/scan step yielded nothing is recorded here and surfaced
// by the on-headset HUD (world/diagHud.js) + capture console, so a scan that
// "does nothing" always says WHY on the device. Honesty: these describe the
// real device state; they never fabricate points.
const SECTORS = 12;              // azimuth sectors for the room-coverage meter
let _depthReason = "idle";       // why _harvestDepth did / didn't land points
let _depthLanded = 0;            // in-range samples that landed this frame
let _lastAck = null;             // last bridge ack/error, verbatim, for the HUD

// the scan is a small state machine, observed by the capture console UI.
//   idle -> scanning -> uploading -> done      (room captured + sent)
//                    -> empty                   (no depth/mesh/plane to capture)
//                    -> error                   (bridge rejected the upload)
function freshScan() {
  return {
    phase: "idle",
    positions: [], indices: [], base: 0, tris: 0,
    meshes: 0, planes: 0,
    queue: [],                 // [{verts, idx, m, vcur, vbaseAtStart}] chunked drain
    taken: new Set(),          // XRSpace identities already queued (union dedupe)
    // point cloud accumulator: voxel key -> slot in the flat arrays
    vox: new Map(),
    cloudPos: new Float32Array(MAX_POINTS * 3),   // running MEAN per voxel
    cloudW: new Uint16Array(MAX_POINTS),          // observation count per voxel
    pts: 0, cloudGen: 0,       // cloudGen bumps whenever points land (render dirty flag)
    depthFrames: 0,            // frames that actually yielded depth (honesty signal)
    sectors: 0,                // bitmask of azimuth sectors a scan has swept (coverage)
    startedT: 0, lastGrowthT: 0, lastTris: -1, lastPtsMark: 0,
    uploadT: 0, err: "",
  };
}
let _scan = freshScan();

// the room's SEMANTIC inventory and its anchor. Both outlive a single scan
// object because the contact tracker reads the registry every frame, including
// after a scan has finished uploading.
const _objects = new SceneObjectRegistry();
const _anchor = new RoomAnchor();
let _anchorPending = false;       // one create() in flight at a time

/** The live registry of labelled room objects (world/sceneObjects.js). */
export function sceneObjects() { return _objects; }

/** The room anchor, for relocation and for the diag HUD. */
export function roomAnchor() { return _anchor; }

export function resetEnvScan() {
  _envId = null; _envName = ""; _wasRecording = false;
  _depthReason = "idle"; _depthLanded = 0; _lastAck = null;
  _lastPoseTx = 0;   // a fresh session's first pose goes out immediately
  _objects.clear();
  resetSceneObjectIds();
  _anchor.reset();
  _anchorPending = false;
  _scan = freshScan();
}

/**
 * Session start: try to put the LAST scanned room back where it was, using its
 * persisted anchor. Returns the relocation matrix on success, else null with
 * `roomAnchor().reason` explaining exactly why (not granted / private mode /
 * cleared site data / never anchored). Never throws into the frame loop.
 */
export async function relocateLastRoom(xrFrame, refSpace, session) {
  const rec = latestAnchor();
  if (!rec) { _anchor.state = "idle"; _anchor.reason = "no anchor stored yet"; return null; }
  const m = await _anchor.restore(rec.handle, xrFrame, refSpace, session);
  if (m && rec.envId) { _envId = rec.envId; _scan.envId = rec.envId; }
  return m;
}

/** Begin an explicit room scan. The next updateEnvCapture frames accumulate the
 *  depth cloud + headset mesh in chunks; auto-finishes on plateau / budget /
 *  timeout, or on an explicit finishScan(). Safe to call again to re-scan. */
export function beginScan() {
  const keepEnv = _scan.envId;
  _scan = freshScan();
  _scan.phase = "scanning";
  _scan.startedT = _now();
  _scan.lastGrowthT = _scan.startedT;
  _scan.envId = keepEnv;
  _depthReason = "waiting for first depth frame";
  _depthLanded = 0;
  // a rescan re-inventories the room from scratch: stale objects from the
  // previous sweep would otherwise linger with stale poses
  _objects.clear();
  resetSceneObjectIds();
}

// the frozen honest explanation for an empty scan, from the real device state
function _emptyReason() {
  if (_depthReason.indexOf("gpu") === 0)
    return "Depth readback failed (" + _depthReason + "). Run Space Setup " +
           "(Settings > Physical Space) so the room mesh can carry the scan, then rescan.";
  if (_depthReason.indexOf("no depth API") === 0 && _scan.meshes === 0 && _scan.planes === 0)
    return "No depth-sensing and no room mesh. Run Space Setup or improve lighting, then rescan.";
  if (_depthReason.indexOf("in range") > 0)
    return "Depth was live but nothing in 0.3-4 m range. Face surfaces and brighten the room.";
  if (_scan.depthFrames === 0 && _scan.meshes === 0 && _scan.planes === 0)
    return "Nothing arrived: no depth, no room mesh, no planes. Run Space Setup " +
           "(Quest Settings > Physical Space > Space Setup), then rescan.";
  return "Nothing captured this sweep. Look around slowly and rescan.";
}

/** Package what has accumulated and upload it. No-op unless scanning. */
export function finishScan(tele) {
  if (_scan.phase !== "scanning") return;
  if (_scan.tris <= 0 && _scan.pts <= 0) { _scan.reason = _emptyReason(); _scan.phase = "empty"; return; }
  _sendEnv(tele);
}

/** Snapshot for the UI:
 *  { phase, tris, pts, meshes, planes, depth, secs, pct, envId, name, err } */
export function scanState() {
  const secs = _scan.startedT ? (_now() - _scan.startedT) / 1000 : 0;
  return {
    phase: _scan.phase, tris: _scan.tris, pts: _scan.pts,
    meshes: _scan.meshes, planes: _scan.planes,
    objects: _objects.count,
    anchor: _anchor.state,
    depth: _scan.depthFrames > 0,
    secs,
    pct: Math.min(1, Math.max(_scan.tris / ENV_TRI_BUDGET, _scan.pts / MAX_POINTS)),
    envId: _envId, name: _envName, err: _scan.err,
  };
}

/** Live cloud buffer for the in-headset "room being drawn" rendering.
 *  Returns the accumulator's flat arrays directly (no copy): positions are
 *  local-floor meters, weights are observation counts. `gen` changes whenever
 *  new points landed, so a renderer can update only when dirty. */
export function scanCloud() {
  return { pos: _scan.cloudPos, w: _scan.cloudW, n: _scan.pts, gen: _scan.cloudGen };
}

// popcount of the swept-sector bitmask (how much of the room was faced)
function _sweptSectors() {
  let m = _scan.sectors, c = 0;
  while (m) { c += m & 1; m >>= 1; }
  return c;
}

/** Room-coverage estimate in 0..1, for the capture UX meter. Two honest
 *  signals, whichever is stronger: how many azimuth sectors the head has faced
 *  and returned depth from, and how much mesh/plane geometry landed. Density
 *  (raw point count) is shown separately as text, not folded in here. */
export function scanCoverage() {
  const sweep = _sweptSectors() / SECTORS;                       // 0..1 angular
  const geom = _scan.tris > 0 ? Math.min(1, _scan.tris / (ENV_TRI_BUDGET * 0.5)) : 0;
  return Math.max(sweep, geom);
}

/** The one active instruction for the operator, driven entirely by real scan
 *  signals. The HUD shows it verbatim; the capture console echoes a short form.
 *  Never claims success it has not measured. */
export function scanGuidance() {
  const s = _scan;
  if (s.phase === "uploading") return "Sending room to host...";
  if (s.phase === "done") return `Captured ${s.pts} pts / ${s.tris} tris -> stored + sent to website`;
  if (s.phase === "error") return `Upload failed: ${s.err || "no ack"}. Tap scan to retry.`;
  if (s.phase === "empty") return s.reason || "No depth or geometry captured.";
  if (s.phase !== "scanning") return "";
  const secs = s.startedT ? (_now() - s.startedT) / 1000 : 0;
  const noDepthApi = _depthReason.indexOf("no depth API") === 0;
  // nothing at all after a grace period: the actionable root causes
  if (s.pts === 0 && s.tris === 0 && secs > 2.5) {
    if (_depthReason.indexOf("gpu") === 0)
      return "Depth readback failing (" + _depthReason + "). Run Space Setup, then rescan.";
    if (noDepthApi && s.meshes === 0 && s.planes === 0)
      return "No depth and no room mesh. Run the headset's Space Setup, or improve lighting, then rescan.";
    if (_depthReason.indexOf("in range") > 0)
      return "Depth is live but sees nothing 0.3-4 m away. Face your walls/desk and brighten the room.";
    if (s.meshes === 0 && s.planes === 0 && secs > 6)
      return "No room mesh yet. If this stays empty, run Space Setup (Settings > Physical Space).";
    return "Waiting for the room. Look slowly around at surfaces 0.3-4 m away.";
  }
  const cov = scanCoverage();
  if (cov < 0.35) return "Turn slowly left and right to sweep the whole room.";
  if (cov < 0.75) return "Keep turning; look up and down to catch walls, floor and ceiling.";
  return "Good coverage. Hold still to finish, or tap scan to send now.";
}

/** Full diagnostic snapshot for the on-headset HUD. Everything envScan knows
 *  about why a scan is / isn't working. Transport + session.enabledFeatures are
 *  merged in by main.js (they live outside this module). */
export function envDiag() {
  return {
    phase: _scan.phase,
    pts: _scan.pts, tris: _scan.tris,
    meshes: _scan.meshes, planes: _scan.planes,
    objects: _objects.count,
    objectLabels: _objects.labelCounts(),
    anchorState: _anchor.state,
    anchorReason: _anchor.reason,
    anchorHandle: _anchor.handle ? _anchor.handle.slice(0, 8) + "..." : null,
    depthFrames: _scan.depthFrames,
    depthReason: _depthReason,
    depthLanded: _depthLanded,
    sectors: _sweptSectors(), sectorsMax: SECTORS,
    coverage: scanCoverage(),
    guidance: scanGuidance(),
    secs: _scan.startedT ? (_now() - _scan.startedT) / 1000 : 0,
    envId: _envId, name: _envName, err: _scan.err,
    lastAck: _lastAck,
  };
}

function _now() {
  return (typeof performance !== "undefined" && performance.now)
    ? performance.now() : Date.now();
}

function _r4(x) { return Math.round(x * 1e4) / 1e4; }   // cheap 4-dp round, no alloc
function _r3(x) { return Math.round(x * 1e3) / 1e3; }   // mm quantization for transport

// enumerate the headset's detected meshes and queue any we have not taken yet.
// Each queued item carries a SNAPSHOT (vertices + indices + world matrix) so the
// chunked drain is stable even if the live mesh mutates mid-scan.
function _enqueueMeshes(xrFrame, refSpace) {
  const meshes = xrFrame.detectedMeshes;
  if (!meshes || meshes.size === 0) return;
  for (const mesh of meshes) {
    const space = mesh.meshSpace;
    if (_scan.taken.has(space)) continue;
    const pose = xrFrame.getPose(space, refSpace);
    if (!pose) continue;
    _scan.taken.add(space);
    _scan.meshes++;
    _scan.queue.push({
      verts: mesh.vertices, idx: mesh.indices,
      m: pose.transform.matrix, vcur: 0, vbaseAtStart: -1,
    });
  }
}

// fallback when there is no room mesh: turn detected PLANES (walls / floor /
// tables) into thin quad strips so the replay still has a coarse room shell.
function _enqueuePlanes(xrFrame, refSpace) {
  const planes = xrFrame.detectedPlanes;
  if (!planes || planes.size === 0) return;
  for (const plane of planes) {
    const space = plane.planeSpace;
    if (_scan.taken.has(space)) continue;
    const pose = xrFrame.getPose(space, refSpace);
    if (!pose || !plane.polygon || plane.polygon.length < 3) continue;
    _scan.taken.add(space);
    _scan.planes++;
    // polygon points are in the plane's local frame (x,z on the plane, y=0);
    // fan-triangulate into a snapshot the drain treats like any mesh
    const poly = plane.polygon;
    const verts = new Float32Array(poly.length * 3);
    for (let i = 0; i < poly.length; i++) {
      verts[i * 3] = poly[i].x; verts[i * 3 + 1] = poly[i].y; verts[i * 3 + 2] = poly[i].z;
    }
    const idx = [];
    for (let i = 1; i < poly.length - 1; i++) idx.push(0, i, i + 1);
    _scan.queue.push({
      verts, idx, m: pose.transform.matrix, vcur: 0, vbaseAtStart: -1,
    });
  }
}

// transform up to VERTS_PER_FRAME vertices from the queue this frame. A mesh's
// indices are appended only once ALL its vertices have landed, so chunking a big
// mesh across frames stays correct. Never exceeds the tri budget.
function _drainChunk() {
  let budget = VERTS_PER_FRAME;
  while (budget > 0 && _scan.queue.length && _scan.tris < ENV_TRI_BUDGET) {
    const item = _scan.queue[0];
    const v = item.verts, m = item.m;
    if (item.vbaseAtStart < 0) item.vbaseAtStart = _scan.base;
    const nVerts = v.length / 3;
    let processed = item.vcur;
    for (; processed < nVerts && budget > 0; processed++, budget--) {
      const x = v[processed * 3], y = v[processed * 3 + 1], z = v[processed * 3 + 2];
      _scan.positions.push(
        _r4(m[0] * x + m[4] * y + m[8] * z + m[12]),
        _r4(m[1] * x + m[5] * y + m[9] * z + m[13]),
        _r4(m[2] * x + m[6] * y + m[10] * z + m[14]));
    }
    item.vcur = processed;
    _scan.base = item.vbaseAtStart + processed;
    if (processed >= nVerts) {
      // all vertices in: emit this mesh's triangles, honoring the tri budget
      const idx = item.idx;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        if (_scan.tris >= ENV_TRI_BUDGET) break;
        _scan.indices.push(idx[i] + item.vbaseAtStart,
                           idx[i + 1] + item.vbaseAtStart,
                           idx[i + 2] + item.vbaseAtStart);
        _scan.tris++;
      }
      _scan.queue.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// DEPTH CLOUD: sparse-sample the per-frame depth map, unproject into the
// reference space, and merge into the voxel accumulator. All closed-form (no
// matrix inverse): for a WebXR projection matrix P (column-major) and a sample
// at NDC (nx, ny) with eye-space depth d,
//   x_view = d * (nx + P[8]) / P[0],  y_view = d * (ny + P[9]) / P[5],
//   z_view = -d
// then view.transform.matrix (rigid, view -> refSpace) carries it to world.
// ---------------------------------------------------------------------------
let _sampleTick = 0;    // per-frame jitter phase so the grid doesn't alias

function _voxKey(x, y, z) {
  const ix = Math.round(x / VOX_M) + VOX_HALF;
  const iy = Math.round(y / VOX_M) + VOX_HALF;
  const iz = Math.round(z / VOX_M) + VOX_HALF;
  if (ix < 0 || iy < 0 || iz < 0 || ix > 1023 || iy > 1023 || iz > 1023) return -1;
  return ix + iy * 1024 + iz * 1048576;
}

function _cloudAdd(x, y, z) {
  const key = _voxKey(x, y, z);
  if (key < 0) return;
  let slot = _scan.vox.get(key);
  if (slot === undefined) {
    if (_scan.pts >= MAX_POINTS) return;
    slot = _scan.pts++;
    _scan.vox.set(key, slot);
    _scan.cloudPos[slot * 3] = x;
    _scan.cloudPos[slot * 3 + 1] = y;
    _scan.cloudPos[slot * 3 + 2] = z;
    _scan.cloudW[slot] = 1;
    _scan.cloudGen++;
  } else {
    // running mean keeps the point on the measured surface, not the voxel center
    const n = Math.min(W_MAX, _scan.cloudW[slot] + 1);
    const k = 1 / n, b = slot * 3;
    _scan.cloudPos[b] += (x - _scan.cloudPos[b]) * k;
    _scan.cloudPos[b + 1] += (y - _scan.cloudPos[b + 1]) * k;
    _scan.cloudPos[b + 2] += (z - _scan.cloudPos[b + 2]) * k;
    _scan.cloudW[slot] = n;
  }
}

// GPU depth readback (world/depthGpu.js), injected by main.js because it
// needs the three renderer. On the Quest browser this is the ONLY depth path:
// the device grants gpu-optimized only, and the CPU getDepthInformation call
// throws InvalidStateError (pinned by the owner's diag log, 2026-07-20).
let _gpuReader = null;
export function setGpuDepthReader(r) { _gpuReader = r; }

function _harvestDepth(xrFrame, refSpace, session) {
  // The bail reasons below are the whole point of this pass: each one is a
  // DISTINCT device state, surfaced verbatim on the HUD + diag log.
  if (typeof xrFrame.getDepthInformation !== "function") {
    _depthReason = "no depth API (depth-sensing not granted)"; return;
  }
  if (typeof xrFrame.getViewerPose !== "function") {
    _depthReason = "no getViewerPose on frame"; return;
  }
  let viewer = null;
  try { viewer = xrFrame.getViewerPose(refSpace); }
  catch (e) { _depthReason = "getViewerPose threw: " + (e && e.name || e); return; }
  if (!viewer || !viewer.views || !viewer.views.length) {
    _depthReason = "no viewer views this frame"; return;
  }
  const view = viewer.views[0];              // one eye is plenty for a room cloud
  _sampleTick++;
  // jittered sparse grid: 16 columns x 14 rows = 224 samples, the grid phase
  // sliding each frame so successive frames fill between one another
  const COLS = DEPTH_GRID_COLS, ROWS = DEPTH_GRID_ROWS;
  const ju = ((_sampleTick * 0.618034) % 1) / COLS;    // golden-ratio slide
  const jv = ((_sampleTick * 0.381966) % 1) / ROWS;
  // depth source: CPU map when the UA honors cpu-optimized; GPU texture
  // readback when the CPU call is invalid (Quest serves gpu-optimized only)
  let depth = null, gpuDepths = null;
  try { depth = xrFrame.getDepthInformation(view); }
  catch (e) {
    if (_gpuReader && session) {
      const g = _gpuReader.read(session, view, ju, jv);
      if (!g.ok) { _depthReason = g.reason; return; }
      gpuDepths = g.depths;
    } else {
      _depthReason = "getDepthInformation threw: " + (e && e.name || e); return;
    }
  }
  if (!gpuDepths && (!depth || !depth.getDepthInMeters)) {
    _depthReason = "depth map null this frame (feature idle)"; return;
  }
  const P = view.projectionMatrix, M = view.transform && view.transform.matrix;
  if (!P || !M) { _depthReason = "view missing projection/transform matrix"; return; }
  _scan.depthFrames++;
  let n = 0, landed = 0;
  for (let r = 0; r < ROWS && n < DEPTH_SAMPLES_PER_FRAME; r++) {
    const v = (r + 0.5) / ROWS + jv;
    if (v >= 1) continue;
    for (let c = 0; c < COLS && n < DEPTH_SAMPLES_PER_FRAME; c++, n++) {
      const u = (c + 0.5) / COLS + ju;
      if (u >= 1) continue;
      let d = 0;
      if (gpuDepths) { d = gpuDepths[r * COLS + c]; }
      else { try { d = depth.getDepthInMeters(u, v); } catch (e) { continue; } }
      if (!(d >= DEPTH_MIN_M && d <= DEPTH_MAX_M)) continue;   // NaN-safe range gate
      const nx = 2 * u - 1, ny = 1 - 2 * v;    // depth buffer v runs top-down
      const xv = d * (nx + P[8]) / P[0];
      const yv = d * (ny + P[9]) / P[5];
      const zv = -d;
      _cloudAdd(
        M[0] * xv + M[4] * yv + M[8] * zv + M[12],
        M[1] * xv + M[5] * yv + M[9] * zv + M[13],
        M[2] * xv + M[6] * yv + M[10] * zv + M[14]);
      landed++;
    }
  }
  _depthLanded = landed;
  if (landed > 0) {
    _depthReason = `ok${gpuDepths ? " (gpu)" : ""} · ${landed}/${n} samples in 0.25-4 m`;
    // coverage: mark the azimuth sector the head faces this frame (view -Z
    // forward). Filling sectors is the honest "you swept the room" signal that
    // drives the rotate/move guidance - not a fabricated meter.
    const fx = -M[8], fz = -M[10];
    if (fx * fx + fz * fz > 1e-6) {
      const sec = Math.floor((Math.atan2(fx, fz) + Math.PI) / (2 * Math.PI) * SECTORS) % SECTORS;
      _scan.sectors |= (1 << ((sec + SECTORS) % SECTORS));
    }
  } else {
    _depthReason = `depth OK but 0/${n} in range (face surfaces 0.3-4 m; brighten room)`;
  }
}

// register the bridge-ack listener exactly once. Called from every path that
// can trigger an upload (headset frame loop, manual finish, desktop sim) so the
// env_saved ack is always heard - the old build only hooked it inside the XR
// frame loop, so a desktop scan never learned its env id.
function _ensureAckHook(tele) {
  if (_ackHooked || !tele || !tele.onSnapshot) return;
  _ackHooked = true;
  tele.onSnapshot((m) => {
    if (!m || m.kind !== "ack") return;
    // keep the last bridge ack verbatim for the HUD (proves the round trip)
    _lastAck = { event: m.event, id: m.id, error: m.error, tris: m.tris, pts: m.pts };
    if (m.event === "env_saved") {
      _envId = m.id; _envName = _scan.pendingName || _envName;
      _scan.envId = m.id; _scan.tris = m.tris != null ? m.tris : _scan.tris;
      if (m.pts != null) _scan.pts = m.pts;
      // bind the persisted anchor to the env the bridge just issued, so a later
      // session can restore the anchor AND know which room it belongs to
      if (_anchor.handle) tagAnchorEnv(_anchor.handle, m.id);
      if (_scan.phase === "uploading") _scan.phase = "done";
    } else if (m.event === "error" && typeof m.error === "string" &&
               m.error.indexOf("env_save") === 0 && _scan.phase === "uploading") {
      _scan.phase = "error"; _scan.err = m.error;
    }
  });
}

function _sendEnv(tele) {
  _ensureAckHook(tele);
  _scan.phase = "uploading";
  _scan.uploadT = _now();
  const d = new Date();
  const name = `Room ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
               `${String(d.getDate()).padStart(2, "0")} ` +
               `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  _scan.pendingName = name;
  // HONESTY: the desktop sim path (simScanTick) fabricates its geometry; it
  // must never wear the "quest" label on disk. Only a scan fed by real XR
  // frames (updateEnvCapture) is source:"quest". This is how a real capture
  // is told apart from a fixture in ~/.sensoryhand_envs.json.
  const msg = { cmd: "env_save", source: _scan.simFed ? "sim-desktop" : "quest", name,
    positions: _scan.positions, indices: _scan.indices };
  // the labelled inventory and the anchor ride along with the geometry: same
  // sweep, same local-floor frame, so they can never drift apart on disk
  if (_objects.count > 0) msg.objects = _objects.serialize();
  const anch = _anchor.serialize();
  if (anch) msg.anchor = anch;
  if (_scan.pts > 0) {
    // mm-quantized transport of the voxel-averaged cloud + observation counts
    const pts = new Array(_scan.pts * 3);
    const w = new Array(_scan.pts);
    for (let i = 0; i < _scan.pts; i++) {
      pts[i * 3] = _r3(_scan.cloudPos[i * 3]);
      pts[i * 3 + 1] = _r3(_scan.cloudPos[i * 3 + 1]);
      pts[i * 3 + 2] = _r3(_scan.cloudPos[i * 3 + 2]);
      w[i] = _scan.cloudW[i];
    }
    msg.points = pts;
    msg.weights = w;
  }
  tele.send(msg);
}

// ---------------------------------------------------------------------------
// hand articulation from the headset's OWN hand tracking. When the physical
// rig is absent, this is the only real measurement of the fingers - streamed
// with the wrist pose so the bridge can fill the take's joint columns from a
// real sensor instead of leaving them flat/synthetic. Convention matches the
// device columns: [abduction (+ toward the thumb side), MCP flexion,
// PIP flexion] in deg.
//
// 2026-07-20 DEVICE-DATA FIX (takes 0088/0090/0091, real Quest hand tracking):
//   1. Abduction sign: the owner reported splay moving the WRONG way, and the
//      real takes disagree with the device convention systematically (open
//      hand: index read -6..-10 where the convention wants +, middle -6..-9
//      where it wants ~+2). AB_SIGN below flips the lateral convention; it is
//      ONE constant so the deliberate flex-then-spread verification take can
//      confirm or revert it in seconds. The dorsal axis itself is correct
//      (the thumb's palmar abduction read +29..36, anatomically right).
//   2. Flexion was the FULL unsigned 3D inter-segment angle, so lateral
//      motion leaked into the flexion columns (spread fingers -> replay also
//      curled). MCP/PIP are now computed in the finger's FLEXION PLANE
//      (segment vectors with their lateral component removed) and SIGNED
//      palmar-positive, so only true flexion enters those columns.
//   3. During deep curls, a segment's palm-plane projection shrinks toward
//      noise and the derived abduction railed into the +-30 clamp (corr up
//      to 0.9 with MCP in the real takes). Abduction now fades out with the
//      in-plane fraction of the proximal segment, which also matches the
//      anatomical shrink of abduction ROM under flexion.
// ---------------------------------------------------------------------------
const _J_FINGERS = ["index", "middle", "ring", "pinky"];
const R2D = 180 / Math.PI;
// Empirical lateral sign (2026-07-20): -1 = flipped vs the derived convention,
// per the owner's on-device report + take data. If the flex-then-spread
// verification take shows spreading driving index NEGATIVE, set back to +1.
const AB_SIGN = -1;

function _sub(a, b) { return [a.x - b.x, a.y - b.y, a.z - b.z]; }
function _dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function _cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function _norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function _angleDeg(a, b) {
  const d = Math.max(-1, Math.min(1, _dot3(_norm3(a), _norm3(b))));
  return Math.acos(d) * R2D;
}

function handJointsDeg(xrFrame, refSpace, src) {
  if (!src || !src.hand || !xrFrame.getJointPose) return null;
  const P = (name) => {
    const j = src.hand.get(name);
    if (!j) return null;
    const jp = xrFrame.getJointPose(j, refSpace);
    return jp ? jp.transform.position : null;
  };
  const wristJ = src.hand.get("wrist");
  const wristPoseFull = wristJ ? xrFrame.getJointPose(wristJ, refSpace) : null;
  if (!wristPoseFull) return null;
  // palm normal: the wrist joint's +Y axis (dorsal, per the WebXR hand module)
  const o = wristPoseFull.transform.orientation;
  const dorsal = _norm3([
    2 * (o.x * o.y - o.w * o.z),
    1 - 2 * (o.x * o.x + o.z * o.z),
    2 * (o.y * o.z + o.w * o.x),
  ]);
  const out = {};
  let got = 0;
  for (const f of _J_FINGERS) {
    const meta = P(`${f}-finger-metacarpal`);
    const prox = P(`${f}-finger-phalanx-proximal`);
    const inter = P(`${f}-finger-phalanx-intermediate`);
    const dist = P(`${f}-finger-phalanx-distal`);
    if (!meta || !prox || !inter || !dist) continue;
    const m = _sub(prox, meta);       // metacarpal segment
    const a = _sub(inter, prox);      // proximal phalanx
    const b = _sub(dist, inter);      // intermediate phalanx
    const mn = _norm3(m);
    // finger lateral axis: in the palm plane, perpendicular to the metacarpal
    const lat = _norm3(_cross3(dorsal, mn));
    const rej = (v, ax) => {          // remove v's component along ax
      const d = _dot3(v, ax);
      return [v[0] - ax[0] * d, v[1] - ax[1] * d, v[2] - ax[2] * d];
    };
    // FLEXION in the flexion plane (lateral component removed) and SIGNED
    // palmar-positive, so spreading the fingers cannot read as curling
    const af = rej(a, lat), bf = rej(b, lat);
    const fsign = (u, v) => (_dot3(_cross3(u, v), lat) >= 0 ? 1 : -1);
    const mcp = Math.max(-15, Math.min(110, _angleDeg(m, af) * fsign(mn, af)));
    const pip = Math.max(-15, Math.min(130, _angleDeg(af, bf) * fsign(af, bf)));
    // ABDUCTION: signed angle between metacarpal and proximal phalanx in the
    // palm plane; lateral sign = AB_SIGN (empirically set, see block comment)
    const pmv = rej(m, dorsal), pav = rej(a, dorsal);
    const pm = _norm3(pmv), pa = _norm3(pav);
    let ab = AB_SIGN * _angleDeg(pm, pa) * Math.sign(_dot3(_cross3(pm, pa), dorsal) || 0);
    // conditioning: fade abduction with the proximal segment's in-plane
    // fraction; a flexed finger's palm-plane projection is direction noise
    const aLen = Math.hypot(a[0], a[1], a[2]) || 1;
    const inPlane = Math.hypot(pav[0], pav[1], pav[2]) / aLen;
    ab *= Math.max(0, Math.min(1, (inPlane - 0.25) / 0.35));
    // clamp 30 deg matches the bridge accept range
    ab = Math.max(-30, Math.min(30, ab));
    out[f] = [Math.round(ab * 10) / 10, Math.round(mcp * 10) / 10, Math.round(pip * 10) / 10];
    got++;
  }
  // THUMB (2026-07-20): the WebXR thumb has NO "-finger-" infix and NO
  // intermediate phalanx - its chain is wrist -> thumb-metacarpal ->
  // thumb-phalanx-proximal -> thumb-phalanx-distal -> thumb-tip. The old
  // four-finger name template could never match it, so the thumb was simply
  // absent from every take. Captured as [palmar abduction, MCP flexion,
  // IP flexion] deg: abduction = signed elevation of the metacarpal out of
  // the palm plane toward the palmar side (0 = in-plane, + = away from the
  // palm); the flexions are inter-segment angles exactly like the fingers.
  // OPTIONAL: a missed thumb never invalidates the four-finger packet.
  const tMeta = P("thumb-metacarpal");
  const tProx = P("thumb-phalanx-proximal");
  const tDist = P("thumb-phalanx-distal");
  const tTip = P("thumb-tip");
  if (tMeta && tProx && tDist && tTip) {
    const tm = _sub(tProx, tMeta);        // metacarpal segment
    const ta = _sub(tDist, tProx);        // proximal phalanx
    const tb = _sub(tTip, tDist);         // distal phalanx
    const mcpT = Math.min(90, _angleDeg(tm, ta));
    const ipT = Math.min(100, _angleDeg(ta, tb));
    const tn = _norm3(tm);
    let abT = Math.asin(Math.max(-1, Math.min(1, -_dot3(tn, dorsal)))) * R2D;
    abT = Math.max(-40, Math.min(80, abT));
    out.thumb = [Math.round(abT * 10) / 10, Math.round(mcpT * 10) / 10,
                 Math.round(ipT * 10) / 10];
  }
  return got === 4 ? out : null;   // all four fingers or nothing (partial hands mislead)
}

function wristPose(xrFrame, refSpace, session) {
  // RIGHT HAND ONLY - the rig is worn on the right hand. There is deliberately
  // NO fallback to the left: streaming the wrong hand would anchor the fusion
  // and the take trajectory to the free hand. When the right hand is occluded
  // we send nothing and the bridge's IMU model carries the pose.
  let src = null;
  for (const s of session.inputSources) {
    if (s.hand && s.handedness === "right") { src = s; break; }
  }
  if (!src) return null;
  const joint = src.hand.get("wrist");
  if (!joint) return null;
  const jp = xrFrame.getJointPose ? xrFrame.getJointPose(joint, refSpace) : null;
  if (!jp) return null;
  const p = jp.transform.position, o = jp.transform.orientation;
  const pose = { pos: [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)],
                 quat: [+o.w.toFixed(4), +o.x.toFixed(4), +o.y.toFixed(4), +o.z.toFixed(4)] };
  const joints = handJointsDeg(xrFrame, refSpace, src);
  if (joints) pose.joints = joints;
  return pose;
}

/** Call once per XR frame from the render loop. Drives the chunked scan when
 *  one is active, and the wrist pose stream while recording. */
export function updateEnvCapture(xrFrame, refSpace, session, tele, latest) {
  if (!xrFrame || !refSpace || !session) return;
  _ensureAckHook(tele);

  // ---- active scan: accumulate in chunks, auto-finish on plateau/budget -----
  if (_scan.phase === "scanning") {
    _harvestDepth(xrFrame, refSpace, session);   // the point cloud (primary)
    _enqueueMeshes(xrFrame, refSpace);           // structural backbone
    if (_scan.meshes === 0) _enqueuePlanes(xrFrame, refSpace);   // coarse fallback
    harvestSceneObjects(xrFrame, refSpace, _objects);   // the labelled inventory
    // drop the room's anchor once, on the first scanning frame. Fire-and-forget:
    // createAnchor is async and must never be awaited inside the frame loop.
    if (!_anchorPending && _anchor.state === "idle") {
      _anchorPending = true;
      _anchor.create(xrFrame, refSpace, session).finally(() => { _anchorPending = false; });
    }
    _drainChunk();
    const now = _now();
    const ptsGrew = _scan.pts >= _scan.lastPtsMark + 25;   // real growth, not noise
    if (_scan.tris !== _scan.lastTris || ptsGrew) {
      _scan.lastTris = _scan.tris;
      if (ptsGrew) _scan.lastPtsMark = _scan.pts;
      _scan.lastGrowthT = now;
    }
    const any = _scan.tris > 0 || _scan.pts > 0;
    const plateaued = any && _scan.queue.length === 0 &&
                      (now - _scan.lastGrowthT) > PLATEAU_MS;
    const full = _scan.tris >= ENV_TRI_BUDGET || _scan.pts >= MAX_POINTS;
    const timedOut = (now - _scan.startedT) > SCAN_MAX_MS;
    // nothing has arrived and nothing WILL (zero depth frames, zero meshes,
    // zero planes after 9 s): resolve to "empty" NOW instead of stranding the
    // console for the full 25 s. The owner's 2026-07-20 diag log showed
    // exactly this hang: depth throwing every frame + no Space Setup mesh.
    const hopeless = !any && _scan.depthFrames === 0 &&
                     _scan.meshes === 0 && _scan.planes === 0 &&
                     (now - _scan.startedT) > NOTHING_MAX_MS;
    if (full || plateaued || timedOut || hopeless) {
      if (any) _sendEnv(tele);
      else { _scan.reason = _emptyReason(); _scan.phase = "empty"; }
    }
  } else if (_scan.phase === "uploading" && (_now() - _scan.uploadT) > UPLOAD_TIMEOUT_MS) {
    // the mesh was sent but no ack came back: treat as done if we ever had an
    // env id, else surface the stall honestly
    _scan.phase = _envId ? "done" : "error";
    if (_scan.phase === "error") _scan.err = "no env_saved ack";
  }

  if (!latest) return;
  const rec = !!(latest.session && latest.session.recording);

  // safety net: if a recording starts and the room was never scanned this
  // session, kick a BACKGROUND scan (chunked, non-blocking) so the take still
  // gets a room. This replaces the old synchronous grab that caused the stall.
  if (rec && !_wasRecording && _scan.phase === "idle" && !_envId) {
    beginScan();
  }
  _wasRecording = rec;

  // ---- wrist + finger stream while recording --------------------------------
  if (rec) {
    const now = _now();
    if (now - _lastPoseTx >= POSE_PERIOD_MS) {
      const wp = wristPose(xrFrame, refSpace, session);
      if (wp) {
        _lastPoseTx = now;
        const msg = { cmd: "pose", pos: wp.pos, quat: wp.quat, hand: "right" };
        if (wp.joints) msg.joints = wp.joints;
        if (_envId) msg.env = _envId;
        tele.send(msg);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Desktop-only scan simulation: the browser preview is not an XR session, so
// there are no detectedMeshes and no depth stream. This lets the capture
// console's scan flow be driven and verified without a headset. NEVER used
// while presenting; the resulting env is a labelled sim fixture.
// ---------------------------------------------------------------------------
// The desktop sim's room furniture. Source is "sim", NEVER "xr-mesh": these
// boxes were typed by a human, not reported by a headset, and every downstream
// count carries that word so a sim run cannot be quoted as a measurement.
const SIM_OBJECTS = [
  { id: "sim_floor", label: "floor", pos: [0, 0, -0.8], size: [4.0, 0.02, 4.0] },
  { id: "sim_wall", label: "wall", pos: [0, 1.3, -2.6], size: [4.0, 2.6, 0.05] },
  { id: "sim_table", label: "table", pos: [0, 0.74, -0.65], size: [1.20, 0.04, 0.70] },
  { id: "sim_chair", label: "chair", pos: [0.95, 0.45, -0.30], size: [0.45, 0.90, 0.45] },
];

function _simObjects() {
  for (const s of SIM_OBJECTS) {
    _objects.add({
      id: s.id, label: s.label, source: "sim", bounded: true, confidence: 1.0,
      pos: s.pos.slice(), quat: [1, 0, 0, 0], size: s.size.slice(),
    });
  }
}

export function simScanTick(dt, tele) {
  if (_scan.phase !== "scanning") return;
  _scan.simFed = true;               // label the upload honestly (sim-desktop)
  _simObjects();                     // exercise the semantic + contact path
  _scan.tris = Math.min(ENV_TRI_BUDGET, _scan.tris + Math.floor(dt * 32000));
  _scan.meshes = Math.max(_scan.meshes, Math.min(6, 1 + Math.floor(_scan.tris / 16000)));
  // a growing synthetic cloud so the live mote rendering + points transport
  // are exercisable off-headset (drives _cloudAdd exactly like real depth)
  const grow = Math.min(600, Math.floor(dt * 9000));
  for (let i = 0; i < grow && _scan.pts < 4000; i++) {
    const a = (_scan.pts * 0.61803 + i * 0.1) % (Math.PI * 2);
    const r = 0.8 + ((_scan.pts * 7 + i) % 100) / 100 * 1.4;
    _cloudAdd(Math.cos(a) * r, 0.02 + ((_scan.pts + i) % 40) * 0.045, Math.sin(a) * r - 0.8);
  }
  // fill coverage sectors over the sweep so the desktop HUD exercises the
  // rotate/move guidance exactly like a real head sweep would
  const secs = (_now() - _scan.startedT) / 1000;
  const fill = Math.min(12, Math.floor(secs / 0.25));
  for (let i = 0; i < fill; i++) _scan.sectors |= (1 << i);
  _depthReason = `sim · ${_scan.pts} pts (desktop, no headset)`;
  const now = _now();
  if (_scan.tris !== _scan.lastTris) { _scan.lastTris = _scan.tris; _scan.lastGrowthT = now; }
  if (_scan.tris >= ENV_TRI_BUDGET * 0.6 || (now - _scan.startedT) > 3200) {
    // synthesize a tiny valid mesh so the real env_save path is exercised
    _scan.positions = [0,0,0, 1,0,0, 1,0,1, 0,0,1];
    _scan.indices = [0,1,2, 0,2,3];
    _scan.tris = 2;
    _sendEnv(tele);
  }
}

export { ENV_TRI_BUDGET, VERTS_PER_FRAME, MAX_POINTS, VOX_M, DEPTH_SAMPLES_PER_FRAME,
         DEPTH_MIN_M, DEPTH_MAX_M, DEPTH_GRID_COLS, DEPTH_GRID_ROWS, SIM_OBJECTS };
