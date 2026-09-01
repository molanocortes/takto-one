// roomAnchor.js - make a scanned room come back to the same place (2026-07-30).
//
// THE PROBLEM. Everything envScan captures - the depth cloud, the mesh
// backbone, the scene objects, the wrist trajectory - lives in `local-floor`,
// whose origin the headset re-establishes every session. So two takes recorded
// on two days are in two different coordinate systems and cannot be compared.
// Until today we never even requested the WebXR Anchors Module, so there was
// nothing to compare against.
//
// THE FIX, borrowed from QuestRoomScan (MIT, Arghya Sur). Its
// `RoomAnchorManager` creates one persisted OVRSpatialAnchor per scan package
// and relocates every artifact with
//     reloc = anchorNow * anchorAtSave^-1                (RoomAnchorManager.cs:138)
// This module is the same idea carried by a WebXR persistent anchor:
//   1. on scan start, drop an anchor at the current viewer position;
//   2. ask it for a persistent handle and keep {handle, matrix, envId} in
//      localStorage;
//   3. next session, restore the handle, read the anchor's pose NOW, and the
//      relocation matrix above maps the stored room into today's local-floor.
//
// RUNTIME LIMITS, quoted from Meta's WebXR documentation and enforced here:
//   - a site may hold only EIGHT persistent anchors at a time. `_prune` keeps
//     the newest MAX_ANCHORS and deletes the rest, so the 9th scan cannot
//     silently fail;
//   - anchors do not survive private browsing or clearing site data. That is
//     surfaced as a restore failure, never papered over.
//
// Units: METRES. Matrices are column-major Float64Array(16), the same layout
// WebXR uses for `pose.transform.matrix`. Quaternions elsewhere in the app are
// [w,x,y,z]; no quaternion crosses this module's boundary.

const STORE_KEY = "takto.roomAnchors.v1";
const MAX_ANCHORS = 8;             // Meta's documented per-site cap

// ---------------------------------------------------------------------------
// 4x4 helpers, column-major. Only what is needed: rigid inverse and multiply.
// ---------------------------------------------------------------------------

/** Inverse of a RIGID transform (rotation + translation, no scale). */
export function invertRigid(m) {
  const out = new Float64Array(16);
  // transpose the 3x3 rotation
  out[0] = m[0]; out[1] = m[4]; out[2] = m[8];
  out[4] = m[1]; out[5] = m[5]; out[6] = m[9];
  out[8] = m[2]; out[9] = m[6]; out[10] = m[10];
  // -R^T * t
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  out[3] = out[7] = out[11] = 0; out[15] = 1;
  return out;
}

