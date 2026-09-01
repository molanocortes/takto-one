// doom.js - TAKTO ONE easter egg (web side): a REMOTE CONTROL for the real
// id Software DOOM that runs on the watch's Teensy.
//
// The game itself lives on the device (Fable/doom/firmware/takto_doomgeneric,
// the actual 1993 DOOM engine via doomgeneric). This page does NOT run a game;
// it is a gamepad. Every time the pressed-key set changes it sends the 12-bit
// key mask to the bridge as {cmd:"doom", keys:<mask>}; teensy_bridge.py relays
// it to the Teensy as "G,<mask>\n" and DOOM plays on the round screen.
//
// Reach it via the Konami code / typing "doom" (konami.js) or #/doom.
import { el } from "../ui.js";
import { store } from "../store.js";

// ---- key bits: MUST match dg_config.h (firmware) and teensy_bridge.py ----
const K_FWD = 1, K_BACK = 2, K_LEFT = 4, K_RIGHT = 8, K_SL = 16, K_SR = 32,
      K_FIRE = 64, K_USE = 128, K_WEAP = 256, K_ENTER = 512, K_ESC = 1024, K_MAP = 2048;

function styleOnce() {
  if (document.getElementById("doom-style")) return;
  const s = el("style", { id: "doom-style" });
  s.textContent = `
  .dm { position:fixed; inset:0; overflow:auto; z-index:40; color:#cdd3df; touch-action:manipulation;
        background:radial-gradient(120% 120% at 50% 22%, #17131a 0%, #0c0a10 60%, #050507 100%);
        display:flex; flex-direction:column; align-items:center; justify-content:flex-start;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace; user-select:none; -webkit-user-select:none; }
  .dm-top { width:100%; display:flex; align-items:center; justify-content:space-between; padding:16px 22px; box-sizing:border-box; }
  .dm-kick { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:#c0402a; }
  .dm-exit { color:#8a93a6; text-decoration:none; font-size:22px; opacity:.75; }
  .dm-exit:hover { opacity:1; }
  .dm-chip { font-size:11px; letter-spacing:.04em; color:#7f8798; }
  .dm-chip b { color:#c9a24a; } .dm-chip.on b { color:#66d98a; }
  /* the watch */
  .dm-watch { position:relative; width:min(62vmin,380px); aspect-ratio:1; border-radius:50%; margin:6px 0 4px;
        background:linear-gradient(150deg,#2b2e35,#111318); padding:13px;
        box-shadow:0 26px 70px rgba(0,0,0,.6), inset 0 2px 4px rgba(255,255,255,.06); }
  .dm-watch::after { content:""; position:absolute; right:-9px; top:44%; width:11px; height:15%; border-radius:4px;
        background:linear-gradient(#3a3e46,#20232a); box-shadow:inset 0 1px 2px rgba(255,255,255,.15); }
  .dm-face { width:100%; height:100%; border-radius:50%; background:radial-gradient(circle at 50% 42%, #241016 0%, #120a0c 62%, #070506 100%);
        display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
        box-shadow:inset 0 0 26px rgba(0,0,0,.85), inset 0 0 0 2px rgba(0,0,0,.55); overflow:hidden; }
  .dm-logo { font:800 clamp(34px,11vmin,66px)/0.9 Impact, Haettenschweiler, "Arial Narrow", sans-serif;
        letter-spacing:.02em; transform:skewX(-6deg); color:#d8321c;
        text-shadow:0 2px 0 #6a1206, 0 0 22px rgba(216,50,28,.5); }
  .dm-run { font-size:10px; letter-spacing:.22em; text-transform:uppercase; color:#9a5a4a; }
  .dm-lvl { font-size:12px; letter-spacing:.14em; color:#c9b26a; }
  .dm-lvl .bl { animation:dmbl 1.1s steps(1) infinite; } @keyframes dmbl { 50% { opacity:0; } }
  .dm-hurt { position:absolute; inset:0; border-radius:50%; box-shadow:inset 0 0 40px rgba(200,30,20,.0);
        transition:box-shadow .12s; pointer-events:none; }
  /* live key ring on the face */
  .dm-live { position:absolute; bottom:14%; display:flex; gap:5px; }
  .dm-live i { width:7px; height:7px; border-radius:2px; background:rgba(255,255,255,.14); font-style:normal; }
  .dm-live i.on { background:#e0552f; box-shadow:0 0 8px #e0552f; }
  /* controls */
  .dm-pads { display:grid; grid-template-columns:auto auto auto; align-items:center; gap:20px; margin:8px 0 26px; }
  .dm-dpad { position:relative; width:168px; height:168px; }
  .dm-btn { position:absolute; display:flex; align-items:center; justify-content:center; cursor:pointer;
        border-radius:13px; border:1px solid rgba(255,255,255,.11); background:rgba(255,255,255,.05);
        color:#b3bbc9; font-size:19px; -webkit-tap-highlight-color:transparent; }
  .dm-btn:active, .dm-btn.hit { background:rgba(200,64,42,.4); color:#fff; border-color:rgba(200,64,42,.6); }
  .dm-dpad .dm-btn { width:54px; height:54px; }
  .dm-up{left:57px;top:0} .dm-dn{left:57px;top:114px} .dm-lf{left:0;top:57px} .dm-rt{left:114px;top:57px}
  .dm-mid { display:flex; flex-direction:column; gap:12px; }
  .dm-strafe { display:flex; gap:12px; }
  .dm-strafe .dm-btn, .dm-menu .dm-btn { position:relative; width:58px; height:44px; font-size:12px; letter-spacing:.06em; }
  .dm-menu { display:flex; gap:10px; }
  .dm-right { display:flex; flex-direction:column; align-items:center; gap:14px; }
  .dm-fire { position:relative; width:104px; height:104px; border-radius:50%; font-size:16px; letter-spacing:.12em;
        background:rgba(200,64,42,.24); border-color:rgba(200,64,42,.55); color:#f2b6a6; }
  .dm-use { position:relative; width:104px; height:46px; font-size:13px; letter-spacing:.1em; }
  .dm-help { max-width:560px; text-align:center; font-size:12px; line-height:1.7; color:#6c7385; margin:0 20px 30px; }
  .dm-help b { color:#98a1b4; } .dm-help code { color:#c9a24a; }
  @media (min-width:900px){ .dm-pads{ gap:34px; } }
  /* phones: D-pad (left) + FIRE/USE (right) on the thumb row, menu wraps below */
  @media (max-width:640px){
    .dm-pads { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start;
               gap:16px; width:100%; box-sizing:border-box; padding:0 14px; }
    .dm-dpad { order:1; width:150px; height:150px; }
    .dm-dpad .dm-btn { width:48px; height:48px; }
    .dm-up{left:51px;top:0} .dm-dn{left:51px;top:102px} .dm-lf{left:0;top:51px} .dm-rt{left:102px;top:51px}
    .dm-right { order:2; }
    .dm-mid { order:3; flex-basis:100%; align-items:center; margin-top:4px; }
    .dm-menu { flex-wrap:wrap; justify-content:center; }
    .dm-watch { width:min(74vw,320px); }
  }
  `;
  document.head.append(s);
}

