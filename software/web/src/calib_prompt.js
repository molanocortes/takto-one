// calib_prompt.js - the neutral-capture prompt and flow (MOTION_PIPELINE.md s.3).
//
// Every power-up needs a neutral: until one exists the bridge runs on a
// provisional (auto) neutral and flags body.provisional / !body.calibrated.
// This component makes that impossible to miss and walks the capture:
//   prompt  -> "Calibrate" sends {cmd:"calibrate",what:"neutral"}
//   phases  <- {kind:"ack",event:"neutral",phase:"countdown"|"hold"|"done"|"abort",t}
//   optional wrist-axis step: {cmd:"calibrate",what:"wrist_axis"}, 5 s of
//   flexion/extension (the ack shape is not in the contract; a local clock
//   runs the step and any {event:"wrist_axis"} ack refines it).
// Used on the Operator stage (variant "stage", an overlay) and on the IMU
// bench (variant "card"). An old bridge without a body block never shows it.

import { el, toast } from "./ui.js";
import { store } from "./store.js";

const INSTR = "Forearm forward, palm down, wrist straight, fingers extended. Hold still.";
const ABORT_WHY = {
  moving: "the arm kept moving (no still 2 s window)",
  imu: "a main IMU dropped out",
};

function handGlyph() {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 48 48");
  s.setAttribute("aria-hidden", "true");
  // forearm + flat hand, side view: the pose the capture wants
  s.innerHTML = '<path d="M4 29h17l4-3h9c1.2 0 1.2 1.8 0 1.8H28l14 .2c1.3 0 1.3 2 0 2l-13 .2h12c1.3 0 1.3 2 0 2H28h9c1.2 0 1.2 1.8 0 1.8h-11l-5-1.6H4z" fill="currentColor" opacity=".9"/><path d="M6 40h36" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".35"/>';
  return s;
}

function ago(s) {
  if (s == null || !Number.isFinite(s)) return "";
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}

