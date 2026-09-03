// main.js - shell + hash router. Surfaces mount/unmount cleanly; transitions
// between them feel like moving through one space.

import { initTheme } from "./theme.js";
import { initLang } from "./i18n.js";
initTheme();   // light by default; applies a persisted dark choice pre-paint
initLang();    // english by default; sets <html lang> from the persisted pick

import { mountEntry } from "./views/entry.js";
import { mountOperator } from "./views/operator.js";
import { mountCapture } from "./views/capture.js";
import { mountGuided } from "./views/guided.js";
import { mountMirror } from "./views/mirror.js";
import { mountReplay } from "./views/replay.js";
import { mountPair } from "./views/pair.js";
import { mountDoom } from "./views/doom.js";
import { mountSign } from "./views/sign.js";
import { mountTranslate } from "./views/translate.js";
import { mountBench } from "./views/bench.js";
import { mountImu } from "./views/imu.js";
import { mountJog } from "./views/jog.js";
import { mountTendon } from "./views/tendon.js";
import { initKonami } from "./konami.js";
import "./store.js";   // start the telemetry connection immediately

initKonami();   // hidden easter egg: Konami code / type "doom" -> #/doom

const app = document.getElementById("app");
const routes = {
  "": mountEntry,
  "operator": mountOperator,
  "guided": mountGuided,
  "capture": mountCapture,
  "mirror": mountMirror,
  "replay": mountReplay,
  "pair": mountPair,
  "doom": mountDoom,
  "sign": mountSign,
  "translate": mountTranslate,
  "bench": mountBench,
  "imu": mountImu,
  "tendon": mountTendon,
  "jog": mountJog,
};

let cleanup = null;
let current = null;      // the view actually mounted right now
let wanted = null;       // the view the hash asks for
let swapQueued = false;  // a view transition is holding a deferred swap

// The swap runs inside a view transition, i.e. a frame or two AFTER the
// hashchange that asked for it. It therefore has to read `wanted` at run time:
// resolving the captured view instead let a fast A -> B -> A leave B mounted
// under A's URL (the second route() saw current still === A and returned early).
function swap() {
  swapQueued = false;
  if (wanted === current) return;
  if (cleanup) { cleanup(); cleanup = null; }
  window.scrollTo(0, 0);
  current = wanted;
  cleanup = current(app);
}

function route() {
  const hash = (location.hash || "#/").replace(/^#\//, "").split("/")[0];
  wanted = routes[hash] || mountEntry;
  if (swapQueued) return;              // the queued swap will pick up `wanted`
  if (wanted === current) return;
  if (document.startViewTransition && current !== null) {
    swapQueued = true;
    // A transition that is superseded (a second navigation while the first is
    // still animating) rejects .finished / .ready. Unhandled, that logged an
    // InvalidStateError on EVERY route change and buried real errors in the
    // console. The swap itself still runs, so the rejection is genuinely
    // nothing to act on: swallow it explicitly rather than leave it unhandled.
    const t = document.startViewTransition(swap);
    if (t && t.finished && t.finished.catch) t.finished.catch(() => {});
    if (t && t.ready && t.ready.catch) t.ready.catch(() => {});
    if (t && t.updateCallbackDone && t.updateCallbackDone.catch) t.updateCallbackDone.catch(() => {});
  } else swap();
}

window.addEventListener("hashchange", route);
route();
