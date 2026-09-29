// status.js - what the in-headset status HUD and the first-run guide SAY.
// Pure (no three.js, no DOM): the view layer (ui/hud.js) only draws these
// strings, and utils/test_pose_fallback.mjs checks them. Every word here is
// derived from the live stream; nothing is invented (an unknown reads "-").

const TONE = { ok: "ok", warn: "warn", bad: "bad", dim: "dim", rec: "rec" };

export function fmtClock(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function healthDetail(snap, stream) {
  const h = snap && Array.isArray(snap.health) ? snap.health.find((x) => x && x.stream === stream) : null;
  return h ? String(h.detail || "") : null;
}

/**
 * The status rows.
 *   transport : tele.describe()  {kind, connected, simulated, url}
 *   snap      : the effective snapshot (pose lane merged)
 *   lane      : PoseLane.stats()  (or null)
 *   snapHz    : snapshot rate
 *   fps       : measured render rate (or null)
 *   stageNote : a transient line (recenter feedback) or ""
 * Returns { link:{word,tone,detail}, rec:{on,text}|null, sensors:[{word,tone}],
 *           neutral:{word,tone}, rate:string, note:string }.
 */
export function statusView({ transport = {}, snap = null, lane = null, snapHz = 0, fps = null,
                             stageNote = "", nowMs = 0 } = {}) {
  // ---- link ----------------------------------------------------------------
  let link;
  const dev = !!(snap && snap.link && snap.link.device);
  const bridgeSim = healthDetail(snap, "link") === "sim" || (snap && snap.source === "sim");
  const fresh = snap && Number.isFinite(snap._ageMs) ? snap._ageMs < 1500 : !!snap;
  if (transport.simulated) link = { word: "SIMULATED", tone: TONE.warn, detail: "in-page mock, nothing is saved" };
  else if (transport.kind === "ws" && !transport.connected) link = { word: "OFFLINE", tone: TONE.bad, detail: "bridge " + (transport.url || "") };
  else if (!fresh) link = { word: "STALLED", tone: TONE.bad, detail: "bridge silent" };
  else if (!dev) link = { word: "NO DEVICE", tone: TONE.bad, detail: "bridge up, device not streaming" };
  else if (bridgeSim) link = { word: "BRIDGE SIM", tone: TONE.warn, detail: "bridge --sim, not the glove" };
  else link = { word: "LIVE", tone: TONE.ok, detail: "device" };

  // ---- recording -----------------------------------------------------------
  let rec = null;
  const ses = snap && snap.session;
  const devb = snap && snap.device;
  if (ses && ses.recording) rec = { on: true, text: "REC " + fmtClock((ses.elapsed_ms || 0) / 1000) };
  else if (devb && devb.sd_recording) rec = { on: true, text: `SD REC take ${devb.sd_take || "?"}` };

  // ---- sensors -------------------------------------------------------------
  const sensors = [];
  let imuTxt = null, imuOk = null;
  const hImu = healthDetail(snap, "imu");
  const m = hImu && /main\s+(\d)\/2/.exec(hImu);
  if (m) { imuTxt = `IMU ${m[1]}/2`; imuOk = m[1] === "2"; }
  else if (snap && snap.body && typeof snap.body.live === "boolean") {
    imuTxt = `IMU ${snap.body.live ? 2 : 0}/2`; imuOk = snap.body.live;
  }
  sensors.push(imuTxt ? { word: imuTxt, tone: imuOk ? TONE.ok : TONE.bad } : { word: "IMU -", tone: TONE.dim });
  let encN = null, encOf = 12;
  if (snap && Array.isArray(snap.joints) && snap.joints.length) {
    const flex = snap.joints.filter((j) => /^(index|middle|ring|pinky)_(mcp|pip|dip)$/.test(j.id));
    encN = flex.filter((j) => j.ok).length; encOf = flex.length || 12;
  } else {
    const hEnc = healthDetail(snap, "encoders");
    const me = hEnc && /(\d+)\/(\d+)/.exec(hEnc);
    if (me) { encN = +me[1]; encOf = +me[2]; }
  }
  sensors.push(encN === null ? { word: "ENC -", tone: TONE.dim }
    : { word: `ENC ${encN}/${encOf}`, tone: encN === encOf ? TONE.ok : encN > 0 ? TONE.warn : TONE.bad });

  // ---- neutral calibration -------------------------------------------------
  let neutral;
  const b = snap && snap.body;
  if (!b) neutral = { word: "neutral -", tone: TONE.dim };
  else if (b.calibrated && !b.provisional) {
    const age = b.quality && b.quality.since_neutral_s;
    neutral = age > 1800 ? { word: "neutral old", tone: TONE.warn } : { word: "neutral ✓", tone: TONE.ok };
  } else if (b.provisional) neutral = { word: "neutral provisional", tone: TONE.warn };
  else neutral = { word: "no neutral", tone: TONE.bad };

  // ---- rates + latency -----------------------------------------------------
  let rate;
  if (lane && lane.active) {
    rate = `pose ${lane.rateHz} Hz`;
    if (lane.totalMs !== null) rate += ` · ${Math.round(lane.totalMs)} ms`;
    else if (lane.bridgeMs !== null) rate += ` · bridge ${Math.round(lane.bridgeMs)} ms (clocks differ)`;
  } else if (snap && !transport.simulated && transport.kind === "ws" && transport.connected) {
    rate = `snap ${snapHz} Hz (no pose lane)`;
  } else rate = `snap ${snapHz} Hz`;
  // the bridge's own pose-lane leg (link.latency_ms {median,p95} over 5 s,
  // section 8): only worth printing when our lane is not already measuring it
  const ll = snap && snap.link && snap.link.latency_ms;
  const llMed = typeof ll === "number" ? ll : ll && Number.isFinite(ll.median) ? ll.median : null;
  if (!(lane && lane.active) && llMed !== null) rate += ` · bridge ${Math.round(llMed)} ms`;
  if (fps) rate += ` · ${fps} fps`;
  void nowMs;
  return { link, rec, sensors, neutral, rate, note: stageNote || "" };
}

/** One stable string per view, so the HUD redraws its texture only on change. */
export function statusKey(v) {
  return [v.link.word, v.link.detail, v.rec ? v.rec.text : "", v.sensors.map((s) => s.word + s.tone).join(","),
          v.neutral.word, v.rate, v.note].join("|");
}

// ---------------------------------------------------------------------------
// FIRST-RUN GUIDE: connect -> calibrate -> twin -> record -> replay.
// Steps complete from the live state (never from a click on "next"), so the
// guide can never claim a step that did not happen; a step already satisfied
// (calibrated before entering) is simply ticked.
// ---------------------------------------------------------------------------
export const GUIDE_STEPS = ["connect", "calibrate", "twin", "record", "replay"];
const TITLES = { connect: "Connect", calibrate: "Calibrate neutral", twin: "Try the twin",
                 record: "Record a take", replay: "Replay it" };

export class Guide {
  constructor() { this.reset(); }
  reset() {
    this.done = {}; this.twinS = 0; this.allDoneS = 0; this.hidden = false;
    this._recSeen = false;
  }
  /**
   * s: { transport, snap, neutral:{phase,t,ageS,err}, mode, deviceDriven,
   *      recordedTake, replayLoaded }
   * Returns the card: null (nothing to say) or
   *   { index, total, id, title, text, detail, countdown, tone, allDone }
   */
  update(dt, s) {
    const tr = s.transport || {}, snap = s.snap || null;
    const linked = !!(snap && snap.link && snap.link.device);
    const b = snap && snap.body;
    const nph = s.neutral || {};
    // ---- completion (sticky: a step once done stays done this session) ----
    if (tr.simulated || (tr.kind === "ws" && tr.connected && linked)) this.done.connect = true;
    const noBodyModel = linked && !b && !(snap && snap.device && snap.device.fw >= 16);
    if ((b && b.calibrated && !b.provisional) || nph.phase === "done" || noBodyModel) this.done.calibrate = true;
    if (s.mode === "twin" && (s.deviceDriven || tr.simulated)) this.twinS += dt;
    if (this.twinS >= 5) this.done.twin = true;
    if (s.recordedTake) this.done.record = true;
    if (s.replayLoaded) this.done.replay = true;

    // ---- the calibration countdown always wins the card while it runs -----
    if (nph.phase === "countdown" || nph.phase === "hold" || nph.phase === "sent") {
      const idx = GUIDE_STEPS.indexOf("calibrate");
      return {
        index: idx + 1, total: GUIDE_STEPS.length, id: "calibrate", title: TITLES.calibrate,
        text: nph.phase === "hold" ? "Hold still…" : nph.phase === "sent" ? "Starting…" : "Forearm level, palm down, fingers straight",
        detail: nph.phase === "hold" ? "the device is averaging your neutral pose" : "the device beeps once per second",
        countdown: nph.phase === "countdown" ? Math.max(1, Math.round(nph.t || 0)) : null,
        tone: "warn", allDone: false,
      };
    }
    if (nph.phase === "abort" && nph.ageS < 6) {
      return { index: 2, total: GUIDE_STEPS.length, id: "calibrate", title: "Calibration aborted",
               text: "You moved during the hold - rest the arm and try again", detail: "press CALIBRATE", countdown: null,
               tone: "bad", allDone: false };
    }
    if (nph.phase === "error" && nph.ageS < 6) {
      return { index: 2, total: GUIDE_STEPS.length, id: "calibrate", title: "Calibrate failed",
               text: String(nph.err || "the bridge refused the command"), detail: "", countdown: null,
               tone: "bad", allDone: false };
    }
    if (nph.phase === "done" && nph.ageS < 3) {
      return { index: 2, total: GUIDE_STEPS.length, id: "calibrate", title: "Calibrated ✓",
               text: "Neutral stored for this power-up", detail: "", countdown: null, tone: "ok", allDone: false };
    }
    if (this.hidden) return null;

    const cur = GUIDE_STEPS.find((k) => !this.done[k]);
    if (!cur) {
      this.allDoneS += dt;
      if (this.allDoneS > 5) return null;
      return { index: GUIDE_STEPS.length, total: GUIDE_STEPS.length, id: "done", title: "All set ✓",
               text: "Connected, calibrated, twin, take, replay", detail: "G hides this guide",
               countdown: null, tone: "ok", allDone: true };
    }
    const card = { index: GUIDE_STEPS.indexOf(cur) + 1, total: GUIDE_STEPS.length, id: cur,
                   title: TITLES[cur], text: "", detail: "", countdown: null, tone: "dim", allDone: false };
    switch (cur) {
      case "connect":
        if (tr.kind === "ws" && !tr.connected) {
          card.text = "Waiting for the bridge"; card.detail = tr.url || ""; card.tone = "bad";
        } else if (!linked) {
          card.text = "Bridge up, the device is not streaming"; card.detail = "check the USB cable / power"; card.tone = "bad";
        } else card.text = "Linking…";
        break;
      case "calibrate":
        card.text = b && b.provisional ? "Provisional neutral: press CALIBRATE"
          : "Press CALIBRATE, then hold the pose";
        card.detail = "forearm level · palm down · fingers straight · 3-2-1 + 2 s hold";
        card.tone = "warn";
        break;
      case "twin":
        card.text = s.mode === "twin" ? `Move fingers and wrist… ${Math.max(0, Math.ceil(5 - this.twinS))} s`
          : "Press TWIN: the hand of light follows the glove";
        card.detail = "fingers from the encoders, wrist from the two IMUs";
        break;
      case "record":
        card.text = "Press RECORD, do the task, press STOP";
        card.detail = "3-2-1 countdown · the take is stored on the bridge";
        break;
      case "replay":
        card.text = "Press REPLAY: the take plays back at real scale";
        card.detail = "the ribbon colour shows vision / body-model frames";
        break;
      default: break;
    }
    return card;
  }
}

export function guideKey(c) {
  return c ? [c.index, c.title, c.text, c.detail, c.countdown, c.tone].join("|") : "";
}