export function buildCalibPrompt(cleanups, { variant = "stage" } = {}) {
  let phase = null;          // null | sent | countdown | hold | done | abort
  let phaseT = null;         // seconds left, from the ack
  let phaseAt = 0;           // performance.now() of the last phase change
  let abortWhy = "";
  let wrist = null;          // null | collect | done | unconfirmed
  let wristLeft = 0;
  let wristTimer = null;
  let wristWhy = "";         // the bridge's reason when the axis could not be solved
  let lastBody = null;       // latest raw body block
  let expanded = false;      // calibrated users can reopen the full prompt

  const title = el("div", { class: "cp-title" }, "Calibrate the arm");
  const instr = el("div", { class: "cp-instr" }, INSTR);
  const status = el("div", { class: "cp-status mono" }, "");
  const btnCal = el("button", { class: "btn primary sm cp-go", type: "button" }, "Calibrate");
  const btnWrist = el("button", { class: "btn ghost sm cp-wrist", type: "button",
    title: "Optional: 5 s of wrist flexion/extension measures the hand sensor's true flexion axis (persisted)" },
    "Wrist axis");
  const btnClose = el("button", { class: "cp-close", type: "button", title: "Hide", "aria-label": "Hide" }, "✕");
  const count = el("div", { class: "cp-count num" }, "");
  const phaseText = el("div", { class: "cp-phase-text" }, "");
  const bar = el("div", { class: "cp-bar" }, el("div", { class: "cp-bar-fill" }));
  const phaseBox = el("div", { class: "cp-phase" }, count, el("div", { class: "cp-phase-main" }, phaseText, bar));
  const actions = el("div", { class: "cp-actions" }, btnCal, btnWrist);
  const card = el("div", { class: "cp-card" },
    el("div", { class: "cp-icon" }, handGlyph()),
    el("div", { class: "cp-body" }, title, instr, status, phaseBox, actions),
    variant === "stage" ? btnClose : null);
  // the calibrated resting state on the stage: a quiet chip, one click away
  const chipText = el("span", null, "Calibrated");
  const chip = el("button", { class: "cp-chip", type: "button", title: "Run a new neutral capture" },
    el("span", { class: "dot ok" }), chipText);
  const node = el("div", { class: `calib-prompt cp-v-${variant}` }, card, chip);

  const send = (cmd, what) => {
    if (!store.send(cmd)) {
      toast("Link down: calibration not sent.", { tone: "warn" });
      return false;
    }
    return true;
  };

  btnCal.addEventListener("click", () => {
    if (!send({ cmd: "calibrate", what: "neutral" })) return;
    setPhase("sent", null);
  });
  btnWrist.addEventListener("click", () => {
    if (!send({ cmd: "calibrate", what: "wrist_axis" })) return;
    wrist = "collect";
    wristWhy = "";
    wristLeft = 5;
    clearInterval(wristTimer);
    const t0 = performance.now();
    wristTimer = setInterval(() => {
      wristLeft = Math.max(0, 5 - (performance.now() - t0) / 1000);
      if (wristLeft <= 0 && wrist === "collect") {
        // no confirmation yet: give the bridge a moment, then say so plainly
        setTimeout(() => { if (wrist === "collect") { wrist = "unconfirmed"; paint(); } }, 2500);
        clearInterval(wristTimer);
      }
      paint();
    }, 100);
    paint();
  });
  btnClose.addEventListener("click", () => { expanded = false; node.classList.add("dismissed"); paint(); });
  chip.addEventListener("click", () => { expanded = true; node.classList.remove("dismissed"); paint(); });
  cleanups.push(() => clearInterval(wristTimer));

  function setPhase(p, t, why = "") {
    phase = p; phaseT = t; phaseAt = performance.now(); abortWhy = why;
    if (p === "done" || p === "abort") {
      setTimeout(() => {
        if (performance.now() - phaseAt >= 2400 && (phase === "done" || phase === "abort")) {
          if (phase === "done") expanded = false;
          phase = null; paint();
        }
      }, 2600);
    }
    paint();
  }

  cleanups.push(store.onAck((a) => {
    if (a.event === "neutral") {
      const ph = a.phase;
      if (ph === "countdown" || ph === "hold") setPhase(ph, Number.isFinite(a.t) ? a.t : null);
      else if (ph === "done") { setPhase("done", 0); toast("Neutral captured", { tone: "ok" }); }
      else if (ph === "abort") setPhase("abort", null, a.why || a.reason || "");
    } else if (a.event === "calibrated" && phase === "sent") {
      setPhase("done", 0);            // an older bridge acknowledges with "calibrated"
    } else if (a.event === "error" && (a.cmd === "calibrate" || phase === "sent")) {
      if (phase) setPhase("abort", null, a.error || "");
      if (wrist === "collect") { wrist = "unconfirmed"; paint(); }
    } else if (a.event === "wrist_axis") {
      // tolerant of the shapes a bridge may use: phase-tagged progress, a
      // plain start acknowledgement ({ok, duration_s}) and a final result
      // ({ok:true, axis_sensor, planarity} or {ok:false, reason})
      const final = a.phase === "done" || a.phase === "fail" || a.ok === false ||
        a.axis_sensor != null || a.planarity != null || a.reason != null;
      if (a.phase === "collect" && Number.isFinite(a.t)) { wrist = "collect"; wristLeft = a.t; }
      else if (final) {
        wrist = a.ok === false || a.phase === "fail" ? "failed" : "done";
        wristWhy = a.reason || a.error || "";
        clearInterval(wristTimer);
        toast(wrist === "failed" ? "Wrist axis not solved" : "Wrist axis saved", { tone: wrist === "failed" ? "warn" : "ok" });
        setTimeout(() => { if (wrist === "done" || wrist === "failed") { wrist = null; paint(); } }, wrist === "failed" ? 7000 : 3500);
      }
      paint();
    }
  }));
  cleanups.push(store.onSnap((s) => {
    const had = !!lastBody;
    lastBody = s.body || null;
    // the device's own flag covers a capture started from the crown/button
    if (s.device && s.device.neutral_running && !phase) setPhase("sent", null);
    if (had !== !!lastBody || (performance.now() - (paint._t || 0)) > 250) paint();
  }));
  // a stuck "sent" (bridge without the neutral flow) must not hang the prompt
  const guard = setInterval(() => {
    if ((phase === "sent" && performance.now() - phaseAt > 5000) ||
        ((phase === "countdown" || phase === "hold") && performance.now() - phaseAt > 9000)) {
      setPhase("abort", null, phase === "sent" ? "no answer from the bridge" : "the capture stopped reporting");
    }
  }, 500);
  cleanups.push(() => clearInterval(guard));

  function paint() {
    paint._t = performance.now();
    const b = lastBody;
    // no body model (old bridge): nothing to prompt for
    node.hidden = !b;
    if (!b) return;
    const needs = !!b.provisional || !b.calibrated;
    const busy = phase != null;
    const q = b.quality || {};
    const stale = b.calibrated && Number.isFinite(q.since_neutral_s) && q.since_neutral_s > 900;
    const showCard = busy || wrist != null || needs || expanded || variant === "card";
    node.classList.toggle("needs", needs && !busy);
    node.classList.toggle("busy", busy);
    node.classList.toggle("collapsed", !showCard);
    if (needs) node.classList.remove("dismissed");
    title.textContent = needs
      ? (b.provisional ? "Calibrate: the twin is on a provisional neutral" : "Calibrate: no neutral for this power-up")
      : "Neutral calibration";
    status.textContent = needs ? ""
      : `calibrated ${ago(q.since_neutral_s)}` + (stale ? " · drift builds up, recalibrate when convenient" : "");
    status.style.display = status.textContent ? "" : "none";
    btnClose.style.display = needs || busy ? "none" : "";
    chipText.textContent = stale ? `Calibrated ${ago(q.since_neutral_s)} · recalibrate` : "Calibrated · recalibrate";
    chip.classList.toggle("stale", !!stale);

    // phase row
    phaseBox.style.display = busy || wrist ? "" : "none";
    actions.style.display = busy || wrist === "collect" ? "none" : "";
    btnCal.textContent = needs ? "Calibrate" : "Recalibrate";
    node.dataset.phase = phase || (wrist ? "wrist-" + wrist : "");
    const fill = bar.firstChild;
    if (busy) {
      if (phase === "sent") {
        count.textContent = "…"; phaseText.textContent = "Starting the capture on the device";
        fill.style.transform = "scaleX(0.04)";
      } else if (phase === "countdown") {
        count.textContent = phaseT != null ? String(Math.max(1, Math.round(phaseT))) : "3";
        phaseText.textContent = "Get into the pose: " + INSTR.replace(" Hold still.", "");
        fill.style.transform = `scaleX(${phaseT != null ? (3 - phaseT) / 5 : 0.1})`;
      } else if (phase === "hold") {
        count.textContent = "●"; phaseText.textContent = "Hold still";
        fill.style.transform = `scaleX(${phaseT != null ? 0.6 + (2 - phaseT) / 5 : 0.7})`;
      } else if (phase === "done") {
        count.textContent = "✓"; phaseText.textContent = "Neutral captured: the twin now matches your arm";
        fill.style.transform = "scaleX(1)";
      } else if (phase === "abort") {
        count.textContent = "!";
        phaseText.textContent = "Capture aborted" + (abortWhy ? ": " + (ABORT_WHY[abortWhy] || abortWhy) : "") + ". Try again.";
        fill.style.transform = "scaleX(0)";
        actions.style.display = "";
      }
    } else if (wrist) {
      if (wrist === "collect") {
        count.textContent = String(Math.max(1, Math.ceil(wristLeft)));
        phaseText.textContent = "Wave the wrist up and down (flex / extend), forearm still";
        fill.style.transform = `scaleX(${(5 - wristLeft) / 5})`;
      } else if (wrist === "done") {
        count.textContent = "✓"; phaseText.textContent = "Wrist axis measured and saved";
        fill.style.transform = "scaleX(1)";
      } else if (wrist === "failed") {
        count.textContent = "!"; phaseText.textContent = "Wrist axis not solved" + (wristWhy ? ": " + wristWhy : "") + ". Try again.";
        fill.style.transform = "scaleX(0)";
      } else {
        count.textContent = "?"; phaseText.textContent = "Wrist axis sent; the bridge did not confirm it";
        fill.style.transform = "scaleX(0)";
      }
    }
  }
  paint();
  return { node };
}
