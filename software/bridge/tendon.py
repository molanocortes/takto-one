"""tendon.py - guarded tendon range calibration + position control for the bridge.

The device now has real tendons on the spools, so a motor that jumps when torque
is enabled breaks a cable. This module owns that risk in ONE place, so the web
console (or any other surface) only has to send an action name.

It is deliberately a state machine with explicit phases, because the ordering IS
the safety property:

    idle -> centered -> ranging -> ranged -> (hold | move) -> ranged

  center      take the bus, torque stays OFF, record where the operator manually
              set the spool. This is the zero reference.
  range_start torque stays OFF; the operator moves the finger by hand and the
              spool backdrives. Records min/max on BOTH the joint encoder and
              the motor.
  range_stop  freezes the range and insets MARGIN_DEG at each end -> safe band.
  hold        enable torque while commanding EXACTLY zero current, then watch.
              More than HOLD_DRIFT_MAX of motion aborts and torques off. This is
              the proof that powering up does not move anything.
  move        position control, setpoint slewed at SLEW_DEG_S, clamped to the
              safe band, aborted on excess commanded-vs-measured lag (a bound
              tendon shows up as lag before it shows up as a break).

Every path out - success, abort, exception, disconnect - ends in torque off.
The firmware's own 44 mA clamp (~10 N at a 5 mm spool) and the servo's reg-38
limit sit underneath all of this; nothing here can raise them.
"""
import json
import os
import threading
import time

MARGIN_DEG = 4.0          # inset from each captured end
SLEW_DEG_S = 8.0          # setpoint ramp rate
HOLD_VERIFY_S = 2.0       # zero-current proof window
HOLD_DRIFT_MAX = 1.5      # deg of drift allowed in that window
MAX_LAG_DEG = 25.0        # commanded-vs-measured lag meaning "bound"
MIN_USABLE_SPAN = 2 * MARGIN_DEG + 5.0
PET_S = 0.1               # firmware host-silence watchdog is 600 ms
BLEND_STEPS = 8           # how gently assist authority is ramped in
TAKE_TIMEOUT_S = 8.0

# ---- jogging ---------------------------------------------------------------
# The ONLY motion primitive exposed to an operator is RELATIVE. There is no
# "go to 345 deg": a UI that can name an absolute angle can name a wrong one,
# and on a tendon that is a broken cable rather than a wrong number. A jog moves
# the SETPOINT (not the measurement, so errors cannot accumulate) by at most
# JOG_MAX_STEP, and the setpoint is then slewed there at SLEW_DEG_S.
JOG_MAX_STEP = 20.0       # biggest single nudge the UI may ask for
# Until a range has been captured there are no measured limits, so excursion is
# bounded relative to the manually-set centre instead. Capturing a range widens
# this to the real safe band; nothing else does.
JOG_MAX_FROM_CENTER = 25.0

# Firmware v11 closes the position loop at the motor tick. The host only slews
# and pets the target; these checks independently stop a powered but motionless
# spool and the firmware still owns the 30 mA jog / 44 mA global force caps.
JOG_STALL_CURRENT_MA = 25.0
JOG_STALL_SPEED_DPS = 0.20
JOG_STALL_TIME_S = 1.5
JOG_POSITION_DEADBAND_DEG = 0.15


