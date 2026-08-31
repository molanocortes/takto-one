// entry.js - the front door, built as a FEELING in a fixed order (owner
// brief, 2026-08-03): CURIOSITY (something is alive on first paint: the twin
// and a live trace), WONDER (one person built this, and you can touch it),
// UNDERSTANDING (one honest line), INSPIRATION (the creed, his own words),
// AGENCY (exactly three doors: EXPLORE the live consoles, BUILD the open
// release, WRITE to the author). Every section serves one of those beats or
// it was cut; the deep content (instrument sheet, compliance map) lives
// behind folds, never deleted. The three doors are reachable from anywhere
// in one click: the fixed nav IS the door rail.
// The device is never inside a fading or translating container, so it can
// never be cropped by its own transition.

import { el, svg, observeReveals, clamp, reducedMotion } from "../ui.js";
import { store } from "../store.js";
import { Twin } from "../twin.js";
import { StripChart } from "../charts.js";
import { strings, getLang, setLang, LANG_LABELS } from "../i18n.js";
import { getTheme, toggleTheme } from "../theme.js";

// the active locale: every visible string on this page comes from here
// (src/locales/en|de|es.js - same shape, translated by hand). Fixed per page
// load; the language picker reloads to rebuild everything, incl. <html lang>.
const L = strings();

const DOOR_ROLES = ["operator", "guided", "mirror", "capture", "sign", "translate"];

// One pinned scene per scroll-length. Step 0 is the hero (hand alone); the
// forearm docks across the first stretch; the camera then walks the machine
// aspect by aspect. Scroll progress drives a CONTINUOUS interpolation across
// these keyframes (camera, emphasis, reveal, copy crossfades), so the page
// answers the wheel analog-proportionally instead of stepping.
// Story GEOMETRY only (camera, emphasis, cover/focus) - the copy for steps
// 1..N comes from the locale (L.story[i-1]), so keyframes and words cannot
// drift apart across languages.
const STORY = [
  {
    // targetY sits a touch higher than the pre-CTA hero (0.72 -> 0.92):
    // the camera looks up, the hand rides lower in frame, and the new CTA
    // row keeps clear air above the machine at common desktop heights
    hero: true, reveal: 0,
    framing: { yaw: -0.55, pitch: 0.28, dist: 6.3, targetY: 0.92, targetZ: 0.95 },
    emph: { pins: 1.2, jewel: 1, spools: 1 },
  },
  {
    reveal: 1,
    framing: { yaw: -0.6, pitch: 0.32, dist: 7.4, targetY: 0.15, targetZ: -0.2 },
    emph: { pins: 1, jewel: 1, spools: 1 },
  },
  {
    reveal: 1,
    framing: { yaw: -0.35, pitch: 0.5, dist: 4.9, targetY: -0.1, targetZ: 1.05 },
    emph: { pins: 2.8, jewel: 0.5, spools: 0.5 },
  },
  {
    reveal: 1,
    framing: { yaw: -1.15, pitch: 0.3, dist: 4.1, targetY: -0.5, targetZ: 1.35 },
    emph: { pins: 2.2, jewel: 0.4, spools: 0.4 },
  },
  {
    reveal: 1,
    framing: { yaw: -0.5, pitch: 0.62, dist: 5.6, targetY: 0.1, targetZ: -1.2 },
    emph: { pins: 0.6, jewel: 0.6, spools: 9 },
  },
  {
    reveal: 1,
    framing: { yaw: -1.5, pitch: 0.34, dist: 4.4, targetY: -0.05, targetZ: -0.95 },
    emph: { pins: 0.6, jewel: 0.8, spools: 1.6 },
    cover: 0, focus: 1,   // lift the lid, lift motors + internals to bone white
  },
  {
    reveal: 1,
    framing: { yaw: -1.3, pitch: 0.5, dist: 8.2, targetY: 0.3, targetZ: 0.1 },
    emph: { pins: 2.0, jewel: 2.2, spools: 2.4 },
  },
];

// The build rail deliberately stays compact: a repository for the work and the
// build guide.
//
// The preprint CTA is removed in this public release: it pointed at
// assets/docs/TAKTO_BioRob_paper_Molano.pdf, an UNPUBLISHED manuscript that is
// not distributed here. Restore it only once the paper is actually published,
// and prefer a DOI over a bundled PDF when that happens.
const MAIL = "mailto:sebastian.molano.29@gmail.com";
const BUILD_GUIDE_URL = "../../docs/build-guide.pdf";
const PROOF_CTAS = [
  { href: "https://github.com/molanocortes/takto-one", ext: true },
  { href: BUILD_GUIDE_URL, ext: true },
];

