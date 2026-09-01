// konami.js - the hidden trigger for the DOOM easter egg.
//
// Type the Konami code (up up down down left right left right B A) OR the word
// "doom" OR "idkfa" anywhere in the console and the watch's secret screen opens
// at #/doom. Kept deliberately undiscoverable: there is no link to it.
const KONAMI = ["arrowup","arrowup","arrowdown","arrowdown","arrowleft","arrowright","arrowleft","arrowright","b","a"];
const WORDS = ["doom", "idkfa"];

// Never listen while the operator is typing into a field: "Profile name: Ida
// Kadoom" or a signer code containing "doom"/"idkfa" would yank the page to
// #/doom mid-take. Real text entry is not a cheat code.
function isTyping(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  // typable input types only: a range slider / checkbox still gets the egg
  return !["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"]
    .includes((t.type || "text").toLowerCase());
}

export function initKonami() {
  let kbuf = [];
  let wbuf = "";
  const go = () => { if ((location.hash || "").replace(/^#\//, "") !== "doom") location.hash = "#/doom"; };
  window.addEventListener("keydown", (e) => {
    if (isTyping(e.target)) { kbuf = []; wbuf = ""; return; }
    const k = (e.key || "").toLowerCase();
    // Konami sequence
    kbuf.push(k); if (kbuf.length > KONAMI.length) kbuf.shift();
    if (kbuf.length === KONAMI.length && KONAMI.every((v, i) => v === kbuf[i])) { kbuf = []; go(); return; }
    // secret words
    if (k.length === 1 && k >= "a" && k <= "z") {
      wbuf = (wbuf + k).slice(-8);
      if (WORDS.some((w) => wbuf.endsWith(w))) { wbuf = ""; go(); }
    }
  });
}
