// sign.js - the TAKTO-SIGN capture route (#/sign). A one-click operator flow for
// recording German Sign Language data through the existing bridge: it is just
// another WS client (via the shared store), driving the SAME capture engine the
// headless harness uses (../sign/capture_core.js). Sealed reps persist to
// IndexedDB the instant they seal, so a refresh or a dropped socket never costs
// more than the rep in flight; on mount the route finds any interrupted session
// and offers to RESUME it (SignCapture.rehydrate), and starting the same
// signer's session on the same day resumes automatically (stable session id).
// On session end it auto-saves to the local sink (capture/sink_server.py),
// falling back to a downloadable bundle.
//
// HONESTY: the session's `source` is derived from what the bridge actually is
// (link health "sim" vs a real device), never hardcoded, and a sim rehearsal is
// stored with consent.released=false (there is no signer to have consented).
//
// EN/DE strings live here (the signer may prefer German). Reuses the console
// theme + ui helpers. No em dashes.

import { el, toast } from "../ui.js";
import { store } from "../store.js";
import { SignCapture, STATE } from "../sign/capture_core.js";
import { idbStore } from "../sign/idb_store.js";

const SINK = (new URLSearchParams(location.search).get("sink")) || "http://localhost:8129";

// The signer code ends up inside the session id (`web_<signer>_<day>`), and BOTH
// consumers reject anything else: sink_server.py SAFE_ID (^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$)
// on every /save, and verify_session.py CODE_RE (^[A-Za-z0-9_-]{1,24}$) on the
// signer_id itself. Catch it here, before a whole session is recorded against a
// code that can only fail at save time.
const SIGNER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;

const STR = {
  en: { title: "Sign Capture", newsession: "New session", signer: "Signer code (anonymous)",
    hand: "Handedness", right: "Right", left: "Left", camera: "Fuse camera", start: "Start",
    pause: "Pause", resume: "Resume", flag: "Flag last rep", get_ready: "Get ready",
    record: "SIGN NOW", rest: "Rest", done: "Session complete", of: "of", reps: "reps",
    flagged: "flagged", save: "Save session", saved: "Data saved", connect: "Connecting to device",
    connected: "Device connected", nodevice: "No device / bridge", qc: "Live quality",
    consent: "I have the signer's informed consent to record and open-source this data",
    block: "Block", take: "Take", download: "Download bundle",
    endsave: "End & save", endconfirm: "End the session now and save what was recorded?",
    partial: "ended early", cam_off: "camera off", cam_start: "starting camera",
    cam_blur: "camera on · face blurred · wrist tracked", cam_blur_fallback: "camera on · head region blurred (offline)",
    cam_unavail: "camera unavailable", cam_blocked: "camera blocked",
    resumed: "Resumed interrupted session", resume_btn: "Resume", save_btn: "Save & close",
    interrupted: "Interrupted session", demo_warn: "Sink offline: demo plan (no calibration block). Rehearsal only.",
    demo_refuse: "Real capture refused: the plan has no neutral calibration block. Start the sink (session_plan.json) first.",
    sim_note: "Sim device detected: this session is labeled sim (rehearsal, no consent release stored)",
    signer_bad: "Anonymous code only: letters, digits, - and _ (max 24, no spaces or accents)" },
  de: { title: "Gebaerden-Aufnahme", newsession: "Neue Sitzung", signer: "Gebaerdenden-Code (anonym)",
    hand: "Haendigkeit", right: "Rechts", left: "Links", camera: "Kamera fusionieren", start: "Start",
    pause: "Pause", resume: "Weiter", flag: "Letzte Wdh. markieren", get_ready: "Bereit machen",
    record: "JETZT GEBAERDEN", rest: "Pause", done: "Sitzung fertig", of: "von", reps: "Wdh.",
    flagged: "markiert", save: "Sitzung speichern", saved: "Daten gespeichert", connect: "Verbinde mit Geraet",
    connected: "Geraet verbunden", nodevice: "Kein Geraet / Bridge", qc: "Live-Qualitaet",
    consent: "Mir liegt die informierte Einwilligung der gebaerdenden Person zur Aufnahme und Open-Source-Freigabe vor",
    block: "Block", take: "Wdh.", download: "Bundle herunterladen",
    endsave: "Beenden & speichern", endconfirm: "Sitzung jetzt beenden und das Aufgenommene speichern?",
    partial: "vorzeitig beendet", cam_off: "Kamera aus", cam_start: "Kamera startet",
    cam_blur: "Kamera an · Gesicht verpixelt · Handgelenk verfolgt", cam_blur_fallback: "Kamera an · Kopfbereich verpixelt (offline)",
    cam_unavail: "Kamera nicht verfuegbar", cam_blocked: "Kamera blockiert",
    resumed: "Unterbrochene Sitzung fortgesetzt", resume_btn: "Fortsetzen", save_btn: "Speichern & schliessen",
    interrupted: "Unterbrochene Sitzung", demo_warn: "Sink offline: Demo-Plan (kein Kalibrierblock). Nur Probe.",
    demo_refuse: "Echte Aufnahme verweigert: der Plan hat keinen Kalibrierblock. Erst den Sink starten (session_plan.json).",
    sim_note: "Sim-Geraet erkannt: Sitzung wird als sim gespeichert (Probe, keine Einwilligungs-Freigabe)",
    signer_bad: "Nur anonymer Code: Buchstaben, Ziffern, - und _ (max. 24, keine Leerzeichen oder Umlaute)" },
};

