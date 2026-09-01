// contact.js - where the hand met the room (2026-07-30).
//
// This is the join the whole room-scan exercise exists for. The registry in
// sceneObjects.js says "there is a TABLE here, 1.2 x 0.7 x 0.75 m, at this
// pose". The hand rig (world/handLink.js -> `HandLight.tips`) says where each
// fingertip is, in the SAME local-floor metres. Crossing the two turns a
// trajectory into a rehab observation: "the index finger touched the table
// 14 times this session".
//
// Detection is deliberately boring: signed distance from the fingertip to the
// object's oriented box, with hysteresis so a fingertip resting on an edge does
// not machine-gun events. No physics, no collision engine.
//
//   enter  when signed distance <= ENTER_M
//   exit   when it rises above  EXIT_M   (EXIT_M > ENTER_M: Schmitt trigger)
//   an event is only SEALED once the contact has lasted MIN_DWELL_MS
//
// HONESTY. Every event carries `src`, the provenance of the hand pose that
// produced it, passed in by the caller and never guessed here:
//   "device"     - the physical rig's encoders posed the hand
//   "quest-hand" - the headset's optical hand tracking
//   "mock"       - the desktop mock stream (SIM, never a measurement)
// A contact count is only as real as its `src`. Mixed-source sessions keep the
// per-source split so nothing can be quoted as bench data by accident.
//
// TWO CLOCKS, BOTH RECORDED. `t_ms` is the HEADSET clock (performance.now(),
// milliseconds since page load) - the only clock this code can read. The take
// rows on the host are stamped with the TEENSY's own millis. Those clocks have
// no known offset, so an event also carries `dev_ms`: the `snap.t_ms` of the
// most recent telemetry snapshot when the contact opened. Aligning on `dev_ms`
// puts a contact on the same timeline as the joint columns, with a residual
// error bounded by one snapshot period plus one network hop. See
// ROOM-FUSION.md section "Time". Never align on t_ms across the two.

const ENTER_M = 0.020;        // 2 cm: fingertip mesh radius plus box slop
const EXIT_M = 0.045;         // 4.5 cm release threshold
const MIN_DWELL_MS = 80;      // shorter than this is tracking noise, not a touch
const MAX_EVENTS = 512;       // ring cap: a session cannot grow without bound
const TIPS = ["index", "middle", "ring", "pinky"];

import { distanceToObject } from "./sceneObjects.js";

export class ContactTracker {
  constructor() {
    /** open contacts, keyed `${tip}|${objId}` */
    this._open = new Map();
    /** sealed events, oldest first, capped at MAX_EVENTS */
    this.events = [];
    /** per-object totals: objId -> {label, n, ms, byTip:{}} */
    this.byObject = new Map();
    this.dropped = 0;          // events lost to the cap (reported, never hidden)
    this.gen = 0;              // bumps on every sealed event
  }

  reset() {
    this._open.clear();
    this.events = [];
    this.byObject.clear();
    this.dropped = 0;
    this.gen++;
  }

  /** True while any fingertip is inside an object. */
  get active() { return this._open.size > 0; }

  /** Currently touching, as [{tip,label,objId,dist}] - for live UI. */
  live() {
    const out = [];
    for (const c of this._open.values()) {
      out.push({ tip: c.tip, label: c.label, objId: c.objId, dist: +c.dist.toFixed(4) });
    }
    return out;
  }

