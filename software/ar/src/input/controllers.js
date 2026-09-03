// controllers.js - Quest controller TEST INPUT (2026-07-19, owner-directed).
//
// The rule that makes it seamless: the controller is a TELEMETRY SOURCE, not
// a mode. While you actively use a controller (trigger / squeeze / stick /
// any button within the last ~2 s), it synthesizes the same snapshot shape
// the bridge streams - joints via the canonical curlToJoints() coupling,
// hand/forearm orientation from the controller's own pose, activation from
// the squeeze - and that overlay simply REPLACES the live snapshot for the
// visual layer. Put the controller down (or just stop touching it) and the
// real stream (Teensy bridge, sim, or mock) flows again two seconds later.
// Nothing to configure, no URL params, both sources always "just work":
//
//   trigger  -> finger curl (all four, slightly staggered, curlToJoints law)
//   squeeze  -> activation/effort channel (EMG stand-in)
//   pose     -> hand + forearm orientation; the hand of light rides the grip
//   trigger PRESS also clicks the reach-interactive under the hand (main.js)
//
// Everything is defensively guarded: no gamepad, no session, missing
// buttons/axes - all read as "inactive" and the live stream passes through.

import * as THREE from "../../vendor/three.module.js";
import { curlToJoints } from "../kinematics.js";
import { FINGERS } from "../world/sensorHand.js";

// a human hand never curls all fingers identically; the stagger keeps the
// synthesized pose organic instead of robot-uniform
const CURL_SHAPE = { index: 1.0, middle: 0.97, ring: 0.93, pinky: 0.88 };
const IDLE_S = 2.0;                 // hands-off this long -> back to live data

export class ControllerInput {
  constructor(world) {
    this.world = world;
    this.active = false;            // overlay currently owns the data
    this.tracked = false;           // a controller pose is available
    this.justPressed = false;       // trigger crossed down-threshold this frame
    this.gripPos = new THREE.Vector3();
    this._gripQuat = new THREE.Quaternion();
    this._idle = IDLE_S + 1;
    this._prevTrig = 0;
    this._curl = 0;
    this._squeeze = 0;
    this._onsetLatch = false;

    // grip-space objects: three.js fills their world pose while presenting;
    // the 'connected' event carries the XRInputSource (handedness + gamepad)
    this._grips = [];
    for (let i = 0; i < 2; i++) {
      const g = world.renderer.xr.getControllerGrip(i);
      g.addEventListener("connected", (e) => { g.userData.src = e.data || null; });
      g.addEventListener("disconnected", () => { g.userData.src = null; });
      world.scene.add(g);
      this._grips.push(g);
    }
    // grip space points along the handle; tilt it toward a natural palm frame
    this._qFix = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-Math.PI / 3, 0, 0));
  }

  /** Short haptic tick on the active controller (press acknowledgement).
   *  Silently a no-op with bare hands or on gamepads without an actuator. */
  pulse(intensity = 0.35, ms = 40) {
    try {
      const src = this._lastSrc;
      const act = src && src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
      if (act && act.pulse) act.pulse(intensity, ms);
    } catch (_) { /* haptics are best-effort */ }
  }

  update(dt) {
    this.justPressed = false;
    let src = null, gripObj = null;
    for (const g of this._grips) {
      const s = g.userData.src;
      // controllers only: bare hands arrive as targetRayMode "tracked-pointer"
      // too on some builds, but they have no gamepad buttons worth reading
      if (s && s.gamepad && s.gamepad.buttons && s.gamepad.buttons.length) {
        if (!src || s.handedness === "right") { src = s; gripObj = g; }
      }
    }
    this._lastSrc = src;
    if (!src) {
      this.active = false;
      this.tracked = false;
      this._idle = IDLE_S + 1;
      return;
    }

    const gp = src.gamepad;
    const btn = (i) => (gp.buttons && gp.buttons[i] ? gp.buttons[i].value || 0 : 0);
    const trig = btn(0);                       // xr-standard: 0 = trigger
    const sq = btn(1);                         // 1 = squeeze
    const ax = Math.abs((gp.axes && gp.axes[2]) || 0) + Math.abs((gp.axes && gp.axes[3]) || 0);
    let pressedAny = false;
    if (gp.buttons) for (const b of gp.buttons) if (b && b.pressed) { pressedAny = true; break; }

    if (trig > 0.02 || sq > 0.02 || ax > 0.06 || pressedAny) this._idle = 0;
    else this._idle += dt;
    this.active = this._idle < IDLE_S;

    if (trig > 0.55 && this._prevTrig <= 0.55) this.justPressed = true;
    this._prevTrig = trig;

    const k = 1 - Math.exp(-dt * 14);
    this._curl += (trig - this._curl) * k;
    this._squeeze += (sq - this._squeeze) * k;

    if (gripObj) {
      gripObj.getWorldPosition(this.gripPos);
      gripObj.getWorldQuaternion(this._gripQuat);
      this._gripQuat.multiply(this._qFix);
      this.tracked = true;
    } else this.tracked = false;
  }

  // overlay: replace the live snapshot while the controller is in use.
  // Mirrors the wire shape exactly (see telemetry.js mock / DATA_CONTRACT):
  // {f}_mcp = abduction (neutral), {f}_pip = MCP flexion, {f}_dip = PIP flexion.
  apply(latest) {
    if (!this.active) return latest;
    const joints = [];
    for (const f of FINGERS) {
      const { mcpDeg, pipDeg } = curlToJoints(this._curl * CURL_SHAPE[f]);
      joints.push({ id: `${f}_mcp`, deg: 0, ok: true });
      joints.push({ id: `${f}_pip`, deg: +mcpDeg.toFixed(1), ok: true });
      joints.push({ id: `${f}_dip`, deg: +pipDeg.toFixed(1), ok: true });
    }
    const q = this._gripQuat;
    const wire = [q.w, q.x, q.y, q.z];
    const sq = this._squeeze;
    const onset = sq > 0.5 && !this._onsetLatch;
    this._onsetLatch = sq > 0.5;
    const base = latest || {};
    return {
      ...base,
      kind: "snap",
      source: "controller",
      link: { ...(base.link || {}), device: true },
      hand: { quat: wire, ok: true },
      forearm: { quat: wire, ok: true },
      joints,
      activation: {
        present: true, level: +sq.toFixed(3), channels: [+sq.toFixed(3)],
        direction: 0, fatigue: 0, onset, quality: "good",
      },
    };
  }
}
