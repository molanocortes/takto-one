// jog.js - manual, deliberately-crippled motor movement for a tendon-coupled spool.
//
// The one rule this surface exists to enforce: there is NO absolute target. You
// cannot type an angle, there is no slider, and nothing here can say "go to 345".
// Every control is a RELATIVE nudge from wherever the motor is right now, and the
// nudge only moves a target that the bridge walks toward at a fixed slew rate.
// A UI press never reaches the servo as a step.
//
// The bridge (tools/tendon.py) owns the safety: torque is only enabled after a
// proven zero-motion power-up, the setpoint is clamped to a band derived either
// from a captured range or from the manually-set centre, and excess
// commanded-vs-measured lag (a bound tendon) aborts and torques off.
//
// Everything shown here is measured on the device except `cmd`, which is what we
// are asking for. When they diverge, that difference IS the lag readout.

import { el, clamp } from "../ui.js";
import { store } from "../store.js";

// Fine steps matter more than big ones on a loaded tendon: 1 deg of spool
// is ~0.2 deg of joint at the current ratio, which is the resolution you
// actually want when creeping up on a mechanical end stop.
const STEPS = [-20, -10, -5, -1, 1, 5, 10, 20];

function styleOnce() {
  if (document.getElementById("jog-style")) return;
  const s = el("style", { id: "jog-style" });
  s.textContent = `
  .jg { max-width:760px; margin:0 auto; padding:26px 22px 60px; }
  .jg-head { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:4px; }
  .jg-back { text-decoration:none; color:var(--text-2,#8B8474); font-size:13px;
    padding:4px 10px; border:1px solid var(--line,#DFDAD0); border-radius:999px; }
  .jg-title { font:600 26px/1.15 var(--font,system-ui); color:var(--ink,#23201A); margin:0; }
  .jg-sub { font:400 13px/1.5 var(--font,system-ui); color:var(--sub,#8B8474); margin:0 0 18px; }
  .jg-chips { display:flex; gap:8px; margin-left:auto; flex-wrap:wrap; }
  .jg-chip { font:600 10px/1 ui-monospace,monospace; letter-spacing:.08em;
    text-transform:uppercase; padding:5px 9px; border-radius:6px;
    background:rgba(35,30,22,.08); color:var(--sub,#8B8474); }
  .jg-chip.live { background:rgba(95,138,92,.16); color:#3f6b3c; }
  .jg-chip.warn { background:rgba(192,131,39,.18); color:#8a6216; }
  .jg-chip.bad  { background:rgba(176,58,46,.16); color:#9c2f24; }
  .jg-card { border:1px solid rgba(35,30,22,.14); border-radius:14px; padding:16px 18px;
    background:rgba(255,255,255,.55); margin-bottom:16px; }
  .jg-card h3 { margin:0 0 12px; font:600 13px/1 var(--font,system-ui);
    letter-spacing:.04em; color:var(--ink,#23201A); }
  .jg-nums { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  @media (max-width:620px){ .jg-nums { grid-template-columns:repeat(2,1fr); } }
  .jg-num { text-align:center; }
  .jg-num b { display:block; font:600 24px/1.1 ui-monospace,monospace; color:var(--ink,#23201A); }
  .jg-num span { display:block; margin-top:4px; font:500 10px/1 ui-monospace,monospace;
    letter-spacing:.1em; text-transform:uppercase; color:var(--sub,#8B8474); }
  .jg-num.alert b { color:#9c2f24; }
  .jg-bar { position:relative; height:10px; border-radius:999px; margin:16px 0 6px;
    background:rgba(35,30,22,.10); overflow:hidden; }
  .jg-bar i { position:absolute; top:0; bottom:0; width:3px; background:#23201A; }
  .jg-bar u { position:absolute; top:0; bottom:0; width:3px; background:#C9401B; opacity:.75; }
  .jg-bandlab { display:flex; justify-content:space-between;
    font:500 10px/1 ui-monospace,monospace; color:var(--sub,#8B8474); }
  .jg-row { display:flex; gap:8px; flex-wrap:wrap; }
  .jg-jog { display:grid; grid-template-columns:repeat(8,1fr); gap:8px; }
  @media (max-width:620px){ .jg-jog { grid-template-columns:repeat(4,1fr); } }
  .jg-btn { font:600 13px/1 ui-monospace,monospace; padding:14px 10px; border-radius:10px;
    border:1px solid rgba(35,30,22,.22); background:rgba(255,255,255,.7);
    color:var(--ink,#23201A); cursor:pointer; }
  .jg-btn:hover:not(:disabled) { border-color:#23201A; }
  .jg-btn:disabled { opacity:.35; cursor:not-allowed; }
  .jg-link { display:inline-flex; align-items:center; text-decoration:none; }
  .jg-btn.go { background:#23201A; color:#F7F4EC; border-color:#23201A; }
  .jg-btn.stop { background:#9c2f24; color:#fff; border-color:#9c2f24; }
  .jg-msg { font:400 13px/1.5 var(--font,system-ui); color:var(--sub,#8B8474); margin:12px 0 0; }
  .jg-err { font:500 13px/1.5 var(--font,system-ui); color:#9c2f24; margin:8px 0 0; }
  .jg-note { font:400 12px/1.5 var(--font,system-ui); color:var(--sub,#8B8474);
    border-left:2px solid rgba(201,64,27,.5); padding-left:10px; margin:0 0 16px; }
  `;
  document.head.appendChild(s);
}

