// tendon.js - the tendon calibration surface: centre, range, proven power-up,
// then guarded position control of the spool.
//
// The spools now carry real tendons, so "enable torque" is a step that can break
// hardware. NONE of that judgement lives here: this view only names a step and
// renders what came back. Every limit, every abort and the zero-motion power-up
// proof live in tools/tendon.py on the bridge, so a stale browser tab, a double
// click or a lost socket cannot talk the device into moving further than the
// captured range allows.
//
// The sequence is deliberately linear and each button unlocks only when the
// previous step has actually produced data:
//   centre  -> torque OFF, record where the operator set the spool by hand
//   range   -> torque OFF, operator sweeps the finger, min/max on joint + motor
//   hold    -> torque ON at exactly zero current, drift proven under the limit
//   move    -> slewed setpoint inside the safe band, aborted on excess lag

import { el, clamp } from "../ui.js";
import { store } from "../store.js";

function styleOnce() {
  if (document.getElementById("tdn-style")) return;
  const s = el("style", { id: "tdn-style" });
  s.textContent = `
  .tdn { max-width:900px; margin:0 auto; padding:26px 22px 60px; }
  .tdn-head { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:4px; }
  .tdn-back { text-decoration:none; color:var(--text-2); font-size:13px; letter-spacing:.04em;
    padding:4px 10px; border:1px solid var(--line,#DFDAD0); border-radius:999px; }
  .tdn-kicker { font:600 11px/1 ui-monospace,monospace; letter-spacing:.14em;
    text-transform:uppercase; color:#C9401B; }
  .tdn-title { font:600 26px/1.15 var(--font,system-ui); color:var(--ink,#23201A); margin:0; }
  .tdn-sub { font:400 13px/1.5 var(--font,system-ui); color:var(--sub,#8B8474); margin:0 0 18px; }
  .tdn-chip { font:600 10px/1 ui-monospace,monospace; letter-spacing:.08em; text-transform:uppercase;
    padding:5px 9px; border-radius:6px; background:rgba(35,30,22,.08); color:var(--sub,#8B8474);
    margin-left:auto; }
  .tdn-chip.live { background:rgba(95,138,92,.16); color:#3f6b3c; }
  .tdn-chip.warn { background:rgba(192,131,39,.16); color:#8a6216; }
  .tdn-chip.bad  { background:rgba(180,60,40,.16); color:#9c2f1c; }
  .tdn-step { border:1px solid rgba(35,30,22,.14); border-radius:14px; padding:14px 16px;
    margin-bottom:12px; background:rgba(255,255,255,.55); }
  .tdn-step.done { border-color:rgba(95,138,92,.45); }
  .tdn-step.off  { opacity:.45; }
  .tdn-srow { display:flex; align-items:center; gap:12px; }
  .tdn-num { font:600 12px ui-monospace,monospace; width:22px; height:22px; flex:0 0 22px;
    border-radius:50%; display:grid; place-items:center; background:rgba(35,30,22,.1);
    color:var(--ink,#23201A); }
  .tdn-step.done .tdn-num { background:rgba(95,138,92,.25); }
  .tdn-stitle { font:600 15px/1.2 var(--font,system-ui); color:var(--ink,#23201A); }
  .tdn-instr { font:400 13px/1.55 var(--font,system-ui); color:var(--sub,#8B8474); margin:6px 0 10px; }
  .tdn-btn { font:600 13px var(--font,system-ui); padding:8px 16px; border-radius:8px; cursor:pointer;
    border:1px solid var(--ink,#23201A); background:var(--ink,#23201A); color:#fff; }
  .tdn-btn.ghost { background:transparent; color:var(--ink,#23201A); }
  .tdn-btn.stop { border-color:#9c2f1c; background:#9c2f1c; }
  .tdn-btn[disabled] { opacity:.35; cursor:not-allowed; }
  .tdn-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .tdn-read { font:500 12px/1.6 ui-monospace,monospace; color:var(--ink,#23201A);
    background:rgba(35,30,22,.05); border-radius:8px; padding:8px 10px; margin-top:10px;
    white-space:pre-wrap; }
  .tdn-msg { font:400 13px/1.5 var(--font,system-ui); margin:10px 0 0; color:var(--sub,#8B8474); }
  .tdn-msg.err { color:#9c2f1c; font-weight:600; }
  .tdn-num-in { font:500 13px ui-monospace,monospace; width:86px; padding:7px 8px;
    border:1px solid rgba(35,30,22,.25); border-radius:8px; background:transparent;
    color:var(--ink,#23201A); }
  .tdn-none { padding:38px; text-align:center; border:1px dashed rgba(35,30,22,.25);
    border-radius:14px; color:var(--sub,#8B8474); font:400 14px/1.6 var(--font,system-ui); }
  .tdn-safety { font:400 12px/1.6 var(--font,system-ui); color:var(--sub,#8B8474);
    border-left:2px solid rgba(192,131,39,.5); padding-left:10px; margin:16px 0 0; }
  `;
  document.head.appendChild(s);
}

