// consent.js - third parties only after a yes (2026-10-01, the public site).
//
// On the public site nothing is fetched from a third party until the visitor
// agrees, per feature, in plain words (GDPR Art. 6(1)(a)). The camera features
// run Google's MediaPipe in the browser: its code comes from jsDelivr and its
// models from Google Cloud Storage, so both see the visitor's IP address, like
// any download. Video never leaves the browser. The answer lives for this page
// view only, so nothing is written to the visitor's device.
//
// On this machine and the lab LAN (isLocalOrigin) the owner is the only
// visitor, and nothing is asked.
import { el } from "./ui.js";
import { isLocalOrigin } from "./telemetry.js";

let granted = false;

/** Resolves true when MediaPipe may load (asked once per page view). */
export function askMediaPipe(feature) {
  if (granted || isLocalOrigin()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const yes = el("button", { type: "button", class: "btn primary sm" }, "Load and continue");
    const no = el("button", { type: "button", class: "btn ghost sm" }, "Cancel");
    const card = el("div", { class: "consent-card card", role: "dialog", "aria-modal": "true", "aria-labelledby": "consent-h" },
      el("h3", { id: "consent-h" }, `${feature} uses Google MediaPipe`),
      el("p", null, "To follow your hand and arm, this feature runs MediaPipe in your browser. It downloads "
        + "MediaPipe's code from jsDelivr (cdn.jsdelivr.net) and its model from Google (storage.googleapis.com). "
        + "Like any download, those services see your IP address. Your camera video stays on your device and is never uploaded."),
      el("p", { class: "consent-fine" }, "Details in the ",
        el("a", { href: "legal.html#datenschutz", target: "_blank", rel: "noopener" }, "privacy policy"), "."),
      el("div", { class: "consent-row" }, no, yes));
    const scrim = el("div", { class: "consent-scrim" }, card);
    const done = (ok) => {
      granted = ok;
      document.removeEventListener("keydown", onKey, true);
      scrim.remove();
      resolve(ok);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(false); } };
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    scrim.addEventListener("click", (e) => { if (e.target === scrim) done(false); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(scrim);
    yes.focus();
  });
}