const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v))
  ? "--" : Number(v).toFixed(d);

export function mountJog(rootHost) {
  styleOnce();

  const chips = {
    bus: el("span", { class: "jg-chip" }, "bus"),
    torque: el("span", { class: "jg-chip" }, "torque"),
    band: el("span", { class: "jg-chip" }, "no band"),
  };

  const nums = {
    cmd: el("b", {}, "--"), pos: el("b", {}, "--"),
    lag: el("b", {}, "--"), joint: el("b", {}, "--"),
  };
  const lagCell = el("div", { class: "jg-num" }, nums.lag,
    el("span", {}, "lag °"));
  const readout = el("div", { class: "jg-nums" },
    el("div", { class: "jg-num" }, nums.cmd, el("span", {}, "commanded °")),
    el("div", { class: "jg-num" }, nums.pos, el("span", {}, "motor °")),
    lagCell,
    el("div", { class: "jg-num" }, nums.joint, el("span", {}, "joint °")));

  const markCmd = el("u", {});
  const markPos = el("i", {});
  const bar = el("div", { class: "jg-bar" }, markCmd, markPos);
  const bandLo = el("span", {}, "--");
  const bandHi = el("span", {}, "--");
  const bandLab = el("div", { class: "jg-bandlab" }, bandLo, bandHi);

  const send = (action, extra = {}) =>
    store.send(Object.assign({ cmd: "tendon", action }, extra));

  const btnCentre = el("button", { class: "jg-btn" }, "Set centre here");
  // Arming is intentionally stationary: making the verb explicit prevents an
  // operator from mistaking a successful zero-motion safety check for a failed
  // movement command.
  const btnEngage = el("button", { class: "jg-btn go" }, "Arm & hold");
  const btnRelease = el("button", { class: "jg-btn" }, "Release");
  const btnStop = el("button", { class: "jg-btn stop" }, "Stop");
  const seaBench = el("a", { class: "jg-btn jg-link", href: "#/bench",
    title: "Cascaded tension and impedance controller bench" }, "SEA control");
  btnCentre.onclick = () => send("center");
  btnEngage.onclick = () => send("engage");
  btnRelease.onclick = () => send("release");
  btnStop.onclick = () => send("abort");

  const jogBtns = STEPS.map((d) => {
    const b = el("button", { class: "jg-btn" }, (d > 0 ? "+" : "") + d + "°");
    b.disabled = true;
    b.onclick = () => send("jog", { delta: d });
    return b;
  });

  const msg = el("p", { class: "jg-msg" }, "");
  const err = el("p", { class: "jg-err" }, "");

  const root = el("div", { class: "jg" },
    el("div", { class: "jg-head" },
      el("a", { class: "jg-back", href: "#/" }, "← back"),
      el("h1", { class: "jg-title" }, "Motor jog"),
      el("div", { class: "jg-chips" }, chips.bus, chips.torque, chips.band)),
    el("p", { class: "jg-sub" },
      "Relative moves only, from wherever the motor is now. There is no absolute target here on purpose."),
    el("p", { class: "jg-note" },
      "Arm & hold is intentionally still: it powers up at zero current and proves the motor does not drift. Once it reads torque on, use a − or + button below to move the target slowly. If the tendon binds, it stops and drops torque."),
    el("div", { class: "jg-card" },
      el("h3", {}, "Position"),
      readout, bar, bandLab),
    el("div", { class: "jg-card" },
      el("h3", {}, "Jog"),
      el("div", { class: "jg-jog" }, ...jogBtns)),
    el("div", { class: "jg-card" },
      el("h3", {}, "Control"),
      el("div", { class: "jg-row" }, btnCentre, btnEngage, btnRelease, btnStop, seaBench),
      msg, err));

  rootHost.appendChild(root);

  const unFrame = store.onFrame(() => {
    const s = store.snap;
    const t = s && s.tendon;
    if (!t) {
      msg.textContent = "No bridge snapshot yet.";
      return;
    }
    const live = t.live || {};
    const band = t.band || {};
    const engaged = !!t.engaged;

    chips.bus.textContent = t.phase;
    chips.bus.className = "jg-chip" + (t.busy ? " warn" : "");
    chips.torque.textContent = engaged ? "torque on" : "torque off";
    chips.torque.className = "jg-chip" + (engaged ? " live" : "");
    chips.band.textContent = band.source
      ? `band: ${band.source}` : "no band";
    chips.band.className = "jg-chip" + (band.source ? "" : " warn");

    const cmd = t.setpoint !== null && t.setpoint !== undefined
      ? t.setpoint : live.cmd;
    nums.cmd.textContent = fmt(cmd);
    nums.pos.textContent = fmt(live.motor);
    nums.lag.textContent = fmt(live.lag, 2);
    nums.joint.textContent = fmt(live.enc, 1);
    const lagBad = typeof live.lag === "number" &&
      live.lag > 0.6 * (t.limits ? t.limits.max_lag_deg : 25);
    lagCell.className = "jg-num" + (lagBad ? " alert" : "");

    if (typeof band.lo === "number" && band.hi > band.lo) {
      bandLo.textContent = fmt(band.lo) + "°";
      bandHi.textContent = fmt(band.hi) + "°";
      const pct = (v) => clamp((v - band.lo) / (band.hi - band.lo), 0, 1) * 100;
      if (typeof live.motor === "number") {
        markPos.style.left = `calc(${pct(live.motor)}% - 1.5px)`;
        markPos.style.display = "";
      } else markPos.style.display = "none";
      if (typeof cmd === "number") {
        markCmd.style.left = `calc(${pct(cmd)}% - 1.5px)`;
        markCmd.style.display = "";
      } else markCmd.style.display = "none";
    } else {
      bandLo.textContent = bandHi.textContent = "--";
      markPos.style.display = markCmd.style.display = "none";
    }

    jogBtns.forEach((b) => { b.disabled = !engaged; });
    btnEngage.disabled = engaged || t.busy || !band.source;
    btnRelease.disabled = !engaged;
    btnCentre.disabled = engaged || t.busy;

    msg.textContent = t.message || (engaged
      ? "Armed and holding. Choose a − or + jog step to move."
      : "Arm & hold verifies the motor safely before jog movement is enabled.");
    err.textContent = t.error || "";
  });

  return () => { unFrame(); root.remove(); };
}
