// ui.js - tiny DOM + formatting helpers shared by every surface.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export const svgNS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const lerp = (a, b, t) => a + (b - a) * t;

export function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function fmtDur(sec) {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// Scroll reveals: any .reveal inside root fades in when it enters the viewport.
// Elements already on screen at mount are revealed synchronously (IO can lag
// or never fire in throttled/hidden documents); IO handles the rest on scroll.
export function observeReveals(root) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
  const nodes = [...root.querySelectorAll(".reveal")];
  const vh = Math.max(window.innerHeight, document.documentElement.clientHeight, 600);
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.top < vh * 0.9 && r.bottom > 0) n.classList.add("in");
    else io.observe(n);
  }
  return io;
}

// Toasts: quiet, glass, self-dismissing.
let toastHost = null;
export function toast(msg, opts = {}) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el("div", { class: "toast-host" });
    document.body.append(toastHost);
  }
  const dot = opts.tone ? el("span", { class: `dot ${opts.tone}` }) : null;
  const t = el("div", { class: "toast" }, dot, msg);
  toastHost.append(t);
  setTimeout(() => { t.classList.add("leaving"); setTimeout(() => t.remove(), 320); }, opts.ms || 2400);
}

const _rmQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
export const reducedMotion = () => _rmQuery.matches;
