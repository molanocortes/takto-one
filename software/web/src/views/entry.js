// entry.js - the product page: TAKTO ONE as an exhibition.
//
// Owner brief (2026-09-30): the site has two parts, the CONSOLE that controls
// the device (#/operator, and every mode inside it) and THIS page, which
// introduces it. "Like Apple, a product exhibition ... modern and elegant,
// clean hospital vibes." The two references were a page with the product
// floating over a giant wordmark, and a page with finish swatches, a product
// row and a bento of features. So, top to bottom:
//
//   hero      giant TAKTO, the device floating over a plinth, finish spheres
//   intro     one honest paragraph pair + three film stills
//   turn      a pinned 360: 72 studio frames scrubbed by the scroll
//   specs     a pinned tour, part by part, with a spotlight; four figures
//   tech specs  Apple's grammar: label column, icon items, drawings, notes
//   finishes  the three finishes from above, side by side
//   tech      a bento: transparency dial, the real watch face renderer,
//             sensing, drive, safety, EMG, SD capture
//   twin      the live digital twin (a showroom choreography offline)
//   film      the 30 s film
//   console   ONE door into the console (the modes live inside it now)
//   build     source, build guide, BOM
//   creed, compliance (folded map), contact, footer
//
// The page is always light: it forces the light theme while mounted and gives
// the visitor's own choice back on unmount (the console keeps the toggle).
// Every image is a local asset (assets/px, cut from docs/media renders and the
// films) and nothing loads from a third party: no fonts, no trackers.

import { el, svg, observeReveals, clamp, reducedMotion } from "../ui.js";
import { store } from "../store.js";
import { Twin } from "../twin.js";
import { StripChart } from "../charts.js";
import { DeviceScreen } from "../device_screen.js";
import { sourceBadges } from "../sim_badge.js";
import { strings, getLang, setLang, LANG_LABELS } from "../i18n.js";
import { getTheme, applyTheme } from "../theme.js";
import { curlToJoints } from "../kinematics.js";
import { qRx, qRy, qMul } from "../arm_model.js";

// the active locale: every visible string on this page comes from here
// (src/locales/en|de|es.js - same shape, translated by hand). Fixed per page
// load; the language picker reloads to rebuild everything, incl. <html lang>.
const L = strings();

const REPO = "https://github.com/molanocortes/takto-one";
// The site is published from software/web alone (.github/workflows/pages.yml),
// so repo files outside it are linked on GitHub, never by a relative path.
const BUILD_LINKS = [REPO, `${REPO}/blob/main/docs/build-guide.pdf`, `${REPO}/blob/main/docs/BOM.md`];
const MAIL = "mailto:sebastianmolano.eng@gmail.com";

const FINISHES = ["snow", "onyx", "signal"];
// swatch spheres: core -> rim of each finish (Signal runs orange into blue)
const SWATCH = { snow: ["#FFFFFF", "#CDD1D7"], onyx: ["#5B5F66", "#141619"], signal: ["#F59A3B", "#3F74AE"] };
// the hero renders (assets/px/hero-{finish}.webp), one crop for all three
const HERO_W = 1600, HERO_H = 1256;
const MODES = ["guided", "mirror", "capture", "replay", "sign", "translate"];

// the index plate: where each callout sits on assets/px/anatomy.webp (percent
// of the image box), in the order of L.specs.callouts
const CALLOUT_AT = [[46, 25], [23.5, 48], [35, 74], [17, 24], [73, 46], [82, 76]];
// how far the tour leans in on each part, and the tour render's pixel size
const TOUR_ZOOM = [2.0, 1.6, 1.6, 1.7, 1.9, 1.8];
const ANAT_W = 2718, ANAT_H = 926;
// The four headline figures (owner, round 3: "keep the most relevant ones";
// labels in L.specs.stats). Sources: 12 encoders + 0.088 deg - the instrument
// sheet; 100 Hz - SAMPLE_HZ in firmware v16; the BOM - docs/BOM.md.
const STATS = [
  { v: 12, viz: "joints" }, { v: 0.088, d: 3, u: "°", viz: "dial" },
  { v: 100, u: "Hz", viz: "pulse" }, { v: 1222.25, cur: true, viz: "cost" },
];
// docs/BOM.md cost summary in EUR, in the order of L.specs.costGroups
const COST = [1040.0, 50.0, 44.38, 43.97, 26.4, 17.5];
// Tech Specs (L.ts.rows order): a drawing beside the row, or each item's icon
const TS_LAYOUT = [
  { icons: ["enc", "res", "imu", "emg"] },            // sensing
  { fig: "rom" },                                     // range of motion
  { icons: ["motor", "spool", "tendon", "crown"] },   // actuation
  { icons: ["force", "shield", "stop"] },             // safety
  { fig: "chip" },                                    // controller and display
  { icons: ["stream", "sd", "tag"] },                 // recording and data
  { icons: ["web", "ar", "phone", "code"] },          // software
  { icons: ["layers", "metal", "slide"] },            // materials
  { fig: "cost" },                                    // cost
];
// line icons on a 24 grid, drawn at 1.5 px like a system symbol set
const TS_ICONS = {
  enc: ["M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0", "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20"],
  res: ["M4 17a8 8 0 0 1 16 0", "M12 9v2M7.6 10.7l1.1 1.5M16.4 10.7l-1.1 1.5M5.5 14l1.7.7M18.5 14l-1.7.7", "M12 17l3.2-4.6"],
  imu: ["M12 13V4.5M12 13l7 4M12 13l-7 4", "M10 6.5l2-2 2 2", "M16.6 18.6l2.4-1.6-.5-2.8", "M7.4 18.6L5 17l.5-2.8"],
  emg: ["M3 12h3.5l1.8-4.5 2.7 9 2.4-7 1.8 4.5h5.8"],
  motor: ["M4 7.5h11.5a3.5 3.5 0 0 1 3.5 3.5v2a3.5 3.5 0 0 1-3.5 3.5H4z", "M19 12h2", "M8 7.5v9M12 7.5v9"],
  spool: ["M6 5h12M6 19h12", "M8.5 5v14M15.5 5v14", "M8.5 9.5h7M8.5 12h7M8.5 14.5h7"],
  tendon: ["M5 18C9.5 18 9 6 14 6s5 8 5.5 12", "M5 18m-1.6 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0"],
  crown: ["M12 12m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0", "M12 5.5V9", "M18.5 12H21"],
  force: ["M12 3v10", "M8.5 9.5L12 13l3.5-3.5", "M5 16.5h14", "M5 20h14"],
  shield: ["M12 3l7 2.8v5.7c0 4.3-2.9 7.7-7 9.5-4.1-1.8-7-5.2-7-9.5V5.8z", "M9 12l2.2 2.2L15.5 10"],
  stop: ["M18.5 4v16", "M4.5 15.5a8.5 8.5 0 0 1 11-8.2", "M13 4.6l2.6 2.7-2.9 2"],
  stream: ["M12 18m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0", "M8.6 14.6a4.8 4.8 0 0 1 6.8 0", "M5.6 11.6a9 9 0 0 1 12.8 0", "M2.6 8.6a13.3 13.3 0 0 1 18.8 0"],
  sd: ["M7 3h8l3 3v15H7z", "M10 3v3.5M13 3v3.5", "M10 15.5h5"],
  tag: ["M3.5 12V4.5H11l9.5 9.5-7 7z", "M7.6 8.1m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0"],
  web: ["M3 5h18v14H3z", "M3 9h18", "M6 7h.01M8.5 7h.01"],
  ar: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"],
  phone: ["M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z", "M11 18h2"],
  code: ["M8.5 7.5L4 12l4.5 4.5", "M15.5 7.5L20 12l-4.5 4.5", "M13.5 5l-3 14"],
  layers: ["M12 4l8 4-8 4-8-4z", "M4 12l8 4 8-4", "M4 16l8 4 8-4"],
  metal: ["M7.5 8.5h9l3 9h-15z", "M7.5 8.5l1.8-3h5.4l1.8 3"],
  slide: ["M4 9h16M4 15h16", "M14 5.5L17.5 9M10 18.5L6.5 15"],
};
// the CAD assembly as modelled (mm), measured off the twin's model: the
// forearm unit (cover, motors, spools) and forearm-to-fingertip, extended
const DIMS = { len: 181, wid: 122, hei: 78, overall: 347 };

// the 360: 72 studio frames, one every 5 degrees, rendered transparent with
// their contact shadow from the owner's studio pipeline. Two cuts of the same
// renders: 2240 px wide for large and retina panels (owner, round 3: "the 360
// is low resolution"), 1120 px for phones
const TURN_N = 72;
const turnSrc = (i, hi) => `assets/px/${hi ? "turn3" : "turn2"}/f${String(i).padStart(2, "0")}.webp`;

// The showroom (owner, round 3): with no device connected, the twin performs
// a short choreography instead of replaying the simulator's raw arm data -
// a finger roll, index to little finger, then a soft grasp, the wrist
// breathing a few degrees. A connected device always wins.
const SHOW_FINGERS = ["index", "middle", "ring", "pinky"];
const SHOW_SPLAY = [5, 1.5, -2, -5.5];
const bump = (t, c, w) => { const x = (t - c) / w; return Math.abs(x) >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x); };

