// i18n.js - locale state + the active string table for the website (entry
// page). DEFAULT IS ENGLISH (owner-directed); German and Spanish are full
// translations, not machine sludge - edit them in src/locales/*.js.
//
// Scope note: the ENTRY page (the website) is localized. The instrument
// consoles (operator/guided/capture/replay) stay English deliberately - they
// are lab surfaces, and their vocabulary matches the thesis + logs.

import { L as EN } from "./locales/en.js";
import { L as DE } from "./locales/de.js";
import { L as ES } from "./locales/es.js";

const KEY = "zero.lang";
export const LOCALES = { en: EN, de: DE, es: ES };
export const LANG_LABELS = { en: "EN", de: "DE", es: "ES" };

// Same guard as theme.js: localStorage THROWS when site data is blocked for the
// origin, and this runs before first paint, so an unguarded read blanked the app.
// An in-memory copy cannot help across setLang's reload (module state dies with
// the page), so the choice travels in the URL instead: ?lang=de outranks storage.
function urlLang() {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    return LOCALES[q] ? q : null;
  } catch (_) { return null; }
}

export function getLang() {
  const q = urlLang();
  if (q) return q;
  let l = null;
  try { l = localStorage.getItem(KEY); } catch (_) {}
  return LOCALES[l] ? l : "en";
}

export function setLang(l) {
  if (!LOCALES[l]) return;
  try { localStorage.setItem(KEY, l); } catch (_) {}   // blocked origin: URL carries it
  // the entry page builds its DOM from the locale at mount time, so a reload is
  // the honest, glitch-free way to rebuild everything (incl. <html lang>). The
  // reload goes through ?lang=, which works whether or not storage is available.
  try {
    const u = new URL(location.href);
    u.searchParams.set("lang", l);
    location.replace(u.toString());
  } catch (_) {
    location.reload();
  }
}

export function strings() {
  return LOCALES[getLang()];
}

// call once before first paint (main.js)
export function initLang() {
  document.documentElement.lang = getLang();
}
