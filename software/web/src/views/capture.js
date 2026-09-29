// capture.js - the data console. Instrument register: set up a labelled take
// in seconds, record open-ended to the device SD with live quality, and browse
// a premium take library.

import { el, clamp, toast, fmtClock, fmtDur } from "../ui.js";
import { store } from "../store.js";
import { drawSpark } from "../charts.js";
import { setReplayTake } from "./replay.js";
import { sourceBadges } from "../sim_badge.js";
import { zipStore } from "../zip_store.js";

const TASKS = ["grasp-cylinder", "grasp-sphere", "pinch", "open-close", "free-manipulation"];

function backGlyph() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("width", "16"); s.setAttribute("height", "16");
  s.innerHTML = '<path d="M 10 3 L 5 8 L 10 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  return s;
}

export function mountCapture(rootHost) {
  localStorage.setItem("zero.role", "capture");
  const root = el("div", { class: "surf cap" });
  const cleanups = [];

  // ---------------- state ----------------
  let takes = [];
  let recording = false;
  let recCoverage = { lo: Infinity, hi: -Infinity };
  const setup = {
    profile: localStorage.getItem("zero.profile") || "",
    task: localStorage.getItem("zero.task") || TASKS[0],
    notes: "",
  };
  const filter = { text: "", profile: null, task: null };

  // ---------------- top bar ----------------
  const recPill = el("div", { class: "pill" }, el("span", { class: "dot ok" }), el("span", null, "idle"));
  // HONESTY: when the in-browser simulation is the source, a "take" recorded
  // here is browser-local fiction that disappears on reload. Say so, exactly
  // as Operator does, and make live-but-unreachable a distinct state instead
  // of a frozen timer (sim_badge.js follows the source as it changes).
  const [mockBadge, linkBadge] = sourceBadges(cleanups, {
    linkTitle: "The live bridge is not answering: recording commands are being dropped. Reconnecting automatically; click to reload now." });
  const bar = el("header", { class: "surf-bar" },
    el("div", { class: "surf-bar-left" },
      el("a", { href: "#/", class: "surf-back", title: "Home" }, backGlyph()),
      el("a", { href: "#/", class: "wordmark sm", title: "Home" }, el("span", { class: "wordmark-dot" }), "TAKTO"),
      el("div", { class: "surf-name" }, "Capture")),
    el("div", { class: "surf-bar-mid" }),
    el("div", { class: "surf-bar-right" },
      mockBadge, linkBadge,
      el("div", { class: "pill cap-storage-pill" }, el("span", { class: "sd-glyph mono" }, "SD"), "device storage"),
      recPill));

  // ---------------- setup card ----------------
  const profileInput = el("input", { placeholder: "Profile name", value: setup.profile, spellcheck: "false" });
  profileInput.addEventListener("input", () => { setup.profile = profileInput.value; localStorage.setItem("zero.profile", setup.profile); });
  const profileChips = el("div", { class: "chip-row", id: "profile-chips" });

  const taskChips = el("div", { class: "chip-row" });
  const customTask = el("input", { placeholder: "custom label", class: "task-custom", spellcheck: "false" });
  function renderTaskChips() {
    taskChips.replaceChildren(
      ...TASKS.map((t) => {
        const c = el("button", { class: "chip" + (setup.task === t ? " on" : "") }, t);
        c.addEventListener("click", () => { setup.task = t; localStorage.setItem("zero.task", t); customTask.value = ""; renderTaskChips(); });
        return c;
      }), customTask);
  }
  renderTaskChips();
  customTask.addEventListener("input", () => {
    if (customTask.value.trim()) { setup.task = customTask.value.trim().toLowerCase().replace(/\s+/g, "-"); renderTaskChips0(); }
  });
  // keep custom text but clear preset highlight
  function renderTaskChips0() {
    taskChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
  }

  const notesInput = el("input", { placeholder: "Notes (optional)", spellcheck: "false" });
  notesInput.addEventListener("input", () => (setup.notes = notesInput.value));

  const setupCard = el("div", { class: "card cap-setup" },
    el("div", { class: "kicker" }, "New take"),
    el("div", { class: "cap-field" }, profileInput, profileChips),
    el("div", { class: "cap-field" }, taskChips),
    el("div", { class: "cap-field" }, notesInput));

  // ---------------- record card ----------------
  const recBtn = el("button", { class: "rec-btn", title: "Start recording" }, el("span", { class: "rec-core" }));
  const recWord = el("div", { class: "rec-word" }, "Record");
  const recSub = el("div", { class: "rec-sub mono" }, "open-ended · to device SD");

  const timer = el("div", { class: "rec-timer num" }, "00:00");
  const samples = el("div", { class: "rec-samples mono" }, "0 samples");
  const gates = {};
  function gate(name) {
    const dot = el("span", { class: "dot ok" });
    const fill = el("div", { class: "gate-fill" });
    const val = el("span", { class: "num gate-val" }, "");
    gates[name] = { dot, fill, val };
    return el("div", { class: "gate-row" }, dot, el("span", { class: "gate-k" }, name), el("div", { class: "gate-track" }, fill), val);
  }
  const gatesEl = el("div", { class: "rec-gates" }, gate("streams"), gate("rate"), gate("coverage"));
  const recLive = el("div", { class: "rec-live" }, timer, samples, gatesEl);

  const recordCard = el("div", { class: "card cap-record" },
    el("div", { class: "rec-idle" }, recBtn, recWord, recSub),
    recLive);

  recBtn.addEventListener("click", () => {
    if (!recording) {
      const name = setup.profile.trim() || "Operator";
      const task = (customTask.value.trim() ? customTask.value.trim().toLowerCase().replace(/\s+/g, "-") : setup.task) || "unlabelled";
      recCoverage = { lo: Infinity, hi: -Infinity };
      store.send({ cmd: "record", action: "start", profile: { name }, task, notes: setup.notes });
    } else {
      store.send({ cmd: "record", action: "stop" });
    }
  });

  // ---------------- device recording (v16 device block) ----------------
  // The device writes every take to its SD card too (the archival copy), and
  // records on its own when it runs standalone from a power bank. This card is
  // the device's view of that: card present, recording, take number, rows,
  // standby, and the standalone auto-record switch.
  const devDot = el("span", { class: "dot" });
  const devState = el("span", { class: "dev-state" }, "no device report");
  const devTake = el("span", { class: "num dev-v" }, "—");
  const devRows = el("span", { class: "num dev-v" }, "—");
  const devPower = el("span", { class: "num dev-v" }, "—");
  const autoSwitch = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": "false",
    title: "Start a take automatically when the device boots without a host (power bank)" },
    el("span", { class: "switch-knob" }));
  let autoOn = null;
  autoSwitch.addEventListener("click", () => {
    if (autoOn == null) return;
    if (!store.send({ cmd: "sd", action: "auto", on: !autoOn })) { toast("Link down: not sent", { tone: "warn" }); return; }
    autoSwitch.classList.add("pending");
  });
  const deviceCard = el("div", { class: "card cap-device" },
    el("div", { class: "cap-dev-head" }, el("span", { class: "kicker" }, "Device recording"),
      el("span", { class: "dev-status" }, devDot, devState)),
    el("div", { class: "dev-grid" },
      el("span", { class: "dev-k" }, "take"), devTake,
      el("span", { class: "dev-k" }, "rows"), devRows,
      el("span", { class: "dev-k" }, "power"), devPower),
    el("div", { class: "dev-auto" },
      el("div", null, el("div", { class: "dev-auto-k" }, "Auto-record when standalone"),
        el("div", { class: "dev-auto-sub" }, "powered from a battery, no host: the device records by itself")),
      autoSwitch));
  deviceCard.style.display = "none";

  // ---------------- SD library ----------------
  const sdList = el("div", { class: "sd-list" });
  const sdCount = el("span", { class: "num lib-count" }, "0");
  const sdRefresh = el("button", { class: "btn ghost sm", type: "button" }, "Refresh");
  sdRefresh.addEventListener("click", () => {
    if (!store.send({ cmd: "sd", action: "list" })) toast("Link down: not sent", { tone: "warn" });
  });
  const sdCard = el("div", { class: "card cap-sd" },
    el("div", { class: "cap-dev-head" },
      el("div", { class: "lib-title" }, el("span", { class: "kicker" }, "SD card"), sdCount), sdRefresh),
    el("p", { class: "sd-note" }, "Takes recorded on the device. Import copies one over USB, runs it through the same pipeline as live data, and adds it to the library and replay."),
    sdList);
  sdCard.style.display = "none";
  const sdProgress = new Map();        // name -> pct while importing
  let sdMsg = null;
  const fmtBytes = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " kB";
  function renderSd() {
    const m = sdMsg;
    sdCard.style.display = m ? "" : "none";
    if (!m) return;
    const items = m.items || [];
    sdCount.textContent = String(items.length);
    sdList.replaceChildren(...(items.length ? items.map((it) => {
      const pct = sdProgress.get(it.name);
      const importing = pct != null;
      const btn = it.imported_take
        ? el("button", { class: "btn ghost sm", type: "button", title: "Open the imported take in replay" }, "Replay")
        : el("button", { class: "btn primary sm", type: "button" }, importing ? "Importing…" : "Import");
      btn.disabled = importing || (!!m.busy && !it.imported_take);
      btn.addEventListener("click", () => {
        if (it.imported_take) { setReplayTake(it.imported_take); location.hash = "#/replay"; return; }
        if (!store.send({ cmd: "sd", action: "import", name: it.name })) { toast("Link down: not sent", { tone: "warn" }); return; }
        sdProgress.set(it.name, 0);
        renderSd();
      });
      const bar = el("div", { class: "sd-bar" }, el("div", { class: "sd-bar-fill", style: `transform:scaleX(${(pct || 0) / 100})` }));
      return el("div", { class: "sd-item" + (importing ? " importing" : "") },
        el("div", { class: "sd-main" },
          el("span", { class: "mono sd-name" }, it.name),
          el("span", { class: "num sd-size" }, fmtBytes(it.bytes || 0)),
          it.imported_take
            ? el("span", { class: "sd-tag ok mono" }, "in library · " + it.imported_take)
            : el("span", { class: "sd-tag mono" }, importing ? `${pct}%` : "on card only")),
        importing ? bar : null,
        btn);
    }) : [el("p", { class: "sd-note" }, "No takes on the card.")]));
  }
  cleanups.push(store.onKind("sd_takes", (m) => { sdMsg = m; for (const it of m.items || []) if (it.imported_take) sdProgress.delete(it.name); renderSd(); }));
  cleanups.push(store.onAck((a) => {
    if (a.event === "sd_import") { sdProgress.set(a.name, Math.round(a.pct || 0)); renderSd(); }
    else if (a.event === "sd_imported") {
      sdProgress.delete(a.name);
      toast(`Imported ${a.name} · ${a.take}`, { tone: "ok" });
      renderSd();
      refreshTakes(true);
    } else if (a.event === "sd_auto") {
      autoSwitch.classList.remove("pending");
    } else if (a.event === "error" && a.cmd === "sd") {
      if (a.name) sdProgress.delete(a.name);
      autoSwitch.classList.remove("pending");
      toast("SD: " + (a.error || "failed"), { tone: "warn" });
      renderSd();
    }
  }));
  if (store.lastSd) { sdMsg = store.lastSd; renderSd(); }
  store.send({ cmd: "sd", action: "list" });   // in case the join push predates this mount

  const capLeft = el("div", { class: "cap-left" }, setupCard, recordCard, deviceCard);

  // ---------------- take library ----------------
  const libCount = el("span", { class: "num lib-count" }, "0");
  const searchInput = el("input", { class: "lib-search", placeholder: "Search takes", spellcheck: "false" });
  searchInput.addEventListener("input", () => { filter.text = searchInput.value.toLowerCase(); renderLib(); });
  const filterChips = el("div", { class: "chip-row lib-filters" });
  const libList = el("div", { class: "lib-list" });
  const capRight = el("div", { class: "cap-right" },
    el("div", { class: "lib-head" },
      el("div", { class: "lib-title" }, el("span", { class: "kicker" }, "Take library"), libCount),
      searchInput),
    filterChips, libList, sdCard);

  function renderFilterChips() {
    const profiles = [...new Set(takes.map((t) => t.profile))];
    const tasks = [...new Set(takes.map((t) => t.task))];
    filterChips.replaceChildren(
      ...profiles.map((p) => {
        const c = el("button", { class: "chip" + (filter.profile === p ? " on" : "") }, p);
        c.addEventListener("click", () => { filter.profile = filter.profile === p ? null : p; renderFilterChips(); renderLib(); });
        return c;
      }),
      el("span", { class: "chip-sep" }),
      ...tasks.map((t) => {
        const c = el("button", { class: "chip" + (filter.task === t ? " on" : "") }, t);
        c.addEventListener("click", () => { filter.task = filter.task === t ? null : t; renderFilterChips(); renderLib(); });
        return c;
      }));
    // recent profiles into setup too
    profileChips.replaceChildren(...profiles.slice(0, 3).map((p) => {
      const c = el("button", { class: "chip" }, p);
      c.addEventListener("click", () => { setup.profile = p; profileInput.value = p; localStorage.setItem("zero.profile", p); });
      return c;
    }));
  }

  function download(name, text, type) {
    const blob = text instanceof Blob ? text : new Blob([text], { type });
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // Export: the metadata alone, or the take's actual ROWS (take_data from the
  // host) as CSV (one header row of column names, empty cells for absent
  // values) or as the replay JSON the viewer itself reads.
  // The research package (MOTION_PIPELINE.md s.8): one zip per take with
  // take.csv (every row, SI units, header documented in take.json), take.json
  // (metadata, quality, provenance, column dictionary) and the raw device
  // stream (the take's S/E lines with receive times, or the SD card file),
  // fetched from the bridge in chunks ({"cmd":"take_file"}).
  let exporting = null;
  async function exportResearch(take, only = null) {
    if (exporting) { toast(`Still exporting ${exporting}`, { tone: "warn" }); return; }
    if (!store.live) { toast("The research export needs the live bridge", { tone: "warn" }); return; }
    exporting = take.id;
    const mb = (b) => (b / 1e6).toFixed(b > 1e7 ? 0 : 1);
    let lastToast = 0;
    const prog = (label) => (got, total) => {
      const now = performance.now();
      if (now - lastToast > 1200 && total > 2e6) { lastToast = now; toast(`${take.id} · ${label} ${mb(got)} / ${mb(total)} MB`, { tone: "live" }); }
    };
    try {
      if (only) {
        const f = await store.requestTakeFile(take.id, only, prog(only));
        download(f.name, new Blob(f.parts, { type: f.mime }));
        toast(`${f.name} · ${mb(f.bytes)} MB`, { tone: "ok" });
        return;
      }
      toast(`Preparing the research package of ${take.id}…`, { tone: "live" });
      const meta = await store.requestTakeFile(take.id, "meta");
      const csv = await store.requestTakeFile(take.id, "csv", prog("rows"));
      let raw = null, rawErr = null;
      try { raw = await store.requestTakeFile(take.id, "raw", prog("raw stream")); }
      catch (e) { rawErr = e.message; }
      const dir = take.id + "_research/";
      const files = [{ name: dir + "take.csv", parts: csv.parts }, { name: dir + "take.json", parts: meta.parts }];
      if (raw) files.push({ name: dir + (raw.name.endsWith(".sd.csv.gz") ? "take.sd.csv.gz" : "take.raw.txt.gz"), parts: raw.parts });
      download(take.id + "_research.zip", zipStore(files));
      const n = csv.parts.reduce((a, p) => a + p.length, 0) + meta.bytes + (raw ? raw.bytes : 0);
      toast(`${take.id} research package · ${mb(n)} MB` + (rawErr ? ` · no raw stream (${rawErr})` : ""),
        { tone: rawErr ? "warn" : "ok" });
    } catch (e) {
      toast(`${take.id}: ${e.message}`, { tone: "warn" });
    } finally {
      exporting = null;
    }
  }

  async function exportTake(take, what) {
    if (what === "research" || what === "raw") { exportResearch(take, what === "raw" ? "raw" : null); return; }
    if (what === "meta") {
      download(take.id + ".meta.json", JSON.stringify(take, null, 2), "application/json");
      toast(`${take.id} metadata exported`, { tone: "live" });
      return;
    }
    toast(`Fetching ${take.id} rows…`, { tone: "live" });
    let d;
    try { d = await store.requestTakeData(take.id); }
    catch (e) { toast(`${take.id}: ${e.message}`, { tone: "warn" }); return; }
    if (what === "csv") {
      const cell = (v) => (v == null ? "" : typeof v === "number" ? String(v) : JSON.stringify(v));
      const lines = [d.cols.join(","), ...d.rows.map((r) => r.map(cell).join(","))];
      download(take.id + ".csv", lines.join("\n") + "\n", "text/csv");
    } else {
      const payload = { ...d, meta: take };
      delete payload.kind;
      download(take.id + ".json", JSON.stringify(payload), "application/json");
    }
    toast(`${take.id} · ${d.rows.length.toLocaleString()} rows exported`, { tone: "ok" });
  }
  let openMenu = null;
  function exportMenu(take, anchor) {
    if (openMenu) { openMenu.remove(); const same = openMenu._take === take.id; openMenu = null; if (same) return; }
    const item = (label, sub, what, enabled = true) => {
      const b = el("button", { class: "exp-item", type: "button" }, el("span", null, label), el("span", { class: "exp-sub mono" }, sub));
      b.disabled = !enabled;
      b.addEventListener("click", () => { menu.remove(); openMenu = null; exportTake(take, what); });
      return b;
    };
    const research = store.live && !!take.has_data;
    const menu = el("div", { class: "exp-menu", role: "menu" },
      item("Research package · ZIP", research ? "take.csv (SI) + take.json + raw stream"
        : (store.live ? "no rows for this take" : "needs the live bridge"), "research", research),
      item("Raw device stream", store.live && take.raw ? `${take.raw.file} · ${((take.raw.bytes || 0) / 1e6).toFixed(1)} MB`
        : "not kept for this take", "raw", !!(store.live && take.raw)),
      item("Rows · CSV", take.has_data ? "every sample, named columns" : "no rows for this take", "csv", !!take.has_data),
      item("Rows · JSON", take.has_data ? "replay format (cols + rows)" : "no rows for this take", "json", !!take.has_data),
      item("Metadata · JSON", "labels, duration, quality", "meta"));
    menu._take = take.id;
    anchor.closest(".take").append(menu);
    openMenu = menu;
  }
  const closeMenu = (e) => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest(".take-export.exp")) { openMenu.remove(); openMenu = null; } };
  document.addEventListener("pointerdown", closeMenu);
  cleanups.push(() => document.removeEventListener("pointerdown", closeMenu));

  // quality badges from the take's `quality` block (bridge v17); a pre-v17
  // take carries only a word, shown as before
  function qualityBadges(q) {
    if (!q || typeof q !== "object") return [];
    const pct = (v) => (Number.isFinite(v) ? (v >= 10 ? v.toFixed(0) : v.toFixed(1)) : "?");
    const out = [];
    if (Number.isFinite(q.rate_hz)) {
      const ok = !q.nominal_hz || Math.abs(q.rate_hz - q.nominal_hz) <= 0.02 * q.nominal_hz;
      out.push(el("span", { class: "take-qb " + (ok ? "ok" : "warn"),
        title: `device frames per second over the take (nominal ${q.nominal_hz || "?"} Hz, clock ${q.clock || "?"})` },
        `${Math.round(q.rate_hz)} Hz`));
    }
    const dr = q.dropped || 0;
    out.push(el("span", { class: "take-qb " + (dr === 0 ? "ok" : q.dropped_pct > 1 ? "stop" : "warn"),
      title: `${dr} frames missing in ${q.gaps || 0} gaps (gap > 1.5 x the nominal period); longest ${Math.round(q.max_gap_ms || 0)} ms` },
      dr === 0 ? "0 drops" : `${dr} drops · ${pct(q.dropped_pct)}%`));
    const cp = q.cal_pct || {};
    const n = q.neutral || {};
    const cal = cp.calibrated >= 95 ? ["ok", "calibrated"] : cp.calibrated >= 50 ? ["warn", "part-cal"]
      : cp.provisional >= 50 ? ["warn", "provisional"] : ["stop", "no neutral"];
    out.push(el("span", { class: "take-qb " + cal[0],
      title: `body neutral: ${pct(cp.calibrated)}% calibrated, ${pct(cp.provisional)}% provisional, ${pct(cp.none)}% none` +
        (n.kind ? `\nneutral at start: ${n.kind}` + (Number.isFinite(n.age_s) ? `, ${n.age_s} s before` : "") +
          (Number.isFinite(n.spread_deg) ? `, hold spread ${n.spread_deg} deg` : "") : "") },
      cal[1]));
    const im = q.imu_live_pct || {};
    const imMin = Math.min(im.hand ?? 0, im.forearm ?? 0);
    if (imMin < 99.5) out.push(el("span", { class: "take-qb " + (imMin < 90 ? "stop" : "warn"),
      title: `IMU live: hand ${pct(im.hand)}%, forearm ${pct(im.forearm)}%, thumb ${pct(im.thumb)}%` }, `IMU ${pct(imMin)}%`));
    return out;
  }
  function qualityTitle(q) {
    if (!q || typeof q !== "object") return "";
    const L = [`grade ${q.grade}` + (q.issues && q.issues.length ? ": " + q.issues.join("; ") : "")];
    if (q.latency_ms) L.push(`pose-lane latency ${q.latency_ms.median} / ${q.latency_ms.p95} ms (p50 / p95, in the bridge)`);
    const t = q.timing || {};
    if (t.qage_ms && t.qage_ms.forearm) L.push(`IMU sample age forearm ${t.qage_ms.forearm.median} / ${t.qage_ms.forearm.p95} ms`);
    if (t.enc_ms) L.push(`encoder sweep ${t.enc_ms.median} ms`);
    if (t.rx_jitter_ms) L.push(`serial jitter ${t.rx_jitter_ms.median} / ${t.rx_jitter_ms.p95} ms`);
    if (q.enc_live) L.push(`encoders live: ${q.enc_live.length ? q.enc_live.join(", ") : "none"}`);
    return L.join("\n");
  }

  function takeCard(take, isNew) {
    const cv = el("canvas", { class: "take-spark" });
    const qObj = take.quality && typeof take.quality === "object" ? take.quality : null;
    const qWord = qObj ? qObj.grade : take.quality;
    const qualityTone = qWord === "good" ? "ok" : "warn";
    const taskChip = el("button", { class: "take-task chip" }, take.task);
    if (store.live) {
      // On the live bridge the HOST library is authoritative: every takes push
      // replaces the client copy wholesale, and the bridge has no relabel
      // command. A local edit here would be reverted without notice, so do not
      // offer one and do not toast a success that was never persisted.
      taskChip.disabled = true;
      taskChip.title = "The host owns take labels: set the label in New take before recording. "
        + "An edit here would be reverted by the next library push.";
    } else taskChip.addEventListener("click", () => {
      const input = el("input", { class: "take-relabel", value: take.task, spellcheck: "false" });
      taskChip.replaceWith(input);
      input.focus(); input.select();
      const commit = () => {
        take.task = input.value.trim().toLowerCase().replace(/\s+/g, "-") || take.task;
        renderFilterChips(); renderLib();
        toast("Relabelled " + take.id + " (mock library, this browser only)", { tone: "warn" });
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") renderLib(); });
      input.addEventListener("blur", commit);
    });
    const node = el("div", { class: "card take" + (isNew ? " new" : "") },
      el("div", { class: "take-main" },
        el("div", { class: "take-id-row" },
          el("span", { class: "mono take-id" }, take.id),
          el("span", { class: `pill take-q`, title: qualityTitle(qObj) }, el("span", { class: `dot ${qualityTone}` }), qWord || "—")),
        cv,
        qObj ? el("div", { class: "take-qbs" }, ...qualityBadges(qObj)) : null,
        el("div", { class: "take-meta" },
          el("span", { class: "take-profile" }, take.profile),
          taskChip,
          el("span", { class: "num take-dur" }, fmtDur(take.duration_s)),
          el("span", { class: "num take-n" }, (take.samples || 0).toLocaleString() + " samples"),
          take.source === "sd" ? el("span", { class: "take-flag mono", title: "Imported from the device SD card" }, "SD") : null,
          take.body ? el("span", { class: "take-flag mono", title: "Carries the body-frame arm (elbow, wrist, segment quaternions)" }, "arm") : null)),
      el("button", { class: "take-export exp", title: "Export rows or metadata",
        onclick: (e) => exportMenu(take, e.currentTarget) }, "↓"));
    if (take.has_data) {
      // 4D replay: this take carries host-side sample rows (and, if recorded
      // in AR, the room scan + wrist trajectory) - open the replay stage
      const rp = el("button", { class: "take-export", title: "Replay in 3D" }, "▶");
      rp.addEventListener("click", () => { setReplayTake(take.id); location.hash = "#/replay"; });
      node.append(rp);
    }
    requestAnimationFrame(() => drawSpark(cv, take.spark, qWord === "good" ? "#C9401B" : "#C08327"));
    return node;
  }

  let newestId = null;
  function renderLib() {
    const list = takes.filter((t) =>
      (!filter.profile || t.profile === filter.profile) &&
      (!filter.task || t.task === filter.task) &&
      (!filter.text || (t.id + t.profile + t.task).toLowerCase().includes(filter.text)));
    libCount.textContent = String(list.length);
    libList.replaceChildren(...list.map((t) => takeCard(t, t.id === newestId)));
  }

  function refreshTakes(markNew) {
    store.listTakes().then((t) => {
      takes = t;
      if (markNew && takes.length) newestId = takes[0].id;
      renderFilterChips();
      renderLib();
      setTimeout(() => { newestId = null; }, 2400);
    });
  }
  refreshTakes(false);

  // ---------------- live wiring ----------------
  cleanups.push(store.onAck((a) => {
    if (a.event === "rec_started") toast("Recording " + a.id, { tone: "rec" });
    if (a.event === "rec_stopped") { toast("Take sealed · " + a.id, { tone: "ok" }); refreshTakes(true); }
  }));

  // library pushes cover what acks cannot: the initial sync on connect, and a
  // take another client (phone, AR) just sealed on the shared host
  cleanups.push(store.onTakes(() => refreshTakes(false)));

  cleanups.push(store.onSnap((s) => {
    const dev = s.device;
    deviceCard.style.display = dev ? "" : "none";
    if (dev) {
      const st = dev.standby ? ["warn", "standby"]
        : !dev.sd_present ? ["stop", "no SD card"]
        : dev.neutral_running ? ["live", "calibrating"]
        : dev.sd_recording ? ["rec", "recording to SD"]
        : ["ok", "SD card ready"];
      devDot.className = "dot " + st[0];
      devState.textContent = st[1];
      devTake.textContent = dev.sd_recording && dev.sd_take ? "TK" + String(dev.sd_take).padStart(5, "0") : "—";
      devRows.textContent = dev.sd_recording ? (dev.sd_rows || 0).toLocaleString() : "—";
      devPower.textContent = dev.standby ? "standby" : "awake" + (dev.fw ? ` · fw ${dev.fw}` : "");
      if (autoOn !== !!dev.standalone_auto_record) {
        autoOn = !!dev.standalone_auto_record;
        autoSwitch.classList.toggle("on", autoOn);
        autoSwitch.setAttribute("aria-checked", String(autoOn));
        autoSwitch.classList.remove("pending");
      }
    }
    const rec = !!s.session?.recording;
    if (rec !== recording) {
      recording = rec;
      // a take started anywhere (this page, another client, the device) gets
      // a fresh coverage window; the old one carried the previous take's range
      if (rec) recCoverage = { lo: Infinity, hi: -Infinity };
      root.classList.toggle("recording", rec);
      recordCard.classList.toggle("rec-on", rec);
      recBtn.classList.toggle("armed", rec);
      recBtn.title = rec ? "Stop recording" : "Start recording";
      recWord.textContent = rec ? "Stop" : "Record";
      recSub.textContent = rec ? `${s.session.profile} · ${s.session.task}` : "open-ended · to device SD";
      recPill.replaceChildren(
        el("span", { class: "dot " + (rec ? "rec" : "ok") }),
        el("span", null, rec ? "REC" : "idle"));
    }
    if (rec) {
      timer.textContent = fmtClock(s.session.elapsed_ms || 0);
      samples.textContent = (s.session.samples || 0).toLocaleString() + " samples";
      // gates
      const okStreams = (s.health || []).filter((h) => h.ok).length;
      const nStreams = (s.health || []).length || 1;
      gates.streams.dot.className = "dot " + (okStreams === nStreams ? "ok" : "warn");
      gates.streams.fill.style.transform = `scaleX(${okStreams / nStreams})`;
      gates.streams.fill.classList.toggle("warn", okStreams !== nStreams);
      gates.streams.val.textContent = `${okStreams}/${nStreams}`;

      const enc = (s.health || []).find((h) => h.stream === "encoders");
      const rate = enc ? enc.rate_hz : 0;
      const rateOk = rate >= 45;
      gates.rate.dot.className = "dot " + (rateOk ? "ok" : "warn");
      gates.rate.fill.style.transform = `scaleX(${clamp(rate / Math.max(50, rate), 0, 1)})`;
      gates.rate.fill.classList.toggle("warn", !rateOk);
      gates.rate.val.textContent = rate + " Hz";

      // coverage = the range of whole-hand FLEXION this take has swept. Only
      // live flexion channels count: {f}_mcp is the signed abduction encoder,
      // and an ok:false channel is a 0.0 zero-fill, not a measurement; mixing
      // either in flattened the range. Normalised over the true ROM exactly
      // like the store's curl (0..95 deg mean of MCP 90 / PIP 110 stops).
      let sum = 0, n = 0;
      for (const j of s.joints || []) if (j.ok && !j.id.endsWith("_mcp")) { sum += j.deg; n++; }
      if (n) {
        const c01 = clamp((sum / n) / 95, 0, 1);
        if (c01 < recCoverage.lo) recCoverage.lo = c01;
        if (c01 > recCoverage.hi) recCoverage.hi = c01;
      }
      const cov = recCoverage.hi > recCoverage.lo ? recCoverage.hi - recCoverage.lo : 0;
      const covOk = cov > 0.55;
      gates.coverage.dot.className = "dot " + (covOk ? "ok" : "warn");
      gates.coverage.fill.style.transform = `scaleX(${clamp(cov, 0.02, 1)})`;
      gates.coverage.fill.classList.toggle("warn", !covOk);
      gates.coverage.val.textContent = Math.round(cov * 100) + "%";
    }
  }));

  const body = el("main", { class: "surf-body" }, el("div", { class: "cap-grid" }, capLeft, capRight));
  root.append(bar, body);
  rootHost.append(root);

  return () => { cleanups.forEach((fn) => fn()); root.remove(); };
}