const n2 = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "--" : Number(v).toFixed(2);

export function mountTendon(rootHost) {
  styleOnce();
  const cleanups = [];
  const send = (action, extra) => store.send(Object.assign({ cmd: "tendon", action }, extra || {}));

  const chip = el("span", { class: "tdn-chip" }, "no device");
  const msg = el("p", { class: "tdn-msg" }, "");
  const none = el("div", { class: "tdn-none" },
    "The bridge is not reporting motors. Start teensy_bridge.py with the device connected.");

  // ---- step 1: centre
  const b1 = el("button", { class: "tdn-btn" }, "Capture centre");
  const r1 = el("div", { class: "tdn-read" }, "not captured");
  const s1 = el("div", { class: "tdn-step" },
    el("div", { class: "tdn-srow" }, el("span", { class: "tdn-num" }, "1"),
      el("span", { class: "tdn-stitle" }, "Centre")),
    el("p", { class: "tdn-instr" },
      "Takes the servo bus with torque OFF and records where you set the spool by hand. Nothing is energised."),
    el("div", { class: "tdn-actions" }, b1), r1);

  // ---- step 2: range
  const b2 = el("button", { class: "tdn-btn" }, "Start range capture");
  const b2s = el("button", { class: "tdn-btn stop" }, "Finish");
  const r2 = el("div", { class: "tdn-read" }, "no range");
  const s2 = el("div", { class: "tdn-step off" },
    el("div", { class: "tdn-srow" }, el("span", { class: "tdn-num" }, "2"),
      el("span", { class: "tdn-stitle" }, "Range")),
    el("p", { class: "tdn-instr" },
      "Torque stays OFF. Move the finger slowly through its full travel, both ends, then press Finish. The spool backdrives and both the joint encoder and the motor are recorded."),
    el("div", { class: "tdn-actions" }, b2, b2s), r2);

  // ---- step 3: hold
  const b3 = el("button", { class: "tdn-btn" }, "Prove zero-motion power-up");
  const r3 = el("div", { class: "tdn-read" }, "not proven");
  const s3 = el("div", { class: "tdn-step off" },
    el("div", { class: "tdn-srow" }, el("span", { class: "tdn-num" }, "3"),
      el("span", { class: "tdn-stitle" }, "Power-up proof")),
    el("p", { class: "tdn-instr" },
      "Enables torque while commanding exactly zero current, then watches. More than the drift limit and it torques off and refuses to continue."),
    el("div", { class: "tdn-actions" }, b3), r3);

  // ---- step 4: move
  const to = el("input", { class: "tdn-num-in", type: "number", step: "1", value: "0" });
  const b4 = el("button", { class: "tdn-btn" }, "Move to");
  const b4h = el("button", { class: "tdn-btn ghost" }, "Back to centre");
  const b4a = el("button", { class: "tdn-btn stop" }, "Abort");
  const r4 = el("div", { class: "tdn-read" }, "idle");
  const s4 = el("div", { class: "tdn-step off" },
    el("div", { class: "tdn-srow" }, el("span", { class: "tdn-num" }, "4"),
      el("span", { class: "tdn-stitle" }, "Move")),
    el("p", { class: "tdn-instr" },
      "Position control inside the safe band. The setpoint is slewed, never stepped, and the run aborts on excess lag between commanded and measured angle, which is what a binding tendon looks like."),
    el("div", { class: "tdn-actions" }, to, b4, b4h, b4a), r4);

  b1.onclick = () => send("center");
  b2.onclick = () => send("range_start");
  b2s.onclick = () => send("range_stop");
  b3.onclick = () => send("hold");
  b4.onclick = () => send("move", { to: parseFloat(to.value) });
  b4h.onclick = () => send("move", { home: true });
  b4a.onclick = () => send("abort");

  const wrap = el("div", { class: "tdn" },
    el("div", { class: "tdn-head" },
      el("a", { class: "tdn-back", href: "#/" }, "back"),
      el("span", { class: "tdn-kicker" }, "bench"), chip),
    el("h1", { class: "tdn-title" }, "Tendon calibration"),
    el("p", { class: "tdn-sub" },
      "Sequential and guarded. Torque is only enabled in steps 3 and 4, and never without proving the motor stays put first."),
    none, s1, s2, s3, s4, msg,
    el("p", { class: "tdn-safety" },
      "Underneath all of this the firmware clamps commanded current to 44 mA (about 10 N at a 5 mm spool) and the servo's own current limit sits below that. This page cannot raise either."));

  rootHost.appendChild(wrap);

  const off = store.onSnap((s) => {
    const t = s && s.tendon;
    const motors = (s && s.motors) || [];
    const live = (s && s.link && s.link.motors) || motors.length > 0;
    none.style.display = live ? "none" : "";
    [s1, s2, s3, s4].forEach((n) => { n.style.display = live ? "" : "none"; });
    if (!t) return;

    chip.textContent = t.phase + (t.busy ? " ..." : "");
    chip.className = "tdn-chip " + (t.error ? "bad" : (t.busy ? "warn" : "live"));
    msg.textContent = t.error ? t.error : (t.message || "");
    msg.className = "tdn-msg" + (t.error ? " err" : "");

    const spool = motors.find((m) => m.id === "spool_" + t.motor_id);
    const haveCenter = !!t.center, haveRange = !!t.range;
    s1.className = "tdn-step" + (haveCenter ? " done" : "");
    s2.className = "tdn-step" + (haveRange ? " done" : (haveCenter ? "" : " off"));
    s3.className = "tdn-step" + (haveRange ? "" : " off");
    s4.className = "tdn-step" + (haveRange ? "" : " off");
    b1.disabled = t.busy;
    b2.disabled = t.busy || !haveCenter;
    b2s.disabled = t.phase !== "ranging";
    b3.disabled = t.busy || !haveRange;
    b4.disabled = b4h.disabled = t.busy || !haveRange;
    b4a.disabled = !t.busy;

    r1.textContent = haveCenter
      ? Object.entries(t.center).map(([k, v]) => `motor ${k}: ${n2(v)} deg`).join("\n")
      : "not captured";

    if (t.phase === "ranging" && t.live) {
      const L = t.live;
      r2.textContent =
        `joint  ${n2(L.enc)}   [${n2(L.enc_lo)} .. ${n2(L.enc_hi)}]  span ${n2(L.enc_span)}\n` +
        `motor  ${n2(L.motor)}   [${n2(L.motor_lo)} .. ${n2(L.motor_hi)}]  span ${n2(L.motor_span)}\n` +
        `${L.seconds ? L.seconds.toFixed(1) : "0.0"} s - keep moving, then Finish`;
    } else if (haveRange) {
      const R = t.range;
      r2.textContent =
        `joint ch${R.enc_ch}: ${n2(R.enc_lo)} .. ${n2(R.enc_hi)}  span ${n2(R.enc_span)}\n` +
        `motor id${R.motor_id}: ${n2(R.motor_lo)} .. ${n2(R.motor_hi)}  span ${n2(R.motor_span)}\n` +
        `SAFE band: ${n2(R.safe_lo)} .. ${n2(R.safe_hi)}  (${n2(R.margin_deg)} deg inset)`;
    }

    if (t.phase === "holding" && t.live) {
      r3.textContent = `drift ${n2(t.live.drift)} deg (limit ${n2(t.limits.hold_drift_max)})`;
    } else if (t.phase === "ranged" && /HELD/.test(t.message || "")) {
      r3.textContent = t.message;
    }

    if (t.phase === "moving" && t.live) {
      const L = t.live;
      r4.textContent =
        `cmd ${n2(L.cmd)} -> ${n2(L.target)} deg\n` +
        `motor ${n2(L.motor)}   lag ${n2(L.lag)} (abort ${n2(t.limits.max_lag_deg)})\n` +
        `joint ${n2(L.enc)}` + (spool ? `   ${n2(spool.cur)} mA` : "");
    } else if (spool) {
      r4.textContent = `motor ${n2(spool.pos)} deg   ${n2(spool.cur)} mA   ` +
        `torque ${spool.torque_on ? "ON" : "off"}`;
    }
  });
  cleanups.push(off);

  send("status");

  return () => { cleanups.forEach((f) => f()); wrap.remove(); };
}