export function mountDoom(rootHost) {
  styleOnce();

  // --- watch face (decorative; the real frame is on the device) ---
  const lvl = el("div", { class: "dm-lvl" }, el("span", { class: "bl" }, "▶"), " E1M1  HANGAR");
  const hurt = el("div", { class: "dm-hurt" });
  const liveDots = [K_FWD, K_LEFT, K_FIRE, K_USE, K_RIGHT, K_BACK].map(() => el("i"));
  const live = el("div", { class: "dm-live" }, ...liveDots);
  const face = el("div", { class: "dm-face" },
    el("div", { class: "dm-logo" }, "DOOM"),
    el("div", { class: "dm-run" }, "running on TAKTO ONE"),
    lvl, live, hurt);
  const watch = el("div", { class: "dm-watch" }, face);

  // --- controls ---
  const mk = (cls, label, bit, title) =>
    el("div", { class: `dm-btn ${cls}`, dataset: { bit }, title: title || "" }, label);
  const dpad = el("div", { class: "dm-dpad" },
    mk("dm-up", "▲", K_FWD, "forward"), mk("dm-dn", "▼", K_BACK, "back"),
    mk("dm-lf", "◀", K_LEFT, "turn left"), mk("dm-rt", "▶", K_RIGHT, "turn right"));
  const mid = el("div", { class: "dm-mid" },
    el("div", { class: "dm-strafe" }, mk("", "⇦ STR", K_SL, "strafe left"), mk("", "STR ⇨", K_SR, "strafe right")),
    el("div", { class: "dm-menu" }, mk("", "ENTER", K_ENTER, "menu select"), mk("", "ESC", K_ESC, "menu / back"),
       mk("", "WEP", K_WEAP, "next weapon"), mk("", "MAP", K_MAP, "automap")));
  const right = el("div", { class: "dm-right" }, mk("dm-fire", "FIRE", K_FIRE, "fire"), mk("dm-use", "USE", K_USE, "use / open"));
  const pads = el("div", { class: "dm-pads" }, dpad, mid, right);

  const chip = el("div", { class: "dm-chip" }, "device ", el("b", {}, "connect the bridge"));
  const root = el("div", { class: "dm" },
    el("div", { class: "dm-top" },
      el("div", { class: "dm-kick" }, "TAKTO // secret"),
      el("a", { class: "dm-exit", href: "#/", title: "exit" }, "✕")),
    chip,
    watch,
    pads,
    el("div", { class: "dm-help" },
      "The real 1993 DOOM runs on the watch. This is the remote. ",
      el("b", {}, "MOVE"), " W/S · ", el("b", {}, "TURN"), " ←/→ · ",
      el("b", {}, "STRAFE"), " A/D · ", el("b", {}, "FIRE"), " space · ",
      el("b", {}, "USE"), " E · ", el("b", {}, "MENU"), " enter/esc · ",
      el("b", {}, "WEAPON"), " Q · ", el("b", {}, "MAP"), " tab.",
      el("br"), "Run ", el("code", {}, "console"), " + ", el("code", {}, "bridge"),
      " and open with ", el("code", {}, "?ws=ws://localhost:8765/ws"), " to drive a connected device."));
  rootHost.append(root);

  // --- input -> mask -> device ---
  const btns = [...dpad.children, ...mid.querySelectorAll(".dm-btn"), ...right.children];
  const byBit = new Map(btns.map((b) => [+b.dataset.bit, b]));
  const down = new Set();
  let lastMask = -1;
  const paint = () => {
    for (const [bit, b] of byBit) b.classList.toggle("hit", down.has(bit));
    liveDots[0].classList.toggle("on", down.has(K_FWD));
    liveDots[1].classList.toggle("on", down.has(K_LEFT));
    liveDots[2].classList.toggle("on", down.has(K_FIRE));
    liveDots[3].classList.toggle("on", down.has(K_USE));
    liveDots[4].classList.toggle("on", down.has(K_RIGHT));
    liveDots[5].classList.toggle("on", down.has(K_BACK));
    hurt.style.boxShadow = down.has(K_FIRE) ? "inset 0 0 40px rgba(224,85,47,.45)" : "inset 0 0 40px rgba(200,30,20,0)";
  };
  const push = () => {
    let m = 0; for (const b of down) m |= b;
    if (m !== lastMask) { lastMask = m; try { store.send({ cmd: "doom", keys: m }); } catch (e) { /* mock */ } }
    paint();
  };

  const KEYMAP = {
    arrowup: K_FWD, w: K_FWD, arrowdown: K_BACK, s: K_BACK,
    arrowleft: K_LEFT, arrowright: K_RIGHT, a: K_SL, d: K_SR,
    " ": K_FIRE, f: K_FIRE, control: K_FIRE, e: K_USE,
    enter: K_ENTER, escape: K_ESC, q: K_WEAP, tab: K_MAP,
  };
  const onKey = (ev, isDown) => {
    const k = (ev.key || "").toLowerCase(); const bit = KEYMAP[k]; if (!bit) return;
    ev.preventDefault();
    if (isDown) down.add(bit); else down.delete(bit); push();
  };
  const kd = (e) => onKey(e, true), ku = (e) => onKey(e, false);
  window.addEventListener("keydown", kd); window.addEventListener("keyup", ku);

  const holders = [];
  for (const b of btns) {
    const bit = +b.dataset.bit;
    const on = (e) => { e.preventDefault(); down.add(bit); push(); };
    const off = (e) => { e.preventDefault(); down.delete(bit); push(); };
    b.addEventListener("pointerdown", on); b.addEventListener("pointerup", off);
    b.addEventListener("pointerleave", off); b.addEventListener("pointercancel", off);
    holders.push([b, on, off]);
  }

  // --- device-link chip (honest: only "linked" on a real ws + a real device) ---
  const refreshChip = () => {
    const linked = store.live && !!(store.snap && store.snap.link && store.snap.link.device);
    chip.classList.toggle("on", linked);
    chip.replaceChildren("device ", el("b", {}, linked ? "WATCH ◉ linked" : store.live ? "bridge up, no device" : "preview (no bridge)"));
  };
  const offSnap = store.onSnap(refreshChip); refreshChip();

  return () => {
    window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku);
    for (const [b, on, off] of holders) { b.removeEventListener("pointerdown", on); b.removeEventListener("pointerup", off); b.removeEventListener("pointerleave", off); b.removeEventListener("pointercancel", off); }
    offSnap();
    try { store.send({ cmd: "doom", keys: 0 }); } catch (e) { /* release device keys */ }
    root.remove();
  };
}
