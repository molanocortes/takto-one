// palette.js - the design tokens as constants (data of record).
// S5 direction (owner, 2026-07-03): the hero hue moves from aqua-green to
// LUMEN AZURE, a luminous blue. The constant NAMES stay (AQUA etc.) so the
// rest of the code reads unchanged; the values are the truth. One hero hue as
// emitted light, one warm counter-accent, one status green, nothing else.

export const AQUA        = 0x66b8ff;  // Lumen Azure (core): alive / contact / active
export const AQUA_DEEP   = 0x2a6db3;  // cool gradient base, un-woken tint
export const AQUA_HALO   = 0xd9edff;  // near-white bloom highlight, contact only
export const AMBER       = 0xffb155;  // Dawn Amber: force, success, warmth
export const CANDLE      = 0xffe6bc;  // Candle Core: hottest light, fingertip on force
export const VOID        = 0x060a10;  // stage/vignette volumes only
export const OBSIDIAN    = 0x0c1320;  // luminous glass body
export const BONE        = 0xd8cdba;  // the one warm light mass, resting point
export const TITANIUM    = 0x9aa3ae;  // brushed metal rims
export const PROGRESS    = 0xa8d4f5;  // earned-progress light (pale azure)
export const OK          = 0x4cc98d;  // sensor-health lamp only (status green)
export const ALERT       = 0xe0556b;  // safety only, always with a non-color cue

// operator-console 2D tokens (HUD surfaces, used sparingly)
export const UI = {
  bg0: "#0F1318", bg1: "#161C24", bg2: "#1D252F",
  text0: "#E9EEF3", text1: "#AAB6C2",
  accent: "#66B8FF", ok: "#4CC98D", warn: "#E8B14E", stop: "#F4564D",
};

export const CSS = {
  aqua: "#66B8FF", aquaDeep: "#2A6DB3", aquaHalo: "#D9EDFF",
  amber: "#FFB155", candle: "#FFE6BC", bone: "#D8CDBA",
  progress: "#A8D4F5", alert: "#E0556B", ok: "#4CC98D",
  // solid text over any real room (words render with a dark backing)
  ink: "rgba(255,255,255,0.99)", inkDim: "rgba(219,233,247,0.95)",
  backing: "rgba(3,7,14,0.93)",
};
