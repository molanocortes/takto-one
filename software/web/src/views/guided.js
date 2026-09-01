// guided.js - a CLOSED-LOOP guided therapy session.
//
// The point of this surface, and the only reason it earns its place: the
// device measures twelve joint angles at 50 Hz, so it can tell the person
// whether they ACTUALLY REACHED the pose. A video cannot do that. Everything
// here serves that loop:
//
//     target pose (real protocol, protocols.js)
//        -> rendered on the twin as a ghost hand, beside the person's LIVE hand
//        -> per-joint match scored from the measured angles (scorePose)
//        -> hold verified for the exercise's hold time
//        -> rep counted, gentle words, rest, next exercise
//        -> summary compared against THIS PERSON'S own previous sessions
//
// PATIENT-GRADE, and it is a hard constraint, not a style: the person may have
// limited hand function. Type is large, one instruction is visible at a time,
// every step AUTO-ADVANCES (rest timers, rep detection, exercise handover), and
// nothing needs two hands or fine pointing. The only controls are one big
// button and one exit. It is meant to be propped on a tablet at arm's length.
//
// HONESTY RAILS: a research prototype, not a medical device; the disclaimer is
// on the start screen and in the footer, not buried. Simulated data is badged
// exactly like every other surface. No diagnostic or outcome language anywhere
// - the vocabulary is "reached / almost / keep going", never "abnormal",
// "deficit", "improving".

import * as THREE from "../../vendor/three.module.js";
import { el, clamp } from "../ui.js";
import { store } from "../store.js";
import { loadHand } from "../twin.js";
import { fingerPose } from "../kinematics.js";
import { PROTOCOLS, getProtocol, FINGERS, scorePose, targetJoints, liveJointIds } from "../protocols.js";
import { saveSession, lastSession, personalBest } from "../sessions.js";

// The honesty rail, in the patient's own reading line - start screen AND
// summary, never buried in a footer.
const DISCLAIMER =
  "TAKTO ONE is a research prototype, not a medical device. These movement " +
  "sequences are implemented from published rehabilitation literature; use " +
  "them under the advice of your therapist or doctor.";
// Encouragement, never evaluation: nothing here grades the person.
const PRAISE = ["That is the position.", "Well held.", "Good, exactly there.", "Yes, that one counted."];
const FINGER_LABEL = { index: "INDEX", middle: "MIDDLE", ring: "RING", pinky: "LITTLE" };

const D2R = Math.PI / 180;
const HOLD_MATCH = 0.72;      // match at or above this counts as "in the pose"
const PARTIAL_MATCH = 0.45;   // below HOLD but above this = "almost"
const REP_RELEASE = 0.35;     // must fall below this before the next rep counts

// ---------------------------------------------------------------------------
// One hand rig in the guided stage. Same GLB and the same kinematic law as the
// live twin and the replay hand - a target pose is rendered by the identical
// mechanism, so what the person is asked to match is a real device pose.
// ---------------------------------------------------------------------------
class GuidedHand {
  constructor(scene, { ghost }) {
    this.group = new THREE.Group();
    this.inner = new THREE.Group();
    // scale is FITTED after the GLB lands, not guessed: the palm subtree's
    // extent in model mm decides it, so both hands end up the same on-screen
    // size and neither can grow into the other's half of the stage
    this.group.add(this.inner);
    scene.add(this.group);
    this.ready = false;
    this._q = new THREE.Quaternion();
    this._fingers = {};
    this.ghost = ghost;
    loadHand().then((gltf) => {
      const model = gltf.scene.clone(true);
      const mat = ghost
        // the target: an outline the person fills, never a solid second hand
        // competing with their own for attention
        ? new THREE.MeshStandardMaterial({
            color: 0xC9401B, transparent: true, opacity: 0.30,
            emissive: 0xC9401B, emissiveIntensity: 0.30, roughness: 0.6, depthWrite: false })
        : new THREE.MeshStandardMaterial({
            color: 0xE8E1D0, metalness: 0.1, roughness: 0.5,
            emissive: 0x3A342A, emissiveIntensity: 0.5 });
      model.traverse((o) => { if (o.isMesh) o.material = mat; });
      const palm = model.getObjectByName("palm");
      if (!palm) return;
      // MEASURE BEFORE PARENTING. The bbox has to be taken in the palm's own
      // model space, while it is still detached: measuring after adding it
      // under `group` returns a WORLD box that already contains the group's
      // side-by-side x offset, so subtracting that centre cancelled the offset
      // and both hands rendered on top of each other in the middle.
      palm.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(palm);
      const size = bb.getSize(new THREE.Vector3());
      const centre = bb.getCenter(new THREE.Vector3());
      const k = GuidedHand.FIT_UNITS / Math.max(size.x, size.y, size.z, 1e-6);
      this.inner.scale.setScalar(k);
      this.inner.position.copy(centre).multiplyScalar(-k);
      this.inner.add(palm);
      for (const f of FINGERS) {
        const j = (n) => {
          const node = palm.getObjectByName(n);
          return node ? { node, baseQuat: node.quaternion.clone(), baseZ: node.position.z } : null;
        };
        this._fingers[f] = {
          ab: j(`${f}_mcp`), mcp: j(`${f}_pip`), pip: j(`${f}_dip`),
          knuckle: j(`${f}_mcp_slide`), mid: j(`${f}_pip_mid`),
          slide: j(`${f}_pip_slide`), cradle: j(`${f}_dip_slide`),
        };
      }
      this.ready = true;
    });
  }

