// twin.js - the digital twin. A large sensor-hand of light floats over the
// desk and mirrors the hand: on the finished device it is driven by the rig's
// own sensors (two orientation sensors + the joint encoders), so the twin
// keeps moving even when the real hand leaves the headset's cameras. In the
// prototype phase (no rig worn) the headset's hand tracking drives it, and in
// the desktop preview the mock telemetry does. One honest word names the
// source.

import * as THREE from "../../vendor/three.module.js";
import { Mode, makeWord } from "./common.js";
import { makeCounter } from "./rhythm.js";
import { DeviceHand, FINGERS } from "../world/deviceHand.js";
import { makeStageDisc, makeFlatRing, makeGlow, MoteField } from "../world/materials.js";
import { AQUA_DEEP } from "../design/palette.js";
import { clamp, Breath, Damped } from "../design/motion.js";
import { curlToJoints, seaJointRegime } from "../kinematics.js";

const ANCHOR = new THREE.Vector3(0, 0.75, -0.55);
const SCALE = 1.0;   // presentation size lives in the rig's MODEL_SCALE

export class Twin extends Mode {
  constructor(ctx) {
    super(ctx);
    this.group.position.copy(ANCHOR);
    this._breath = new Breath(0.11);
    this._pos = new THREE.Vector3(0, 0.17, -0.14);   // palm centre (local)
    this._quat = new THREE.Quaternion();
    this._quatT = new THREE.Quaternion();
    this._fq = new THREE.Quaternion();
    // zero_hand.glb frame (from the builder): y-up, fingers +Z. Present it
    // raised: fingers up, dorsal toward the viewer.
    this._qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)));
    // bare-hand driving: wrist frame (fingers -Z, dorsal +Y) -> device frame
    // (fingers +Z, dorsal +Y) is a half turn about Y
    this._qBare = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
    this._joints = {};
    this._activation = 0;
    this._source = "";
    this._tmp = new THREE.Vector3();
    this._build();
  }

  _build() {
    const g = this.group;

    // the stage: a wide pool of darkness and a resting ring hold the giant
    const stage = makeStageDisc(0.52);
    stage.position.set(0, 0.001, -0.10);
    g.add(stage);
    const ring = makeFlatRing(0.34, AQUA_DEEP, 0.05);
    ring.position.set(0, 0.003, -0.10);
    ring.material.opacity = 0.2;
    g.add(ring);
    this._ring = ring;

    // the twin itself: the DEVICE's real CAD, same as the web console's twin
    this._hand = new DeviceHand(g, { scale: SCALE });

    // twin pedestal: two slow counter-rotating rings and a pool of azure light
    this._ring2 = makeFlatRing(0.26, AQUA_DEEP, 0.08);
    this._ring2.position.set(0, 0.005, -0.10);
    this._ring2.material.opacity = 0.35;
    g.add(this._ring2);
    this._groundGlow = makeGlow(0x66b8ff, 0.34, 0.3, { depthTest: true });
    this._groundGlow.position.set(0, 0.05, -0.10);
    g.add(this._groundGlow);

    // a private key light so the metal twin reads silver, never a silhouette;
    // lives in the mode group, so it costs nothing outside TWIN
    this._key = new THREE.PointLight(0xeaf3ff, 2.6, 1.6, 1.6);
    this._key.position.set(0.35, 0.55, 0.35);
    g.add(this._key);
    this._rim = new THREE.PointLight(0x86b8f0, 1.6, 1.4, 1.6);
    this._rim.position.set(-0.4, 0.35, -0.5);
    g.add(this._rim);

    // the honest source word (swapped when the driver changes)
    this._sourceWord = null;
    this._setSource("telemetry");

    // ---- SEA status (2026-07-30): the series-elastic control layer ---------
    // Rendered ONLY from snap.sea (the runner's own estimates, relayed by the
    // host while fresh) and labeled exactly as the contract demands: every
    // tension/stretch is an ESTIMATE from the identified spring model
    // (label:"estimated" travels with the frame and is shown), sim:true is
    // said out loud, and NOTHING here is derived from the encoder joints
    // through the old rigid motor->joint law (DATA_CONTRACT 2026-07-27:
    // motor position no longer equals joint position). No sea frame -> the
    // panel says nothing (the host already drops stale sea state).
    this._seaHead = makeCounter({ px: 34, size: 0.22, color: "rgba(150,232,220,0.95)" });
    this._seaHead.spr.position.set(-0.34, 0.315, 0.16);
    g.add(this._seaHead.spr);
    this._seaRows = [];
    for (let i = 0; i < 2; i++) {
      const row = makeCounter({ px: 27, size: 0.30, color: "rgba(196,216,236,0.92)" });
      row.spr.position.set(-0.34, 0.255 - i * 0.055, 0.16);
      g.add(row.spr);
      this._seaRows.push(row);
    }
    this._seaFlags = makeCounter({ px: 27, size: 0.26, color: "rgba(231,180,90,0.95)" });
    this._seaFlags.spr.position.set(-0.34, 0.145, 0.16);
    g.add(this._seaFlags.spr);

    this._motes = new MoteField({
      count: 46, radius: 0.55, center: new THREE.Vector3(0, 0.35, -0.10),
      size: 0.024, seed: 23, ySpan: [0.06, 0.7],
    });
    this._motes.opacity = 1.0;
    g.add(this._motes.points);
  }

  _setSource(name) {
    if (name === this._source) return;
    this._source = name;
    if (this._sourceWord) this.group.remove(this._sourceWord);
    this._sourceWord = makeWord(name, { size: 0.14 });
    this._sourceWord.position.set(0.30, 0.06, 0.18);
    this.group.add(this._sourceWord);
  }

  enter() {
    super.enter();
    this.ctx.audio.setBedLevel(0.85, 2.5);
    this.ctx.hand.setHalo(false);
    this.ctx.hand.setAura(false);
  }

  update(dt, snap, t) {
    const hand = this.ctx.hand;
    // RIGHT HAND ONLY: the device twin may be puppeteered by the headset's
    // hand tracking only when it is tracking the RIG hand (right). The left
    // hand keeps working for UI gestures, but never drives the device.
    const bare = hand.bareActive && hand.bareFlex !== null
      && hand.bareHandedness === "right";

    // ---- drive the twin from the best source available -------------------
    if (bare) {
      // prototype: the headset's own hand tracking is the sensor
      this._setSource("headset");
      this._quatT.copy(hand.handQuat).multiply(this._qBare);   // wrist frame -> device hand frame

      // the twin also FOLLOWS the hand: real motion around a slow-drifting
      // anchor is amplified onto the giant, so gestures read at giant scale
      this._anchor = this._anchor || hand.palm.clone();
      this._anchor.lerp(hand.palm, 1 - Math.exp(-dt / 6));   // ~6 s re-centring
      this._off = this._off || new THREE.Vector3();
      this._off.copy(hand.palm).sub(this._anchor).multiplyScalar(1.8);
      this._off.x = clamp(this._off.x, -0.30, 0.30);
      this._off.y = clamp(this._off.y, -0.22, 0.28);
      this._off.z = clamp(this._off.z, -0.25, 0.25);

      // with bare hands the user's real fingers stand in for the encoders,
      // measured joint by joint and mapped onto the device channels, palm
      // outward: {f}_mcp = MCP abduction (true signed spread), {f}_pip = MCP
      // flexion, {f}_dip = PIP flexion - the same two-DOF MCP the rig senses.
      //
      // Flexion is ZEROED like the real encoders are: the headset reports a
      // little residual bend even on a flat-open hand, so the lowest angle
      // seen recently IS the open pose. It creeps up slowly (1.5 deg/s) so a
      // drifting track re-finds its zero; any lower reading snaps it down.
      // Result: a fully open hand -> a fully open twin, always.
      this._cal = this._cal || {};
      const zeroed = (id, meas) => {
        let n = this._cal[id];
        n = n === undefined ? meas : Math.min(n + 1.5 * dt, meas);
        this._cal[id] = n;
        return meas - n;
      };
      const ba = hand.bareAngles || {};
      for (const f of FINGERS) {
        if (ba[`${f}_mcp`] !== undefined) {
          this._joints[`${f}_mcp`] = ba[`${f}_abd`] ?? 0;
          this._joints[`${f}_pip`] = zeroed(`${f}_pip`, ba[`${f}_mcp`]);
          this._joints[`${f}_dip`] = zeroed(`${f}_dip`, ba[`${f}_pip`]);
        } else {
          const flex = clamp(hand.bareFlexOf[f] ?? 0.3, 0, 1);
          // canonical curl coupling (kinematics.js): full 90/110 ROM
          const pair = curlToJoints(flex);
          this._joints[`${f}_mcp`] = 0;
          this._joints[`${f}_pip`] = pair.mcpDeg;
          this._joints[`${f}_dip`] = pair.pipDeg;
        }
      }
      this._activation = 0;
    } else {
      // the rig's own stream (mock in the preview, real telemetry when worn):
      // every joints[] channel drives its hinge, exactly like the web console.
      // The controller overlay (input/controllers.js) SYNTHESIZES this same
      // shape from the trigger and forces link.device true, so it must never be
      // shown as "telemetry": it tags itself source:"controller" and the word
      // on stage says so.
      this._setSource(snap && snap.source === "controller" ? "controller"
        : snap && snap.link && snap.link.device ? "telemetry" : "waiting");
      if (snap && snap.rel && snap.rel.quat) {
        // relative wrist pose: the forearm is the static reference, so the
        // twin shows the hand's articulation about the wrist, and the wrist
        // lever arm TRANSLATES it (bridge kinematics: rel.pos_mm - pos0)
        const q = snap.rel.quat;
        this._quatT.set(q[1], q[2], q[3], q[0]).multiply(this._qBase);
        const p = snap.rel.pos_mm, p0 = snap.rel.pos0_mm;
        if (p && p0) {
          this._relOff = this._relOff || new THREE.Vector3();
          // mm -> m, x1.6 presentation gain so the giant's travel reads
          this._relOff.set(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2])
            .multiplyScalar(0.0016).applyQuaternion(this._qBase);
        }
      } else if (snap && snap.hand && snap.hand.quat) {
        const q = snap.hand.quat;
        this._quatT.set(q[1], q[2], q[3], q[0]).multiply(this._qBase);
      }
      if (snap && snap.joints) {
        for (const j of snap.joints) this._joints[j.id] = j.deg;
      }
      this._activation = snap && snap.activation && snap.activation.present
        ? snap.activation.level : 0;
    }
    this._quat.slerp(this._quatT, 1 - Math.exp(-dt * 12));

    // a giant breathes slower than a jewel, and follows its original
    const br = this._breath.at(t);
    this._tmp.copy(this._pos);
    if (this._off) this._tmp.add(this._off);
    if (this._relOff && !bare) this._tmp.add(this._relOff);   // wrist-lever travel
    this._tmp.y += br * 0.012;
    this._hand.pose(this._tmp, this._quat, this._joints, this._activation, dt,
                    snap && snap.thumb ? snap.thumb.rel_quat : null);
    this._hand.update(t);

    this._updateSea(snap, dt);

    this._sourceWord.material.opacity += (0.9 - this._sourceWord.material.opacity) * (1 - Math.exp(-dt * 3));
    this._ring.material.opacity = 0.3 + br * 0.12;
    this._ring.rotation.z = t * 0.08;
    this._ring2.rotation.z = -t * 0.05;
    this._groundGlow.material.opacity = 0.24 + br * 0.14;
    this._motes.update(t);

    // the desktop stand-in hand rests while its giant speaks
    if (!this.ctx.world.renderer.xr.isPresenting) this.ctx.hand.rest();
  }

  // SEA readout: verbatim runner state, estimates marked "~", regime derived
  // only from the runner's OWN stretch estimate via the shared spring law
  // (kinematics.js seaJointRegime - the same constants the runner uses).
  //
  // PER-JOINT, and that matters: the demo routing sprung the PIP wires only
  // (config.WIRE_KIND = {mcp:"rigid", pip:"sea"}). Labelling both joints with
  // the dual-rate law printed a rigid MCP wire pulling ~5.4 N at 0.36 mm as
  // "soft", i.e. inside a force-sensing band that wire does not have. The MCP
  // pair now reads "rigid", which is what it is.
  _updateSea(snap, dt) {
    const sea = snap && snap.sea;
    const k = 1 - Math.exp(-dt * 5);
    const fade = (ui, on, o = 0.92) => {
      ui.spr.material.opacity += ((on ? o : 0) - ui.spr.material.opacity) * k;
    };
    if (!sea || !sea.joints) {         // no fresh sea frame: say nothing
      fade(this._seaHead, false);
      for (const r of this._seaRows) fade(r, false);
      fade(this._seaFlags, false);
      return;
    }
    const simTag = sea.sim ? " · sim" : "";
    this._seaHead.set(`sea ${sea.mode || ""} · ${sea.label || "estimated"}${simTag}`);
    fade(this._seaHead, true);
    const names = ["mcp", "pip"];
    const flags = [];
    for (let i = 0; i < 2; i++) {
      const d = sea.joints[names[i]];
      const row = this._seaRows[i];
      if (!d) { fade(row, false); continue; }
      const pose = (d.theta_deg != null ? Math.round(d.theta_deg) : "--")
        + (d.target_deg != null ? `→${Math.round(d.target_deg)}°` : "°");
      const tn = d.tension_est_n || {};
      const xm = d.stretch_est_mm || {};
      // one line per joint, and it has to FIT: both wires of a pair are the
      // same kind, so when they read the same regime it is named once at the
      // end ("f ~1.3 · e ~1.5 N soft") instead of twice. When they differ
      // (one slack, one loaded) each leg carries its own word - that
      // difference is the interesting part and must never be collapsed.
      const reg = (side) => (xm[side] != null ? seaJointRegime(names[i], xm[side]) : null);
      const num = (side) => (tn[side] != null ? tn[side].toFixed(1) : "?");
      const has = (side) => tn[side] != null || xm[side] != null;
      const rF = reg("flex"), rE = reg("ext");
      let legs;
      if (has("flex") && has("ext") && rF && rF === rE) {
        legs = [`f ~${num("flex")} · e ~${num("ext")} N ${rF}`];
      } else {
        legs = [["flex", rF], ["ext", rE]]
          .filter(([s]) => has(s))
          .map(([s, r]) => `${s[0]} ~${num(s)}N${r ? " " + r : ""}`);
      }
      row.set([pose, ...legs].join(" · ").replace(/^/, `${names[i]} `));
      fade(row, true);
      if (d.enc_alive === false) flags.push(`${names[i]} enc dead`);
      // released names the SIDE that was let go ("flex"/"ext"), not a boolean -
      // say which, because "released" alone hides half the fact
      if (d.released) {
        flags.push(`${names[i]} released`
          + (typeof d.released === "string" ? `:${d.released}` : ""));
      }
      if (d.rescued) flags.push(`${names[i]} rescued`);
    }
    if (flags.length) this._seaFlags.set(flags.join(" · "));
    fade(this._seaFlags, flags.length > 0);
  }
}
