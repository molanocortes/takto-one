// theme.js - light/dark theme state for the whole console.
//
// DEFAULT IS LIGHT (owner-directed): no prefers-color-scheme sniffing - the
// page opens as Paper Studio unless the visitor chose Night Studio before
// (persisted in localStorage). The active theme lives as data-theme on <html>
// so every token in tokens.css flips at once; interested runtimes (the twin)
// listen for the "zero:theme" event to swap their own materials.

const KEY = "zero.theme";

// Storage can THROW, not just return null (cookies/site-data blocked for the
// origin, Safari private mode quota). This module runs before first paint, so an
// unguarded access took the whole console down to a blank page. Fall back to an
// in-memory choice: the theme still works for the session, it just is not saved.
let memTheme = null;
function readKey() {
  try { return localStorage.getItem(KEY); } catch (_) { return memTheme; }
}
function writeKey(v) {
  memTheme = v;
  try { localStorage.setItem(KEY, v); } catch (_) {}
}

export function getTheme() {
  return readKey() === "dark" ? "dark" : "light";
}

export function applyTheme(t, { persist = true } = {}) {
  const theme = t === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  if (persist) writeKey(theme);
  window.dispatchEvent(new CustomEvent("zero:theme", { detail: theme }));
  return theme;
}

export function toggleTheme() {
  return applyTheme(getTheme() === "dark" ? "light" : "dark");
}

// call once before first paint (main.js)
export function initTheme() {
  applyTheme(getTheme(), { persist: false });
}
