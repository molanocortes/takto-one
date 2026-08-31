// sceneObjects.js - the SEMANTIC half of the room (2026-07-30).
//
// Until now envScan.js harvested the headset's scene geometry as raw vertices
// and indices and threw the labels away: `mesh.semanticLabel` and
// `plane.semanticLabel` are delivered by the Quest browser on every detected
// mesh / plane and nothing ever read them. So a take could say "a fingertip was
// at (0.31, 0.78, -0.42)" but never "the index finger touched the TABLE".
//
// This module builds the missing inventory: one labelled oriented box per
// detected object, in the SAME local-floor metres as the point cloud, the mesh
// backbone and the wrist pose stream. It is a direct port of the idea in
// QuestRoomScan (MIT, Arghya Sur) - `Runtime/Data/SceneObject.cs` +
// `Runtime/Modules/SceneObjectRegistry.cs` - onto the WebXR runtime, where the
// labels come from the browser rather than from Meta's MRUK.
//
// Record shape (JSON, the wire form in env_save.objects):
//   { id, label, source:"xr-mesh"|"xr-plane", bounded, confidence,
//     pos:[x,y,z], quat:[w,x,y,z], size:[sx,sy,sz] }
// Units: METRES. Quaternion order [w,x,y,z] to match the telemetry contract
// (HARDWARE_IO.md section 3), NOT three.js's (x,y,z,w).
//
// HONESTY: `confidence` is 1.0 for anything the headset reported and is not a
// measurement of our own - the runtime gives no confidence value. It exists so
// AI-sourced objects (which we do not do) could carry a real one without a
// schema change. Objects the runtime gives no label for are recorded with
// label "unlabelled" and are NOT invented.

const FALLBACK_LABEL = "unlabelled";

// XRMesh / XRPlane object identity is stable across frames, so a WeakMap gives
// each detected object a durable id without touching the runtime objects.
let _ids = new WeakMap();
let _nextId = 1;

function _idFor(xrObj, prefix) {
  let id = _ids.get(xrObj);
  if (id === undefined) {
    id = `${prefix}_${_nextId++}`;
    _ids.set(xrObj, id);
  }
  return id;
}

/** Drop every assigned id. Call when a session ends so a new session's objects
 *  do not inherit last session's numbering. */
export function resetSceneObjectIds() {
  _ids = new WeakMap();
  _nextId = 1;
}

/**
 * Inventory of labelled room objects. Mirrors QuestRoomScan's
 * SceneObjectRegistry API so the two stay conceptually swappable.
 */
export class SceneObjectRegistry {
  constructor() {
    this._list = [];
    this._byId = new Map();
    this.bySource = {};        // "xr-mesh" | "xr-plane" | "sim" -> count
    this.gen = 0;              // bumps on any change (render dirty flag)
  }

  get count() { return this._list.length; }
  all() { return this._list; }
  get(id) { return this._byId.get(id) || null; }

  /** Insert or replace by id. Returns true when the object was NEW. */
  add(obj) {
    if (!obj || !obj.id) return false;
    const prev = this._byId.get(obj.id);
    if (prev) {
      this._list[this._list.indexOf(prev)] = obj;
      this._byId.set(obj.id, obj);
      this.gen++;
      return false;
    }
    this._list.push(obj);
    this._byId.set(obj.id, obj);
    this.bySource[obj.source] = (this.bySource[obj.source] || 0) + 1;
    this.gen++;
    return true;
  }

  /** Case-insensitive substring match on the label, like theirs. */
  findByLabel(label) {
    if (!label) return [];
    const q = String(label).toLowerCase();
    return this._list.filter((o) => o.label.toLowerCase().indexOf(q) >= 0);
  }

  /** Distinct labels with counts, for the session report. */
  labelCounts() {
    const m = {};
    for (const o of this._list) m[o.label] = (m[o.label] || 0) + 1;
    return m;
  }

  clear() {
    this._list = [];
    this._byId = new Map();
    this.bySource = {};
    this.gen++;
  }

  /** The wire form: a plain array, rounded for transport (mm / 4-dp quats). */
  serialize() {
    return this._list.map((o) => ({
      id: o.id, label: o.label, source: o.source,
      bounded: o.bounded, confidence: o.confidence,
      pos: o.pos.map((v) => Math.round(v * 1e3) / 1e3),
      quat: o.quat.map((v) => Math.round(v * 1e4) / 1e4),
      size: o.size.map((v) => Math.round(v * 1e3) / 1e3),
    }));
  }
}

// ---------------------------------------------------------------------------
// geometry: an axis-aligned box in the object's OWN space, carried into
// local-floor by the object's pose. That is an oriented box in the room, which
// is what a "table" actually is - an AABB in room space would be wrong the
// moment the table is not axis-aligned with the play space.
// ---------------------------------------------------------------------------

function _boxFromVertices(verts) {
  if (!verts || verts.length < 3) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX) || !isFinite(maxX)) return null;
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