class TendonCal:
    """One finger's tendon calibration. Thread-safe; owns a worker while active.

    send(str)        -> write one line to the Teensy (the bridge's serial lock)
    motors()         -> the parsed motor block from the S-line, or None
    encoders()       -> list of joint degrees by channel, or None
    """

    def __init__(self, send, motors, encoders, state_path,
                 motor_id=2, enc_ch=9):
        self.send = send
        self._motors = motors
        self._encoders = encoders
        self.path = state_path
        self.motor_id = motor_id
        self.enc_ch = enc_ch
        self.lock = threading.RLock()
        self.phase = "idle"
        self.message = "not started"
        self.error = None
        self.busy = False
        self.center = None
        self.range = None
        self.live = None
        self._worker = None
        self._abort = threading.Event()
        self.engaged = False       # torque on and the assist law holding a setpoint
        self.setpoint = None       # what we are commanding, deg (never the measurement)
        self.jog_target = None     # where the setpoint is slewing to
        self._load()

    # ---- jog band ---------------------------------------------------------
    def _band(self):
        """(lo, hi) the setpoint may occupy, and where it came from."""
        with self.lock:
            if self.range:
                return self.range["safe_lo"], self.range["safe_hi"], "range"
            if self.center:
                c = self.center.get(str(self.motor_id))
                if c is not None:
                    return (c - JOG_MAX_FROM_CENTER, c + JOG_MAX_FROM_CENTER,
                            "centre")
        return None, None, None

    # ---- persistence ------------------------------------------------------
    def _load(self):
        try:
            with open(self.path) as f:
                d = json.load(f)
            self.center = d.get("center")
            self.range = d.get("range")
            if self.range:
                self.phase = "ranged"
                self.message = "range loaded from disk"
            elif self.center:
                self.phase = "centered"
                self.message = "centre loaded from disk"
        except Exception:
            pass

    def _save(self):
        try:
            with open(self.path, "w") as f:
                json.dump({"center": self.center, "range": self.range,
                           "motor_id": self.motor_id, "enc_ch": self.enc_ch},
                          f, indent=2)
        except Exception as e:
            self.error = f"could not save: {e}"

    # ---- helpers ----------------------------------------------------------
    def _pos(self):
        m = self._motors()
        if not m:
            return None
        return (m.get("m") or {}).get(self.motor_id, {}).get("pos")

    def _taken(self):
        m = self._motors()
        return bool(m and m.get("taken"))

    def _torque(self):
        m = self._motors()
        return bool(m and m.get("torque"))

    def _enc(self):
        e = self._encoders()
        if not e or self.enc_ch >= len(e):
            return None
        v = e[self.enc_ch]
        return None if v is None or v <= -1.0 else v

    def _vel(self):
        m = self._motors() or {}
        return float(((m.get("m") or {}).get(self.motor_id) or {}).get("vel") or 0.0)

    def _ma(self):
        m = self._motors() or {}
        return float(((m.get("m") or {}).get(self.motor_id) or {}).get("ma") or 0.0)

    def _take_bus(self):
        if self._taken():
            return True
        self.send("M,t,1")
        t0 = time.time()
        while time.time() - t0 < TAKE_TIMEOUT_S:
            if self._taken():
                return True
            time.sleep(0.2)
        return False

    def _recover_faulted_bus(self):
        """Return a latched firmware motor fault to a known-safe connection.

        A failed enable leaves the firmware intentionally faulted.  Treating
        its still-true ``taken`` bit as a healthy bus made the next Engage only
        repeat the same failed enable.  Releasing first is safe (torque is off),
        and the firmware's M,t,1 path then re-detects both servos, verifies the
        link, and keeps torque off until the normal enable proof below.
        """
        m = self._motors() or {}
        if not m.get("fault"):
            return True
        with self.lock:
            self.message = "motor fault detected; safely reconnecting the servo bus"
        self.send("M,e,0")
        self.send("M,t,0")
        deadline = time.time() + 2.0
        while time.time() < deadline and self._taken():
            time.sleep(0.05)
        if self._taken():
            return False
        return self._take_bus()

    def torque_off(self):
        try:
            self.send("M,e,0")
            time.sleep(0.15)
            self.send("M,a,-1")
        except Exception:
            pass

    # ---- public API -------------------------------------------------------
    def public(self):
        lo, hi, src = self._band()
        with self.lock:
            return {
                "phase": self.phase, "message": self.message,
                "error": self.error, "busy": self.busy,
                "motor_id": self.motor_id, "enc_ch": self.enc_ch,
                "center": self.center, "range": self.range, "live": self.live,
                "engaged": self.engaged, "setpoint": self.setpoint,
                "jog_target": self.jog_target,
                "band": {"lo": lo, "hi": hi, "source": src},
                # Always expose the firmware's last cause on the jog snapshot,
                # including before/after a worker error changes the message.
                "motor_diagnostic": ((self._motors() or {}).get("diagnostic") or None),
                "limits": {"margin_deg": MARGIN_DEG, "slew_deg_s": SLEW_DEG_S,
                           "hold_drift_max": HOLD_DRIFT_MAX,
                           "max_lag_deg": MAX_LAG_DEG,
                           "jog_max_step": JOG_MAX_STEP,
                           "jog_max_from_center": JOG_MAX_FROM_CENTER},
            }

    def action(self, act, **kw):
        with self.lock:
            # jog/release must reach a RUNNING engage loop; everything else is
            # refused while a step owns the motor.
            if self.busy and act not in ("range_stop", "abort", "status",
                                         "jog", "release"):
                return False, "a calibration step is already running"
        if act == "status":
            return True, None
        if act == "abort":
            self._abort.set()
            self.torque_off()
            with self.lock:
                self.busy = False
                self.message = "aborted by operator"
                self.phase = "ranged" if self.range else (
                    "centered" if self.center else "idle")
            return True, None
        if act == "center":
            return self._spawn(self._do_center)
        if act == "range_start":
            with self.lock:
                if not self.center:
                    return False, "record the centre first"
            return self._spawn(self._do_range)
        if act == "range_stop":
            self._abort.set()
            return True, None
        if act == "hold":
            with self.lock:
                if not self.range:
                    return False, "capture the range first"
            return self._spawn(self._do_hold)
        if act == "move":
            with self.lock:
                if not self.range:
                    return False, "capture the range first"
                r = self.range
                if kw.get("home"):
                    tgt = self.center.get(str(self.motor_id))
                else:
                    tgt = kw.get("to")
            try:
                tgt = float(tgt)
            except (TypeError, ValueError):
                return False, "move needs a target angle"
            if not (r["safe_lo"] <= tgt <= r["safe_hi"]):
                return False, (f"{tgt:.1f} deg is outside the safe band "
                               f"[{r['safe_lo']:.1f} .. {r['safe_hi']:.1f}]")
            return self._spawn(self._do_move, tgt)
        if act == "engage":
            lo, hi, src = self._band()
            if lo is None:
                return False, "record the centre first"
            with self.lock:
                if self.engaged:
                    return True, None
            return self._spawn(self._do_engage)
        if act == "jog":
            with self.lock:
                if not self.engaged or self.setpoint is None:
                    return False, "engage the motor first"
                sp = self.setpoint
            try:
                d = float(kw.get("delta"))
            except (TypeError, ValueError):
                return False, "jog needs a delta"
            if not (0.0 < abs(d) <= JOG_MAX_STEP):
                return False, (f"a jog step must be between 0 and "
                               f"{JOG_MAX_STEP:.0f} deg")
            lo, hi, _ = self._band()
            tgt = max(lo, min(hi, sp + d))
            if abs(tgt - sp) < 1e-6:
                return False, ("already at the end of the safe band in that "
                               "direction")
            with self.lock:
                self.jog_target = tgt
                self.message = (f"jog {d:+.0f} deg: {sp:.1f} -> {tgt:.1f} "
                                f"at {SLEW_DEG_S:.0f} deg/s")
            return True, None
        if act == "release":
            with self.lock:
                self.engaged = False        # the engage loop unwinds and torques off
            if not self.busy:
                self.torque_off()
                self.send("M,t,0")
                with self.lock:
                    self.message = "torque off, bus released"
            return True, None
        return False, f"unknown action {act!r}"

    def _spawn(self, fn, *a):
        self._abort.clear()
        with self.lock:
            self.busy = True
            self.error = None
        self._worker = threading.Thread(target=self._guard, args=(fn,) + a,
                                        daemon=True)
        self._worker.start()
        return True, None

    def _guard(self, fn, *a):
        try:
            fn(*a)
        except Exception as e:
            self.torque_off()
            with self.lock:
                self.error = str(e)
                self.message = f"ABORTED: {e}"
        finally:
            with self.lock:
                self.busy = False

    # ---- phases -----------------------------------------------------------
    def _do_center(self):
        with self.lock:
            self.phase = "centering"
            self.message = "taking the servo bus (torque stays off)"
        if not self._take_bus():
            raise RuntimeError("the servo bus did not come up: check the 12 V "
                               "supply and the motor cabling")
        time.sleep(0.4)
        pos = self._pos()
        if pos is None:
            raise RuntimeError("no motor telemetry on the stream")
        m = self._motors()
        with self.lock:
            self.center = {str(k): v["pos"] for k, v in (m.get("m") or {}).items()}
            self.center_enc = self._enc()
            self.range = None            # a new centre invalidates the old range
            self.phase = "centered"
            self.message = (f"centre captured at {pos:.2f} deg with torque OFF; "
                            "now sweep the finger by hand")
            self._save()

    def _do_range(self):
        with self.lock:
            self.phase = "ranging"
            self.message = "move the finger through its FULL range, by hand"
        if not self._take_bus():
            raise RuntimeError("the servo bus did not come up")
        if self._torque():
            self.torque_off()
        lo_m = hi_m = lo_e = hi_e = None
        t0 = time.time()
        while not self._abort.is_set():
            if time.time() - t0 > 300:
                raise RuntimeError("range capture timed out after 5 minutes")
            pos, e = self._pos(), self._enc()
            if pos is not None:
                lo_m = pos if lo_m is None else min(lo_m, pos)
                hi_m = pos if hi_m is None else max(hi_m, pos)
            if e is not None:
                lo_e = e if lo_e is None else min(lo_e, e)
                hi_e = e if hi_e is None else max(hi_e, e)
            with self.lock:
                self.live = {"motor": pos, "enc": e,
                             "motor_lo": lo_m, "motor_hi": hi_m,
                             "enc_lo": lo_e, "enc_hi": hi_e,
                             "motor_span": (hi_m - lo_m) if lo_m is not None else 0.0,
                             "enc_span": (hi_e - lo_e) if lo_e is not None else 0.0,
                             "seconds": time.time() - t0}
            time.sleep(0.05)
        span = (hi_m - lo_m) if lo_m is not None else 0.0
        if span < MIN_USABLE_SPAN:
            raise RuntimeError(
                f"the motor only moved {span:.1f} deg, which is not a usable "
                f"range (need > {MIN_USABLE_SPAN:.0f}). Either the tendon is "
                "slipping on the spool or the finger did not travel.")
        with self.lock:
            self.range = {
                "motor_id": self.motor_id, "enc_ch": self.enc_ch,
                "motor_lo": lo_m, "motor_hi": hi_m, "motor_span": span,
                "enc_lo": lo_e, "enc_hi": hi_e,
                "enc_span": (hi_e - lo_e) if lo_e is not None else 0.0,
                "safe_lo": lo_m + MARGIN_DEG, "safe_hi": hi_m - MARGIN_DEG,
                "margin_deg": MARGIN_DEG,
                "captured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            self.phase = "ranged"
            self.message = (f"range {lo_m:.1f} .. {hi_m:.1f} deg (safe band "
                            f"{self.range['safe_lo']:.1f} .. "
                            f"{self.range['safe_hi']:.1f})")
            self.live = None
            self._save()

    def _enable_verified(self):
        """Torque on at EXACTLY zero current, proven not to move. Never skipped."""
        if not self._take_bus():
            raise RuntimeError("the servo bus did not come up")
        if not self._recover_faulted_bus():
            raise RuntimeError(
                "the servo bus could not recover from its fault; check the motor "
                "supply and cable, then try again")
        self.send("M,a,0")               # crown out of the loop, blend 0
        time.sleep(0.2)
        self.send("M,e,1")
        t0 = time.time()
        while time.time() - t0 < 3.0 and not self._torque():
            time.sleep(0.15)
        if not self._torque():
            d = (self._motors() or {}).get("diagnostic") or {}
            cause = d.get("cause")
            if cause and cause != "none":
                detail = f" ({cause}"
                if cause == "servo hardware alarm":
                    detail += f", register 70: {d.get('hardware_error')}"
                elif cause == "sustained bus miss":
                    detail += f", {d.get('consecutive_misses', 0)} consecutive misses"
                detail += ")"
                raise RuntimeError("torque did not enable" + detail)
            raise RuntimeError("torque did not enable")
        # Seed BOTH direct-current slots before selecting mode 2. iSet survives
        # torque-off in firmware, so zeroing only the selected motor leaves a
        # stale command window on the other spool.
        self.send("M,c,1,0")
        self.send("M,c,2,0")
        self.send("M,m,2")               # direct current, both proven zero
        time.sleep(0.3)
        p0 = self._pos()
        if p0 is None:
            raise RuntimeError("no telemetry after enable")
        worst = 0.0
        t0 = time.time()
        while time.time() - t0 < HOLD_VERIFY_S:
            self.send(f"M,c,{self.motor_id},0")
            time.sleep(PET_S)
            p = self._pos()
            if p is not None:
                worst = max(worst, abs(p - p0))
            with self.lock:
                self.live = {"motor": p, "drift": worst, "hold_p0": p0}
        if worst > HOLD_DRIFT_MAX:
            self.torque_off()
            raise RuntimeError(
                f"the motor moved {worst:.2f} deg on power-up (limit "
                f"{HOLD_DRIFT_MAX}). Torque is off. Do not retry until you "
                "know why.")
        return p0, worst

    def _do_hold(self):
        with self.lock:
            self.phase = "holding"
            self.message = "enabling torque at zero current and watching drift"
        p0, worst = self._enable_verified()
        self.torque_off()
        with self.lock:
            self.phase = "ranged"
            self.message = (f"HELD: {worst:.2f} deg drift at {p0:.1f} deg "
                            f"(limit {HOLD_DRIFT_MAX}). Torque back off.")
            self.live = None

    def _do_engage(self):
        """Power up proven-still, hand to the assist law, then hold and jog.

        The loop below is the ONLY thing that ever commands a position, and it
        moves the setpoint by at most SLEW_DEG_S*PET_S per tick. A UI press does
        not command the motor; it moves a target that this loop walks toward.
        """
        with self.lock:
            self.phase = "engaging"
            self.message = "verifying the motor does not move on power-up"
        p0, worst = self._enable_verified()
        lo, hi, src = self._band()
        if lo is None:
            self.torque_off()
            raise RuntimeError("no centre recorded")
        if not (lo - MARGIN_DEG <= p0 <= hi + MARGIN_DEG):
            self.torque_off()
            raise RuntimeError(
                f"the motor sits at {p0:.1f} deg, outside the allowed band "
                f"[{lo:.1f} .. {hi:.1f}]. Re-record the centre where it is now.")
        # Hand position regulation to dedicated firmware mode 3. The mode change
        # seeds both current positions and commands zero until M,p selects this
        # one motor, so entry is stationary. Regulation then runs at the motor
        # tick rather than across this 10 Hz host loop.
        self.send("M,m,3")
        self.send(f"M,p,{self.motor_id},{p0:.2f}")
        with self.lock:
            self.engaged = True
            self.setpoint = p0
            self.jog_target = p0
            self.phase = "engaged"
            self.message = (f"engaged, holding {p0:.1f} deg "
                            f"(band {lo:.1f} .. {hi:.1f}, from the {src})")
        step = SLEW_DEG_S * PET_S
        stalled_s = 0.0
        try:
            while not self._abort.is_set():
                with self.lock:
                    if not self.engaged:
                        break
                    sp, tg = self.setpoint, self.jog_target
                sp = max(lo, min(hi, sp + max(-step, min(step, tg - sp))))
                with self.lock:
                    self.setpoint = sp
                self.send(f"M,p,{self.motor_id},{sp:.2f}")
                time.sleep(PET_S)
                # The firmware can drop torque underneath us (25 consecutive
                # missed status frames trips it, and a display paint can do
                # that at a 2 kHz tick). Until 2026-08-11 this loop kept
                # cheerfully commanding positions into a de-energised motor and
                # reported "engaged, holding" the whole time, which is exactly
                # the kind of lie that makes an operator press harder.
                mfw = self._motors() or {}
                if not mfw.get("torque") or mfw.get("fault"):
                    d = mfw.get("diagnostic") or {}
                    cause = d.get("cause")
                    detail = ""
                    if cause and cause != "none":
                        detail = f" Cause: {cause}"
                        if cause == "servo hardware alarm":
                            detail += f" (register 70: {d.get('hardware_error')})."
                        elif cause == "sustained bus miss":
                            detail += f" ({d.get('consecutive_misses', 0)} consecutive misses)."
                        else:
                            detail += "."
                    raise RuntimeError(
                        "the firmware dropped torque; nothing is being driven."
                        + detail + " Release and Engage once to recover. If it "
                        "repeats, use the reported cause rather than retrying blindly.")
                pos, e = self._pos(), self._enc()
                if pos is None:
                    continue
                lag = abs(sp - pos)
                command_ma = self._ma()
                if (abs(command_ma) >= JOG_STALL_CURRENT_MA
                        and abs(self._vel()) <= JOG_STALL_SPEED_DPS
                        and lag > JOG_POSITION_DEADBAND_DEG):
                    stalled_s += PET_S
                else:
                    stalled_s = 0.0
                if stalled_s >= JOG_STALL_TIME_S:
                    raise RuntimeError(
                        f"motor did not move under {abs(command_ma):.0f} mA for "
                        f"{stalled_s:.1f} s; torque is being dropped because the "
                        "spool or tendon may be bound")
                with self.lock:
                    self.live = {"cmd": sp, "motor": pos, "lag": lag,
                                 "enc": e, "target": tg,
                                 "command_ma": command_ma}
                if pos < lo - MARGIN_DEG or pos > hi + MARGIN_DEG:
                    raise RuntimeError(f"the motor left the safe band at "
                                       f"{pos:.1f} deg")
                if lag > MAX_LAG_DEG:
                    raise RuntimeError(f"{lag:.1f} deg of lag: the tendon is "
                                       "bound or the spool is slipping")
        finally:
            self.torque_off()
            with self.lock:
                self.engaged = False
                self.setpoint = self.jog_target = None
                self.live = None
                self.phase = "ranged" if self.range else "centered"
                if not self.error:
                    self.message = "released, torque off"

    def _do_move(self, target):
        with self.lock:
            self.phase = "moving"
            self.message = f"verifying zero-motion power-up before moving"
            r = dict(self.range)
        p0, _ = self._enable_verified()
        lo, hi = r["safe_lo"], r["safe_hi"]
        if not (lo - MARGIN_DEG <= p0 <= hi + MARGIN_DEG):
            self.torque_off()
            raise RuntimeError(f"the motor sits at {p0:.1f} deg, outside the "
                               "captured range; re-run the range capture")
        # hand over to the assist law, whose setpoint the firmware seeded at the
        # CURRENT position: engaging is a no-op by construction.
        self.send("M,m,1")
        self.send(f"M,p,{self.motor_id},{p0:.2f}")
        for k in range(1, BLEND_STEPS + 1):
            self.send(f"M,a,{int(1000 * k / BLEND_STEPS)}")
            self.send(f"M,p,{self.motor_id},{p0:.2f}")
            time.sleep(0.12)
        with self.lock:
            self.message = f"ramping {p0:.1f} -> {target:.1f} deg"
        cur = p0
        step = SLEW_DEG_S * PET_S
        while abs(cur - target) > 0.05 and not self._abort.is_set():
            cur += max(-step, min(step, target - cur))
            cur = max(lo, min(hi, cur))
            self.send(f"M,p,{self.motor_id},{cur:.2f}")
            time.sleep(PET_S)
            pos, e = self._pos(), self._enc()
            if pos is None:
                continue
            lag = abs(cur - pos)
            with self.lock:
                self.live = {"cmd": cur, "motor": pos, "lag": lag, "enc": e,
                             "target": target}
            if pos < lo - MARGIN_DEG or pos > hi + MARGIN_DEG:
                self.torque_off()
                raise RuntimeError(f"the motor left the safe band at "
                                   f"{pos:.1f} deg")
            if lag > MAX_LAG_DEG:
                self.torque_off()
                raise RuntimeError(f"{lag:.1f} deg of lag: the tendon is bound "
                                   "or the spool is slipping")
        t0 = time.time()
        while time.time() - t0 < 1.2 and not self._abort.is_set():
            self.send(f"M,p,{self.motor_id},{target:.2f}")
            time.sleep(PET_S)
        pos, e = self._pos(), self._enc()
        self.torque_off()
        with self.lock:
            self.phase = "ranged"
            self.message = (f"reached {pos:.2f} deg (target {target:.2f}, "
                            f"err {(pos - target):+.2f}); joint "
                            f"{('%.2f' % e) if e is not None else 'n/a'} deg. "
                            "Torque off.")
            self.live = None
