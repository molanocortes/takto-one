// pair.js - "#/pair": the console shows a QR of the bridge's ws URL; the
// TAKTO ONE Companion app (not in this release) scans it and is connected in
// seconds. The bridge advertises its LAN address in
// link.lan/link.port (DATA_CONTRACT 2026-07-18); until a snapshot arrives we
// fall back to this page's own ?ws= target.
import { el } from "../ui.js";
import { store } from "../store.js";
import qrcode from "../../vendor/qrcode-generator.js";

function wsTarget() {
  const link = store.snap && store.snap.link;
  if (link && link.lan && link.port) return `ws://${link.lan}:${link.port}/ws`;
  const p = new URLSearchParams(location.search).get("ws");
  if (p) return p.replace("localhost", location.hostname).replace("127.0.0.1", location.hostname);
  return null;
}

export function mountPair(rootHost) {
  const canvas = el("canvas", { width: 480, height: 480,
    style: "width:min(70vw,340px);height:auto;image-rendering:pixelated;border-radius:12px;" });
  const urlLine = el("div", { class: "mono", style: "font-size:13px;color:var(--text-2)" }, "waiting for the bridge...");
  const root = el("div", { style: "min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:32px;text-align:center;" },
    el("div", { class: "kicker" }, "Pair your phone"),
    el("h2", { style: "font-size:clamp(28px,4vw,44px);letter-spacing:-0.02em;max-width:520px" },
      "Scan with the TAKTO ONE app."),
    canvas, urlLine,
    el("p", { style: "max-width:440px;color:var(--text-2);font-size:14px;line-height:1.6" },
      "In the app: Settings, then “Pair by QR”. Phone and this machine must share the same Wi-Fi."),
    el("a", { href: "#/", style: "color:var(--accent)" }, "← back"));
  rootHost.append(root);

  let drawn = null;
  const draw = () => {
    const target = wsTarget();
    if (!target || target === drawn) return;
    drawn = target;
    const q = qrcode(0, "M");
    q.addData(target);
    q.make();
    const n = q.getModuleCount(), ctx = canvas.getContext("2d");
    const cell = Math.floor(480 / (n + 8)), off = Math.floor((480 - cell * n) / 2);
    ctx.fillStyle = "#FAF8F2";
    ctx.fillRect(0, 0, 480, 480);
    ctx.fillStyle = "#23201A";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
    }
    urlLine.textContent = target;
  };
  draw();
  const off = store.onSnap(draw);
  return () => { off(); root.remove(); };
}