function backGlyph() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("width", "16"); s.setAttribute("height", "16");
  s.innerHTML = '<path d="M 10 3 L 5 8 L 10 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  return s;
}

// a session is resumable when it has sealed reps but the queue never finished
function isInterrupted(meta) {
  return !!(meta && Array.isArray(meta.sealed) && meta.sealed.length > 0
    && Number.isFinite(meta.queue_index) && Number.isFinite(meta.queue_len)
    && meta.queue_index < meta.queue_len);
}

function hasNeutralBlock(plan) {
  return !!(plan && Array.isArray(plan.blocks) && plan.blocks.some((b) => b && b.kind === "neutral"));
}

export function mountSign(rootHost) {
  localStorage.setItem("zero.role", "sign");
  const lang = (localStorage.getItem("takto.sign.lang") || (navigator.language || "en").slice(0, 2));
  const L = STR[lang] || STR.en;
  const root = el("div", { class: "surf sign" });
  const cleanups = [];

  const capStore = idbStore();

  let plan = null, planIsDemo = false, cap = null, running = false, camOn = false, camRow = null, camStream = null, camStop = null;
  let deviceUp = false, ending = false, simLink = null, simNoted = false;

  // ---------------- top bar ----------------
  const linkPill = el("div", { class: "pill" }, el("span", { class: "dot warn" }), el("span", null, L.connect));
  const langBtn = el("button", { class: "chip" }, lang.toUpperCase());
  langBtn.addEventListener("click", () => {
    localStorage.setItem("takto.sign.lang", lang === "en" ? "de" : "en");
    location.reload();
  });
  const bar = el("header", { class: "surf-bar" },
    el("div", { class: "surf-bar-left" },
      el("a", { href: "#/", class: "surf-back", title: "Home" }, backGlyph()),
      el("a", { href: "#/", class: "wordmark sm", title: "Home" }, el("span", { class: "wordmark-dot" }), "TAKTO"),
      el("div", { class: "surf-name" }, L.title)),
    el("div", { class: "surf-bar-mid" }),
    el("div", { class: "surf-bar-right" }, langBtn, linkPill));

  // ---------------- setup card ----------------
  const signerInput = el("input", { placeholder: L.signer, spellcheck: "false", value: "" });
  const handSel = el("select", null, el("option", { value: "right" }, L.right), el("option", { value: "left" }, L.left));
  const camChk = el("input", { type: "checkbox" });
  const consentChk = el("input", { type: "checkbox" });
  const startBtn = el("button", { class: "btn primary", disabled: "true" }, L.start);
  const resumeList = el("div", { class: "sign-resume" });
  const signerHint = el("div", { class: "sub" }, "");
  const setupCard = el("div", { class: "card sign-setup" },
    el("div", { class: "kicker" }, L.newsession),
    el("label", { class: "sign-field" }, L.signer, signerInput),
    signerHint,
    el("label", { class: "sign-field" }, L.hand, handSel),
    el("label", { class: "sign-check" }, camChk, " ", L.camera),
    el("label", { class: "sign-check" }, consentChk, " ", el("span", { class: "sub" }, L.consent)),
    startBtn, resumeList);
  const updateStart = () => {
    const code = signerInput.value.trim();
    const okCode = SIGNER_RE.test(code);
    signerHint.textContent = code.length && !okCode ? L.signer_bad : "";
    startBtn.disabled = !(consentChk.checked && okCode);
  };
  signerInput.addEventListener("input", updateStart);
  consentChk.addEventListener("change", updateStart);
  camChk.addEventListener("change", () => { camOn = camChk.checked; if (camOn) startCamera(); else stopCamera(); });

  // ---------------- prompt card ----------------
  const promptGloss = el("div", { class: "sign-gloss" }, "-");
  const promptMeaning = el("div", { class: "sign-meaning" }, "");
  const promptBlock = el("div", { class: "sign-block mono" }, "");
  const countRing = el("div", { class: "sign-count" }, "");
  const phaseTag = el("div", { class: "sign-phase" }, "");
  const progressBar = el("div", { class: "sign-prog" }, el("div", { class: "sign-prog-fill" }));
  const progressTxt = el("div", { class: "sign-prog-txt mono" }, "");
  const pauseBtn = el("button", { class: "btn" }, L.pause);
  const flagBtn = el("button", { class: "btn warn" }, L.flag);
  const endBtn = el("button", { class: "btn danger" }, L.endsave);
  const promptCard = el("div", { class: "card sign-prompt" },
    promptBlock, promptGloss, promptMeaning, countRing, phaseTag,
    el("div", { class: "sign-controls" }, pauseBtn, flagBtn, endBtn),
    progressBar, progressTxt);
  promptCard.style.display = "none";

  // ---------------- QC strip ----------------
  const qcCells = {};
  function qcCell(name) { const dot = el("span", { class: "dot ok" }); const v = el("span", { class: "mono qcv" }, ""); qcCells[name] = { dot, v }; return el("div", { class: "qc-cell" }, dot, el("span", { class: "qc-k" }, name), v); }
  const qcStrip = el("div", { class: "card sign-qc" }, el("div", { class: "kicker" }, L.qc),
    el("div", { class: "qc-row" }, qcCell("encoders"), qcCell("imu"), qcCell("thumb"), qcCell("rate"), qcCell("dropout")));

  // ---------------- camera pane ----------------
  // the video is only a hidden SOURCE; what the operator sees is the canvas,
  // where every frame has the signer's FACE BLURRED before it is ever shown
  // (privacy: this data is for Deaf people and open-sourced). No pixels are
  // stored either way (only the wrist location columns), but the preview is
  // blurred so a face is never on screen.
  const video = el("video", { autoplay: true, playsinline: true, muted: true, style: "display:none" });
  const camCanvas = el("canvas", { class: "sign-cam-canvas" });
  const camTag = el("div", { class: "sign-cam-tag" }, L.cam_off);
  const camPane = el("div", { class: "card sign-cam" }, video, camCanvas, camTag);
  camPane.style.display = "none";

  // ---------------- layout ----------------
  const left = el("div", { class: "sign-left" }, setupCard, qcStrip);
  const rightCol = el("div", { class: "sign-right" }, promptCard, camPane);
  const grid = el("div", { class: "sign-grid" }, left, rightCol);   // .session added while recording
  const body = el("main", { class: "surf-body" }, grid);
  root.append(bar, body);
  rootHost.append(root);

  // ---------------- plan fetch (+ resume scan once the plan is known) --------
  fetch(`${SINK}/plan`).then((r) => r.json()).then((p) => { if (p && p.blocks) plan = p; })
    .catch(() => {})
    .finally(() => {
      if (!plan) { plan = DEMO_PLAN; planIsDemo = true; toast(L.demo_warn, { tone: "warn" }); }
      scanInterrupted();
    });

  // ---------------- refresh safety: find + offer interrupted sessions -------
  async function scanInterrupted() {
    let ids = [];
    try { ids = await capStore.listSessions(); } catch (_) { return; }
    for (const id of ids) {
      let meta = null;
      try { meta = await capStore.getMeta(id); } catch (_) { meta = null; }  // corrupt meta: rep files still resumable via Start
      if (!isInterrupted(meta)) continue;
      const row = el("div", { class: "sign-resume-row" },
        el("span", { class: "mono" }, `${L.interrupted}: ${meta.signer_id} · ${meta.sealed.length} ${L.reps} (${meta.queue_index}/${meta.queue_len})`),
        el("button", { class: "btn sm" }, L.resume_btn),
        el("button", { class: "btn sm" }, L.save_btn));
      const [, resumeB, saveB] = row.children;
      resumeB.addEventListener("click", async () => { row.remove(); await beginSession(meta); });
      saveB.addEventListener("click", async () => {
        row.remove();
        cap = await SignCapture.rehydrate(optsFromMeta(meta));
        cap.stop();
        await endSession();
      });
      resumeList.append(row);
    }
  }

  function optsFromMeta(meta) {
    return {
      sessionId: meta.session_id, signerId: meta.signer_id, handedness: meta.handedness,
      source: meta.source || "bench", deviceFw: meta.device_fw, rateHz: meta.sample_rate_hz || 60,
      createdMs: meta.created_ms || 0, plan: meta.plan || plan, corpusVersion: meta.corpus_version,
      hasCamera: !!meta.has_camera, store: capStore, consent: meta.consent,
    };
  }

  // ---------------- capture wiring ----------------
  // stable session id: signer + calendar day, so the SAME session resumes after
  // a refresh instead of stranding its sealed reps under a dead timestamp id
  function sessionIdFor(signer) {
    const d = new Date();
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return `web_${signer}_${day}`;
  }

  async function beginSession(resumeMeta) {
    // HONESTY: derive the data source from what the bridge actually is. A sim
    // bridge must produce source:"sim" (and no consent release: a rehearsal has
    // no signer whose consent could be released).
    // `simLink` only ever becomes true from a BRIDGE health frame (link.detail
    // === "sim"); the built-in MockSource emits no detail, so it left simLink
    // null and mock-generated reps were sealed as source:"bench" with the
    // consent release set. Any non-WebSocket source is synthetic by definition.
    const sim = simLink === true || !store.live;
    if (resumeMeta) {
      cap = await SignCapture.rehydrate(optsFromMeta(resumeMeta));
      signerInput.value = resumeMeta.signer_id || "";
      toast(`${L.resumed}: ${cap.sealed.length} ${L.reps}`, { tone: "ok" });
    } else {
      const signer = signerInput.value.trim();
      if (!hasNeutralBlock(plan) && !sim) { toast(L.demo_refuse, { tone: "warn" }); return; }
      if (!hasNeutralBlock(plan)) toast(L.demo_warn, { tone: "warn" });
      const sid = sessionIdFor(signer);
      let existing = null;
      try { existing = await capStore.getMeta(sid); } catch (_) { existing = null; }
      const opts = {
        sessionId: sid, signerId: signer, handedness: handSel.value,
        source: sim ? "sim" : "bench",
        deviceFw: (store.snap && store.snap.link) ? 4 : null, rateHz: 60, createdMs: Date.now(),
        plan, corpusVersion: plan.corpus_version || 1, hasCamera: camOn, store: capStore,
        consent: { released: consentChk.checked && !sim, template_version: consentChk.checked ? 1 : null },
      };
      if (isInterrupted(existing)) {
        cap = await SignCapture.rehydrate({ ...optsFromMeta(existing), consent: opts.consent });
        toast(`${L.resumed}: ${cap.sealed.length} ${L.reps}`, { tone: "ok" });
      } else {
        cap = new SignCapture(opts);
      }
      if (sim) toast(L.sim_note, { tone: "warn" });
    }
    cap.onEvent(onCapEvent);
    setupCard.style.display = "none"; promptCard.style.display = "flex";
    grid.classList.add("session");     // switch from centered-idle to rail + hero
    running = true; ending = false; cap.start();
  }

  function onCapEvent(ev) {
    if (ev.type === "state") {
      const p = ev.prompt;
      promptGloss.textContent = p ? p.gloss : "-";
      promptBlock.textContent = p ? `${L.block}: ${p.block} - ${L.take} ${((p.take || 1) % 100)}` : "";
      phaseTag.textContent = { countdown: L.get_ready, recording: L.record, gap: L.rest, idle: "", done: L.done }[ev.state] || "";
      promptCard.classList.toggle("rec", ev.state === STATE.RECORDING);
      countRing.textContent = "";
    } else if (ev.type === "countdown") {
      countRing.textContent = ev.n > 0 ? String(ev.n) : "";
    } else if (ev.type === "rep_sealed") {
      const pr = ev.progress;
      progressBar.querySelector(".sign-prog-fill").style.transform = `scaleX(${pr.total ? pr.done / pr.total : 0})`;
      progressTxt.textContent = `${pr.done} ${L.of} ${pr.total} ${L.reps} - ${pr.flagged} ${L.flagged}`;
    } else if (ev.type === "session_done") {
      endSession();
    }
  }

  pauseBtn.addEventListener("click", () => {
    if (!cap) return;
    if (cap.running) { cap.pause(); pauseBtn.textContent = L.resume; }
    else { cap.resume(store.snap ? store.snap.t_ms : 0); pauseBtn.textContent = L.pause; }
  });
  flagBtn.addEventListener("click", () => { if (cap && cap.flagLastRep()) toast(L.flag, { tone: "warn" }); });
  startBtn.addEventListener("click", () => { if (plan) beginSession(); });

  // End & save: stop the session before the queue finishes (signer tired / an
  // issue) and save everything recorded so far. Two-click confirm so a stray
  // tap cannot end a session; every sealed rep is already safe on disk.
  let endArmed = false, endTimer = null;
  endBtn.addEventListener("click", () => {
    if (!cap || ending) return;
    if (!endArmed) {
      endArmed = true; endBtn.textContent = L.endconfirm;
      endTimer = setTimeout(() => { endArmed = false; endBtn.textContent = L.endsave; }, 4000);
      return;
    }
    clearTimeout(endTimer); endArmed = false;
    cap.pause(); cap.stop();
    endSession();
  });

  // feed bridge frames into the engine (and keep the honest source label live:
  // if the link turns out to be the sim, the session must be labeled sim even
  // if it started before the first health frame arrived)
  cleanups.push(store.onSnap((s) => {
    deviceUp = !!(s.link && s.link.device);
    const link = (s.health || []).find((x) => x.stream === "link");
    if (link && link.ok && link.detail) simLink = link.detail === "sim";
    linkPill.replaceChildren(el("span", { class: "dot " + (deviceUp ? "ok" : "warn") }),
      el("span", null, deviceUp ? L.connected : L.nodevice));
    if (cap && (simLink === true || !store.live) && cap.source !== "sim") {
      cap.source = "sim";
      cap.consent = { ...(cap.consent || {}), released: false };
      if (!simNoted) { simNoted = true; toast(L.sim_note, { tone: "warn" }); }
    }
    // QC strip
    if (running) updateQC(s);
    if (cap && cap.running) cap.onFrame(s, camOn ? camRow : null);
  }));

  function updateQC(s) {
    const h = (name) => (s.health || []).find((x) => x.stream === name) || {};
    const enc = h("encoders"); const set = (k, ok, txt) => { if (qcCells[k]) { qcCells[k].dot.className = "dot " + (ok ? "ok" : "warn"); qcCells[k].v.textContent = txt; } };
    // numeric live-channel count, not a string sniff on enc.detail
    const nliv = (s.joints || []).filter((j) => j.ok).length;
    set("encoders", nliv >= 10, enc.detail || `${nliv}/12`);
    const imu = h("imu"); set("imu", imu.ok, imu.detail || "");
    set("thumb", !!s.thumb, s.thumb ? "live" : "absent");
    set("rate", (enc.rate_hz || 0) >= 45, `${Math.round(enc.rate_hz || 0)} Hz`);
    const drop = (s.joints || []).length ? 1 - nliv / s.joints.length : 1;
    set("dropout", drop < 0.2, `${Math.round(drop * 100)}%`);
  }

  async function endSession() {
    if (ending) return;             // guard: never save twice (stop + session_done)
    ending = true; running = false;
    stopCamera();
    promptCard.querySelector(".sign-phase").textContent = L.done;
    const bundle = await cap.serialize();
    // auto-save to the sink; fall back to a downloadable bundle
    let saved = false, saveErr = "";
    try {
      const r = await fetch(`${SINK}/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
      const j = await r.json(); saved = !!(j && j.ok);
      // surface the sink's own reason (e.g. "unsafe session_id") instead of only
      // falling back to a download with no explanation
      if (!saved) saveErr = (j && j.error) ? String(j.error) : `HTTP ${r.status}`;
    } catch (_) { saved = false; saveErr = "sink unreachable"; }
    if (saved) { try { await capStore.clearSession(cap.sessionId); } catch (_) {} }  // saved: stop offering it as resumable
    const early = bundle.ended_early ? ` - ${L.partial} (${bundle.prompts.done}/${bundle.prompts.total})` : "";
    const simTag = bundle.sim ? " - SIM" : "";
    const summary = el("div", { class: "card sign-summary" },
      el("div", { class: "kicker" }, (saved ? L.saved : L.save) + simTag),
      el("div", { class: "sign-sum-row" }, `${bundle.counts.reps} ${L.reps} - ${bundle.counts.signs} signs - QC ${Math.round(bundle.qc.score * 100)}% - ${bundle.counts.flagged} ${L.flagged}${early}`),
      saved ? el("div", { class: "sign-sum-dot" }, el("span", { class: "dot ok" }), L.saved)
            : el("div", {}, el("div", { class: "sub mono" }, saveErr), dlBtn(bundle)));
    grid.classList.remove("session");     // back to a centered single column
    rightCol.replaceChildren();           // clear the (hidden) prompt/camera
    left.replaceChildren(summary);
    promptCard.style.display = "none";
    toast(saved ? `${L.saved}: ${bundle.session_id}` : `${L.download} (${saveErr})`, { tone: saved ? "ok" : "warn" });
  }

  function dlBtn(bundle) {
    const b = el("button", { class: "btn" }, L.download);
    b.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: bundle.session_id + ".json" });
      a.click(); URL.revokeObjectURL(a.href);
    });
    return b;
  }

  // ---------------- camera (face-blurred preview + wrist fusion) ------------
  const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
  const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  let faceDet = null, handLm = null;
  const blurBuf = document.createElement("canvas");   // offscreen scratch for the blur

  // Blur a region of the ALREADY-DRAWN canvas by downscaling it to a tiny buffer
  // and upscaling it back. This does NOT use ctx.filter (which is unsupported /
  // a silent no-op in several browsers, the reason the face was showing clear):
  // downscale + smooth upscale is a real blur that works everywhere.
  function blurRegion(ctx, w, h, b) {
    const px = b.width * 0.18, py = b.height * 0.35;
    const x = Math.max(0, Math.round(b.originX - px)), y = Math.max(0, Math.round(b.originY - py));
    const bw = Math.min(w - x, Math.round(b.width + 2 * px)), bh = Math.min(h - y, Math.round(b.height + 2 * py));
    if (bw < 4 || bh < 4) return;
    const dw = Math.max(3, Math.round(bw / 18)), dh = Math.max(3, Math.round(bh / 18));  // ~1/18 = strong blur
    blurBuf.width = dw; blurBuf.height = dh;
    const bctx = blurBuf.getContext("2d");
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(ctx.canvas, x, y, bw, bh, 0, 0, dw, dh);      // downscale the region
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(blurBuf, 0, 0, dw, dh, x, y, bw, bh);          // upscale back = blur
  }

  async function startCamera() {
    camPane.style.display = "block"; camTag.textContent = L.cam_start;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camTag.textContent = L.cam_unavail; return; }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
      video.srcObject = camStream; await video.play().catch(() => {});
    } catch (e) { camTag.textContent = L.cam_blocked; camRow = null; return; }

    // load MediaPipe (face detector for the blur; hand landmarker for the wrist).
    // If it cannot load (offline), fall back to blurring the head region so a
    // face is never shown, and to a coarse wrist proxy.
    let vision = null, hasMP = false;
    try {
      vision = await import(/* @vite-ignore */ `${VISION_CDN}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
      faceDet = await vision.FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: "VIDEO" });
      handLm = await vision.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: HAND_MODEL }, numHands: 1, runningMode: "VIDEO" });
      hasMP = true; camTag.textContent = L.cam_blur;
    } catch (e) { camTag.textContent = L.cam_blur_fallback; }

    const ctx = camCanvas.getContext("2d");
    let raf = 0;
    const draw = () => {
      if (!camStream) return;
      const w = camCanvas.width = video.videoWidth || 640, h = camCanvas.height = video.videoHeight || 480;
      ctx.filter = "none"; ctx.drawImage(video, 0, 0, w, h);
      const now = performance.now();
      // face blur (real detections if available, else a generous head region)
      let faces = [];
      if (faceDet) { try { faces = (faceDet.detectForVideo(video, now).detections || []).map((d) => d.boundingBox); } catch (_) {} }
      if (!faces.length) faces = [{ originX: w * 0.20, originY: 0, width: w * 0.60, height: h * 0.55 }];
      for (const b of faces) blurRegion(ctx, w, h, b);
      // wrist location (the fused camera channel)
      if (handLm) {
        try {
          const lm = handLm.detectForVideo(video, now).landmarks;
          if (lm && lm[0]) { const wr = lm[0][0]; camRow = { wx: wr.x, wy: wr.y, wz: wr.z || 0, present: true };
            ctx.fillStyle = "rgba(95,138,92,.9)"; ctx.beginPath(); ctx.arc(wr.x * w, wr.y * h, 7, 0, 2 * Math.PI); ctx.fill(); }
          else camRow = { wx: NaN, wy: NaN, wz: NaN, present: false };
        } catch (_) {}
      } else if (!hasMP) { camRow = { wx: 0.5, wy: 0.5, wz: 0, present: true }; }
      raf = requestAnimationFrame(draw);
    };
    draw();
    camStop = () => cancelAnimationFrame(raf);
  }
  function stopCamera() {
    if (camStop) camStop(); camStop = null; camRow = null;
    try { faceDet && faceDet.close(); handLm && handLm.close(); } catch (_) {}
    faceDet = null; handLm = null;
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null; camPane.style.display = "none";
  }

  return () => { stopCamera(); cleanups.forEach((fn) => fn()); root.remove(); };
}

// a tiny fallback plan so the route still loads + demonstrates when the sink is
// down (the real schedule comes from corpus/session_plan.json via the sink).
// It has NO neutral calibration block, so beginSession refuses to run a
// real-device session on it (a real session without calibration would silently
// skip per-signer normalization).
const DEMO_PLAN = {
  plan_id: "demo", corpus_version: 1, countdown_s: 3, record_s: 2.2, gap_s: 0.7, rest_every_s: 1e9,
  blocks: [{ block: "greetings", kind: "sign", reps: 3, items: [
    { prompt_id: "greet_hallo", gloss: "HALLO", meaning_en: "hello" },
    { prompt_id: "greet_danke", gloss: "DANKE", meaning_en: "thank you" },
    { prompt_id: "greet_ja", gloss: "JA", meaning_en: "yes" }] }],
};
