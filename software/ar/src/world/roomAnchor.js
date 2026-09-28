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

/** Rotation part of a column-major rigid 4x4 as a quaternion [w,x,y,z]. */
export function quatFromMatrix(m) {
  const m00 = m[0], m01 = m[4], m02 = m[8];
  const m10 = m[1], m11 = m[5], m12 = m[9];
  const m20 = m[2], m21 = m[6], m22 = m[10];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const n = Math.hypot(w, x, y, z) || 1;
  return [w / n, x / n, y / n, z / n];
}

/** Apply a column-major 4x4 to one point [x,y,z]; returns a new array. */
export function applyToPoint(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14]];
}

export const IDENTITY4 = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);   // treat as read-only

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

/** The newest stored record that is bound to an env id (the only kind worth
 *  restoring: an anchor whose upload never got an id relocates nothing). */
export function latestEnvAnchor() { return _store().find((a) => a.envId) || null; }

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
    // idle | creating | live | restoring | localizing | restored | unsupported | error
    this.state = "idle";
    this.reason = "";          // honest, human-readable, shown on the diag HUD
    this.envId = null;         // the env a restored anchor belongs to
    this.pending = false;      // an async create/restore is in flight
    this._locT0 = 0;           // when localization started (ms)
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
    this.pending = true;
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
    } finally { this.pending = false; }
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
   * Restore a previously persisted anchor. ASYNC and FRAME-FREE on purpose:
   * an XRFrame is only valid inside its own rAF callback, so the old code's
   * `xrFrame.getPose` after `await restorePersistentAnchor` always threw
   * (reported as "private browsing"). The pose is read later, inside a real
   * frame, by tick(). Resolves true when the anchor object came back (state
   * "localizing"), false with `reason` set otherwise.
   */
  async restore(handle, session, nowMs = 0) {
    const rec = _store().find((a) => a.handle === handle) || null;
    if (!rec) { this.state = "error"; this.reason = "no stored anchor for that handle"; return false; }
    if (!RoomAnchor.supported(session)) {
      this.state = "unsupported";
      this.reason = "anchors feature not granted by the session";
      return false;
    }
    this.state = "restoring";
    this.pending = true;
    try {
      const anchor = await session.restorePersistentAnchor(handle);
      this.anchor = anchor;
      this.handle = handle;
      this.envId = rec.envId || null;
      this.matrixAtSave = Float64Array.from(rec.matrix);
      this.state = "localizing";
      this.reason = "restored; waiting for the headset to localize it";
      this._locT0 = nowMs;
      return true;
    } catch (e) {
      this.state = "error";
      // several causes land here; name the exception, list the usual ones
      this.reason = "restorePersistentAnchor failed (" + ((e && e.name) || e) +
                    "): the anchor was deleted, site data cleared, or private browsing";
      return false;
    } finally { this.pending = false; }
  }

  /**
   * Per XR frame (inside the frame callback). While localizing/restored, read
   * the anchor's pose NOW and keep the relocation matrix current (anchors
   * refine their pose as tracking improves). Gives up after `timeoutMs`
   * without a pose: the room was not recognised.
   */
  tick(xrFrame, refSpace, nowMs, timeoutMs = 15000) {
    if (this.state !== "localizing" && this.state !== "restored") return;
    if (!this.anchor || !xrFrame || !xrFrame.getPose) return;
    let pose = null;
    try { pose = xrFrame.getPose(this.anchor.anchorSpace, refSpace); } catch (_) { pose = null; }
    if (pose && this.matrixAtSave) {
      this.relocated = relocationMatrix(Float64Array.from(pose.transform.matrix), this.matrixAtSave);
      if (this.state !== "restored") {
        this.state = "restored";
        this.reason = "relocated against a persisted anchor";
      }
    } else if (this.state === "localizing" && nowMs - this._locT0 > timeoutMs) {
      this.state = "error";
      this.relocated = null;
      this.reason = `anchor restored but never localized in ${Math.round(timeoutMs / 1000)} s ` +
                    "(this room was not recognised)";
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
    this.envId = null; this.pending = false; this._locT0 = 0;
  }
}

export { MAX_ANCHORS, STORE_KEY };
