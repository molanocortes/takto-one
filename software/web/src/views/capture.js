// capture.js - the data console. Instrument register: set up a labelled take
// in seconds, record open-ended to the device SD with live quality, and browse
// a premium take library.

import { el, clamp, toast, fmtClock, fmtDur } from "../ui.js";
import { store } from "../store.js";
import { drawSpark } from "../charts.js";
import { setReplayTake } from "./replay.js";

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
  // HONESTY (the ?ws= mock trap): without ?ws= the console runs on the built-in
  // mock, so a "take" recorded here is browser-local fiction that disappears on
  // reload. Say so, exactly as Operator does, and make live-but-unreachable a
  // distinct state instead of a frozen timer.
  const mockBadge = el("button", { class: "mock-badge",
    title: "Showing simulated data: takes recorded here are not real and are not stored on the host. Click to connect to the live bridge (ws://localhost:8765/ws)." }, "MOCK DATA");
  mockBadge.addEventListener("click", () => {
    const u = new URL(location.href);
    u.searchParams.set("ws", "ws://localhost:8765/ws");
    location.href = u.toString();   // full reload into live mode (also remembered)
  });
  if (store.live) mockBadge.style.display = "none";
  const linkBadge = el("button", { class: "mock-badge",
    title: "The live bridge is not answering: recording commands are being dropped. Reconnecting automatically; click to reload now." }, "LINK DOWN");
  linkBadge.addEventListener("click", () => location.reload());
  linkBadge.style.display = "none";
  if (store.live) {
    const updLink = (up) => { linkBadge.style.display = up ? "none" : ""; };
    updLink(store.connected);
    cleanups.push(store.onLink(updLink));
  }
  const bar = el("header", { class: "surf-bar" },
    el("div", { class: "surf-bar-left" },
      el("a", { href: "#/", class: "surf-back", title: "Home" }, backGlyph()),
      el("a", { href: "#/", class: "wordmark sm", title: "Home" }, el("span", { class: "wordmark-dot" }), "TAKTO"),
      el("div", { class: "surf-name" }, "Capture")),
    el("div", { class: "surf-bar-mid" }),
    el("div", { class: "surf-bar-right" },
      mockBadge, linkBadge,
      el("div", { class: "pill" }, el("span", { class: "sd-glyph mono" }, "SD"), "device storage"),
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

  const capLeft = el("div", { class: "cap-left" }, setupCard, recordCard);

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
    filterChips, libList);

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

  function exportTake(take) {
    const blob = new Blob([JSON.stringify(take, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: take.id + ".json" });
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`${take.id} exported`, { tone: "live" });
  }

  function takeCard(take, isNew) {
    const cv = el("canvas", { class: "take-spark" });
    const qualityTone = take.quality === "good" ? "ok" : "warn";
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
          el("span", { class: `pill take-q` }, el("span", { class: `dot ${qualityTone}` }), take.quality)),
        cv,
        el("div", { class: "take-meta" },
          el("span", { class: "take-profile" }, take.profile),
          taskChip,
          el("span", { class: "num take-dur" }, fmtDur(take.duration_s)),
          el("span", { class: "num take-n" }, take.samples.toLocaleString() + " samples"))),
      el("button", { class: "take-export", title: "Export metadata", onclick: () => exportTake(take) }, "↓"));
    if (take.has_data) {
      // 4D replay: this take carries host-side sample rows (and, if recorded
      // in AR, the room scan + wrist trajectory) - open the replay stage
      const rp = el("button", { class: "take-export", title: "Replay in 3D" }, "▶");
      rp.addEventListener("click", () => { setReplayTake(take.id); location.hash = "#/replay"; });
      node.append(rp);
    }
    requestAnimationFrame(() => drawSpark(cv, take.spark, take.quality === "good" ? "#C9401B" : "#C08327"));
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
    const rec = !!s.session?.recording;
    if (rec !== recording) {
      recording = rec;
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
      gates.rate.fill.style.transform = `scaleX(${clamp(rate / 50, 0, 1)})`;
      gates.rate.fill.classList.toggle("warn", !rateOk);
      gates.rate.val.textContent = rate + " Hz";

      const curl = s.joints ? s.joints.reduce((a, j) => a + j.deg, 0) / s.joints.length : 0;
      const c01 = clamp((curl - 8) / 52, 0, 1);
      if (c01 < recCoverage.lo) recCoverage.lo = c01;
      if (c01 > recCoverage.hi) recCoverage.hi = c01;
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
