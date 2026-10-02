// main.js - shell + hash router. Surfaces mount/unmount cleanly; transitions
// between them feel like moving through one space.

import { initTheme } from "./theme.js";
import { initLang } from "./i18n.js";
initTheme();   // light by default; applies a persisted dark choice pre-paint
initLang();    // english by default; sets <html lang> from the persisted pick

// The product page ships with the shell. Every console surface is its own
// chunk, fetched the first time someone opens it: the front door used to
// download and evaluate all fourteen surfaces before it could paint.
import { mountEntry } from "./views/entry.js";
import { initKonami } from "./konami.js";
import "./store.js";   // start the telemetry connection immediately
import { mountSimBanner } from "./sim_badge.js";

initKonami();   // hidden easter egg: Konami code / type "doom" -> #/doom
mountSimBanner();   // SIMULATED DATA, on every surface, whenever the mock is the source

const app = document.getElementById("app");
const routes = {
  "": () => mountEntry,
  "operator": () => import("./views/operator.js").then((m) => m.mountOperator),
  "guided": () => import("./views/guided.js").then((m) => m.mountGuided),
  "capture": () => import("./views/capture.js").then((m) => m.mountCapture),
  "mirror": () => import("./views/mirror.js").then((m) => m.mountMirror),
  "replay": () => import("./views/replay.js").then((m) => m.mountReplay),
  "pair": () => import("./views/pair.js").then((m) => m.mountPair),
  "doom": () => import("./views/doom.js").then((m) => m.mountDoom),
  "sign": () => import("./views/sign.js").then((m) => m.mountSign),
  "translate": () => import("./views/translate.js").then((m) => m.mountTranslate),
  "bench": () => import("./views/bench.js").then((m) => m.mountBench),
  "imu": () => import("./views/imu.js").then((m) => m.mountImu),
  "tendon": () => import("./views/tendon.js").then((m) => m.mountTendon),
  "jog": () => import("./views/jog.js").then((m) => m.mountJog),
};

let cleanup = null;
let current = null;      // the view actually mounted right now
let wanted = null;       // the view the hash asks for
let swapQueued = false;  // a view transition is holding a deferred swap
let navSeq = 0;          // the latest navigation: a chunk that lands late is dropped
let booted = false;      // the first route has mounted

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
  // the product page names itself; every other route is a console surface
  if (current !== mountEntry) document.title = "TAKTO ONE · Console";
  cleanup = current(app);
}

async function route() {
  const hash = (location.hash || "#/").replace(/^#\//, "").split("/")[0];
  const seq = ++navSeq;
  let mount;
  try {
    mount = await (routes[hash] || routes[""])();
  } catch (e) {
    // a surface's chunk did not arrive. After a deploy the open page still
    // names the previous build's chunks: a reload fetches the new names. On
    // the very first route a reload could loop, so the front door opens.
    if (booted && e instanceof TypeError) { location.reload(); return; }
    console.warn("route", hash, e);
    mount = mountEntry;
  }
  if (seq !== navSeq) return;          // a newer navigation took over meanwhile
  booted = true;
  wanted = mount;
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