const chevron = (d = "M4 6l4 4 4-4") => svg("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true" },
  svg("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
const arrow = () => chevron("M5 11l6-6M6 5h5v5");

// the hero ground: soft satin folds in white and pale grey, drawn as SVG so
// it costs no download and stays sharp at any size
function silk() {
  const grad = (id, a, b) => svg("linearGradient", { id, x1: 0, y1: 0, x2: 0.4, y2: 1 },
    svg("stop", { offset: 0, "stop-color": a }), svg("stop", { offset: 1, "stop-color": b }));
  const blur = (id, d) => svg("filter", { id, x: "-30%", y: "-30%", width: "160%", height: "160%" },
    svg("feGaussianBlur", { stdDeviation: d }));
  const fold = (d, stroke, w, f, o) => svg("path", { d, fill: "none", stroke, "stroke-width": w,
    "stroke-linecap": "round", filter: `url(#${f})`, opacity: o });
  return svg("svg", { class: "px-silk", viewBox: "0 0 1440 900", preserveAspectRatio: "xMidYMid slice", "aria-hidden": "true" },
    svg("defs", {}, grad("pxsg", "#F6F7F9", "#E2E6EB"), blur("pxsb", 34), blur("pxsb2", 12), blur("pxsb3", 2.4)),
    svg("rect", { width: 1440, height: 900, fill: "url(#pxsg)" }),
    svg("g", { class: "px-silk-a" },
      fold("M-260 300 C 160 120, 540 470, 960 250 S 1560 70, 1760 170", "#FFFFFF", 190, "pxsb", 0.95),
      fold("M-260 400 C 180 230, 560 580, 990 350 S 1590 170, 1760 260", "#D2D8DF", 130, "pxsb", 0.85),
      fold("M-260 300 C 160 120, 540 470, 960 250 S 1560 70, 1760 170", "#FFFFFF", 6, "pxsb3", 0.9)),
    svg("g", { class: "px-silk-b" },
      fold("M-260 700 C 220 500, 600 860, 1020 620 S 1600 420, 1760 520", "#FFFFFF", 210, "pxsb", 0.9),
      fold("M-260 800 C 240 610, 640 960, 1060 720 S 1620 530, 1760 620", "#D0D6DE", 150, "pxsb", 0.8),
      fold("M-260 690 C 220 490, 600 850, 1020 610 S 1600 410, 1760 510", "#FFFFFF", 5, "pxsb3", 0.85),
      fold("M-100 590 C 300 470, 700 700, 1100 520", "#E7EAEE", 60, "pxsb2", 0.5)));
}

export function mountEntry(rootHost) {
  // ---------- page mode: light, clean, its own title ----------
  applyTheme("light", { persist: false });
  document.documentElement.classList.add("px-page");
  document.title = "TAKTO ONE · The hand, alive";

  const cleanups = [];
  const root = el("div", { class: "px" });
  // Onyx opens the show: graphite on the white silk reads at a glance, where
  // the white study melts into its own ground (owner feedback, round 2)
  let finish = "onyx";

  // ---------- nav ----------
  const sectionFor = {};
  const goTo = (key) => sectionFor[key]?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  const navLink = (key) => {
    const a = el("a", { href: "#", class: "px-nav-link" }, L.nav[key]);
    // plain scrollIntoView, never location.hash - the hash belongs to the router
    a.addEventListener("click", (e) => { e.preventDefault(); goTo(key); });
    return a;
  };
  const brand = el("a", { href: "#", class: "px-brand", "aria-label": "TAKTO" },
    el("img", { src: "assets/brand/takto-logo.svg", class: "px-brand-logo", alt: "TAKTO", width: 114, height: 22 }));
  brand.addEventListener("click", (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" }); });
  const lang = el("div", { class: "px-lang", role: "group", "aria-label": "Language" },
    ...Object.keys(LANG_LABELS).map((l) => {
      const b = el("button", { type: "button", class: getLang() === l ? "on" : "", "aria-pressed": String(getLang() === l) }, LANG_LABELS[l]);
      b.addEventListener("click", () => { if (getLang() !== l) setLang(l); });
      return b;
    }));
  const consoleIcon = () => svg("svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
    svg("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5, fill: "none", stroke: "currentColor", "stroke-width": 1.4 }),
    svg("path", { d: "M4.5 9.5l2-2 1.6 1.6L11.5 6", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  const nav = el("header", { class: "px-nav" },
    brand,
    el("nav", { class: "px-nav-links", "aria-label": "Sections" },
      navLink("design"), navLink("specs"), navLink("tech"), navLink("build"), navLink("contact")),
    el("div", { class: "px-nav-r" },
      lang,
      el("a", { class: "px-nav-console", href: "#/operator", title: L.nav.consoleTitle },
        el("span", null, L.nav.console), el("span", { class: "px-ico" }, consoleIcon()))));

  // ---------- hero: the exhibit ----------
  // Owner brief, round 2 (2026-10-01): "more premium, like the two samples",
  // and no top view. So: the giant wordmark, the device in 3/4 floating over a
  // white plinth on a silk-white ground (the first sample), and the finish
  // picker beside the product name (the second). The renders (assets/px/
  // hero-*.webp) come from the owner's studio pipeline, transparent, so the
  // page draws the plinth and the ground shadow itself.
  const devImgs = Object.fromEntries(FINISHES.map((f) => [f, el("img", {
    class: "px-dev-img" + (f === finish ? " on" : ""), src: `assets/px/hero-${f}.webp`,
    alt: f === finish ? `TAKTO ONE · ${L.finishes[f].name}` : "", width: HERO_W, height: HERO_H,
    decoding: "async", draggable: "false", fetchpriority: f === finish ? "high" : "low",
  })]));
  const device = el("div", { class: "px-dev", style: `aspect-ratio:${HERO_W} / ${HERO_H}` }, ...Object.values(devImgs));
  const float = el("div", { class: "px-float" }, device);
  const plinth = el("div", { class: "px-plinth", "aria-hidden": "true" },
    el("i", { class: "px-plinth-body" }), el("i", { class: "px-plinth-top" }), el("i", { class: "px-plinth-shadow" }));
  const word = el("h1", { class: "px-word", "aria-label": "TAKTO ONE" }, "TAKTO");
  const head = el("div", { class: "px-head" }, word, el("p", { class: "px-tag" }, L.hero.tagline));
  const swBtns = Object.fromEntries(FINISHES.map((f) => {
    const b = el("button", { type: "button", class: "px-sw", role: "radio", title: L.finishes[f].name,
      "aria-label": L.finishes[f].name, style: `--a:${SWATCH[f][0]};--b:${SWATCH[f][1]}` });
    b.addEventListener("click", () => setFinish(f));
    return [f, b];
  }));
  const finishName = el("span", { class: "px-pick-name" }, "");
  const finishLine = el("span", { class: "px-pick-line" }, "");
  const heroDown = el("button", { type: "button", class: "px-down", "aria-label": L.hero.next }, chevron());
  const pillBtn = (label, href, cls = "") => el("a", { class: "px-pill " + cls, href },
    el("span", null, label), el("span", { class: "px-pill-ico" }, arrow()));
  // a folded panel: the deep content stays one click away, never deleted
  const fold = (cueText, ...content) => el("details", { class: "px-fold reveal" },
    el("summary", null, el("span", { class: "px-fold-plus", "aria-hidden": "true" }), cueText),
    el("div", { class: "px-fold-body" }, ...content));
  const picker = el("div", { class: "px-pick" },
    el("span", { class: "px-pick-k" }, "TAKTO ONE"),
    finishName, finishLine,
    el("div", { class: "px-sw-row", role: "radiogroup", "aria-label": L.hero.finishLabel }, ...Object.values(swBtns)),
    pillBtn(L.hero.cta, "#/operator", "dark"));
  const stage = el("div", { class: "px-stage" }, plinth, float);
  const heroCard = el("div", { class: "px-hero-card" },
    silk(), head, stage, picker,
    el("div", { class: "px-hero-foot" }, el("p", { class: "px-sub" }, L.hero.sub), heroDown));
  const hero = el("section", { class: "px-hero" }, heroCard);

  // ---------- intro ----------
  const stillTile = (src, cap, d) => el("figure", { class: "px-still reveal", style: `--d:${d}ms` },
    el("img", { src, alt: cap, loading: "lazy", decoding: "async" }),
    el("figcaption", null, cap));
  const intro = el("section", { class: "px-sec px-intro" },
    el("div", { class: "px-kicker reveal" }, L.intro.kicker),
    el("h2", { class: "px-h2 reveal", style: "--d:60ms" }, L.intro.head),
    el("p", { class: "px-lede reveal", style: "--d:120ms" }, L.intro.sub),
    el("div", { class: "px-cols reveal", style: "--d:180ms" },
      el("p", null, L.intro.left), el("span", { class: "px-cols-rule", "aria-hidden": "true" }), el("p", null, L.intro.right)),
    // the film's own stills, soft focus and all (owner, round 3: "looked
    // better before"), cut at the film's full 1920 px
    el("div", { class: "px-stills" },
      stillTile("assets/px/still-extend.webp", L.intro.tiles[0], 80),
      stillTile("assets/px/still-curl.webp", L.intro.tiles[1], 160),
      stillTile("assets/px/still-threequarter.webp", L.intro.tiles[2], 240)));

  // ---------- turn: the pinned 360 ----------
  // two stacked <img>s, double-buffered: the browser decodes and rasters DOM
  // images on its own threads, where a canvas drawImage decoded every new
  // angle on the main thread (18 ms a frame on a phone, mid-scroll)
  const turnImgs = [0, 1].map(() => el("img", { alt: "", decoding: "async", draggable: "false" }));
  const turnCv = el("div", { class: "px-turn-cv", role: "img", "aria-label": "TAKTO ONE, 360°" }, ...turnImgs);
  const turnDeg = el("span", { class: "px-turn-deg" }, "0°");
  const turnFill = el("i");
  const turnCaps = L.turn.caps.map((c, i) => el("div", { class: "px-turn-cap" + (i === 0 ? " on" : "") },
    el("span", { class: "px-turn-n" }, `0${i + 1}`),
    el("h3", null, c.h), el("p", null, c.p)));
  const turnSticky = el("div", { class: "px-turn-sticky" },
    el("div", { class: "px-turn-panel" },
      turnCv,
      el("div", { class: "px-turn-caps" }, ...turnCaps),
      el("div", { class: "px-turn-meter" }, el("span", { class: "px-turn-bar" }, turnFill), turnDeg)));
  const turnTrack = el("div", { class: "px-turn-track" }, turnSticky);
  const turn = el("section", { class: "px-sec px-turn" },
    el("div", { class: "px-sec-head" },
      el("div", { class: "px-kicker reveal" }, L.turn.kicker),
      el("h2", { class: "px-h2 reveal", style: "--d:60ms" }, L.turn.head)),
    turnTrack);

  // ---------- finishes ----------
  // the three finishes side by side from above (owner, round 3: the top
  // view "looks really good" for a colour comparison): one studio plan
  // render each, same camera, same light, so only the colour changes
  const finCards = Object.fromEntries(FINISHES.map((f, i) => {
    const btnLabel = el("span", { class: "px-fc-label" }, L.finishSec.select);
    const card = el("button", { type: "button", class: "px-fc reveal", style: `--d:${80 + i * 90}ms` },
      el("span", { class: "px-fc-img" },
        el("img", { src: `assets/px/plan-${f}.webp`, alt: `TAKTO ONE · ${L.finishes[f].name}`, loading: "lazy", decoding: "async" })),
      el("span", { class: "px-fc-meta" },
        el("span", { class: "px-fc-txt" },
          el("span", { class: "px-fc-name" }, L.finishes[f].name),
          el("span", { class: "px-fc-line" }, L.finishes[f].line)),
        el("span", { class: "px-fc-go" }, btnLabel, el("span", { class: "px-fc-dot", style: `--a:${SWATCH[f][0]};--b:${SWATCH[f][1]}` }))));
    card.addEventListener("click", () => {
      setFinish(f);
      window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
    });
    return [f, { card, btnLabel }];
  }));
  const finishSec = el("section", { class: "px-sec px-finishes" },
    el("div", { class: "px-sec-row" },
      el("div", null,
        el("div", { class: "px-kicker reveal" }, L.finishSec.kicker),
        el("h2", { class: "px-h2 reveal", style: "--d:60ms" }, L.finishSec.head)),
      el("p", { class: "px-sec-aside reveal", style: "--d:120ms" }, L.finishSec.sub)),
    el("div", { class: "px-fc-row" }, ...Object.values(finCards).map((x) => x.card)));

  function setFinish(f) {
    finish = f;
    for (const k of FINISHES) {
      const on = k === f;
      devImgs[k].classList.toggle("on", on);
      devImgs[k].alt = on ? `TAKTO ONE · ${L.finishes[k].name}` : "";
      swBtns[k].classList.toggle("on", on);
      swBtns[k].setAttribute("aria-checked", String(on));
      finCards[k].card.classList.toggle("on", on);
      finCards[k].btnLabel.textContent = on ? L.finishSec.selected : L.finishSec.select;
    }
    finishName.textContent = L.finishes[f].name;
    finishLine.textContent = L.finishes[f].line;
    finishName.classList.remove("swap"); void finishName.offsetWidth; finishName.classList.add("swap");
  }
  setFinish(finish);

  // ---------- specs: a guided tour of the machine, four figures, the sheet ----------
  // Phone-launch grammar (owner, 2026-10-01: "give more importance to the
  // specs"; round 3: "more dynamic and better formatted", "too heavy on
  // numbers"). The section pins and the scroll walks the camera from the whole
  // machine into each part in turn while a spotlight holds it; every stop says
  // what the part does for the wearer, its figures kept to one small line, and
  // the chapter rail names all six. Then four headline figures, each with a
  // small live drawing of what it measures, and the sheet as scannable value
  // chips with every line of it behind a fold.
  const TOUR_N = L.specs.callouts.length;            // steps 1..N; step 0 is the whole machine
  const tourImg = el("img", { class: "px-tour-img", src: "assets/px/anatomy.webp", alt: "TAKTO ONE",
    width: ANAT_W, height: ANAT_H, decoding: "async" });
  const tourLayer = el("div", { class: "px-tour-layer" }, tourImg);
  const tourSpot = el("div", { class: "px-tour-spot", "aria-hidden": "true" });
  const tourPins = L.specs.callouts.map((c, i) => el("button", { type: "button", class: "px-pin",
    "aria-label": `${i + 1}. ${c.k}` }, el("i")));
  const two = (n) => String(n).padStart(2, "0");
  const tourCaps = [
    el("div", { class: "px-tour-cap on" },
      el("span", { class: "px-tour-n" }, `${two(0)} · ${L.specs.kicker}`),
      el("h3", { class: "px-tour-h" }, L.specs.tour0.h),
      el("p", null, L.specs.tour0.p)),
    ...L.specs.callouts.map((c, i) => el("div", { class: "px-tour-cap" },
      el("span", { class: "px-tour-n" }, `${two(i + 1)} · ${c.k}`),
      el("h3", { class: "px-tour-h" }, c.h),
      el("p", null, c.p),
      el("span", { class: "px-tour-s" }, c.s))),
  ];
  // the chapter rail: every part by name, the current one filling as you go
  const tourChaps = L.specs.callouts.map((c) => {
    const fill = el("i", { class: "px-chap-fill" });
    return { b: el("button", { type: "button", class: "px-chap" }, el("span", null, c.k), fill), fill };
  });
  const tourProg = el("i");
  const tourStage = el("div", { class: "px-tour-stage" }, tourLayer, tourSpot, ...tourPins);
  const tourSticky = el("div", { class: "px-tour-sticky" },
    el("div", { class: "px-tour-panel" },
      tourStage,
      el("span", { class: "px-tour-prog", "aria-hidden": "true" }, tourProg),
      el("div", { class: "px-tour-card" }, ...tourCaps),
      el("div", { class: "px-tour-rail" }, ...tourChaps.map((c) => c.b))));
  const tourTrack = el("div", { class: "px-tour-track" }, tourSticky);

  // the four figures, each over a small drawing of what it measures
  const numFmt = (n, d) => new Intl.NumberFormat(getLang(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  const eurFmt = (n) => new Intl.NumberFormat(getLang(), { style: "currency", currency: "EUR" }).format(n);
  const costTotal = COST.reduce((a, b) => a + b, 0);
  const statViz = {
    // twelve joints: four fingers of three, lighting up in a wave
    joints: () => svg("svg", { viewBox: "0 0 120 64", class: "px-viz px-viz-joints", "aria-hidden": "true" },
      ...[0, 1, 2, 3].map((f) => svg("line", { x1: 21 + f * 26, y1: 52, x2: 21 + f * 26, y2: 12 })),
      ...[0, 1, 2, 3].flatMap((f) => [0, 1, 2].map((j) => svg("circle", {
        cx: 21 + f * 26, cy: 52 - j * 20, r: 5.5, style: `--i:${f * 3 + j}` })))),
    // 0.088 deg: a fine scale, and a needle that steps rather than glides
    dial: () => {
      const ticks = [];
      for (let i = 0; i <= 40; i++) {
        const a = (-50 + i * 2.5) * Math.PI / 180, maj = i % 5 === 0;
        const r0 = maj ? 38 : 43, r1 = 49;
        ticks.push(svg("line", { class: maj ? "maj" : "",
          x1: (60 + r0 * Math.sin(a)).toFixed(2), y1: (60 - r0 * Math.cos(a)).toFixed(2),
          x2: (60 + r1 * Math.sin(a)).toFixed(2), y2: (60 - r1 * Math.cos(a)).toFixed(2) }));
      }
      return svg("svg", { viewBox: "0 0 120 64", class: "px-viz px-viz-dial", "aria-hidden": "true" },
        ...ticks,
        svg("g", { class: "px-needle" },
          svg("line", { x1: 60, y1: 60, x2: 60, y2: 16 }), svg("circle", { cx: 60, cy: 60, r: 3.6 })));
    },
    // 100 Hz: samples that never stop arriving (one period = the 120 px loop)
    pulse: () => {
      const pts = [];
      for (let x = 0; x <= 240; x += 4) {
        const t = ((x % 120) / 120) * Math.PI * 2;
        pts.push([x, 34 - 14 * Math.sin(t) - 5 * Math.sin(3 * t + 0.6)]);
      }
      return svg("svg", { viewBox: "0 0 120 64", class: "px-viz px-viz-pulse", "aria-hidden": "true" },
        svg("g", { class: "px-pulse-run" },
          svg("path", { d: "M" + pts.map(([x, y]) => `${x} ${y.toFixed(2)}`).join(" L") }),
          ...pts.map(([x, y]) => svg("circle", { cx: x, cy: y.toFixed(2), r: 1.4 }))));
    },
    // the bill of materials: one bar, each group its share (the motors are most of it)
    cost: () => el("div", { class: "px-viz px-viz-cost", "aria-hidden": "true" },
      el("div", { class: "px-cost-bar" }, ...COST.map((v, i) => el("i", {
        style: `--g:${v.toFixed(2)};--i:${i}`, title: `${L.specs.costGroups[i]} · ${eurFmt(v)}` }))),
      el("div", { class: "px-cost-key" },
        el("span", null, el("b", { class: "k0" }), `${L.specs.costGroups[0]} ${numFmt((COST[0] / costTotal) * 100, 0)} %`),
        el("span", null, el("b", { class: "k1" }), L.specs.costGroups.slice(1, 3).join(", ") + " …"))),
  };
  const statEls = STATS.map((n, i) => {
    const val = el("span", { class: "px-stat-v" }, n.cur ? eurFmt(n.v) : numFmt(n.v, n.d || 0));
    return { n, val, node: el("div", { class: "px-stat reveal", style: `--d:${i * 90}ms` },
      el("div", { class: "px-stat-viz" }, statViz[n.viz]()),
      el("div", { class: "px-stat-big" + (n.cur ? " cur" : "") }, val,
        n.u ? el("span", { class: "px-stat-u" + (n.u === "°" ? " deg" : "") }, n.u) : null),
      el("div", { class: "px-stat-l" }, L.specs.stats[i])) };
  });
  const countUp = () => {
    if (reducedMotion()) return;
    const t0 = performance.now(), dur = 1500;
    const tick = (now) => {
      const f = Math.min(1, (now - t0) / dur), e = 1 - (1 - f) ** 3;
      for (const { n, val } of statEls) val.textContent = n.cur ? eurFmt(n.v * e) : numFmt(n.v * e, n.d || 0);
      if (f < 1 && root.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const statsBand = el("div", { class: "px-stats" }, ...statEls.map((x) => x.node));
  // the full sheet lives near the end of the page, the way Apple sets it; the
  // figures point to it
  const statsMore = el("div", { class: "px-stats-more reveal" });

  const specsSec = el("section", { class: "px-sec px-specsec" },
    el("div", { class: "px-sec-head" },
      el("div", { class: "px-kicker reveal" }, L.specs.kicker),
      el("h2", { class: "px-h2 reveal", style: "--d:60ms" }, L.specs.head),
      el("p", { class: "px-lede reveal", style: "--d:120ms" }, L.specs.sub)),
    tourTrack, statsBand, statsMore);

  // ---------- tech specs: set the way Apple sets them ----------
  // Owner, round 3: "fix the tech specs ... do it like Apple would do it".
  // So: a white sheet of its own, a label column, short items each led by a
  // line icon, three drawings where words are weaker (the dimensioned plan
  // view, the finger's range of motion, the controller), and the fine print
  // as numbered notes at the foot. Every line of the old instrument sheet is
  // here; the honesty notes (targets, the bench setup, no metal fabricated,
  // indicative prices) are the footnotes.
  const tsIcon = (name) => svg("svg", { viewBox: "0 0 24 24", width: 28, height: 28, "aria-hidden": "true" },
    ...TS_ICONS[name].map((d) => svg("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 1.5,
      "stroke-linecap": "round", "stroke-linejoin": "round" })));
  const tsItem = ([h, p], icon) => el("div", { class: "px-ts-item" },
    icon ? el("span", { class: "px-ts-ico" }, tsIcon(icon)) : null,
    el("h4", null, h), el("p", null, p));
  const tsRow = (k, ...content) => el("div", { class: "px-ts-row reveal" },
    el("h3", { class: "px-ts-k" }, k), el("div", { class: "px-ts-v" }, ...content));
  const mm = (v) => `${numFmt(v, 0)} mm`;

  // the finger's range of motion: a ghost of the straight finger, the finger
  // itself curling into it as the row arrives (MCP 90 deg, then PIP 110 deg),
  // the two arcs in sapphire. Rotations are SVG rotate(a cx cy) on nested
  // groups, so each joint turns about its own pivot in its parent's frame.
  const ROM = { mcp: [96, 70], pip: [160, 70], dip: [206, 70], tip: [240, 70] };
  function romFigure() {
    const seg = (a, b, cls) => svg("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: cls });
    const joint = (p, cls = "") => svg("circle", { cx: p[0], cy: p[1], r: 5, class: "px-rom-j " + cls });
    const tx = (x, y, t, anchor, cls) => svg("text", { x, y, "text-anchor": anchor, class: cls }, t);
    const dip = svg("g", { class: "px-rom-dip" }, seg(ROM.dip, ROM.tip, "px-rom-flex"), joint(ROM.dip));
    const pip = svg("g", { class: "px-rom-pip" }, seg(ROM.pip, ROM.dip, "px-rom-flex"), dip, joint(ROM.pip));
    const mcp = svg("g", { class: "px-rom-mcp" }, seg(ROM.mcp, ROM.pip, "px-rom-flex"), pip);
    const at = (c, r, deg) => [c[0] + r * Math.cos(deg * Math.PI / 180), c[1] + r * Math.sin(deg * Math.PI / 180)];
    const flexPip = [ROM.mcp[0], ROM.mcp[1] + (ROM.pip[0] - ROM.mcp[0])];          // where the PIP lands at MCP 90
    const [m0, m1] = [at(ROM.mcp, 42, 0), at(ROM.mcp, 42, 90)];
    const [p0, p1] = [at(flexPip, 26, 90), at(flexPip, 26, 200)];
    const fig = svg("svg", { viewBox: "0 0 260 190", class: "px-fig px-rom", role: "img", "aria-label": "MCP 90°, PIP 110°" },
      svg("rect", { x: 10, y: 56, width: 86, height: 28, rx: 10, class: "px-rom-palm" }),
      seg(ROM.mcp, ROM.tip, "px-rom-ghost"),
      svg("path", { d: `M${m0[0]} ${m0[1]} A42 42 0 0 1 ${m1[0].toFixed(2)} ${m1[1].toFixed(2)}`, class: "px-rom-arc" }),
      svg("path", { d: `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A26 26 0 0 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`, class: "px-rom-arc" }),
      mcp, joint(ROM.mcp),
      tx(140, 118, "90°", "start", "px-rom-deg"), tx(64, 176, "110°", "end", "px-rom-deg"),
      tx(ROM.mcp[0], 44, "MCP", "middle", "px-rom-lab"), tx(ROM.pip[0], 44, "PIP", "middle", "px-rom-lab"));
    // curl once when the row arrives; reduced motion lands the pose at once
    const pose = (k) => {
      mcp.setAttribute("transform", `rotate(${(90 * k).toFixed(2)} ${ROM.mcp[0]} ${ROM.mcp[1]})`);
      pip.setAttribute("transform", `rotate(${(110 * k).toFixed(2)} ${ROM.pip[0]} ${ROM.pip[1]})`);
      dip.setAttribute("transform", `rotate(${(45 * k).toFixed(2)} ${ROM.dip[0]} ${ROM.dip[1]})`);
    };
    pose(0);
    const romIO = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      romIO.disconnect();
      if (reducedMotion()) { pose(1); return; }
      const t0 = performance.now() + 250, dur = 1600;
      const step = (now) => {
        const f = clamp((now - t0) / dur, 0, 1);
        pose(f * f * (3 - 2 * f));
        if (f < 1 && root.isConnected) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, { threshold: 0.6 });
    romIO.observe(fig);
    cleanups.push(() => romIO.disconnect());
    return fig;
  }
  // the controller: chip art, the way a phone launch draws its silicon
  function chipFigure() {
    const pins = [];
    for (let i = 0; i < 8; i++) {
      const o = 52 + i * 13.7;
      pins.push(svg("rect", { x: o - 2, y: 22, width: 4, height: 12, rx: 1.5 }), svg("rect", { x: o - 2, y: 166, width: 4, height: 12, rx: 1.5 }),
        svg("rect", { x: 22, y: o - 2, width: 12, height: 4, rx: 1.5 }), svg("rect", { x: 166, y: o - 2, width: 12, height: 4, rx: 1.5 }));
    }
    return svg("svg", { viewBox: "0 0 200 200", class: "px-fig px-chip", role: "img", "aria-label": "Teensy 4.1, 600 MHz" },
      svg("defs", {},
        svg("linearGradient", { id: "pxchip", x1: 0, y1: 0, x2: 1, y2: 1 },
          svg("stop", { offset: 0, "stop-color": "#2E3540" }), svg("stop", { offset: 1, "stop-color": "#0C0F13" })),
        svg("linearGradient", { id: "pxchipt", x1: 0, y1: 0, x2: 1, y2: 0 },
          svg("stop", { offset: 0, "stop-color": "#FFFFFF" }), svg("stop", { offset: 1, "stop-color": "#9CC8F2" }))),
      svg("g", { class: "px-chip-pins" }, ...pins),
      svg("rect", { x: 34, y: 34, width: 132, height: 132, rx: 20, fill: "url(#pxchip)" }),
      svg("rect", { x: 42, y: 42, width: 116, height: 116, rx: 14, class: "px-chip-edge" }),
      svg("text", { x: 100, y: 86, "text-anchor": "middle", class: "px-chip-k" }, "TEENSY"),
      svg("text", { x: 100, y: 128, "text-anchor": "middle", class: "px-chip-n", fill: "url(#pxchipt)" }, "4.1"),
      svg("text", { x: 100, y: 148, "text-anchor": "middle", class: "px-chip-f" }, "600 MHz"));
  }
  // the bill of materials: one bar, every priced group its share
  const costFigure = () => el("div", { class: "px-fig px-ts-cost" },
    el("div", { class: "px-ts-cost-bar" }, ...COST.map((v, i) => el("i", { style: `--g:${v.toFixed(2)};--i:${i}` }))),
    el("ul", { class: "px-ts-cost-key" }, ...COST.map((v, i) => el("li", null,
      el("b", { style: `--i:${i}` }), el("span", null, L.specs.costGroups[i]), el("em", null, eurFmt(v))))));
  const FIGS = { rom: romFigure, chip: chipFigure, cost: costFigure };

  const tsRows = L.ts.rows.map((r, i) => {
    const lay = TS_LAYOUT[i] || {};
    const items = el("div", { class: "px-ts-items" }, ...r.items.map((it, j) => tsItem(it, lay.icons && lay.icons[j])));
    return tsRow(r.k, lay.fig ? el("div", { class: "px-ts-figrow fig-" + lay.fig }, FIGS[lay.fig](), items) : items);
  });
  const finishRow = tsRow(L.ts.finishK,
    el("div", { class: "px-ts-fins" }, ...FINISHES.map((f) => el("figure", { class: "px-ts-fin" },
      el("img", { src: `assets/px/plan-${f}.webp`, alt: `TAKTO ONE · ${L.finishes[f].name}`, loading: "lazy", decoding: "async" }),
      el("figcaption", null, el("span", { class: "px-ts-sw", style: `--a:${SWATCH[f][0]};--b:${SWATCH[f][1]}` }), L.finishes[f].name)))),
    el("p", { class: "px-ts-note" }, L.ts.finishP));
  // the plan view as a line drawing, dimensioned (the CAD assembly as
  // modelled: DIMS), beside the figures in words
  const sizeRow = tsRow(L.ts.sizeK,
    el("div", { class: "px-ts-size" },
      el("div", { class: "px-ts-draw" },
        el("img", { src: "assets/px/outline-top.webp", alt: "TAKTO ONE, plan view", loading: "lazy", decoding: "async" }),
        el("span", { class: "px-dim w", "aria-hidden": "true" }, el("i"), el("b", null, mm(DIMS.wid))),
        el("span", { class: "px-dim l", "aria-hidden": "true" }, el("i"), el("b", null, mm(DIMS.len))),
        el("span", { class: "px-dim o", "aria-hidden": "true" }, el("i"), el("b", null, mm(DIMS.overall)))),
      el("div", { class: "px-ts-dims" },
        el("div", { class: "px-ts-dg" }, el("h4", null, L.ts.unit + "¹"),
          ...[DIMS.len, DIMS.wid, DIMS.hei].map((v, i) => el("p", null, el("span", null, L.ts.dims[i]), el("b", null, mm(v))))),
        el("div", { class: "px-ts-dg" }, el("h4", null, L.ts.overall + "¹"),
          el("p", { class: "big" }, mm(DIMS.overall)), el("p", { class: "sub" }, L.ts.overallP)),
        el("div", { class: "px-ts-dg" }, el("h4", null, L.ts.hand),
          el("p", { class: "big" }, "< 150 g²"), el("p", { class: "sub" }, L.ts.handP)))));
  const techSpecs = el("section", { class: "px-ts", "aria-label": L.ts.head },
    el("div", { class: "px-ts-in" },
      el("header", { class: "px-ts-head reveal" },
        el("h2", { class: "px-ts-h" }, L.ts.head),
        el("div", { class: "px-ts-model" }, el("b", null, L.ts.model), el("span", null, L.ts.config))),
      finishRow, sizeRow, ...tsRows,
      el("ol", { class: "px-ts-notes" }, ...L.ts.notes.map((n) => el("li", null, n)))));
  const toSpecs = el("a", { href: "#", class: "px-more" }, el("span", null, L.ts.all), chevron("M6 4l4 4-4 4"));
  toSpecs.addEventListener("click", (e) => { e.preventDefault(); techSpecs.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }); });
  statsMore.append(toSpecs);

  // ---------- tech: the bento ----------

  // transparency dial: the crown, as an instrument you can turn
  const DIAL_R = 112, DIAL_SWEEP = 270;
  const arcLen = (DIAL_R * Math.PI * DIAL_SWEEP) / 180;
  const polar = (deg, r = DIAL_R) => {
    const a = (deg - 90) * Math.PI / 180;
    return [150 + r * Math.cos(a), 150 + r * Math.sin(a)];
  };
  const [ax0, ay0] = polar(-135), [ax1, ay1] = polar(135);
  const arcD = `M${ax0.toFixed(2)} ${ay0.toFixed(2)} A${DIAL_R} ${DIAL_R} 0 1 1 ${ax1.toFixed(2)} ${ay1.toFixed(2)}`;
  const dialFill = svg("path", { d: arcD, class: "px-dial-fill", "stroke-dasharray": arcLen.toFixed(1), "stroke-dashoffset": arcLen.toFixed(1) });
  const dialKnob = svg("circle", { r: 13, class: "px-dial-knob" });
  const ticks = [];
  for (let i = 0; i <= 27; i++) {
    const deg = -135 + (i * DIAL_SWEEP) / 27;
    const [x0, y0] = polar(deg, 136), [x1, y1] = polar(deg, i % 9 === 0 ? 146 : 142);
    ticks.push(svg("line", { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: "px-dial-tick" + (i % 9 === 0 ? " major" : "") }));
  }
  const dialPct = el("span", { class: "px-dial-pct" }, "0");
  const dialWord = el("span", { class: "px-dial-word" }, L.tech.dial.words[0]);
  const dialSvg = svg("svg", { viewBox: "0 0 300 300", class: "px-dial-svg", "aria-hidden": "true" },
    ...ticks,
    svg("path", { d: arcD, class: "px-dial-track" }),
    dialFill, dialKnob);
  const dialRange = el("input", { type: "range", min: 0, max: 100, step: 1, value: 0, class: "px-dial-range", "aria-label": L.tech.dial.aria });
  const dial = el("div", { class: "px-dial" }, dialSvg,
    el("div", { class: "px-dial-read" }, el("span", { class: "px-dial-num" }, dialPct, el("small", null, "%")), dialWord));
  let dialV = 0, dialTouched = false;
  function setDial(v) {
    dialV = clamp(v, 0, 1);
    dialFill.setAttribute("stroke-dashoffset", (arcLen * (1 - dialV)).toFixed(1));
    const [kx, ky] = polar(-135 + dialV * DIAL_SWEEP);
    dialKnob.setAttribute("cx", kx.toFixed(2)); dialKnob.setAttribute("cy", ky.toFixed(2));
    const pct = Math.round(dialV * 100);
    dialPct.textContent = String(pct);
    if (+dialRange.value !== pct) dialRange.value = String(pct);
    dialRange.style.setProperty("--fill", pct + "%");
    const w = L.tech.dial.words;
    dialWord.textContent = dialV < 0.15 ? w[0] : dialV > 0.85 ? w[2] : w[1];
    dial.style.setProperty("--v", dialV.toFixed(3));
  }
  setDial(0.18);
  const dialFromPointer = (e) => {
    const r = dialSvg.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    let deg = Math.atan2(x, -y) * 180 / Math.PI;          // 0 at the top, clockwise
    if (Math.abs(deg) > 135) deg = dialV > 0.5 ? 135 : -135; // the gap at the bottom: hold the nearer end
    setDial((deg + 135) / DIAL_SWEEP);
  };
  dialSvg.addEventListener("pointerdown", (e) => {
    dialTouched = true;
    dialSvg.setPointerCapture(e.pointerId);
    dialFromPointer(e);
    const move = (ev) => dialFromPointer(ev);
    const up = () => { dialSvg.removeEventListener("pointermove", move); dialSvg.removeEventListener("pointerup", up); dialSvg.removeEventListener("pointercancel", up); };
    dialSvg.addEventListener("pointermove", move);
    dialSvg.addEventListener("pointerup", up);
    dialSvg.addEventListener("pointercancel", up);
  });
  dialRange.addEventListener("input", () => { dialTouched = true; setDial(+dialRange.value / 100); });

  const tile = (cls, ...kids) => el("article", { class: "px-tile " + cls + " reveal" }, ...kids);
  const tileText = (t) => el("div", { class: "px-tile-txt" },
    el("div", { class: "px-kicker" }, t.kicker), el("h3", null, t.head), el("p", null, t.p));

  // the watch face: the console's own renderer, cycling the real stages
  const faceCv = el("canvas", { class: "px-face-cv", "aria-hidden": "true" });
  const faceScreen = new DeviceScreen(faceCv);
  const FACE_STAGES = ["home", "transparent", "capture", "saved"];
  let faceStage = "home", faceSince = performance.now(), faceHeld = 0;
  const faceChips = Object.fromEntries(FACE_STAGES.map((s) => {
    const b = el("button", { type: "button", class: "px-face-chip" + (s === faceStage ? " on" : "") }, L.tech.face.modes[s]);
    b.addEventListener("click", () => { setFace(s); faceHeld = performance.now() + 12000; });
    return [s, b];
  }));
  function setFace(s) {
    faceStage = s; faceSince = performance.now();
    for (const k of FACE_STAGES) faceChips[k].classList.toggle("on", k === s);
  }
  const faceState = (now) => {
    const t = (now - faceSince) / 1000;
    const health = { imu: true, enc: true, drv: true, lnk: true };
    if (faceStage === "transparent") return { screen: "transparent", health, effort: 0.42 + 0.3 * Math.sin(t * 1.3), assist: true };
    if (faceStage === "capture") return { screen: "capture", health, recSec: t, recording: true };
    if (faceStage === "saved") return { screen: "saved", health, summaryOk: true };
    return { screen: "home", health };
  };

  // EMG: the store's activation series (live or simulated, and labelled as
  // such); a quiet procedural envelope when the feed carries no EMG at all
  const emgCv = el("canvas", { class: "px-emg-cv", "aria-hidden": "true" });
  const emgTag = el("span", { class: "px-src-tag" }, "");
  const emgChart = new StripChart(emgCv, { min: 0, max: 1, windowMs: 6000, width: 1.8, fill: true });
  const emgSynth = { t: [], v: [] };
  const sdClock = el("span", { class: "px-sd-clock" }, "00:00:00");

  const tech = el("section", { class: "px-sec px-tech" },
    el("div", { class: "px-sec-head" },
      el("div", { class: "px-kicker reveal" }, L.tech.kicker),
      el("h2", { class: "px-h2 reveal", style: "--d:60ms" }, L.tech.head)),
    el("div", { class: "px-bento" },
      tile("px-t-dial",
        tileText(L.tech.dial),
        el("div", { class: "px-dial-wrap" }, dial, dialRange,
          el("div", { class: "px-dial-scale" }, ...L.tech.dial.words.map((w) => el("span", null, w))))),
      tile("px-t-face dark",
        el("div", { class: "px-face" }, el("div", { class: "px-face-bezel" }, faceCv)),
        el("div", { class: "px-face-chips" }, ...Object.values(faceChips)),
        tileText(L.tech.face)),
      tile("px-t-img",
        el("img", { src: "assets/px/detail-joints.webp", alt: "", loading: "lazy", decoding: "async" }),
        el("div", { class: "px-tile-num" }, "0.088°"),
        tileText(L.tech.enc)),
      tile("px-t-img",
        el("img", { src: "assets/px/detail-spools.webp", alt: "", loading: "lazy", decoding: "async" }),
        tileText(L.tech.tendon)),
      tile("px-t-safe",
        el("div", { class: "px-safe-n" }, L.tech.safe.n),
        tileText(L.tech.safe)),
      tile("px-t-emg",
        tileText(L.tech.emg),
        el("div", { class: "px-emg" }, emgCv, emgTag)),
      tile("px-t-sd",
        tileText(L.tech.sd),
        el("div", { class: "px-sd" }, el("span", { class: "px-sd-dot" }), el("span", { class: "px-sd-rec" }, "REC"), sdClock))));

  // ---------- the live twin ----------
  const twinStage = el("div", { class: "px-twin-stage" });
  // the badges still claim the page's source indicator; the twin itself
  // says what it shows: the live device, or the showroom's demo motion
  const [, linkBadge] = sourceBadges(cleanups);
  const livePill = el("span", { class: "px-live-pill" }, el("span", { class: "dot live" }), L.twin.live);
  const demoPill = el("button", { type: "button", class: "px-live-pill px-demo-pill",
    title: "No TAKTO connected: a demo choreography. Click to look for a TAKTO bridge again." },
    el("span", { class: "dot" }), L.twin.demo);
  demoPill.addEventListener("click", () => { if (store.retryLive) store.retryLive(); });
  const liveNow = () => store.sourceKind === "ws" && store.connected;
  const paintLive = () => { const on = liveNow(); livePill.hidden = !on; demoPill.hidden = on; };
  paintLive();
  cleanups.push(store.onSource(paintLive), store.onLink(paintLive));
  // the showroom state: the store's shape, written in place every frame
  const show = { joints: {}, curl: 0, fingers: {}, handQuat: [1, 0, 0, 0], forearmQuat: [1, 0, 0, 0],
    wristQuat: null, jointOk: {}, body: null, poseLane: false, thumbRel: null, rel: null, blend: null,
    activation: { level: 0, fatigue: 0, direction: 0 }, motors: {} };
  function showPose(sec) {
    const tm = sec % 12;
    let grip = 0;
    SHOW_FINGERS.forEach((f, i) => {
      const roll = bump(tm, 1.6 + i * 0.42, 0.95);           // a finger roll, index to little
      const grasp = bump(tm, 7.8 + (3 - i) * 0.14, 1.6);     // a soft grasp, the little finger first
      const c = 0.16 + 0.035 * Math.sin(sec * 0.9 + i * 1.3) + 0.56 * roll + 0.5 * grasp;
      const j = curlToJoints(c);
      show.joints[`${f}_mcp`] = SHOW_SPLAY[i] * (1 - 0.8 * c);  // abduction closes as the hand closes
      show.joints[`${f}_pip`] = j.mcpDeg;
      show.joints[`${f}_dip`] = j.pipDeg;
      show.fingers[f] = c;
      grip = Math.max(grip, grasp);
    });
    show.curl = grip;
    show.activation.level = 0.12 + 0.55 * grip;
    // the wrist breathes: a few degrees of flexion and deviation
    show.handQuat = qMul(qRx(5 * Math.sin(sec * 0.45) - 4 * grip), qRy(3 * Math.sin(sec * 0.31 + 1)));
    return show;
  }
  const twinSec = el("section", { class: "px-sec px-twin" },
    el("div", { class: "px-twin-panel reveal" },
      twinStage,
      el("div", { class: "px-twin-txt" },
        el("div", { class: "px-kicker" }, L.twin.kicker),
        el("h2", { class: "px-h2" }, L.twin.head),
        el("p", null, L.twin.p)),
      el("div", { class: "px-twin-badges" }, livePill, demoPill, linkBadge),
      el("div", { class: "px-twin-hint" }, chevron("M6 4L2 8l4 4M10 4l4 4-4 4"), L.twin.hint),
      el("div", { class: "px-twin-cta" }, pillBtn(L.twin.open, "#/operator", "light"))));

  // ---------- film ----------
  const video = el("video", { class: "px-film-v", poster: "assets/px/film-poster.jpg", preload: "none",
    playsinline: "", src: "assets/film/takto_60s.mp4", "aria-label": L.film.alt });
  const playBtn = el("button", { type: "button", class: "px-play", "aria-label": L.film.play },
    el("span", { class: "px-play-ico" }, svg("svg", { viewBox: "0 0 16 16", width: 18, height: 18, "aria-hidden": "true" },
      svg("path", { d: "M5 3.5v9l7.5-4.5z", fill: "currentColor" }))),
    el("span", null, L.film.play));
  const filmFrame = el("div", { class: "px-film-frame reveal", style: "--d:80ms" }, video, playBtn);
  playBtn.addEventListener("click", () => {
    video.controls = true;
    filmFrame.classList.add("playing");
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  });
  const film = el("section", { class: "px-sec px-film" },
    el("div", { class: "px-sec-head" },
      el("div", { class: "px-kicker reveal" }, L.film.kicker),
      el("h2", { class: "px-h2 reveal", style: "--d:60ms" }, L.film.head)),
    filmFrame);

  // ---------- console: one door; the modes live inside it ----------
  const consoleSec = el("section", { class: "px-sec px-console" },
    el("div", { class: "px-console-card reveal" },
      el("div", { class: "px-console-txt" },
        el("div", { class: "px-kicker" }, L.console.kicker),
        el("h2", { class: "px-h2" }, L.console.head),
        el("p", { class: "px-console-p" }, L.console.p),
        pillBtn(L.console.open, "#/operator", "dark"),
        el("div", { class: "px-console-inside" },
          el("span", { class: "px-console-k" }, L.console.inside),
          el("div", { class: "px-console-modes" },
            ...MODES.map((m) => el("a", { class: "px-mode", href: "#/" + m }, L.console.modes[m]))))),
      el("div", { class: "px-console-art", "aria-hidden": "true" },
        el("img", { src: "assets/px/onyx-angled.webp", alt: "", loading: "lazy", decoding: "async" }))));

  // ---------- build ----------
  const build = el("section", { class: "px-sec px-build" },
    el("div", { class: "px-sec-head" },
      el("div", { class: "px-kicker reveal" }, L.build.kicker),
      el("h2", { class: "px-h2 reveal", style: "--d:60ms" }, L.build.head)),
    el("div", { class: "px-cards" },
      ...L.build.cards.map((c, i) => el("a", { class: "px-card reveal", style: `--d:${80 + i * 80}ms`,
        href: BUILD_LINKS[i], target: "_blank", rel: "noopener" },
        el("div", { class: "px-kicker" }, c.k),
        el("h3", null, c.h),
        el("p", null, c.p),
        el("span", { class: "px-card-go" }, c.label, arrow())))));

  // ---------- creed ----------
  // owner, round 3: the idea "could be explained much better". So it opens on
  // one plain line (the hammer is about the house, not the nail) and the
  // paragraph says what the finger stands for, with examples
  const creed = el("section", { class: "px-sec px-creed" },
    el("div", { class: "px-kicker reveal" }, L.creed.kicker),
    el("h2", { class: "px-creed-h reveal", style: "--d:60ms" }, L.creed.head),
    el("p", { class: "px-quote reveal", style: "--d:140ms" }, L.creed.p),
    el("div", { class: "px-quote-by reveal", style: "--d:200ms" }, L.creed.by));

  // ---------- compliance ----------
  // Honesty rules (thesis ch. "market viability"): a research instrument, NOT
  // a certified medical device; standards are named ONLY as the mapped route.
  const compliance = el("section", { class: "px-sec px-comp" },
    el("div", { class: "px-sec-head" },
      el("div", { class: "px-kicker reveal" }, L.compliance.kicker),
      el("h2", { class: "px-h2 reveal", style: "--d:60ms" }, L.compliance.head),
      el("p", { class: "px-lede reveal", style: "--d:120ms" }, L.compliance.p)),
    fold(L.compliance.cue,
      el("div", { class: "px-comp-row" },
        ...L.compliance.cards.map((c) => el("div", { class: "px-comp-card" },
          el("div", { class: "px-kicker" }, c.k), el("p", null, c.p)))),
      el("p", { class: "px-fine" }, L.compliance.finePre,
        el("a", { href: "legal.html", target: "_blank", rel: "noopener" }, L.compliance.fineLink), ".")));

  // ---------- contact ----------
  const contact = el("section", { class: "px-sec px-contact" },
    el("div", { class: "px-contact-card reveal" },
      el("div", { class: "px-kicker" }, L.write.kicker),
      el("h2", { class: "px-h2" }, L.write.head),
      el("p", null, L.write.p1),
      el("p", null, L.write.p2),
      el("div", { class: "px-chips" }, ...L.craft.map((c) => el("span", { class: "px-chip" }, c))),
      el("div", { class: "px-contact-btns" },
        pillBtn(L.write.contact, MAIL, "light"),
        el("a", { class: "px-ghost", href: "https://github.com/molanocortes", target: "_blank", rel: "noopener" }, L.write.github))));

  const toTop = el("a", { href: "#", class: "px-foot-link" }, L.foot.top);
  toTop.addEventListener("click", (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" }); });
  const foot = el("footer", { class: "px-foot" },
    el("div", { class: "px-foot-brand" },
      el("img", { src: "assets/brand/takto-logo.svg", alt: "TAKTO", class: "px-foot-logo", width: 93, height: 18 }),
      el("span", { class: "px-foot-line" }, L.foot.line)),
    el("div", { class: "px-foot-links" },
      el("a", { class: "px-foot-link", href: "#/operator" }, L.nav.console),
      el("a", { class: "px-foot-link", href: REPO, target: "_blank", rel: "noopener" }, "GitHub"),
      el("a", { class: "px-foot-link", href: "legal.html", target: "_blank", rel: "noopener" }, L.foot.legal),
      toTop));

  root.append(nav, hero, intro, turn, specsSec, finishSec, tech, twinSec, film, consoleSec, techSpecs, build, creed, compliance, contact, foot);
  rootHost.append(root);
  Object.assign(sectionFor, { design: turn, specs: specsSec, tech, build, contact });
  const numsIO = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { numsIO.disconnect(); countUp(); }
  }, { threshold: 0.3 });
  numsIO.observe(statsBand);
  cleanups.push(() => numsIO.disconnect());
  heroDown.addEventListener("click", () => intro.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }));

  // ================= life =================

  // ---------- hero fit ----------
  // The wordmark spans 82% of the card; the device takes what the height
  // allows. Measured, not guessed: the display face differs per platform
  // (Futura on Apple, a geometric fallback elsewhere).
  function fitHero() {
    const W = heroCard.clientWidth, H = heroCard.clientHeight;
    const stacked = stackMQ.matches;
    word.style.fontSize = "100px";
    const w100 = word.getBoundingClientRect().width;
    if (!w100) return;
    const fs = stacked ? clamp((100 * (W - 36)) / w100, 48, 150) : clamp((100 * W * 0.76) / w100, 90, H * 0.33);
    word.style.fontSize = fs.toFixed(1) + "px";
    const devW = stacked ? Math.min(W * 0.9, 560) : Math.min(W * 0.56, H * 0.66 * (HERO_W / HERO_H));
    heroCard.style.setProperty("--devw", devW.toFixed(1) + "px");
  }
  // the floating device leans a little toward the pointer: depth, not motion
  // for its own sake (fine pointers only; never with reduced motion)
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  if (finePointer && !reducedMotion()) {
    const lean = (e) => {
      const r = heroCard.getBoundingClientRect();
      const mx = (e.clientX - r.left) / r.width - 0.5, my = (e.clientY - r.top) / r.height - 0.5;
      device.style.transform = `translate3d(${(mx * 18).toFixed(1)}px, ${(my * 10).toFixed(1)}px, 0) rotate(${(mx * 1.2).toFixed(2)}deg)`;
    };
    const rest = () => { device.style.transform = ""; };
    heroCard.addEventListener("pointermove", lean);
    heroCard.addEventListener("pointerleave", rest);
  }
  const stackMQ = window.matchMedia("(max-width: 780px)");
  const heroRO = new ResizeObserver(() => fitHero());
  heroRO.observe(heroCard);
  cleanups.push(() => heroRO.disconnect());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (root.isConnected) fitHero(); });
  fitHero();
  // the entrance plays on the first frame; a timer backs it up, because a tab
  // opened in the background runs no frames and the hero would wait unseen
  const heroIn = () => heroCard.classList.add("in");
  requestAnimationFrame(heroIn);
  const heroInTimer = setTimeout(heroIn, 160);
  cleanups.push(() => clearTimeout(heroInTimer));

  // ---------- scroll geometry (sticky offsets, the tour stage), per resize ----------
  const geo = { turnStick: 0, turnStickH: 0, tourStick: 0, tourStickH: 0, Ws: 0, Hs: 0 };
  function measureGeo() {
    geo.turnStick = parseFloat(getComputedStyle(turnSticky).top) || 0;
    geo.turnStickH = turnSticky.offsetHeight;
    geo.tourStick = parseFloat(getComputedStyle(tourSticky).top) || 0;
    geo.tourStickH = tourSticky.offsetHeight;
    geo.Ws = tourStage.clientWidth; geo.Hs = tourStage.clientHeight;
  }
  measureGeo();

  // ---------- turn: frames, coarse to fine ----------
  const frames = new Array(TURN_N).fill(null);
  let turnLoading = false, turnIdx = 0, turnShown = null, turnFront = 0;
  function loadTurn() {
    if (turnLoading) return;
    turnLoading = true;
    // the 2240 px cut wherever the panel has the pixels for it (any desktop,
    // any retina tablet); phones take the 1120 px cut
    const hi = turnCv.clientWidth * Math.min(2, window.devicePixelRatio || 1) > 1000;
    // every 6th frame first, so the whole turn is scrubbable within ~15
    // requests; the in-between frames fill in behind it
    const order = [];
    for (const stepN of [6, 3, 1]) for (let i = 0; i < TURN_N; i += stepN) if (!order.includes(i)) order.push(i);
    let k = 0;
    const lane = () => {
      if (k >= order.length || !root.isConnected) return;
      const i = order[k++];
      const fetchFrame = (lo) => {
        const im = new Image();
        im.decoding = "async";
        im.src = turnSrc(i, hi && !lo);
        // decoded BEFORE it joins the set: a draw mid-scroll must never stop
        // to decode a 2240 px picture on the main thread
        im.decode().then(() => {
          frames[i] = im;
          if (Math.abs(i - turnIdx) <= 3 || !turnShown) requestTurnDraw();
          lane();
        }, () => {
          // a missing large frame falls back to the small cut of the same angle
          if (hi && !lo) fetchFrame(true); else lane();
        });
      };
      fetchFrame(false);
    };
    for (let c = 0; c < 4; c++) lane();
  }
  function nearestFrame(i) {
    for (let d = 0; d < TURN_N / 2; d++) {
      const a = frames[(i + d) % TURN_N]; if (a) return a;
      const b = frames[(i - d + TURN_N) % TURN_N]; if (b) return b;
    }
    return null;
  }
  // the back buffer takes the new angle; it comes to the front once decoded
  // (frames are decoded as they join the set, so that is at once), and the
  // shown angle never blanks while the next one is getting ready
  function drawTurn() {
    const im = nearestFrame(turnIdx);
    if (!im || im === turnShown) return;
    turnShown = im;
    const back = turnImgs[turnFront ^ 1];
    back.src = im.src;
    back.decode().catch(() => {}).then(() => {
      if (turnShown !== im || !root.isConnected) return;   // a newer angle took over
      back.classList.add("on");
      turnImgs[turnFront].classList.remove("on");
      turnFront ^= 1;
    });
  }
  // A fast flick runs the index through dozens of angles a second, and every
  // new angle is a fresh picture to raster. Swaps are paced to ~30 a second -
  // at that speed the eye cannot tell - and the angle the scroll comes to
  // rest on always lands.
  let turnDrawAt = 0, turnDrawRaf = 0;
  function requestTurnDraw() {
    const now = performance.now();
    if (now - turnDrawAt >= 30) { turnDrawAt = now; drawTurn(); return; }
    if (!turnDrawRaf) turnDrawRaf = requestAnimationFrame(() => { turnDrawRaf = 0; requestTurnDraw(); });
  }
  cleanups.push(() => cancelAnimationFrame(turnDrawRaf));

  let turnCap = 0, turnP = -1, turnDegText = "0°";
  function onTurnScroll(r) {
    const span = r.height - geo.turnStickH;
    const p = span > 0 ? clamp((geo.turnStick - r.top) / span, 0, 1) : 0;
    if (p === turnP) return;            // above or below it: nothing moved
    turnP = p;
    const idx = Math.round(p * TURN_N) % TURN_N;
    turnFill.style.transform = `scaleX(${p.toFixed(4)})`;
    const deg = `${Math.round(p * 360)}°`;
    if (deg !== turnDegText) { turnDegText = deg; turnDeg.textContent = deg; }
    const cap = Math.min(turnCaps.length - 1, Math.floor(p * turnCaps.length));
    if (cap !== turnCap) {
      turnCap = cap;
      turnCaps.forEach((c, i) => c.classList.toggle("on", i === cap));
    }
    if (idx !== turnIdx) { turnIdx = idx; requestTurnDraw(); }
  }

  // ---------- the specs tour: scroll position -> camera on the render ----------
  // Each step holds for two thirds of its stretch and travels in the middle
  // third, so every part rests long enough to read. The part in focus lands
  // where the caption card leaves room (right of it on wide panels, above it
  // on phones), and the spotlight holds that spot while the render slides
  // underneath, like a camera moving from part to part.
  let tourStep = -1;
  const tourSpan = () => {
    const r = tourTrack.getBoundingClientRect();
    return { r, stickTop: geo.tourStick, span: r.height - geo.tourStickH };
  };
  const tourFocus = (Ws, Hs) => stackMQ.matches ? { x: Ws * 0.5, y: Hs * 0.32 } : { x: Ws * 0.63, y: Hs * 0.44 };
  function tourPose(k, Ws, Hs, lw, lh) {
    const phone = stackMQ.matches;
    if (k === 0) {
      // the whole machine, clear of the card: centred, a little high
      const s0 = phone ? 1.02 : 0.86;
      return { s: s0, tx: Ws * (phone ? 0.5 : 0.55) - s0 * 0.5 * lw, ty: Hs * (phone ? 0.3 : 0.36) - s0 * 0.5 * lh };
    }
    const f = tourFocus(Ws, Hs);
    const [cx, cy] = CALLOUT_AT[k - 1], s = TOUR_ZOOM[k - 1] * (phone ? 1.3 : 1);
    return { s, tx: f.x - s * (cx / 100) * lw, ty: f.y - s * (cy / 100) * lh };
  }
  let tourLW = -1, tourPoseKey = "", tourSpotKey = "";
  function onTourScroll(r) {
    const span = r.height - geo.tourStickH;
    if (span <= 0 || r.bottom < 0 || r.top > window.innerHeight) return;
    const pr = clamp((geo.tourStick - r.top) / span, 0, 1);
    const p = pr * TOUR_N;
    const i = Math.min(Math.floor(p), TOUR_N - 1), fr = p - i;
    const t = clamp((fr - 0.33) / 0.34, 0, 1), e = t * t * (3 - 2 * t);
    const Ws = geo.Ws, Hs = geo.Hs, lw = Ws, lh = Ws * ANAT_H / ANAT_W;
    // the camera only moves in the middle third of a step; while it holds, the
    // layer, the pins and the spotlight are left alone (the spotlight is a
    // painted gradient: rewriting it every frame repainted the whole stage)
    const poseKey = `${i}|${e.toFixed(4)}|${Ws}|${Hs}`;
    if (poseKey !== tourPoseKey) {
      tourPoseKey = poseKey;
      const A = tourPose(i, Ws, Hs, lw, lh), B = tourPose(Math.min(i + 1, TOUR_N), Ws, Hs, lw, lh);
      const sc = A.s + (B.s - A.s) * e, tx = A.tx + (B.tx - A.tx) * e, ty = A.ty + (B.ty - A.ty) * e;
      if (lw !== tourLW) { tourLW = lw; tourLayer.style.width = lw + "px"; }
      tourLayer.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${sc.toFixed(4)})`;
      tourPins.forEach((pin, k) => {
        const [cx, cy] = CALLOUT_AT[k];
        pin.style.transform = `translate3d(${(tx + sc * (cx / 100) * lw).toFixed(1)}px, ${(ty + sc * (cy / 100) * lh).toFixed(1)}px, 0)`;
      });
      // the spotlight: wide open on the whole machine, closing onto the focus
      const f = tourFocus(Ws, Hs);
      const rOpen = Math.hypot(Ws, Hs), rPart = Math.min(Ws, Hs) * (stackMQ.matches ? 0.3 : 0.27);
      const rad = i === 0 ? rOpen + (rPart - rOpen) * e : rPart;
      const spot = `${f.x.toFixed(1)}|${f.y.toFixed(1)}|${rad.toFixed(1)}`;
      if (spot !== tourSpotKey) {
        tourSpotKey = spot;
        tourSpot.style.setProperty("--sx", f.x.toFixed(1) + "px");
        tourSpot.style.setProperty("--sy", f.y.toFixed(1) + "px");
        tourSpot.style.setProperty("--sr", rad.toFixed(1) + "px");
      }
    }
    tourProg.style.transform = `scaleX(${pr.toFixed(4)})`;
    tourChaps.forEach((c, k) => {
      const n = k + 1, w = n === TOUR_N ? 0.5 : 1;
      c.fill.style.transform = `scaleX(${clamp((p - (n - 0.5)) / w, 0, 1).toFixed(3)})`;
    });
    const step = i + (e > 0.5 ? 1 : 0);
    if (step === tourStep) return;
    tourStep = step;
    tourCaps.forEach((c, k) => c.classList.toggle("on", k === step));
    tourChaps.forEach((c, k) => { c.b.classList.toggle("on", k + 1 === step); c.b.classList.toggle("done", k + 1 < step); });
    tourPins.forEach((pin, k) => {
      pin.classList.toggle("on", k + 1 === step);
      pin.classList.toggle("dim", step > 0 && k + 1 !== step);
    });
  }
  // a chapter or a pin takes the reader to that part (the start of its hold)
  const scrollTourTo = (k) => {
    const { r, stickTop, span } = tourSpan();
    window.scrollTo({ top: window.scrollY + r.top - stickTop + span * (k / TOUR_N) + 1,
      behavior: reducedMotion() ? "auto" : "smooth" });
  };
  tourChaps.forEach((c, k) => c.b.addEventListener("click", () => scrollTourTo(k + 1)));
  tourPins.forEach((pin, i) => pin.addEventListener("click", () => scrollTourTo(i + 1)));

  // ---------- scroll: nav state, hero parallax, the 360 ----------
  let heroH = heroCard.offsetHeight;
  // a resize can cross the phone breakpoint: the head's centring transform and
  // the tour both depend on it, so redo the whole scroll frame. The sticky
  // offsets and the stage size only change here, so they are measured here
  // instead of being re-read on every frame of a scroll.
  const onResize = () => { measureGeo(); heroH = heroCard.offsetHeight; tourStep = -1; turnP = -1; tourPoseKey = ""; onScrollFrame(); };
  window.addEventListener("resize", onResize, { passive: true });
  cleanups.push(() => window.removeEventListener("resize", onResize));
  // the panes can change size without a window resize too (fonts, the phone
  // breakpoint's own rules): watch them directly
  const geoRO = new ResizeObserver(() => onResize());
  for (const n of [turnSticky, tourSticky, tourStage, heroCard]) geoRO.observe(n);
  cleanups.push(() => geoRO.disconnect());
  let scrollRaf = 0, lastScrollAt = 0;
  const onScrollFrame = () => {
    scrollRaf = 0;
    const y = window.scrollY;
    // every read first, while layout is clean; only writes after this line
    // (the 360 used to write its label and the tour then read its rect: a
    // forced layout on every frame of every scroll)
    const turnR = turnTrack.getBoundingClientRect(), tourR = tourTrack.getBoundingClientRect();
    nav.classList.toggle("solid", y > 24);
    if (!reducedMotion() && y < heroH) {
      const k = y / heroH;
      stage.style.transform = `translate3d(0, ${(-y * 0.12).toFixed(1)}px, 0)`;
      // desktop centres the head with translateX(-50%); the phone column does not
      head.style.transform = `translate3d(${stackMQ.matches ? "0" : "-50%"}, ${(y * 0.24).toFixed(1)}px, 0) scale(${(1 - k * 0.05).toFixed(4)})`;
      head.style.opacity = String(clamp(1 - k * 1.25, 0, 1).toFixed(3));
    }
    onTurnScroll(turnR);
    onTourScroll(tourR);
  };
  const onScroll = () => { lastScrollAt = performance.now(); if (!scrollRaf) scrollRaf = requestAnimationFrame(onScrollFrame); };
  window.addEventListener("scroll", onScroll, { passive: true });
  cleanups.push(() => { window.removeEventListener("scroll", onScroll); if (scrollRaf) cancelAnimationFrame(scrollRaf); });
  onScrollFrame();

  // ---------- visibility: nothing animates off screen ----------
  const visible = new Set();
  let twin = null;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target);
      if (e.isIntersecting && e.target === turn) loadTurn();
      if (e.isIntersecting && e.target === twinSec) acquireTwinSoon();
    }
  }, { rootMargin: "600px 0px" });
  // The twin's build (renderer, studio light, materials, the model's parse) is
  // tens of milliseconds of main thread. Pay it while the visitor reads the
  // hero, never in the middle of a scroll: an idle callback can land between
  // two frames of a fling, so the kick re-arms until the page has been still
  // for half a second. The intersection above is the fallback for someone who
  // races down; it too waits for the scroll to pause (a fling past the twin
  // never pays for it), with a 2.5 s safety net for a long continuous scroll.
  const settled = (ms) => performance.now() - lastScrollAt > ms;
  let kickT = 0, soonT = 0;
  function kickTwin() {
    kickT = 0;
    if (twin || !root.isConnected) return;
    if (!settled(500)) { kickT = setTimeout(kickTwin, 400); return; }
    if (!("requestIdleCallback" in window)) { acquireTwin(); return; }
    requestIdleCallback(() => {
      if (settled(500)) acquireTwin(); else if (!twin) kickT = setTimeout(kickTwin, 400);
    }, { timeout: 2500 });
  }
  function acquireTwinSoon() {
    if (twin || soonT) return;
    const t0 = performance.now();
    const step = () => {
      soonT = 0;
      if (twin || !root.isConnected) return;
      if (settled(200) || performance.now() - t0 > 2500) acquireTwin();
      else soonT = setTimeout(step, 100);
    };
    step();
  }
  cleanups.push(() => { clearTimeout(kickT); clearTimeout(soonT); });
  function acquireTwin() {
    if (twin || !root.isConnected) return;
    // autoFrame: a live device can hold any pose (the hand far from the
    // forearm, the arm raised), so the camera frames whatever it holds
    // a 3/4 view from a little above, like the hero render; the sphere fit
    // is conservative for a long, thin machine, so the margin runs under 1
    twin = Twin.acquire(twinStage, { orbit: false, spin: true, idle: true, idleSpin: true,
      reveal: 1, yaw: -0.62, pitch: 0.42, dist: 7.2, targetY: 0.1, targetZ: -0.15,
      autoFrame: true, autoFrameMargin: 0.86, autoFrameMinDist: 4.2, autoFrameMaxDist: 13, autoFrameMaxTargetShift: 3 });
    twin.setCover(1, true); twin.setFocus(0, true);
    twin.setEmphasis({ pins: 1, jewel: 1, spools: 1 });
    twinInsets();
  }
  // the hero's entrance is compositor-only animation: the build can start under it
  kickT = setTimeout(kickTwin, 800);
  for (const s of [turn, tech, twinSec]) io.observe(s);
  cleanups.push(() => io.disconnect());

  // the words sit over the stage: the camera centres the machine in the rest
  function twinInsets() {
    if (!twin) return;
    twin.setInsets(twinStage.clientWidth > 900 ? { left: 400, bottom: 40 } : { top: 180, bottom: 76 });
  }
  window.addEventListener("resize", twinInsets, { passive: true });
  cleanups.push(() => window.removeEventListener("resize", twinInsets));

  // one frame loop for everything alive on the page
  let frameNo = 0, sdT0 = performance.now(), sdShown = -1;
  const offFrame = store.onFrame((sm, snap, dt) => {
    frameNo++;
    const now = performance.now();
    // While the page scrolls, the scroll gets the whole frame: the twin and
    // the tech panel's live canvases hold their last picture for a beat. Their
    // motion is slow - nobody sees a few held frames, everybody feels a hitch.
    const scrolling = now - lastScrollAt < 120;
    if (twin && visible.has(twinSec) && !scrolling) twin.render(liveNow() ? sm : showPose(now / 1000), dt);
    if (!visible.has(tech) || scrolling) return;
    // the dial breathes on its own until someone takes it
    if (!dialTouched && !reducedMotion()) setDial(0.5 + 0.36 * Math.sin(now / 2400));
    if (now > faceHeld && now - faceSince > 3600) setFace(FACE_STAGES[(FACE_STAGES.indexOf(faceStage) + 1) % FACE_STAGES.length]);
    faceScreen.render(faceState(now), now);
    if ((frameNo & 1) === 0) {
      const ser = store.getSeries("activation");
      const tNow = snap ? snap.t_ms : now;
      if (ser && ser.t && ser.t.length > 1) {
        emgChart.draw(ser, tNow);
        const tag = store.sourceKind === "ws" ? "LIVE" : "SIMULATED";
        if (emgTag.textContent !== tag) emgTag.textContent = tag;
      } else {
        // no EMG on this feed: an illustrative envelope, and it says so
        emgSynth.t.push(now);
        const s = now / 1000;
        emgSynth.v.push(clamp(0.22 + 0.32 * Math.max(0, Math.sin(s * 0.9)) ** 3 + 0.05 * Math.sin(s * 23) * Math.sin(s * 7.3), 0, 1));
        while (emgSynth.t.length && emgSynth.t[0] < now - 6500) { emgSynth.t.shift(); emgSynth.v.shift(); }
        emgChart.draw(emgSynth, now);
        if (emgTag.textContent !== "ILLUSTRATION") emgTag.textContent = "ILLUSTRATION";
      }
      const s = Math.floor((now - sdT0) / 1000);
      if (s !== sdShown) {
        sdShown = s;
        const p2 = (n) => String(n).padStart(2, "0");
        sdClock.textContent = `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
      }
    }
  });
  cleanups.push(offFrame);

  const revealIO = observeReveals(root);
  cleanups.push(() => revealIO.disconnect());

  return () => {
    for (const fn of cleanups) { try { fn(); } catch (_) {} }
    video.pause();
    if (twin) { twin.setInsets({}); twin.dispose(); }   // the shared twin leaves as it came
    root.remove();
    document.documentElement.classList.remove("px-page");
    applyTheme(getTheme(), { persist: false });
  };
}
