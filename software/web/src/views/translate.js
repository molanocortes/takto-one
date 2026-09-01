// translate.js - the TAKTO-SIGN live sign-recognition route (#/translate). A
// read-only view of the streaming decoder: it connects to the inference server's
// events socket (infer/live_server.py, default ws://localhost:8771) and renders
// the live transcript with confidence coloring and per-sign latency. Honest by
// construction: it shows exactly what the model decoded, names itself
// recognition (not translation), and states the segmenter's limit (low-motion
// signs can be missed by the motion gate). No em dashes.

import { el } from "../ui.js";

const WS = (new URLSearchParams(location.search).get("live")) || "ws://localhost:8771";

function backGlyph() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("width", "16"); s.setAttribute("height", "16");
  s.innerHTML = '<path d="M 10 3 L 5 8 L 10 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  return s;
}

function confColor(c) {
  // low = amber, high = sapphire. Uses the console accent tokens.
  if (c >= 0.85) return "var(--ok, #3f8f6b)";
  if (c >= 0.6) return "var(--accent, #66B8FF)";
  return "var(--warn, #C08327)";
}

export function mountTranslate(rootHost) {
  localStorage.setItem("zero.role", "translate");
  const root = el("div", { class: "surf translate" });

  const linkPill = el("div", { class: "pill" }, el("span", { class: "dot warn" }), el("span", null, "connecting"));
  const bar = el("header", { class: "surf-bar" },
    el("div", { class: "surf-bar-left" },
      el("a", { href: "#/", class: "surf-back", title: "Home" }, backGlyph()),
      el("a", { href: "#/", class: "wordmark sm", title: "Home" }, el("span", { class: "wordmark-dot" }), "TAKTO"),
      el("div", { class: "surf-name" }, "Live Sign Recognition")),
    el("div", { class: "surf-bar-mid" }, el("span", { class: "sub mono" }, "Tier 1: isolated signs, signer-dependent · motion-gated (low-motion signs may be missed)")),
    el("div", { class: "surf-bar-right" }, linkPill));

  const bigSign = el("div", { class: "tr-big" }, "-");
  const bigConf = el("div", { class: "tr-bigconf mono" }, "");
  const hero = el("div", { class: "card tr-hero" }, el("div", { class: "kicker" }, "Latest sign"), bigSign, bigConf);

  const stream = el("div", { class: "tr-stream" });
  const streamCard = el("div", { class: "card tr-streamcard" }, el("div", { class: "kicker" }, "Transcript"), stream);
  const stat = el("div", { class: "tr-stat mono" }, "waiting for the inference server");

  const body = el("main", { class: "surf-body" }, el("div", { class: "tr-grid" }, hero, streamCard), stat);
  root.append(bar, body);
  rootHost.append(root);

  // collapse CONSECUTIVE repeats of the same sign into one chip with a small
  // count. Capture reps (and a signer holding a sign) emit the same sign several
  // times in a row; a translation transcript should read "WO" once, not "WO WO
  // WO". Distinct utterances still get their own chip, so a genuine repeat later
  // (e.g. a second "WO") reads as a new entry.
  let lastSign = null, lastChip = null, lastCount = 0, uttCount = 0;
  function addSign(ev) {
    bigSign.textContent = ev.sign;
    bigSign.style.color = confColor(ev.confidence);
    bigConf.textContent = `${Math.round(ev.confidence * 100)}%` + (ev.latency_ms != null ? `  ·  ${ev.latency_ms} ms` : "");
    if (ev.sign === lastSign && lastChip) {                 // same sign again: bump the count
      lastCount++;
      let badge = lastChip.querySelector(".tr-count");
      if (!badge) { badge = el("span", { class: "tr-count" }); lastChip.append(badge); }
      badge.textContent = "×" + lastCount;              // "×N"
      return;
    }
    lastSign = ev.sign; lastCount = 1; uttCount++;
    const chip = el("span", { class: "tr-chip", title: (ev.top3 || []).map((t) => `${t.sign} ${Math.round(t.p * 100)}%`).join("  ") }, el("span", { class: "tr-word" }, ev.sign));
    chip.style.borderColor = confColor(ev.confidence);
    lastChip = chip;
    stream.prepend(chip);
    while (stream.children.length > 60) stream.lastChild.remove();
  }
  function transcriptCount() { return uttCount; }

  function setPill(cls, text) {
    linkPill.replaceChildren(el("span", { class: "dot " + cls }), el("span", null, text));
  }

  let ws = null, closed = false, retry = 0, badUrl = false;
  function connect() {
    try { ws = new WebSocket(WS); badUrl = false; }
    catch (e) {
      // an unparseable ?live= URL (no scheme, "ws:/host", a bare host:port) throws
      // HERE, before any connection is attempted. Saying "connecting" forever would
      // blame the inference server for a URL the browser rejected.
      badUrl = true;
      setPill("warn", "bad live URL");
      stat.textContent = `cannot open "${WS}": ${(e && e.message) || e}. `
        + "Pass a full socket URL, e.g. ?live=ws://localhost:8771";
      return schedule();
    }
    ws.onopen = () => { retry = 0; setPill("ok", "live"); stat.textContent = "connected to " + WS; };
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch (_) { return; }
      if (d.kind === "sign") { addSign(d); stat.textContent = `${transcriptCount()} signs`; }
      else if (d.kind === "hello") { (d.transcript || []).forEach(addSign); stat.textContent = `connected - ${transcriptCount()} signs so far`; }
      else if (d.kind === "status") stat.textContent = `${d.state}${d.session ? " " + d.session : ""}`;
    };
    ws.onclose = () => { setPill("warn", "offline"); if (!closed) schedule(); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  function schedule() {
    // "connecting" must never survive a failed attempt, whichever path failed
    if (!badUrl) setPill("warn", "offline");
    const d = Math.min(500 * 2 ** Math.min(retry++, 4), 5000);
    setTimeout(() => { if (!closed) connect(); }, d);
  }
  connect();

  return () => { closed = true; if (ws) try { ws.close(); } catch (_) {} root.remove(); };
}