  /**
   * One step. `tips` is {index,middle,ring,pinky} of anything with x/y/z in
   * local-floor metres (three.js Vector3 satisfies this). `registry` is a
   * SceneObjectRegistry. `nowMs` is the HEADSET clock, `devMs` the device clock
   * (snap.t_ms) or null, `src` the pose provenance.
   * Returns the events SEALED by this call (usually none).
   */
  update(tips, registry, nowMs, src, devMs) {
    const sealed = [];
    if (!tips || !registry || registry.count === 0) {
      // no room, no contacts: close anything still open so a scan reset cannot
      // strand an open contact forever
      if (this._open.size) this._closeAll(nowMs, sealed);
      return sealed;
    }
    const objs = registry.all();
    const seen = new Set();

    for (const tip of TIPS) {
      const p = tips[tip];
      if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) continue;
      // nearest object only: a fingertip touches one thing at a time
      let best = null, bestD = Infinity;
      for (const o of objs) {
        const d = distanceToObject(o, p.x, p.y, p.z);
        if (d < bestD) { bestD = d; best = o; }
      }
      if (!best) continue;
      const key = `${tip}|${best.id}`;
      const open = this._open.get(key);

      if (open) {
        open.dist = bestD;
        open.minDist = Math.min(open.minDist, bestD);
        if (bestD > EXIT_M) {
          // do NOT advance lastMs here: this frame is the RELEASE. Duration is
          // open-to-last-frame-still-touching, so a release never inflates it.
          this._seal(key, nowMs, sealed);
        } else {
          open.lastMs = nowMs;
          seen.add(key);
        }
      } else if (bestD <= ENTER_M) {
        this._open.set(key, {
          tip, objId: best.id, label: best.label, src,
          startMs: nowMs, lastMs: nowMs,
          startDevMs: (devMs === undefined || devMs === null) ? null : devMs,
          dist: bestD, minDist: bestD,
        });
        seen.add(key);
      }
    }

    // a contact whose object vanished from the registry (rescan) or whose tip
    // stopped reporting: close it on the frame it went stale
    for (const key of Array.from(this._open.keys())) {
      if (!seen.has(key)) this._seal(key, nowMs, sealed);
    }
    return sealed;
  }

  _closeAll(nowMs, sealed) {
    for (const key of Array.from(this._open.keys())) this._seal(key, nowMs, sealed);
  }

  _seal(key, nowMs, sealed) {
    const c = this._open.get(key);
    this._open.delete(key);
    if (!c) return;
    const dur = Math.max(0, c.lastMs - c.startMs);
    if (dur < MIN_DWELL_MS) return;          // noise, not a touch
    const ev = {
      t_ms: Math.round(c.startMs),          // HEADSET clock (performance.now)
      dev_ms: c.startDevMs === null ? null : Math.round(c.startDevMs),  // Teensy clock
      dur_ms: Math.round(dur),
      tip: c.tip,
      obj: c.objId,
      label: c.label,
      min_dist_m: +c.minDist.toFixed(4),
      src: c.src,
    };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) { this.events.shift(); this.dropped++; }

    let agg = this.byObject.get(c.objId);
    if (!agg) { agg = { label: c.label, n: 0, ms: 0, byTip: {} }; this.byObject.set(c.objId, agg); }
    agg.n++; agg.ms += Math.round(dur);
    agg.byTip[c.tip] = (agg.byTip[c.tip] || 0) + 1;

    this.gen++;
    sealed.push(ev);
  }

  /** Per-object interaction counts, sorted busiest first. The session report. */
  summary() {
    const rows = [];
    for (const [objId, a] of this.byObject) {
      rows.push({ obj: objId, label: a.label, n: a.n, ms: a.ms, byTip: Object.assign({}, a.byTip) });
    }
    rows.sort((x, y) => y.n - x.n);
    return rows;
  }

  /** Per-label roll-up, the human-readable line: {table: 14, chair: 2}. */
  labelCounts() {
    const m = {};
    for (const a of this.byObject.values()) m[a.label] = (m[a.label] || 0) + a.n;
    return m;
  }

  /** Provenance split, so a mixed session can never be quoted as one source. */
  sourceCounts() {
    const m = {};
    for (const e of this.events) m[e.src] = (m[e.src] || 0) + 1;
    return m;
  }
}

export { ENTER_M, EXIT_M, MIN_DWELL_MS, MAX_EVENTS, TIPS };