  /** joints = {finger: {ab, mcp, pip}} in degrees. */
  pose(joints) {
    if (!this.ready) return;
    for (const f of FINGERS) {
      const jf = this._fingers[f], tg = joints[f];
      if (!jf || !tg) continue;
      const set = (b, axis, deg) => {
        if (!b) return;
        this._q.setFromAxisAngle(axis, deg * D2R);
        b.node.quaternion.copy(b.baseQuat).multiply(this._q);
      };
      set(jf.ab, GuidedHand._Y, tg.ab);
      set(jf.mcp, GuidedHand._X, tg.mcp);
      set(jf.pip, GuidedHand._X, tg.pip);
      const p = fingerPose(f, tg.ab, tg.mcp, tg.pip);
      if (jf.knuckle) jf.knuckle.node.position.z = jf.knuckle.baseZ + p.slideKnuckleMm;
      if (jf.mcp) jf.mcp.node.position.z = jf.mcp.baseZ + p.slideKnuckleMm;
      if (jf.mid) jf.mid.node.position.z = jf.mid.baseZ + p.slideMcpMidMm;
      if (jf.slide) jf.slide.node.position.z = jf.slide.baseZ + p.slideMcpMm;
      if (jf.pip) jf.pip.node.position.z = jf.pip.baseZ + p.slideMcpMm;
      if (jf.cradle) jf.cradle.node.position.z = jf.cradle.baseZ + p.slidePipMm;
    }
  }
}
GuidedHand._X = new THREE.Vector3(1, 0, 0);
GuidedHand._Y = new THREE.Vector3(0, 1, 0);
GuidedHand.FIT_UNITS = 1.9;    // on-screen size of each hand, in world units