export function mountEntry(rootHost) {
  const lastRole = localStorage.getItem("zero.role");

  const root = el("div", { class: "entry" });

  // ---------- top bar: the three doors, one click from anywhere ----------
  // Plain scrollIntoView, no location.hash - the hash belongs to the router.
  const sectionFor = {};
  const navLink = (label, key) => {
    const a = el("a", { href: "#", class: "entry-nav-link" }, label);
    a.addEventListener("click", (e) => {
      e.preventDefault();
      sectionFor[key]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return a;
  };
  // theme + language controls: light/EN are the defaults, the choice persists
  const themeBtn = el("button", {
    class: "nav-ctl theme-ctl", type: "button",
    "aria-label": "Toggle dark mode", title: "Light / dark",
  }, getTheme() === "dark" ? "☀" : "☾");
  themeBtn.addEventListener("click", () => {
    themeBtn.textContent = toggleTheme() === "dark" ? "☀" : "☾";
  });
  const langCtl = el("div", { class: "lang-ctl", role: "group", "aria-label": "Language" },
    ...Object.keys(LANG_LABELS).map((l) => {
      const b = el("button", { class: "nav-ctl lang-btn" + (getLang() === l ? " on" : ""), type: "button" },
        LANG_LABELS[l]);
      b.addEventListener("click", () => { if (getLang() !== l) setLang(l); });
      return b;
    }));

  // the wordmark is a click target people try: it takes you back to the top
  const wordmark = el("a", { href: "#", class: "wordmark", "aria-label": "TAKTO" },
    el("img", { src: "assets/takto_mark.svg", class: "wordmark-logo", alt: "TAKTO" }),
    el("span", { class: "wordmark-name" }, "TAKTO"));
  wordmark.addEventListener("click", (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const nav = el("nav", { class: "entry-nav" },
    wordmark,
    el("div", { class: "entry-nav-right" },
      el("div", { class: "entry-nav-links" },
        navLink(L.nav.explore, "explore"),
        navLink(L.nav.build, "build"),
        navLink(L.nav.write, "write")),
      el("div", { class: "entry-nav-ctls" }, langCtl, themeBtn)),
  );

  // ---------- the pinned stage: hero + aspects + vision ----------
  // The hero must be ALIVE within seconds even on a slow line: the twin
  // carries the motion once its geometry lands, and the live trace chip
  // (fed by the telemetry store, a few kilobytes of code) moves within the
  // first second. Honesty rides along: the chip is labelled as a sim feed.
  const heroTraceCv = el("canvas", { class: "hero-live-cv", "aria-hidden": "true" });
  // the chip is a live-data teaser, so clicking it opens the live console
  const heroLive = el("button", { class: "hero-live mono", type: "button",
    title: L.hero.liveOpen },
    heroTraceCv,
    el("span", { class: "hero-live-tag" }, el("span", { class: "dot live" }), L.hero.live));
  heroLive.addEventListener("click", () => { location.hash = "#/operator"; });
  const heroCtas = el("div", { class: "hero-ctas reveal", style: "--d:360ms" },
    el("button", { class: "btn primary", type: "button",
      onclick: () => sectionFor.explore?.scrollIntoView({ behavior: "smooth", block: "start" }) },
      L.hero.ctaExplore),
    el("button", { class: "btn ghost", type: "button",
      onclick: () => sectionFor.build?.scrollIntoView({ behavior: "smooth", block: "start" }) },
      L.hero.ctaBuild),
    el("a", { class: "btn ghost", href: MAIL }, L.hero.ctaWrite),
  );
  const storyStage = el("div", { class: "story-stage" });
  const visionBg = el("div", { class: "story-vision-bg" });
  // hero stagger is TIGHT (0..360 ms, 500 ms fades - see .story-hero .reveal):
  // the words are the page's largest paint, and a leisurely fade put the
  // LCP a full second late for nothing anyone perceives as craft
  const heroContent = el("div", { class: "story-hero" },
    el("div", { class: "kicker accent reveal" }, L.hero.kicker),
    el("h1", { class: "entry-title reveal", style: "--d:80ms", html: L.hero.title }),
    el("div", { class: "entry-sub reveal", style: "--d:160ms" }, L.hero.sub),
    el("div", { class: "entry-byline reveal", style: "--d:240ms" }, L.hero.byline),
    heroCtas,
    el("div", { class: "hero-live-slot reveal", style: "--d:520ms" }, heroLive),
  );
  const cue = el("button", { class: "scroll-cue", type: "button",
    "aria-label": "Next" }, el("span"));
  cue.addEventListener("click", () => scrollToStep(Math.min(step + 1, STORY.length - 1)));
  const copyBlocks = STORY.map((s, i) => s.hero ? null : el("div", { class: "story-copy" },
    el("div", { class: "kicker accent" }, L.story[i - 1].kicker),
    el("h2", { class: "story-copy-head" }, L.story[i - 1].head),
    el("p", { class: "story-copy-line" }, L.story[i - 1].line)));
  // the tick rail doubles as step navigation - people click progress dots
  const ticks = STORY.map((_, i) => {
    const t = el("button", { class: "story-tick" + (i === 0 ? " on" : ""),
      type: "button", "aria-label": `${i + 1} / ${STORY.length}` });
    t.addEventListener("click", () => scrollToStep(i));
    return t;
  });
  // scroll so the pinned story rests exactly on keyframe k (inverse of the
  // progress math in onScroll below)
  const scrollToStep = (k) => {
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const top = storyWrap.getBoundingClientRect().top + window.scrollY;
    const span = storyWrap.offsetHeight - vh;
    window.scrollTo({ top: top + (span * k) / (STORY.length - 1), behavior: "smooth" });
  };
  const storySticky = el("div", { class: "story-sticky" },
    visionBg, storyStage, heroContent, ...copyBlocks.filter(Boolean), cue,
    el("div", { class: "story-ticks" }, ...ticks));
  const storyWrap = el("section", { class: "story-wrap" }, storySticky);

  // ---------- spec strip: the honest numbers, at a glance ----------
  // each spec card opens the instrument sheet, where its number lives in full
  const specs = el("section", { class: "spec-strip" },
    el("div", { class: "kicker reveal" }, L.specsKicker),
    el("div", { class: "spec-row" },
      ...L.specs.map((s, i) => {
        const card = el("button", { class: "spec reveal", type: "button",
          style: `--d:${100 + i * 80}ms`, title: L.build.sheetCue },
          el("div", { class: "spec-n num" }, s.n),
          el("div", { class: "spec-u" }, s.u),
          el("div", { class: "spec-d" }, s.d));
        card.addEventListener("click", () => {
          build.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        return card;
      })),
  );

  // ---------- film: the real machine, on camera ----------
  // Hidden until assets land: drop assets/film/poster.jpg (a real bench
  // photograph) and the section appears with it; drop assets/film/takto_60s.mp4
  // beside it and the photograph becomes the 60-second bench cut. No asset,
  // no section - the page never shows a placeholder where proof should be.
  const filmMedia = el("div", { class: "film-media reveal", style: "--d:120ms" });
  const film = el("section", { class: "film", style: "display:none" },
    el("div", { class: "kicker reveal" }, L.film.kicker),
    el("h2", { class: "film-head reveal", style: "--d:80ms" }, L.film.head),
    filmMedia);

  // ---------- a fold: 1-2 sentences at the surface, depth on demand ----------
  // Progressive disclosure without layout animation: the content appears
  // instantly (only its opacity animates - compositor-friendly), the cue
  // reads like an instrument label, and nothing deep was deleted.
  const fold = (cueText, ...content) => el("details", { class: "fold reveal" },
    el("summary", { class: "fold-cue mono" },
      el("span", { class: "fold-plus", "aria-hidden": "true" }, "+"), cueText),
    el("div", { class: "fold-body" }, ...content));

  // ---------- DOOR 1 · EXPLORE: living miniatures of the consoles ----------
  const opPrevChart = el("canvas", { class: "prev-chart" });
  const opPrev = [
    opPrevChart,
    el("div", { class: "prev-status mono" },
      el("span", { class: "prev-stat" }, el("span", { class: "dot ok" }), "12/12"),
      el("span", { class: "prev-stat" }, el("span", { class: "dot ok" }), "50 Hz"),
      el("span", { class: "prev-stat" }, el("span", { class: "dot live" }), "SIM")),
  ];

  const gdR = 46, gdC = 2 * Math.PI * gdR;
  const gdFill = svg("circle", { cx: 60, cy: 60, r: gdR, fill: "none", stroke: "#C9401B", "stroke-width": 4.5,
    "stroke-linecap": "round", "stroke-dasharray": gdC, "stroke-dashoffset": gdC, transform: "rotate(-90 60 60)",
    style: "" });
  const gdMotes = Array.from({ length: 5 }, () => el("span", { class: "prev-mote" }));
  const gdPrev = [
    el("div", { class: "prev-ring-wrap" },
      el("div", { class: "prev-halo" }),
      svg("svg", { viewBox: "0 0 120 120", class: "prev-ring" },
        svg("circle", { cx: 60, cy: 60, r: gdR, fill: "none", stroke: "rgba(35,30,22,.18)", "stroke-width": 2 }),
        gdFill)),
    el("div", { class: "prev-motes" }, ...gdMotes),
  ];

  const capPrevSparks = el("canvas", { class: "prev-sparks" });
  const capClock = el("span", null, "REC 00:00");
  const capPrev = [
    capPrevSparks,
    el("div", { class: "prev-rec mono" }, el("span", { class: "dot rec" }), capClock),
  ];

  const mirPrev = [
    el("div", { class: "prev-ring-wrap" },
      el("div", { class: "prev-halo" }),
      svg("svg", { viewBox: "0 0 120 120", class: "prev-ring" },
        svg("path", { d: "M40 60 q20 -26 40 0", fill: "none", stroke: "#C9401B", "stroke-width": 3,
          "stroke-linecap": "round", style: "" }),
        svg("path", { d: "M40 60 q20 26 40 0", fill: "none", stroke: "rgba(95,138,92,.9)", "stroke-width": 3,
          "stroke-linecap": "round" }))),
  ];
  const signPrev = [
    el("div", { class: "prev-gloss" }, "HALLO"),
    el("div", { class: "prev-rec mono" }, el("span", { class: "dot rec" }), "SIGN NOW"),
  ];
  const trPrev = [
    el("div", { class: "prev-chips" },
      el("span", { class: "prev-chip" }, "HILFE"),
      el("span", { class: "prev-chip" }, "WO"),
      el("span", { class: "prev-chip on" }, "DANKE")),
    el("div", { class: "prev-rec mono" }, el("span", { class: "dot live" }), "98%"),
  ];
  const PREVIEWS = { operator: opPrev, guided: gdPrev, mirror: mirPrev, capture: capPrev,
                     sign: signPrev, translate: trPrev };
  const doorEls = DOOR_ROLES.map((role, i) => {
    const d = L.explore.items[role];
    return el("a", { href: "#/" + role, class: "door reveal", style: `--d:${120 + i * 90}ms` },
      el("div", { class: "door-preview" },
        ...(PREVIEWS[role] || []),
        lastRole === role ? el("div", { class: "door-resume" }, el("span", { class: "dot live" }), L.explore.resume) : null),
      el("div", { class: "door-meta" },
        el("div", { class: "door-name" }, d.name),
        el("div", { class: "door-line" }, d.line),
        el("div", { class: "door-arrow", "aria-hidden": "true" }, "→")));
  });
  const doors = el("section", { class: "entry-doors" },
    el("div", { class: "kicker reveal" }, L.explore.kicker),
    el("h2", { class: "doors-head reveal", style: "--d:80ms" }, L.explore.head),
    el("p", { class: "doors-sub reveal", style: "--d:140ms" }, L.explore.sub),
    el("div", { class: "doors-row" }, ...doorEls),
  );

  // ---------- the creed: why this exists, in the author's own words ----------
  const creed = el("section", { class: "essay creed" },
    el("div", { class: "kicker reveal" }, L.creed.kicker),
    el("h2", { class: "essay-head reveal", style: "--d:80ms" }, L.creed.head),
    el("p", { class: "creed-p reveal", style: "--d:160ms" }, L.creed.p));

  // ---------- DOOR 2 · BUILD: the open release + the folded sheet ----------
  // (the fake storefront died here long ago; nothing on this page pretends
  // to sell - the honest currency is openness, and the honest number is the
  // COSTED four-finger design, never money spent)
  const specTable = el("div", { class: "spec-table" },
    el("div", { class: "spec-table-head mono" }, L.build.sheetTitle),
    ...L.build.rows.map(([k, v]) => el("div", { class: "spec-tr" },
      el("div", { class: "spec-tk" }, k),
      el("div", { class: "spec-tv num" }, v))));
  const sheetFold = fold(L.build.sheetCue, specTable);
  const build = el("section", { class: "essay openhw" },
    el("div", { class: "kicker reveal" }, L.build.kicker),
    el("h2", { class: "openhw-head reveal", style: "--d:80ms" }, L.build.head),
    el("div", { class: "proof-row" },
      ...L.build.cards.map((p, i) => el("a", {
        class: "proof-card reveal", style: `--d:${140 + i * 70}ms`,
        href: PROOF_CTAS[i].href,
        ...(PROOF_CTAS[i].dl ? { download: "" } : {}),
        ...(PROOF_CTAS[i].ext ? { target: "_blank", rel: "noopener" } : {}) },
        el("div", { class: "kicker accent" }, p.k),
        el("h3", { class: "proof-h" }, p.h),
        el("p", { class: "proof-p" }, p.p),
        el("span", { class: "btn ghost sm" }, p.label)))),
  );

  // ---------- compliance: one honest sentence, the map behind the fold ----------
  // Honesty rules (mirrors thesis ch. "market viability"): TAKTO ONE is a
  // research instrument, NOT a certified medical device; standards are named
  // ONLY as the mapped route. Never claim a certificate we do not hold.
  const compliance = el("section", { class: "essay compliance" },
    el("div", { class: "kicker reveal" }, L.compliance.kicker),
    el("h2", { class: "essay-head reveal", style: "--d:80ms" }, L.compliance.head),
    el("p", { class: "openhw-line reveal", style: "--d:140ms" }, L.compliance.p),
    fold(L.compliance.cue,
      el("div", { class: "why-row" },
        ...L.compliance.cards.map((w) => el("div", { class: "why-card" },
          el("div", { class: "kicker accent" }, w.k),
          el("p", { class: "why-p" }, w.p)))),
      el("p", { class: "sect-fine" },
        L.compliance.finePre,
        el("a", { class: "legal-link", href: "legal.html", target: "_blank", rel: "noopener" },
          L.compliance.fineLink), ".")),
  );

  // ---------- DOOR 3 · WRITE: the person, and a direct invitation ----------
  const credit = el("section", { class: "credit" },
    el("div", { class: "kicker reveal" }, L.write.kicker),
    el("h2", { class: "credit-head reveal", style: "--d:80ms" }, L.write.head),
    el("p", { class: "credit-line reveal", style: "--d:140ms" }, L.write.p1),
    el("p", { class: "credit-line reveal", style: "--d:200ms" }, L.write.p2),
    el("div", { class: "credit-chips reveal", style: "--d:260ms" },
      ...L.craft.map((c) => el("span", { class: "chip" }, c))),
    el("div", { class: "credit-links reveal", style: "--d:320ms" },
      el("a", { class: "btn primary", href: MAIL }, L.write.contact),
      el("a", { class: "btn ghost", href: "https://github.com/molanocortes", target: "_blank", rel: "noopener" }, L.write.github)),
  );

  const foot = el("footer", { class: "entry-foot mono" },
    el("span", null, "TAKTO ONE"),
    el("span", { class: "entry-foot-dot" }, "·"),
    el("span", { id: "feed-label" }, L.foot.feed),
    el("span", { class: "entry-foot-dot" }, "·"),
    el("a", { class: "entry-foot-link", href: "legal.html", target: "_blank", rel: "noopener" },
      L.foot.legal),
  );

  root.append(nav, storyWrap, specs, film, doors, creed, build, compliance, credit, foot);
  rootHost.append(root);

  // the three doors, anchored (order on the page: explore, build, write)
  Object.assign(sectionFor, { explore: doors, build, write: credit });

  // ---------- life ----------
  const twin = Twin.acquire(storyStage, { orbit: false, spin: true, idle: true, idleSpin: true, deferLoad: true, reveal: STORY[0].reveal, ...STORY[0].framing });
  window.__heroTwin = twin;   // framing/story test hook (same spirit as zero:step)

  // optional art layer for the vision step: drop an image at assets/vision.jpg
  // and it fades in behind the finale; without it the gradient stands alone.
  const visionImg = new Image();
  visionImg.onload = () => { visionBg.style.backgroundImage = `url(${visionImg.src})`; visionBg.classList.add("has-img"); };
  visionImg.src = "assets/vision.jpg";

  // film section probe: poster photograph first, bench cut on top of it.
  // (Asset drops light this up with zero code changes - see the section note.)
  const posterImg = new Image();
  posterImg.onload = () => {
    film.style.display = "";
    const still = el("img", { src: posterImg.src, class: "film-still", alt: L.film.alt });
    filmMedia.append(still);
    const clip = el("video", { class: "film-clip", controls: "", playsinline: "",
      preload: "metadata", poster: posterImg.src });
    clip.addEventListener("loadedmetadata", () => { still.remove(); filmMedia.append(clip); });
    clip.src = "assets/film/takto_60s.mp4";
  };
  posterImg.src = "assets/film/poster.jpg";

  // CV probe: drop assets/cv.pdf and a CV button joins the contact row.
  fetch("assets/cv.pdf", { method: "HEAD" }).then((r) => {
    if (!r.ok) return;
    credit.querySelector(".credit-links")?.append(
      el("a", { class: "btn ghost", href: "assets/cv.pdf", target: "_blank", rel: "noopener" }, L.write.cv));
  }).catch(() => {});

  const opPrevStrip = new StripChart(opPrevChart, { min: 0, max: 1, windowMs: 9000, width: 1.5 });
  const heroStrip = new StripChart(heroTraceCv, { min: 0, max: 1, windowMs: 7000, width: 1.5 });
  const capCtx = capPrevSparks.getContext("2d");
  let takes = [];
  store.listTakes().then((t) => { takes = t.slice(0, 4); });

  // CONTINUOUS story engine: scroll progress p in [0, N-1] (fractional)
  // drives every layer analog-proportionally. Camera, glow emphasis, and the
  // forearm reveal interpolate between keyframes with a smoothstep on the
  // local fraction; copy blocks crossfade by distance to their keyframe. The
  // page therefore answers every wheel tick with motion, never with a wait
  // for the next range. The twin's short damped follow remains, purely to
  // round off notchy wheel steps.
  const lerpN = (a, b, f) => a + (b - a) * f;
  // these layers are frame-driven here; their CSS transitions would fight
  for (const elx of [heroContent, cue, visionBg, ...copyBlocks.filter(Boolean)]) {
    elx.style.transition = "none";
  }
  let prog = -1;
  let step = 0;
  let heroOn = true;   // gates the hero trace redraw
  function applyProgress(p) {
    p = clamp(p, 0, STORY.length - 1);
    if (Math.abs(p - prog) < 0.0005 && prog >= 0) return;
    prog = p;
    const i = Math.min(Math.floor(p), STORY.length - 2);
    const f = p - i;
    const e = f * f * (3 - 2 * f);               // smoothstep between keyframes
    const A = STORY[i], B = STORY[i + 1];
    twin.setFraming({
      yaw: lerpN(A.framing.yaw, B.framing.yaw, e),
      pitch: lerpN(A.framing.pitch, B.framing.pitch, e),
      dist: lerpN(A.framing.dist, B.framing.dist, e),
      targetY: lerpN(A.framing.targetY, B.framing.targetY, e),
      targetZ: lerpN(A.framing.targetZ, B.framing.targetZ, e),
    });
    twin.setEmphasis({
      pins: lerpN(A.emph.pins, B.emph.pins, e),
      jewel: lerpN(A.emph.jewel, B.emph.jewel, e),
      spools: lerpN(A.emph.spools, B.emph.spools, e),
    });
    // cover lift + interior focus ride the same keyframe interpolation
    twin.setCover(lerpN(A.cover ?? 1, B.cover ?? 1, e));
    twin.setFocus(lerpN(A.focus ?? 0, B.focus ?? 0, e));
    twin.setReveal(clamp(p, 0, 1));              // the forearm docks WITH the wheel
    step = Math.round(p);
    twin.opts.idleSpin = p < 0.5;
    const heroK = clamp(1 - p * 1.6, 0, 1);
    heroContent.style.opacity = String(heroK);
    heroContent.style.transform = `translateY(${(1 - heroK) * -26}px)`;
    heroContent.classList.toggle("off", heroK <= 0.02);
    heroOn = heroK > 0.02;
    cue.classList.toggle("off", p > 0.4);
    copyBlocks.forEach((b, k) => {
      if (!b) return;
      // plateau crossfade: fully readable within half a keyframe either side,
      // fading only through the brief handover between neighbours
      const o = clamp(1.9 - Math.abs(p - k) * 1.9, 0, 1);
      b.style.opacity = String(o);
      b.style.transform = `translateY(${(1 - o) * 22}px)`;
      b.classList.toggle("on", o > 0.02);
    });
    const vis = clamp((p - (STORY.length - 2.4)) * 1.4, 0, 1);
    visionBg.style.opacity = String(vis);
    visionBg.classList.toggle("on", vis > 0.02);
    ticks.forEach((t2, k) => t2.classList.toggle("on", k === step));
  }
  applyProgress(0);
  const stepHook = (e) => {
    const p = +e.detail || 0;        // fractional progress allowed (test hook)
    applyProgress(p);
    twin.snapFraming();
    twin.setReveal(clamp(p, 0, 1), true);
    twin.setCover(twin._coverT, true);   // land cover + focus with the snap
    twin.setFocus(twin._focusT, true);
  };
  window.addEventListener("zero:step", stepHook);

  // scroll: advance the pinned story SYNCHRONOUSLY with the event. The work
  // is a handful of lerps and style writes, far cheaper than a layout pass,
  // and skipping the old rAF deferral removes a frame of latency from every
  // wheel tick - the page answers the wheel the moment it moves.
  let storyVisible = true;
  let idleTimer = null;
  let settleY = 0;          // the scrollY the magnetic glide last wrote (see below)
  const onScroll = () => {
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const r = storyWrap.getBoundingClientRect();
    storyVisible = r.bottom > 0 && r.top < vh;
    const span = r.height - vh;
    if (span > 0) applyProgress(clamp(-r.top / span, 0, 1) * (STORY.length - 1));
    // A scroll we did not cause while the glide is running means the reader
    // took the page back (scrollbar drag, trackpad fling, find-in-page). Those
    // gestures never reach the wheel/pointer listeners below, so without this
    // check the glide kept writing scrollTo underneath them and the page
    // fought the hand holding it.
    if (settleRaf && Math.abs(window.scrollY - settleY) > 2) cancelSettle();
    // magnetic rest (see below): re-arm the idle settle on every real scroll,
    // but never from the glide's own scroll events - that just churned the
    // timer once per frame for the whole 460 ms
    if (settleRaf) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(settleToKeyframe, 160);
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  // MAGNETIC REST. While the wheel moves, the page answers it 1:1 (analog).
  // But the crossfades mean a stop BETWEEN keyframes would rest on a half
  // composed stage - so when the wheel goes quiet, glide the page itself to
  // the nearest keyframe (the scroll position stays the single source of
  // truth, so the settle IS a scroll and everything stays in lockstep). Any
  // new input cancels the glide instantly; it never fights the reader.
  // Honors prefers-reduced-motion: no automatic glide, the page rests where
  // the reader left it (the crossfade plateau keeps copy readable anyway).
  let settleRaf = null;
  const cancelSettle = () => {
    if (settleRaf) { cancelAnimationFrame(settleRaf); settleRaf = null; }
  };
  function settleToKeyframe() {
    if (reducedMotion()) return;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const r = storyWrap.getBoundingClientRect();
    const span = r.height - vh;
    if (span <= 0) return;
    const sp = -r.top / span;
    if (sp < -0.001 || sp > 1.001) return;          // not inside the pinned story
    const p = clamp(sp, 0, 1) * (STORY.length - 1);
    const k = Math.round(p);
    if (Math.abs(p - k) < 0.02) return;             // already composed
    const startY = window.scrollY;
    const targetY = startY + r.top + (span * k) / (STORY.length - 1);
    const dy = targetY - startY;
    if (Math.abs(dy) < 2) return;
    const t0 = performance.now(), dur = 460;
    const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - ((2 - 2 * x) ** 2) / 2);
    cancelSettle();
    // `glide`, not `step`: the outer `step` is the story keyframe index, and
    // shadowing it here reads like the loop is advancing the story
    const glide = (now) => {
      const f = Math.min(1, (now - t0) / dur);
      window.scrollTo(0, startY + dy * ease(f));
      settleY = window.scrollY;                      // read BACK: the browser clamps and rounds
      onScroll();                                    // stage follows the glide
      settleRaf = f < 1 ? requestAnimationFrame(glide) : null;
    };
    settleY = window.scrollY;
    settleRaf = requestAnimationFrame(glide);
  }
  const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown"];
  for (const ev of inputEvents) window.addEventListener(ev, cancelSettle, { passive: true });

  // canvas size cached: no per-frame layout reads
  let capSize = null;
  const measureCap = () => {
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    capSize = { w: Math.round(capPrevSparks.clientWidth * dpr), h: Math.round(capPrevSparks.clientHeight * dpr) };
  };
  requestAnimationFrame(measureCap);
  window.addEventListener("resize", measureCap, { passive: true });

  function drawCapPreview(tms) {
    if (!capSize || !capSize.w || takes.length === 0) return;
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    const { w, h } = capSize;
    if (capPrevSparks.width !== w || capPrevSparks.height !== h) { capPrevSparks.width = w; capPrevSparks.height = h; }
    capCtx.clearRect(0, 0, w, h);
    takes.slice(0, 2).forEach((take, r) => {
      const vals = take.spark;
      const yBase = ((r + 0.5) / 2) * h;
      const amp = h / 2 * 0.36;
      const shift = ((tms * 0.02) % vals.length);
      capCtx.beginPath();
      for (let i = 0; i < vals.length; i++) {
        const v = vals[(i + Math.floor(shift)) % vals.length];
        const x = (i / (vals.length - 1)) * w;
        capCtx[i ? "lineTo" : "moveTo"](x, yBase - (v - 0.5) * amp * 2);
      }
      capCtx.strokeStyle = r === 0 ? "rgba(201,64,27,.85)" : "rgba(192,131,39,.65)";
      capCtx.lineWidth = 1.4 * dpr;
      capCtx.stroke();
    });
  }

  // the door previews only draw while their section is actually on screen -
  // no 2D canvas work rides along with the story scroll
  let doorsVisible = false;
  const doorsIO = new IntersectionObserver((entries) => {
    for (const e2 of entries) doorsVisible = e2.isIntersecting;
  }, { rootMargin: "80px 0px" });
  doorsIO.observe(doors);

  // the twin renders every frame; the 2D previews at half rate, gated by
  // what is on screen (hero trace with the hero, door miniatures with doors)
  let frameNo = 0;
  let litCount = -1, clockS = -1;
  // dt is the store's MEASURED frame time and must be forwarded: every easing
  // in the twin (camera damping, reveal/cover/focus, idle float, idle spin) is
  // exp(-dt/tau). Dropping it pinned dt at the 16 ms default, so the story ran
  // ~2x fast on a 120 Hz panel and stalled-then-jumped whenever a frame ran
  // long - the stutter read as lag even at a healthy frame rate.
  const offFrame = store.onFrame((sm, snap, dt) => {
    if (storyVisible) twin.render(sm, dt);
    frameNo++;
    if (snap && (frameNo & 1) === 0) {
      const curlSer = store.getSeries("curl");
      if (heroOn && storyVisible && curlSer) heroStrip.draw(curlSer, snap.t_ms);
      if (doorsVisible) {
        if (curlSer) opPrevStrip.draw(curlSer, snap.t_ms);
        gdFill.setAttribute("stroke-dashoffset", String(gdC * (1 - Math.max(0.04, sm.curl))));
        const lit = Math.round(sm.curl * 5);
        if (lit !== litCount) {
          litCount = lit;
          gdMotes.forEach((m, i) => m.classList.toggle("lit", i < lit));
        }
        drawCapPreview(snap.t_ms);
        const s = Math.floor(snap.t_ms / 1000) % 3600;
        if (s !== clockS) {
          clockS = s;
          capClock.textContent = `REC ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
        }
      }
    }
  });

  const io = observeReveals(root);

  return () => {
    offFrame();
    io.disconnect();
    doorsIO.disconnect();
    if (idleTimer) clearTimeout(idleTimer);
    cancelSettle();
    for (const ev of inputEvents) window.removeEventListener(ev, cancelSettle);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", measureCap);
    window.removeEventListener("zero:step", stepHook);
    delete window.__heroTwin;
    twin.dispose();
    root.remove();
  };
}
