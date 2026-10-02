// vision_arm.js - the webcam measures the one thing the two IMUs cannot: where
// the UPPER ARM points. MediaPipe's pose model gives metric 3D shoulder,
// elbow and wrist ("world landmarks"); this streams those three points to the
// bridge ({"cmd":"vision"}), whose body model steers the upper-arm direction
// with them while forearm and hand orientation stay IMU (MOTION_PIPELINE.md,
// "Camera upper arm"). Video never leaves the browser: only the three points
// do, about 30 times a second.
import { el, svg, toast } from "./ui.js";
import { store } from "./store.js";
import { askMediaPipe } from "./consent.js";

const TASKS_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
// BlazePose indices: the person's own right/left (the camera image is not mirrored)
const ARM = { right: [12, 14, 16], left: [11, 13, 15] };
const SIDE_KEY = "takto.vision.side";
const SEND_MS = 33;

export function buildVisionArm(cleanups) {
  let side = "right";
  try { side = localStorage.getItem(SIDE_KEY) === "left" ? "left" : "right"; } catch (_) {}
  let on = false, stream = null, landmarker = null, raf = 0, lastSend = 0, loadTry = 0;
  let trackedAt = 0, quality = 0;

  const video = el("video", { class: "va-video", playsinline: "", muted: "" });
  video.muted = true;
  const cv = el("canvas", { class: "va-cv" });
  const status = el("span", { class: "va-status mono" }, "camera off");
  // the bridge's verdict: is the twin actually using the camera?
  const verdict = el("div", { class: "va-verdict mono" }, "");
  const sideBtn = el("button", { type: "button", class: "va-side", title: "Which arm wears the device" }, "");
  const closeBtn = el("button", { type: "button", class: "va-close", title: "Turn the camera off" }, "✕");
  const node = el("div", { class: "va-pip lg", hidden: "" },
    el("div", { class: "va-frame" }, video, cv),
    el("div", { class: "va-row" }, status, sideBtn, closeBtn), verdict);
  cleanups.push(store.onSnap((s) => {
    if (!on) return;
    const q = (s.body && s.body.quality) || {};
    let txt, cls;
    if (!s.body) { txt = "twin: no body model on this bridge"; cls = "bad"; }
    else if (q.vision) { txt = `twin: moving with the camera · elevation ${Math.round(q.elevation_deg ?? 0)}°`; cls = "ok"; }
    else if (!q.vision_rx) { txt = "twin: bridge has received nothing yet"; cls = "bad"; }
    else if (q.vision_conf != null && q.vision_conf < 0.5) { txt = `twin: ignored, ${side} arm only ${Math.round(q.vision_conf * 100)} % visible`; cls = "warn"; }
    else { txt = "twin: camera samples stale"; cls = "warn"; }
    if (verdict.textContent !== txt) { verdict.textContent = txt; verdict.className = "va-verdict mono " + cls; }
  }));
  const button = el("button", { type: "button", class: "op-dock-btn",
    title: "Camera: track the upper arm with the webcam (moves the twin through space)" },
    svg("svg", { viewBox: "0 0 16 16", width: 15, height: 15 },
      svg("rect", { x: 1.5, y: 4, width: 9.5, height: 8, rx: 2, fill: "none", stroke: "currentColor", "stroke-width": 1.4 }),
      svg("path", { d: "M11 7l3.5-2v6L11 9z", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linejoin": "round" })));

  const paintSide = () => { sideBtn.textContent = side === "right" ? "right arm" : "left arm"; };
  paintSide();
  sideBtn.addEventListener("click", () => {
    side = side === "right" ? "left" : "right";
    try { localStorage.setItem(SIDE_KEY, side); } catch (_) {}
    paintSide();
  });
  button.addEventListener("click", () => (on ? stop() : start()));
  closeBtn.addEventListener("click", () => stop());

  async function loadModel() {
    // a failed dynamic import is cached by the module map: retries need a fresh specifier
    const bust = loadTry++ ? `?retry=${loadTry}` : "";
    const vision = await import(/* @vite-ignore */ `${TASKS_CDN}/vision_bundle.mjs${bust}`);
    const files = await vision.FilesetResolver.forVisionTasks(`${TASKS_CDN}/wasm`);
    const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: "VIDEO", numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { return await make("GPU"); } catch (_) { return await make("CPU"); }
  }

  async function start() {
    if (on) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("This browser does not expose a camera.", { tone: "warn" });
      return;
    }
    // the public site asks before MediaPipe loads from jsDelivr and Google, and
    // asks first: without it the camera has nothing to do, so a "no" keeps it off
    if (!landmarker && !(await askMediaPipe("The camera arm tracker"))) return;
    on = true;
    button.classList.add("on");
    node.hidden = false;
    status.textContent = "starting camera…";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
    } catch (_) {
      toast("Camera permission was declined.", { tone: "warn" });
      stop();
      return;
    }
    if (!on) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!landmarker) {
      if (!on) return;
      status.textContent = "loading pose model…";
      try { landmarker = await loadModel(); } catch (_) {
        toast("The pose model could not be loaded (it needs the network the first time).", { tone: "warn" });
        stop();
        return;
      }
    }
    if (!on) return;
    loop();
  }

  function stop() {
    on = false;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    button.classList.remove("on");
    node.hidden = true;
    status.textContent = "camera off";
  }
  cleanups.push(stop);

  const ctx = cv.getContext("2d");
  function draw(lm2d, idx, conf) {
    const w = cv.width = video.videoWidth || 640, h = cv.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, w, h);
    if (!lm2d) return;
    const pts = idx.map((i) => [lm2d[i].x * w, lm2d[i].y * h]);
    ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = conf >= 0.5 ? "rgba(91,168,245,0.95)" : "rgba(240,180,90,0.9)";
    ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]); ctx.lineTo(...pts[2]); ctx.stroke();
    ctx.fillStyle = "#fff";
    for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 7); ctx.fill(); }
  }

  function loop() {
    if (!on || !landmarker) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2) return;
    const now = performance.now();
    let res = null;
    try { res = landmarker.detectForVideo(video, now); } catch (_) { return; }
    const w = res && res.worldLandmarks && res.worldLandmarks[0];
    const l2 = res && res.landmarks && res.landmarks[0];
    const idx = ARM[side];
    if (!w || !l2) {
      draw(null, idx, 0);
      quality = Math.max(0, quality - 0.05);
      if (now - trackedAt > 600) status.textContent = "no one in view";
      return;
    }
    // visibility of the three joints: the upper arm is only as good as its
    // worst end (an elbow hidden behind the body is a guess)
    const conf = Math.min(...idx.map((i) => (l2[i].visibility ?? 1)));
    draw(l2, idx, conf);
    trackedAt = now;
    quality = quality * 0.9 + conf * 0.1;
    status.textContent = `${side} arm · ${Math.round(quality * 100)} %`;
    if (now - lastSend >= SEND_MS) {
      lastSend = now;
      const p = (i) => [w[i].x, w[i].y, w[i].z];
      store.send({ cmd: "vision", shoulder: p(idx[0]), elbow: p(idx[1]), wrist: p(idx[2]),
        conf: Math.round(conf * 1000) / 1000 });
    }
  }

  return { button, node, isOn: () => on };
}