/** a * b, both column-major. */
export function mul4(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                     a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/**
 * The relocation matrix that carries geometry saved against `anchorAtSave`
 * into the space where the same anchor now sits at `anchorNow`.
 * Port of QuestRoomScan RoomAnchorManager.ComputeRelocationMatrix.
 */
export function relocationMatrix(anchorNow, anchorAtSave) {
  return mul4(anchorNow, invertRigid(anchorAtSave));
}

/** Apply a column-major 4x4 to a flat xyz array IN PLACE. Metres in, metres out. */
export function applyToPoints(m, flatXYZ) {
  for (let i = 0; i + 2 < flatXYZ.length; i += 3) {
    const x = flatXYZ[i], y = flatXYZ[i + 1], z = flatXYZ[i + 2];
    flatXYZ[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    flatXYZ[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    flatXYZ[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return flatXYZ;
}

// ---------------------------------------------------------------------------
// persistence store: {handle, matrix[16], envId, savedMs}, newest first
// ---------------------------------------------------------------------------

function _store() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function _writeStore(list) {
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(list));
    }
  } catch (e) { /* storage full or blocked: the anchor simply will not persist */ }
}

/** Every stored anchor record, newest first. */
export function storedAnchors() { return _store(); }

/** The newest stored record, or null. */
export function latestAnchor() { return _store()[0] || null; }

/** The stored record for one env id, or null. */
export function anchorForEnv(envId) {
  return _store().find((a) => a.envId === envId) || null;
}

/** Attach an env id to a stored anchor record once the bridge has issued one. */
export function tagAnchorEnv(handle, envId) {
  const list = _store();
  const rec = list.find((a) => a.handle === handle);
  if (!rec) return false;
  rec.envId = envId;
  _writeStore(list);
  return true;
}

// ---------------------------------------------------------------------------
// the manager
// ---------------------------------------------------------------------------

export class RoomAnchor {
  constructor() {
    this.anchor = null;        // live XRAnchor this session
    this.handle = null;        // persistent handle string
    this.matrixAtSave = null;  // Float64Array(16), anchor pose when it was saved
    this.relocated = null;     // Float64Array(16) after a successful restore
    this.state = "idle";       // idle | creating | live | restoring | restored | unsupported | error
    this.reason = "";          // honest, human-readable, shown on the diag HUD
  }

  /** True when the running session negotiated the anchors feature. */
  static supported(session) {
    if (!session) return false;
    const ef = session.enabledFeatures || [];
    return Array.prototype.indexOf.call(ef, "anchors") >= 0 &&
           typeof session.restorePersistentAnchor === "function";
  }

  /**
   * Drop an anchor at the viewer's current position and persist it.
   * Safe to call when anchors are not granted: it records why and returns null
   * rather than throwing into the frame loop.
   */
  async create(xrFrame, refSpace, session) {
    if (!RoomAnchor.supported(session)) {
      this.state = "unsupported";
      this.reason = "anchors feature not granted by the session";
      return null;
    }
    if (typeof xrFrame.createAnchor !== "function") {
      this.state = "unsupported";
      this.reason = "frame.createAnchor missing on this runtime";
      return null;
    }
    this.state = "creating";
    try {
      const viewer = xrFrame.getViewerPose(refSpace);
      if (!viewer) { this.state = "error"; this.reason = "no viewer pose to anchor to"; return null; }
      // anchor at the viewer's position with identity orientation: the room's
      // frame should not tilt with the head
      const pose = new XRRigidTransform(viewer.transform.position, { x: 0, y: 0, z: 0, w: 1 });
      const anchor = await xrFrame.createAnchor(pose, refSpace);
      this.anchor = anchor;
      if (typeof anchor.requestPersistentHandle === "function") {
        this.handle = await anchor.requestPersistentHandle();
      } else {
        this.handle = null;
        this.reason = "anchor created but not persistable on this runtime";
      }
      this.matrixAtSave = Float64Array.from(pose.matrix);
      if (this.handle) {
        const list = _store().filter((a) => a.handle !== this.handle);
        list.unshift({
          handle: this.handle,
          matrix: Array.from(this.matrixAtSave),
          envId: null,
          savedMs: Date.now(),
        });
        await this._prune(session, list);
        this.reason = "anchor persisted";
      }
      this.state = "live";
      return this.handle;
    } catch (e) {
      this.state = "error";
      this.reason = "createAnchor failed: " + ((e && e.name) || e);
      return null;
    }
  }

  // keep the newest MAX_ANCHORS; delete the overflow from the runtime too, so
  // the documented 8-anchor cap can never silently reject a new scan
  async _prune(session, list) {
    const keep = list.slice(0, MAX_ANCHORS);
    const drop = list.slice(MAX_ANCHORS);
    for (const rec of drop) {
      try {
        if (typeof session.deletePersistentAnchor === "function") {
          await session.deletePersistentAnchor(rec.handle);
        }
      } catch (e) { /* already gone; dropping the record is still correct */ }
    }
    _writeStore(keep);
  }

  /**
   * Restore a previously persisted anchor and compute the relocation matrix
   * that maps geometry saved against it into today's reference space.
   * Returns the matrix, or null with `reason` set.
   */
  async restore(handle, xrFrame, refSpace, session) {
    const rec = _store().find((a) => a.handle === handle) || null;
    if (!rec) { this.state = "error"; this.reason = "no stored anchor for that handle"; return null; }
    if (!RoomAnchor.supported(session)) {
      this.state = "unsupported";
      this.reason = "anchors feature not granted by the session";
      return null;
    }
    this.state = "restoring";
    try {
      const anchor = await session.restorePersistentAnchor(handle);
      this.anchor = anchor;
      this.handle = handle;
      const pose = xrFrame.getPose(anchor.anchorSpace, refSpace);
      if (!pose) { this.state = "error"; this.reason = "anchor restored but not localized this frame"; return null; }
      const now = Float64Array.from(pose.transform.matrix);
      const saved = Float64Array.from(rec.matrix);
      this.matrixAtSave = saved;
      this.relocated = relocationMatrix(now, saved);
      this.state = "restored";
      this.reason = "relocated against a persisted anchor";
      return this.relocated;
    } catch (e) {
      this.state = "error";
      // the honest cause: private mode and cleared site data both land here
      this.reason = "restorePersistentAnchor failed (" + ((e && e.name) || e) +
                    "); private browsing or cleared site data both do this";
      return null;
    }
  }

  /** The anchor's pose in `refSpace` right now, or null. */
  poseNow(xrFrame, refSpace) {
    if (!this.anchor || !xrFrame || !xrFrame.getPose) return null;
    const p = xrFrame.getPose(this.anchor.anchorSpace, refSpace);
    return p ? Float64Array.from(p.transform.matrix) : null;
  }

  /** The wire form written into env_save.anchor. Null when there is no anchor. */
  serialize() {
    if (!this.handle || !this.matrixAtSave) return null;
    return {
      handle: this.handle,
      matrix: Array.from(this.matrixAtSave).map((v) => Math.round(v * 1e5) / 1e5),
      space: "local-floor",
      units: "m",
    };
  }

  reset() {
    this.anchor = null; this.handle = null;
    this.matrixAtSave = null; this.relocated = null;
    this.state = "idle"; this.reason = "";
  }
}

export { MAX_ANCHORS, STORE_KEY };
