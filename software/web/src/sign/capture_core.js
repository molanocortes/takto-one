// capture_core.js - the pure capture engine for TAKTO-SIGN.
//
// No DOM, no filesystem, no wall clock: every state transition is driven by the
// TIMESTAMP carried on the frames you feed it, and every side effect goes
// through an injected `store` (browser: IndexedDB; Node: fs; test: memory). That
// is what makes "survives refresh / disconnect without data loss" a property we
// can actually test: a sealed rep is persisted the instant it seals, so losing
// the tab or the socket never costs more than the rep in flight.
//
// The website view (Fable/web/app/src/views/sign.js) and the headless harness
// (capture_node.mjs) both drive THIS module; the sim signer and the live bridge
// are just two frame sources feeding the same onFrame(). No em dashes.

import {
  SCHEMA_VERSION, DEVICE_COLS, CAMERA_COLS, N_DEVICE, N_CAMERA,
  deviceRowFromSnap, cameraRow,
} from "./schema.js";

// ---- base64 of a Float32Array, working in both browser and Node -------------
export function f32ToB64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

// ---- an in-memory store (the reference implementation + test double) ---------
export function memoryStore() {
  const meta = new Map();
  const reps = new Map(); // sessionId -> Map(index -> repRecord)
  return {
    async putMeta(id, m) { meta.set(id, JSON.parse(JSON.stringify(m))); },
    async getMeta(id) { return meta.get(id) || null; },
    async putRep(id, rep) {
      if (!reps.has(id)) reps.set(id, new Map());
      reps.get(id).set(rep.index, JSON.parse(JSON.stringify(rep)));
    },
    async getReps(id) {
      const m = reps.get(id);
      return m ? [...m.values()].sort((a, b) => a.index - b.index) : [];
    },
    async listSessions() { return [...meta.keys()]; },
    async clearSession(id) { meta.delete(id); reps.delete(id); },
  };
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// rep lifecycle: idle -> countdown -> recording -> (seal) -> gap|countdown|done
export const STATE = { IDLE: "idle", COUNTDOWN: "countdown", RECORDING: "recording", GAP: "gap", DONE: "done" };

export class SignCapture {
  /**
   * @param {object} o
   *   sessionId, signerId (anon), handedness ("left"|"right"), source ("sim"|"bench"),
   *   deviceFw, rateHz, createdMs, plan (see corpus/session_plan.json shape),
   *   store (persistence adapter), corpusVersion, hasCamera (bool),
   *   consent ({released, template_version}), maxRetake (default 2)
   */
  constructor(o) {
    this.sessionId = o.sessionId;
    this.signerId = o.signerId || "anon";
    this.handedness = o.handedness || "right";
    this.source = o.source || "bench";
    this.deviceFw = o.deviceFw ?? null;
    this.rateHz = o.rateHz || 60;
    this.createdMs = o.createdMs ?? 0;
    this.plan = o.plan || { plan_id: "adhoc", countdown_s: 3, record_s: 2.2, rest_every_s: 420, rest_s: 20, blocks: [] };
    this.store = o.store || memoryStore();
    this.corpusVersion = o.corpusVersion ?? null;
    this.hasCamera = !!o.hasCamera;
    this.consent = o.consent || { released: false, template_version: null };
    this.maxRetake = o.maxRetake ?? 2;

    this.countdownMs = (this.plan.countdown_s ?? 3) * 1000;
    this.recordMs = (this.plan.record_s ?? 2.2) * 1000;
    this.gapMs = (this.plan.gap_s ?? 0.7) * 1000;
    this.restEveryMs = (this.plan.rest_every_s ?? 420) * 1000;
    this.restMs = (this.plan.rest_s ?? 20) * 1000;

    this.state = STATE.IDLE;
    this.running = false;
    this._tPhase = null;         // ms of the current phase start (frame time)
    this._lastT = null;
    this._rep = null;            // buffer for the in-progress rep
    this.sealed = [];            // sealed rep meta (frames live in the store)
    this._retakes = {};          // prompt_id -> count of re-queues used
    this._sinceRest = 0;         // ms of recording since the last rest
    this._cbs = new Set();
    this._pending = [];          // in-flight persistence promises (drained by serialize)

    this.queue = this._buildQueue();   // [{prompt_id, gloss, block, take}]
    this._qi = 0;
    this._neutral = null;              // filled from a neutral-pose block, if the plan has one
  }

  // ---- events -------------------------------------------------------------
  onEvent(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
  _emit(ev) { for (const cb of this._cbs) { try { cb(ev); } catch (e) { /* isolate */ } } }

  // ---- the prompt queue ---------------------------------------------------
  _buildQueue() {
    const q = [];
    // a malformed plan (blocks/items not arrays) must not throw during
    // construction; treat anything non-array as empty
    const blocks = Array.isArray(this.plan && this.plan.blocks) ? this.plan.blocks : [];
    for (const blk of blocks) {
      if (!blk || typeof blk !== "object") continue;
      // per-block timing overrides (sentences want a longer record window than
      // isolated signs); fall back to the plan / constructor defaults
      const cd = ((blk.countdown_s ?? this.plan.countdown_s ?? this.countdownMs / 1000)) * 1000;
      const rec = ((blk.record_s ?? this.plan.record_s ?? this.recordMs / 1000)) * 1000;
      const gap = ((blk.gap_s ?? this.plan.gap_s ?? this.gapMs / 1000)) * 1000;
      const items = Array.isArray(blk.items) ? blk.items : [];
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const reps = Number.isFinite(it.reps) ? it.reps : (Number.isFinite(blk.reps) ? blk.reps : 10);
        for (let k = 0; k < reps; k++) {
          q.push({ prompt_id: it.prompt_id, gloss: it.gloss, block: blk.block,
                   kind: blk.kind || it.kind || "sign", take: k + 1,
                   countdown_ms: cd, record_ms: rec, gap_ms: gap });
        }
      }
    }
    return q;
  }
  _timing() {
    const p = this.currentPrompt();
    return {
      countdownMs: (p && p.countdown_ms) || this.countdownMs,
      recordMs: (p && p.record_ms) || this.recordMs,
      gapMs: (p && p.gap_ms) || this.gapMs,
    };
  }
  // timing of a BLOCK, read off any queue item belonging to it. A re-queued rep
  // (retake / recovered loss) must record for its own block's window: a
  // 'sentences' retake at the plan default would cut a 4 s sentence in half
  // while keeping the full multi-gloss label, and QC could not see it because
  // dur_ok is measured against the same wrong number.
  _blockTiming(block) {
    const q = this.queue.find((it) => it && it.block === block);
    return {
      countdown_ms: (q && q.countdown_ms) || this.countdownMs,
      record_ms: (q && q.record_ms) || this.recordMs,
      gap_ms: (q && q.gap_ms) || this.gapMs,
    };
  }
  currentPrompt() { return this._qi < this.queue.length ? this.queue[this._qi] : null; }
  progress() { return { done: this._qi, total: this.queue.length, sealed: this.sealed.length, flagged: this.sealed.filter((r) => r.flagged).length }; }

  // ---- control ------------------------------------------------------------
  start() {
    if (this.currentPrompt()) { this.running = true; this._enterCountdown(this._lastT ?? 0); }
    else { this.state = STATE.DONE; this._emit({ type: "session_done" }); }
    return this;
  }
  pause() { this.running = false; if (this.state === STATE.COUNTDOWN || this.state === STATE.GAP) { this.state = STATE.IDLE; this._emit({ type: "state", state: this.state, prompt: this.currentPrompt() }); } }
  resume(t) { if (!this.currentPrompt()) return; this.running = true; if (this.state === STATE.IDLE) this._enterCountdown(t ?? this._lastT ?? 0); }
  /** End the session before the queue is finished (signer tired, an issue, etc).
   *  Every rep sealed so far is already persisted, so serialize() saves exactly
   *  what was captured; the in-flight incomplete rep is discarded. Idempotent. */
  stop() {
    this.running = false;
    this._rep = null;               // drop the partial rep in progress, if any
    this.state = STATE.DONE;
    this.endedEarly = this._qi < this.queue.length;
    this._emit({ type: "stopped", ended_early: this.endedEarly, progress: this.progress() });
    return this;
  }

  _enterCountdown(t) {
    this.state = STATE.COUNTDOWN; this._tPhase = t;
    this._emit({ type: "state", state: this.state, prompt: this.currentPrompt() });
  }
  _enterRecording(t) {
    this.state = STATE.RECORDING; this._tPhase = t;
    const p = this.currentPrompt();
    this._rep = { prompt_id: p.prompt_id, gloss: p.gloss, block: p.block, kind: p.kind,
                  take: p.take, t_start_ms: t, record_ms: this._timing().recordMs,
                  dev: [], cam: this.hasCamera ? [] : null, live: [] };
    this._emit({ type: "state", state: this.state, prompt: p });
  }
  _enterGap(t, ms) { this.state = STATE.GAP; this._tPhase = t; this._gapMs = ms; this._emit({ type: "state", state: this.state, prompt: this.currentPrompt() }); }

  // ---- the frame pump: every transition is timestamp-driven ---------------
  onFrame(snap, cam) {
    const t = (snap && Number.isFinite(snap.t_ms)) ? snap.t_ms : (this._lastT == null ? 0 : this._lastT + Math.round(1000 / this.rateHz));
    this._lastT = t;
    const { row, thumbLive, encLive } = deviceRowFromSnap(snap || {});

    if (this.state === STATE.COUNTDOWN) {
      const left = this._timing().countdownMs - (t - this._tPhase);
      this._emit({ type: "countdown", n: Math.max(0, Math.ceil(left / 1000)), prompt: this.currentPrompt() });
      if (left <= 0) this._enterRecording(t);
    } else if (this.state === STATE.RECORDING) {
      this._rep.dev.push(row);
      if (this.hasCamera) this._rep.cam.push(cameraRow(cam));
      this._rep.live.push({ enc: encLive, thumb: thumbLive ? 1 : 0 });
      if (t - this._tPhase >= this._rep.record_ms) { this._sealRep(t); }
    } else if (this.state === STATE.GAP) {
      if (t - this._tPhase >= (this._gapMs ?? this.gapMs)) {
        if (this.running && this.currentPrompt()) this._enterCountdown(t);
        else if (!this.currentPrompt()) { this.state = STATE.DONE; this._emit({ type: "session_done" }); }
        else this.state = STATE.IDLE;
      }
    }
    return this.state;
  }

  // ---- sealing + QC -------------------------------------------------------
  // SYNCHRONOUS by design: all state (this._rep, sealed[], _qi, state) advances
  // in one call so the frame pump can never see a half-sealed rep. Persistence
  // is fired as a tracked promise; the fs/memory stores write synchronously up
  // to their first await, so a sealed rep is on disk before the next frame even
  // though the promise resolves later (serialize() drains _pending).
  _sealRep(t) {
    const rep = this._rep; this._rep = null;
    const n = rep.dev.length;
    // next index = one past the highest sealed index (not the count), so a gap
    // from a skipped corrupt rep file on rehydrate can never cause an overwrite
    const index = this.sealed.length ? Math.max(...this.sealed.map((r) => r.index)) + 1 : 0;
    const rep_id = `${this.sessionId}_r${String(index).padStart(4, "0")}`;

    // per-channel dropout = fraction of frames that are NaN in that device col
    const dropout = {};
    let deadCols = 0, dropSum = 0;
    for (let c = 0; c < N_DEVICE; c++) {
      let nan = 0;
      for (let i = 0; i < n; i++) if (!Number.isFinite(rep.dev[i][c])) nan++;
      const d = n ? nan / n : 1;
      dropout[DEVICE_COLS[c]] = +d.toFixed(4);
      dropSum += d;
      if (d > 0.5) deadCols++;
    }
    const meanEnc = n ? rep.live.reduce((a, l) => a + l.enc, 0) / n : 0;
    const durMs = t - rep.t_start_ms;
    const recMs = rep.record_ms || this.recordMs;
    const durOk = durMs >= 0.5 * recMs && durMs <= 1.6 * recMs;
    const liveOk = meanEnc >= 8;           // >=8/12 encoders live on average
    const dropOverall = +(dropSum / N_DEVICE).toFixed(4);
    const qc = { n_frames: n, dur_ms: Math.round(durMs), dur_ok: durOk,
                 mean_enc_live: +meanEnc.toFixed(2), live_ok: liveOk,
                 dropout_overall: dropOverall, dead_cols: deadCols, dropout,
                 ok: durOk && liveOk && dropOverall < 0.5 };

    // pack frames as flat float32 for compact, lossless persistence
    const devFlat = new Float32Array(n * N_DEVICE);
    for (let i = 0; i < n; i++) devFlat.set(rep.dev[i], i * N_DEVICE);
    let camB64 = null;
    if (this.hasCamera) {
      const camFlat = new Float32Array(n * N_CAMERA);
      for (let i = 0; i < n; i++) camFlat.set(rep.cam[i], i * N_CAMERA);
      camB64 = f32ToB64(camFlat);
    }
    const record = {
      index, rep_id, prompt_id: rep.prompt_id, gloss: rep.gloss, block: rep.block,
      kind: rep.kind, take: rep.take, flagged: false,
      t_start_ms: rep.t_start_ms, t_end_ms: t, n_frames: n, qc,
      dev_b64: f32ToB64(devFlat), cam_b64: camB64,
    };
    const sealedRep = { index, rep_id, prompt_id: rep.prompt_id, gloss: rep.gloss,
                        block: rep.block, kind: rep.kind, take: rep.take, flagged: false,
                        t_start_ms: rep.t_start_ms, t_end_ms: t, n_frames: n, qc };
    this.sealed.push(sealedRep);

    // a neutral-pose block seeds per-signer calibration (mean angles at rest)
    if (rep.kind === "neutral" && n) this._captureNeutral(rep.dev);

    this._sinceRest += durMs;
    this._qi++;
    // persist the sealed rep + updated meta (fire-and-track; stores write the
    // rep synchronously before the promise settles). Advance state regardless.
    this._persist(record);
    // emit the object we just pushed (NOT this.sealed[index]: after a gapped
    // rehydrate the array position and the .index field diverge, so indexing by
    // `index` would emit undefined)
    this._emit({ type: "rep_sealed", rep: sealedRep, progress: this.progress() });

    // schedule the next phase
    if (!this.running) { this.state = STATE.IDLE; return; }
    if (!this.currentPrompt()) { this.state = STATE.DONE; this._emit({ type: "session_done" }); return; }
    if (this._sinceRest >= this.restEveryMs) { this._sinceRest = 0; this._emit({ type: "rest" }); this._enterGap(t, this.restMs); }
    else this._enterGap(t, this._timing().gapMs);
  }

  _persist(record) {
    const p = (async () => {
      await this.store.putRep(this.sessionId, record);
      await this.store.putMeta(this.sessionId, this._meta());
    })().catch((e) => { this._emit({ type: "persist_error", error: String(e) }); });
    this._pending.push(p);
    return p;
  }

  _captureNeutral(devRows) {
    const n = devRows.length, means = new Array(N_DEVICE).fill(0), cnt = new Array(N_DEVICE).fill(0);
    for (const r of devRows) for (let c = 0; c < N_DEVICE; c++) if (Number.isFinite(r[c])) { means[c] += r[c]; cnt[c]++; }
    const out = {};
    for (let c = 0; c < N_DEVICE; c++) out[DEVICE_COLS[c]] = cnt[c] ? +(means[c] / cnt[c]).toFixed(3) : null;
    this._neutral = out;
  }

  // ---- flag + re-queue ----------------------------------------------------
  flagLastRep() {
    if (!this.sealed.length) return false;
    const rep = this.sealed[this.sealed.length - 1];
    if (rep.flagged) return false;
    rep.flagged = true;
    // re-queue this exact prompt at the END of its block (capped)
    const used = this._retakes[rep.prompt_id] || 0;
    if (used < this.maxRetake) {
      this._retakes[rep.prompt_id] = used + 1;
      const insertAt = this._lastIndexOfBlock(rep.block) + 1;
      const tb = this._blockTiming(rep.block);
      this.queue.splice(insertAt, 0, { prompt_id: rep.prompt_id, gloss: rep.gloss,
        block: rep.block, kind: rep.kind, take: rep.take + 100 /* retake marker */,
        countdown_ms: tb.countdown_ms, record_ms: tb.record_ms, gap_ms: tb.gap_ms });
    }
    // the flag rides in session meta (sealed[]), which rehydrate reads and
    // serialize() syncs onto the stored frames; no need to rewrite the frames.
    this._pending.push(Promise.resolve(this.store.putMeta(this.sessionId, this._meta())));
    this._emit({ type: "rep_flagged", rep, progress: this.progress() });
    return true;
  }
  _lastIndexOfBlock(block) {
    let last = this._qi - 1;
    for (let i = this._qi; i < this.queue.length; i++) if (this.queue[i].block === block) last = i;
    return Math.max(last, this._qi - 1);
  }

  // ---- persistence of session meta (so a refresh can rehydrate) -----------
  _meta() {
    return {
      schema_version: SCHEMA_VERSION, session_id: this.sessionId, signer_id: this.signerId,
      handedness: this.handedness, source: this.source, sim: this.source === "sim",
      device_fw: this.deviceFw,
      sample_rate_hz: this.rateHz, created_ms: this.createdMs, plan_id: this.plan.plan_id,
      // the full plan rides in meta so a browser refresh can rehydrate without
      // re-fetching (and without risking a DIFFERENT plan silently resuming an
      // old session with a mismatched queue)
      plan: this.plan,
      corpus_version: this.corpusVersion, has_camera: this.hasCamera,
      columns: { device: DEVICE_COLS, camera: this.hasCamera ? CAMERA_COLS : null },
      consent: this.consent, neutral: this._neutral,
      queue_index: this._qi, queue_len: this.queue.length,
      sealed: this.sealed, retakes: this._retakes,
    };
  }

  // ---- rehydrate an interrupted session from the store --------------------
  // Reconciles meta with the rep FILES on disk: the rep files are the source of
  // truth for how many reps are sealed, so a corrupt or missing meta.json can
  // never reset the index to 0 and overwrite already-sealed reps (a data-loss
  // path found in adversarial review).
  static async rehydrate(o) {
    const cap = new SignCapture(o);
    const onDisk = await cap.store.getReps(o.sessionId);   // corrupt files already skipped
    const fromDisk = onDisk.map((r) => ({ index: r.index, rep_id: r.rep_id, prompt_id: r.prompt_id,
      gloss: r.gloss, block: r.block, kind: r.kind, take: r.take, flagged: !!r.flagged,
      t_start_ms: r.t_start_ms, t_end_ms: r.t_end_ms, n_frames: r.n_frames, qc: r.qc }));
    let meta = null;
    try { meta = await cap.store.getMeta(o.sessionId); } catch (_) { meta = null; }  // corrupt -> fall back

    // sealed is ALWAYS the actual valid rep files on disk (ground truth). meta
    // can OVER-CLAIM if a rep file corrupted after it was written, so we never
    // trust its count. This unifies corrupt-meta and corrupt-rep resume.
    cap.sealed = fromDisk;
    cap._neutral = (meta && meta.neutral) || null;
    cap._retakes = (meta && meta.retakes) || {};
    // resume PAST the highest sealed index so no already-sealed prompt is
    // re-recorded and no rep file is overwritten (safe under index gaps too)
    cap._qi = fromDisk.length ? Math.max(...fromDisk.map((r) => r.index)) + 1 : 0;
    // re-queue any prompt that meta recorded as sealed but whose rep file is now
    // gone/corrupt, so a lost rep is RE-CAPTURED rather than silently dropped
    if (meta && Array.isArray(meta.sealed)) {
      const have = new Set(fromDisk.map((r) => r.index));
      let lost = 0, requeued = 0;
      for (const s of meta.sealed) {
        if (have.has(s.index)) continue;
        lost++;
        // A loss at or past the resumed pointer needs NO re-queue: cap._qi is one
        // past the highest index still on disk, so it lands on that prompt's own
        // queue slot and the ordinary resume re-records it. Splicing a retake as
        // well captured the same prompt TWICE (5 reps for a 4-prompt plan). Only
        // losses BEHIND the pointer would otherwise be skipped.
        if (s.index >= cap._qi) continue;
        requeued++;
        const insertAt = cap._lastIndexOfBlock(s.block) + 1;
        // timing from the LOST rep's own block, not from queue[0] (whose block
        // may specify a completely different record window)
        const tb = cap._blockTiming(s.block);
        cap.queue.splice(insertAt, 0, { prompt_id: s.prompt_id, gloss: s.gloss, block: s.block,
          kind: s.kind, take: (s.take || 1) + 100,
          countdown_ms: tb.countdown_ms, record_ms: tb.record_ms, gap_ms: tb.gap_ms });
      }
      if (lost) cap._emit({ type: "data_gap", lost, recovered: fromDisk.length, requeued,
        resumed: lost - requeued });
    }
    // replay flagged-rep re-queues that were pending before the interruption
    for (const [pid, count] of Object.entries(cap._retakes)) {
      for (let k = 0; k < count; k++) {
        const src = cap.queue.find((q) => q.prompt_id === pid);
        if (src) {
          const insertAt = cap._lastIndexOfBlock(src.block) + 1;
          cap.queue.splice(insertAt, 0, { ...src, take: src.take + 100 });
        }
      }
    }
    cap.state = STATE.IDLE; cap.running = false;
    return cap;
  }

  // ---- final bundle for the sink ------------------------------------------
  async serialize() {
    await Promise.all(this._pending);       // let every in-flight seal land first
    const rawReps = await this.store.getReps(this.sessionId);
    // Validate every rep record before decoding: a value-corrupt but JSON-valid
    // rep (bit-rot in n_frames, a truncated dev_b64) must be quarantined, never
    // crash serialize or inflate the matrix with garbage (adversarial review).
    // n_frames is derived from the ACTUAL decoded byte length, not trusted.
    const reps = [];
    for (const r of rawReps) {
      if (typeof r.dev_b64 !== "string") { this._emit({ type: "quarantine", rep_id: r.rep_id, reason: "dev_b64 not a string" }); continue; }
      let bytes;
      try { bytes = b64ToU8(r.dev_b64); } catch (_) { this._emit({ type: "quarantine", rep_id: r.rep_id, reason: "dev_b64 undecodable" }); continue; }
      if (bytes.byteLength % (N_DEVICE * 4) !== 0) { this._emit({ type: "quarantine", rep_id: r.rep_id, reason: "dev_b64 length not a frame multiple" }); continue; }
      const nActual = bytes.byteLength / (N_DEVICE * 4);
      if (!Number.isFinite(r.n_frames) || r.n_frames !== nActual) {
        this._emit({ type: "quarantine", rep_id: r.rep_id, reason: `n_frames ${r.n_frames} != actual ${nActual}` });
        continue;
      }
      if (this.hasCamera && r.cam_b64) {
        let cb; try { cb = b64ToU8(r.cam_b64); } catch (_) { r.cam_b64 = null; cb = null; }
        if (cb && cb.byteLength !== nActual * N_CAMERA * 4) r.cam_b64 = null;
      }
      r._bytes = bytes;
      reps.push(r);
    }
    // sync flags from live sealed meta onto stored records
    const flagByIdx = Object.fromEntries(this.sealed.map((r) => [r.index, r.flagged]));
    for (const r of reps) if (flagByIdx[r.index] !== undefined) r.flagged = flagByIdx[r.index];

    // concat all rep device matrices into one frames.f32, remember row ranges
    let totalRows = 0;
    for (const r of reps) totalRows += r.n_frames;
    const dev = new Float32Array(totalRows * N_DEVICE);
    // camera rows default to NaN, not 0: a rep whose camera block is missing or
    // was nulled as corrupt must read "absent" (NaN, schema.js liveness
    // contract), never as a wrist parked at the origin (0,0,0)
    const cam = this.hasCamera ? new Float32Array(totalRows * N_CAMERA).fill(NaN) : null;
    const repMeta = [];
    let off = 0;
    for (const r of reps) {
      const bytes = r._bytes;
      const f = new Float32Array(bytes.buffer, bytes.byteOffset, r.n_frames * N_DEVICE);
      dev.set(f, off * N_DEVICE);
      if (cam && r.cam_b64) {
        const cb = b64ToU8(r.cam_b64);
        cam.set(new Float32Array(cb.buffer, cb.byteOffset, r.n_frames * N_CAMERA), off * N_CAMERA);
      }
      repMeta.push({ rep_id: r.rep_id, index: r.index, prompt_id: r.prompt_id, gloss: r.gloss,
        block: r.block, kind: r.kind, take: r.take, flagged: !!r.flagged,
        t_start_ms: r.t_start_ms, t_end_ms: r.t_end_ms, n_frames: r.n_frames,
        row0: off, row1: off + r.n_frames, qc: r.qc });
      off += r.n_frames;
    }

    // session-level QC (guard reps with a missing/garbled qc block)
    const signs = new Set(reps.filter((r) => r.kind === "sign").map((r) => r.gloss));
    const okReps = reps.filter((r) => r.qc && r.qc.ok).length;
    const dropOverall = reps.length ? +(reps.reduce((a, r) => a + ((r.qc && r.qc.dropout_overall) || 0), 0) / reps.length).toFixed(4) : 0;
    const deadChannels = this._deadChannels(reps);
    const qc = {
      score: reps.length ? +(okReps / reps.length).toFixed(3) : 0,
      reps: reps.length, ok_reps: okReps, flagged: reps.filter((r) => r.flagged).length,
      signs: signs.size, dropout_overall: dropOverall, dead_channels: deadChannels,
    };

    return {
      schema_version: SCHEMA_VERSION, session_id: this.sessionId, signer_id: this.signerId,
      handedness: this.handedness, source: this.source, sim: this.source === "sim",
      device_fw: this.deviceFw,
      sample_rate_hz: this.rateHz, created_ms: this.createdMs, plan_id: this.plan.plan_id,
      corpus_version: this.corpusVersion, has_camera: this.hasCamera,
      columns: { device: DEVICE_COLS, camera: this.hasCamera ? CAMERA_COLS : null },
      consent: this.consent, neutral: this._neutral,
      blocks: (this.plan.blocks || []).map((b) => ({ block: b.block, kind: b.kind || "sign", items: (b.items || []).length })),
      // honesty: record whether the session ran to completion or was stopped
      // early (tired signer / an issue). A partial session is still valid data.
      ended_early: this._qi < this.queue.length,
      prompts: { done: this._qi, total: this.queue.length },
      counts: { reps: reps.length, signs: signs.size, flagged: qc.flagged, frames: totalRows },
      qc, reps: repMeta,
      shape: { device: [totalRows, N_DEVICE], camera: this.hasCamera ? [totalRows, N_CAMERA] : null },
      frames_b64: f32ToB64(dev),
      camera_b64: cam ? f32ToB64(cam) : null,
    };
  }

  _deadChannels(reps) {
    // a device column dead across the WHOLE session (fully NaN in every rep)
    const dead = [];
    for (const col of DEVICE_COLS) {
      const everLive = reps.some((r) => r.qc && r.qc.dropout && r.qc.dropout[col] < 1);
      if (!everLive) dead.push(col);
    }
    return dead;
  }
}

// b64 -> Uint8Array (browser + Node)
export function b64ToU8(b64) {
  if (typeof Buffer !== "undefined") { const b = Buffer.from(b64, "base64"); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