export function mountGuided(rootHost) {
  localStorage.setItem("zero.role", "guided");
  const root = el("div", { class: "surf gd" });
  const cleanups = [];
  let disposed = false;

  // ---------------- chrome ----------------
  const exit = el("a", { href: "#/", class: "gd-exit", title: "Home", "aria-label": "Home" }, "✕");
  // HONESTY BADGE. Being connected to a bridge is NOT the same as being
  // connected to hardware: `teensy_bridge.py --sim` is a live socket carrying
  // an entirely synthetic hand, and a therapy surface is the last place that
  // should look like a real measurement. So the badge shows for the built-in
  // mock AND whenever the bridge reports its own link source as "sim"
  // (health[link].detail, which the bridge sets to "sim" or "teensy").
  const mockBadge = el("div", { class: "gd-mock mono" }, "SIMULATED DATA");
  const setBadge = (snap) => {
    const link = snap && snap.health && snap.health.find((h) => h.stream === "link");
    const simulated = !store.live || !link || link.detail === "sim";
    mockBadge.style.display = simulated ? "" : "none";
  };
  setBadge(store.snap);

  // ---------------- start screen: choose a protocol ----------------
  const cards = PROTOCOLS.map((p, i) => {
    const best = personalBest(p.id);
    const card = el("button", { class: "gd-card", type: "button" },
      el("div", { class: "gd-card-k kicker accent mono" }, `S-0${i + 1}`),
      el("div", { class: "gd-card-name" }, p.name),
      el("div", { class: "gd-card-why" }, p.why),
      el("div", { class: "gd-card-meta mono" },
        `${p.exercises.length} exercises · ${p.minutes} min`),
      best ? el("div", { class: "gd-card-best mono" }, `your best ${Math.round(best)}°`) : null);
    card.addEventListener("click", () => startSession(p.id));
    return card;
  });
  const start = el("div", { class: "gd-start" },
    el("div", { class: "kicker accent" }, "Guided session"),
    el("h1", { class: "gd-start-head", html: "Move. It <em>counts</em>." }),
    el("p", { class: "gd-start-sub" }, "Choose a sequence. The device watches your hand and counts a repetition when you reach the position and hold it."),
    el("div", { class: "gd-cards" }, ...cards),
    el("p", { class: "gd-disclaim" }, DISCLAIMER));

  // ---------------- session screen ----------------
  const stage = el("div", { class: "gd-stage" });
  const exName = el("div", { class: "gd-ex-name" }, "");
  const exCue = el("div", { class: "gd-cue" }, "");
  const feedback = el("div", { class: "gd-feedback" }, "");
  const holdRing = el("div", { class: "gd-hold" }, el("span", { class: "gd-hold-fill" }));
  const holdFill = holdRing.firstChild;
  const repDots = el("div", { class: "gd-reps" });
  const stepLine = el("div", { class: "gd-step mono" }, "");
  // per-finger match bars: which finger still needs to move, at a glance
  const barEls = {};
  const bars = el("div", { class: "gd-bars" }, ...FINGERS.map((f) => {
    const fill = el("span", { class: "gd-bar-fill" });
    barEls[f] = fill;
    return el("div", { class: "gd-bar" }, fill, el("span", { class: "gd-bar-lab mono" }, FINGER_LABEL[f]));
  }));
  const skipBtn = el("button", { class: "gd-skip", type: "button" }, "Skip");
  const session = el("div", { class: "gd-session" },
    el("div", { class: "gd-top" }, exName, stepLine),
    el("div", { class: "gd-coach-wrap" }, exCue, feedback),
    el("div", { class: "gd-hud" }, holdRing, repDots),
    bars, skipBtn);

  // ---------------- summary ----------------
  const sumHead = el("h2", { class: "gd-sum-head" }, "");
  const sumStats = el("div", { class: "gd-sum-stats" });
  const sumCompare = el("div", { class: "gd-sum-compare" }, "");
  const againBtn = el("button", { class: "btn primary gd-big", type: "button" }, "Again");
  const homeBtn = el("a", { class: "btn ghost gd-big", href: "#/" }, "Home");
  const summary = el("div", { class: "gd-summary" },
    el("div", { class: "kicker accent" }, "Session summary"),
    sumHead, sumStats, sumCompare,
    el("div", { class: "gd-sum-row" }, againBtn, homeBtn),
    el("p", { class: "gd-disclaim" }, DISCLAIMER));

  root.append(stage, exit, mockBadge, start, session, summary);
  rootHost.append(root);

  // ---------------- 3D stage: target ghost + live hand ----------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 60);
  camera.position.set(0, 0.15, 4.4);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xB9B3A4, 1.5));
  const key = new THREE.DirectionalLight(0xFFF4E2, 2.2);
  key.position.set(2, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9FB6D0, 0.8);
  rim.position.set(-3, 1, -4);
  scene.add(rim);

  const ghostHand = new GuidedHand(scene, { ghost: true });
  const liveHand = new GuidedHand(scene, { ghost: false });
  // side by side, the target on the left (read first), the person on the right
  // THREE-QUARTER VIEW, and it is the whole readability of the surface: the
  // model's fingers point +Z, i.e. straight at the camera, so the default
  // framing showed both hands end-on and MCP/PIP flexion was invisible - you
  // could not tell a fist from a flat hand. But FULL profile (~75 deg) failed
  // the opposite way: an OPEN flat hand seen from the side is a sliver, and
  // the "Open hand" target rendered as a red stick. ~58 deg yaw with a
  // deeper downward tilt keeps curl legible AND shows enough of the dorsal
  // plane that a flat hand reads as a hand.
  for (const h of [ghostHand, liveHand]) {
    h.group.rotation.set(-0.34, -1.02, 0.05);
  }
  ghostHand.group.position.set(-1.15, 0, 0);
  liveHand.group.position.set(1.15, 0, 0);
  const labTarget = el("div", { class: "gd-stage-lab mono is-target" }, "THE POSITION");
  const labYou = el("div", { class: "gd-stage-lab mono is-you" }, "YOUR HAND");
  stage.append(labTarget, labYou);

  function resize() {
    const w = stage.clientWidth || 900, h = stage.clientHeight || 460;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // narrow screens: stack the two hands closer and pull the camera back so
    // both stay in frame on a phone
    const narrow = w < 720;
    ghostHand.group.position.x = narrow ? -0.92 : -1.15;
    liveHand.group.position.x = narrow ? 0.92 : 1.15;
    camera.position.z = narrow ? 5.2 : 3.9;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  cleanups.push(() => ro.disconnect());

  // ---------------- session state ----------------
  let phase = "choose";      // choose | exercise | rest | done
  let protocol = null, exIx = 0, repIx = 0;
  let holdT = 0, restT = 0, tTotal = 0, sinceFeedback = 0;
  let released = true;       // must open between reps
  let repMarks = [];         // per rep: "reached" | "partial"
  let peakFlex = 0, matchSum = 0, matchN = 0, repsReached = 0, repsTotal = 0;
  let started = 0;

  const ex = () => protocol.exercises[exIx];

  function setPhase(p) {
    phase = p;
    root.classList.toggle("in-session", p === "exercise" || p === "rest");
    root.classList.toggle("is-done", p === "done");
    root.classList.toggle("is-choose", p === "choose");
  }

  function say(msg, kind = "") {
    feedback.textContent = msg;
    feedback.className = "gd-feedback on " + kind;
    sinceFeedback = 0;
  }

  function renderReps() {
    repDots.replaceChildren(...Array.from({ length: ex().reps }, (_, i) => {
      const mark = repMarks[i];
      return el("span", { class: "gd-rep" + (mark ? " " + mark : "") });
    }));
    stepLine.textContent = `Exercise ${exIx + 1}/${protocol.exercises.length} · Rep ${Math.min(repIx + 1, ex().reps)}/${ex().reps}`;
  }

  function beginExercise() {
    repIx = 0; holdT = 0; released = true; repMarks = [];
    const e = ex();
    exName.textContent = e.name;
    exCue.textContent = e.cue;
    ghostHand.pose(targetJoints(e));
    renderReps();
    setPhase("exercise");
    say("Take your time.", "calm");
  }

  function startSession(id) {
    protocol = getProtocol(id);
    exIx = 0; tTotal = 0; peakFlex = 0; matchSum = 0; matchN = 0;
    repsReached = 0; repsTotal = 0; started = Date.now();
    // the session is bracketed as a normal take (DATA_CONTRACT record), so it
    // joins the take library like any other capture - one recording path
    store.send({ cmd: "record", action: "start", task: `guided-${protocol.id}`, notes: "guided session" });
    store.send({ cmd: "guided", action: "start", goal: protocol.exercises.reduce((n, e) => n + e.reps, 0) });
    beginExercise();
  }

  function finishRep(quality) {
    repMarks[repIx] = quality;
    repsTotal++;
    if (quality === "reached") repsReached++;
    renderReps();
    say(quality === "reached" ? pick(PRAISE) : "Almost. That one counts as partial.", quality === "reached" ? "good" : "");
    repIx++;
    holdT = 0; released = false;
    if (repIx >= ex().reps) {
      if (exIx + 1 >= protocol.exercises.length) return endSession(true);
      restT = ex().restS;
      setPhase("rest");
    } else renderReps();
  }

  const pick = (arr) => arr[Math.floor(tTotal * 7) % arr.length];

  function nextExercise() {
    exIx++;
    beginExercise();
  }

  function endSession(completed) {
    store.send({ cmd: "guided", action: "stop" });
    store.send({ cmd: "record", action: "stop" });
    const prev = lastSession(protocol.id);
    const best = personalBest(protocol.id);
    const rec = {
      protocol: protocol.id, at: started, durationS: Math.round(tTotal),
      repsReached, repsTotal, completed,
      peakFlexDeg: Math.round(peakFlex),
      meanMatch: matchN ? matchSum / matchN : 0,
    };
    saveSession(rec);

    sumHead.textContent = completed ? "Session complete." : "Session ended.";
    sumStats.replaceChildren(
      stat(`${repsReached}/${repsTotal}`, "reached"),
      stat(`${Math.round(peakFlex)}°`, "best close"),
      stat(`${Math.floor(rec.durationS / 60)}:${String(rec.durationS % 60).padStart(2, "0")}`, "time"),
    );
    // progress against THEMSELVES only - never a norm, never an expected value
    let cmp = "";
    if (prev) {
      const d = Math.round(peakFlex - (prev.peakFlexDeg || 0));
      cmp = d > 2 ? `That is ${d}° further than your last session.`
          : d < -2 ? "A quieter day than last time. That is normal."
          : "About the same as your last session.";
    } else cmp = "Your first session with this sequence. Next time you will have something to compare with.";
    if (best && peakFlex >= best) cmp = "That is your furthest close yet.";
    sumCompare.textContent = cmp;
    setPhase("done");
  }
  const stat = (n, u) => el("div", { class: "gd-stat" },
    el("div", { class: "gd-stat-n num" }, n), el("div", { class: "gd-stat-u" }, u));

  skipBtn.addEventListener("click", () => {
    if (phase === "rest") { restT = 0; return; }
    if (exIx + 1 >= protocol.exercises.length) endSession(false);
    else nextExercise();
  });
  againBtn.addEventListener("click", () => startSession(protocol.id));

  // ---------------- the loop ----------------
  const offSnap = store.onSnap(setBadge);   // the bridge may connect after mount
  cleanups.push(offSnap);

  const offFrame = store.onFrame((sm, snap, dt) => {
    const ds = dt / 1000;
    if (disposed) return;

    // the person's live hand always renders, in every phase - it is their
    // hand, and seeing it move is the proof the device is reading them
    const live = {};
    for (const f of FINGERS) {
      live[f] = {
        ab: sm.joints[`${f}_mcp`] ?? 0,
        mcp: sm.joints[`${f}_pip`] ?? 0,
        pip: sm.joints[`${f}_dip`] ?? 0,
      };
    }
    liveHand.pose(live);
    renderer.render(scene, camera);

    if (phase !== "exercise" && phase !== "rest") return;
    tTotal += ds;
    sinceFeedback += ds;

    if (phase === "rest") {
      restT -= ds;
      const secs = Math.max(0, Math.ceil(restT));
      exName.textContent = "Rest";
      exCue.textContent = `Let the hand relax. ${secs}s`;
      holdFill.style.transform = `scaleX(${1 - clamp(restT / Math.max(1, ex().restS), 0, 1)})`;
      if (restT <= 0) nextExercise();
      return;
    }

    // ---- the closed loop: score the MEASURED pose against the target ----
    const okIds = liveJointIds(snap);
    const sc = scorePose(ex(), sm.joints, okIds.size ? okIds : null);
    for (const f of FINGERS) {
      const v = sc.perFinger[f];
      barEls[f].style.transform = `scaleX(${clamp(v ?? 0, 0, 1)})`;
      barEls[f].classList.toggle("good", (v ?? 0) >= HOLD_MATCH);
    }
    matchSum += sc.match; matchN++;
    // peak flexion this session, from the measured flexion channels
    for (const f of FINGERS) {
      const v = sm.joints[`${f}_dip`];
      if (Number.isFinite(v) && v > peakFlex) peakFlex = v;
    }

    if (sc.match < REP_RELEASE) released = true;

    if (sc.match >= HOLD_MATCH && released) {
      holdT += ds;
      holdFill.style.transform = `scaleX(${clamp(holdT / ex().holdS, 0, 1)})`;
      holdRing.classList.add("holding");
      if (holdT === ds) say("Hold it there.", "good");
      if (holdT >= ex().holdS) { holdRing.classList.remove("holding"); holdFill.style.transform = "scaleX(0)"; finishRep("reached"); }
    } else {
      holdRing.classList.remove("holding");
      if (holdT > 0) holdT = Math.max(0, holdT - ds * 1.6);   // decay, never snap
      holdFill.style.transform = `scaleX(${clamp(holdT / ex().holdS, 0, 1)})`;
      // gentle, specific nudges - never more than one every few seconds
      if (sinceFeedback > 4.5 && released) {
        if (!sc.live) say("Waiting for the hand sensors.", "");
        else if (sc.match >= PARTIAL_MATCH) say("Nearly there, a little further.", "");
        else say("Take your time, move as far as is comfortable.", "");
      }
    }
  });
  cleanups.push(offFrame);

  setPhase("choose");
  resize();

  return () => {
    disposed = true;
    if (phase === "exercise" || phase === "rest") {
      store.send({ cmd: "guided", action: "stop" });
      store.send({ cmd: "record", action: "stop" });
    }
    cleanups.forEach((fn) => fn());
    renderer.dispose();
    root.remove();
  };
}