function _boxFromPolygon(poly) {
  if (!poly || poly.length < 3) return null;
  const flat = new Float32Array(poly.length * 3);
  for (let i = 0; i < poly.length; i++) {
    flat[i * 3] = poly[i].x; flat[i * 3 + 1] = poly[i].y; flat[i * 3 + 2] = poly[i].z;
  }
  const b = _boxFromVertices(flat);
  if (!b) return null;
  // a WebXR plane is flat in its own X-Z; give it a nominal 1 cm thickness so
  // contact tests against a wall or a desk have something to hit
  b.size[1] = Math.max(b.size[1], 0.01);
  return b;
}

// transform a point by a column-major 4x4 (the WebXR pose matrix layout)
function _xform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

// Rotation as [w,x,y,z] read out of the pose MATRIX rather than off
// `transform.orientation`. The matrix is the one field every XRPose is
// guaranteed to carry, and deriving from it keeps this working against
// minimal fixtures as well as the real runtime. Basis vectors are normalised
// first so any scale in the matrix cannot leak into the quaternion.
function _quatFromMatrix(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const tr = r00 + r11 + r22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [s / 4, (r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s];
  }
  if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    return [(r21 - r12) / s, s / 4, (r01 + r10) / s, (r02 + r20) / s];
  }
  if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    return [(r02 - r20) / s, (r01 + r10) / s, s / 4, (r12 + r21) / s];
  }
  const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
  return [(r10 - r01) / s, (r02 + r20) / s, (r12 + r21) / s, s / 4];
}

function _makeObject(id, label, source, bounded, pose, box) {
  const m = pose.transform.matrix;
  return {
    id,
    label: (label && String(label)) || FALLBACK_LABEL,
    source,
    bounded: !!bounded,
    confidence: 1.0,          // reported by the runtime, not measured by us
    pos: _xform(m, box.center),
    quat: _quatFromMatrix(m),
    size: box.size.map((v) => Math.max(v, 0.005)),
  };
}

/**
 * Harvest every labelled object the headset currently reports into `registry`.
 * Cheap and idempotent: an object already in the registry is refreshed in place
 * (its pose can drift as the headset refines the room), never duplicated.
 *
 * Returns the number of objects NEWLY added this call.
 */
export function harvestSceneObjects(xrFrame, refSpace, registry) {
  if (!xrFrame || !refSpace || !registry) return 0;
  let added = 0;

  const meshes = xrFrame.detectedMeshes;
  if (meshes && meshes.size) {
    for (const mesh of meshes) {
      // The global scene mesh (isBounded3D false / absent) is the room shell,
      // already captured as the geometry backbone by envScan. Only BOUNDED
      // meshes are objects, per Meta's WebXR scene-understanding guide.
      if (mesh.isBounded3D === false) continue;
      const pose = xrFrame.getPose(mesh.meshSpace, refSpace);
      if (!pose) continue;
      const box = _boxFromVertices(mesh.vertices);
      if (!box) continue;
      const id = _idFor(mesh, "mesh");
      if (registry.add(_makeObject(id, mesh.semanticLabel, "xr-mesh", true, pose, box))) added++;
    }
  }

  const planes = xrFrame.detectedPlanes;
  if (planes && planes.size) {
    for (const plane of planes) {
      const pose = xrFrame.getPose(plane.planeSpace, refSpace);
      if (!pose) continue;
      const box = _boxFromPolygon(plane.polygon);
      if (!box) continue;
      const id = _idFor(plane, "plane");
      if (registry.add(_makeObject(id, plane.semanticLabel, "xr-plane", false, pose, box))) added++;
    }
  }

  return added;
}

/**
 * Signed distance from a world point to an object's oriented box surface.
 * Negative inside. Used by the contact detector; exported so the spec can pin
 * the geometry without a headset.
 */
export function distanceToObject(obj, x, y, z) {
  // world -> object local: subtract the centre, rotate by the conjugate quat
  const dx = x - obj.pos[0], dy = y - obj.pos[1], dz = z - obj.pos[2];
  const [w, qx, qy, qz] = obj.quat;
  // v' = conj(q) * v * q  for a unit quaternion (rotate into the box frame)
  const tx = 2 * (-qy * dz + qz * dy);
  const ty = 2 * (-qz * dx + qx * dz);
  const tz = 2 * (-qx * dy + qy * dx);
  const lx = dx + w * tx + (-qy * tz + qz * ty);
  const ly = dy + w * ty + (-qz * tx + qx * tz);
  const lz = dz + w * tz + (-qx * ty + qy * tx);

  const hx = obj.size[0] / 2, hy = obj.size[1] / 2, hz = obj.size[2] / 2;
  const ox = Math.abs(lx) - hx, oy = Math.abs(ly) - hy, oz = Math.abs(lz) - hz;
  const outside = Math.hypot(Math.max(ox, 0), Math.max(oy, 0), Math.max(oz, 0));
  const inside = Math.min(Math.max(ox, Math.max(oy, oz)), 0);
  return outside + inside;
}

/** The nearest object to a world point, or null. `maxDist` in metres. */
export function nearestObject(registry, x, y, z, maxDist) {
  let best = null, bestD = maxDist === undefined ? Infinity : maxDist;
  for (const o of registry.all()) {
    const d = distanceToObject(o, x, y, z);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best ? { obj: best, dist: bestD } : null;
}
