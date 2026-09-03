#!/usr/bin/env python3
"""
teensy_bridge.py - the TAKTO ONE ecosystem host bridge.

Connects the TAKTO operator console to the Teensy over
ws://<host>:8765/ws. Shared state, calibration and recorded sessions are owned
by this process and broadcast to connected consoles at 60 Hz.

Data sources (pick one):
  --port /dev/cu.usbmodemXXX   live Teensy (bringup_12ch stream, 'j' = ON):
      S,<t_ms>,<enc00..enc13>,<h_qw..h_qz>,<f_qw..f_qz>,<imu0live>,<imu1live>[,emg]
      Encoders/IMUs the firmware reports absent are sent ok:false (honest);
      motors stay host-owned and un-bridged on real hardware (never faked).
  --sim   no hardware at all: a 50 Hz synthetic full-system scene (12 joints,
      2 IMUs, EMG through the real activation filter, N simulated motors) runs
      through the same calibration and snapshot pipeline.

Run:
    python teensy_bridge.py --port /dev/cu.usbmodemXXXX
    python teensy_bridge.py --sim
Then open the console URL documented in software/README.md.
"""
import argparse, asyncio, copy, glob, json, math, os, re, threading, time, sys
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tendon

# Snapshot broadcast rate. 60 Hz outruns the device's 50 Hz sampling, so a
# fresh sample never waits more than one 16.7 ms tick to ship (at 30 Hz the
# mean queueing delay alone was ~17 ms). Overridable: --hz / bench_replay.
# Latency notes: asyncio TCP transports have TCP_NODELAY on by default
# (CPython) and the hub serializes each snapshot ONCE for all clients.
HZ = 60
WS_PORT = 8765               # advertised in link.port for QR pairing

# Every persisted file (calibrations, home pose, take library) lives here.
# Tests set SENSORYHAND_STATE_DIR to an isolated dir so runs never touch the
# real bench calibration in ~.
STATE_DIR = os.environ.get("SENSORYHAND_STATE_DIR", os.path.expanduser("~"))
# A fresh checkout has no state directory yet; the first atomic write would
# otherwise fail on the .tmp file before the bridge ever serves a frame.
os.makedirs(STATE_DIR, exist_ok=True)


def _write_json_atomic(path, obj):
    """Every state write goes through tmp+rename (os.replace is atomic on
    POSIX), so a crash mid-write can never leave a half-written index or
    calibration file for the next start to trip over."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def _quarantine_corrupt(path, err, tag):
    """A corrupt index must never be silently forgotten: keep the evidence and
    say so loudly. Data files stay on disk; _next_state_id() keeps counting
    from them, so a reset index can never recycle an ID over old data."""
    dest = "%s.corrupt-%d" % (path, int(time.time()))
    try:
        os.replace(path, dest)
    except OSError:
        dest = "(could not move it)"
    print(f"[{tag}] CORRUPT index {path}: {err} -> quarantined to {dest}; "
          "data files untouched, IDs continue from the files on disk")

# Rolling capture-diagnostics log (2026-07-20): clients ship their full scan
# diagnostic ({cmd:"diag"}) at every transition, and every env_save - success
# OR reject - is appended too. serve_quest.py's HTTP beacon writes the same
# file, so ONE file reconstructs any capture attempt (the round-1 failure was
# exactly that nothing was written anywhere). Trimmed so it never grows
# unbounded.
DIAG_LOG = os.path.join(STATE_DIR, ".sensoryhand_diag.log")
DIAG_LOG_MAX_LINES = 4000


def diag_append(entry):
    """Append one JSON line to the diag log; trim the file when it gets long.
    Never raises: diagnostics must not take the bridge down."""
    try:
        entry = dict(entry)
        entry["t_srv_ms"] = int(time.time() * 1000)
        with open(DIAG_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
        if os.path.getsize(DIAG_LOG) > 8 * 1024 * 1024:
            with open(DIAG_LOG) as f:
                lines = f.readlines()[-DIAG_LOG_MAX_LINES:]
            with open(DIAG_LOG, "w") as f:
                f.writelines(lines)
    except Exception as e:
        print("[diag] could not append log:", e)

try:
    import serial  # pyserial
except Exception as e:
    print("MISSING pyserial:", e); sys.exit(3)
try:
    import websockets
except Exception as e:
    print("MISSING websockets:", e); sys.exit(3)

N_CH = 14
FINGERS = ["index", "middle", "ring", "pinky"]
SEGMENTS = ["mcp", "pip", "dip"]

# encoder channel -> joint name. Default order: ch0..11 = the 4 fingers x 3
# segments (mcp,pip,dip), ch12/13 spare. Adjust here once calibration ('c')
# tells you which channel actually moves for which joint.
JOINT2CH = {}
for fi, f in enumerate(FINGERS):
    for si, seg in enumerate(SEGMENTS):
        JOINT2CH[f + "_" + seg] = fi * 3 + si

CH2JOINT = {ch: name for name, ch in JOINT2CH.items()}   # reverse: encoder channel -> joint name

# ---- wired-finger encoder -> DOF mapping + live zeroing ---------------------
# The one wired finger's 3 encoders drive its MCP (2 DOF) and PIP (1 DOF). The
# twin reads, per finger (see twin.js render): <f>_mcp = MCP ABDUCTION (signed,
# ~+-16 deg, 0 = straight), <f>_pip = MCP FLEXION (8 = open .. ~60 curl), <f>_dip
# = PIP FLEXION (8 = open .. curl). So map each wired channel to a DOF, sign and
# scale (adjust after watching each joint move), and zero it to a live neutral.
WIRED_FINGER = "index"
# channel -> (dof, sign) per the wiring the user reported: ch10 = MCP side-to-side
# (abduction), ch8 = MCP up/down (flexion), ch9 = PIP up/down (flexion).
ENC_DOF = {
    10: ("abduct",  +1.0),
    8:  ("mcpflex", +1.0),
    9:  ("pipflex", +1.0),
}
# Real AS5600 samples are absolute magnet angles, not anatomical joint angles.
# Only channels in ENC_DOF have a measured channel -> DOF mapping today. The
# simulator and the explicit bench replay opt in when their arrays are already
# joint-space degrees. This prevents an uncalibrated 230 degree sensor reading
# from becoming a 230 degree finger pose hidden only by a renderer clamp.
ENC_JOINT_SPACE_DIRECT = False
DOF_SEG = {"abduct": "mcp", "mcpflex": "pip", "pipflex": "dip"}
ABDUCT_SCALE = 1.0                    # deg abduction per deg encoder (tune from side-to-side)
# Twin flexion range = the MECHANICAL ROM (thesis hard stops): open 0 deg,
# MCP flexion closes at 90, PIP flexion at 110 (per-DOF closed map below).
FLEX_OPEN, FLEX_CLOSED = 0.0, 90.0
DOF_CLOSED = {"mcpflex": 90.0, "pipflex": 110.0}
# Two-point flexion calibration: raw at the straight-EXTENDED pose (open) and the
# fully-CONTRACTED pose (closed) per channel. Mapping raw between them gives each
# flexion joint its direction AND travel for free (no manual sign/scale needed).
ENC_OPEN = {}    # channel -> raw at straight/extended reference
ENC_CLOSED = {}  # channel -> raw at contracted reference

# ----- continuous (unwrapped) encoder angle ----------------------------------
# [BENCH 2026-08-06] ch8's magnetic zero sits INSIDE its travel, so an ordinary
# flexion walks the AS5600 straight through its 0/360 seam. Measured on the
# bench: ch8 swept 0.0..359.9 with four ~359.8 deg steps in 20 s, and the joint
# it drives snapped its full 0..100 deg range on every one of them.
#
# The old joint math used _wrap180(raw - open), which is only correct while the
# joint stays within +/-180 deg of its open mark AND never crosses the seam
# mid-travel. Crossing it flips the sign of the difference, which is exactly the
# "after a given angle the value flips" symptom.
#
# The fix is to stop asking a wrapped number to behave like a continuous one:
# accumulate shortest-arc steps into an unwrapped angle per channel, and do all
# joint arithmetic there. The seam then does not exist as far as the twin is
# concerned. `enc` itself stays 0..360 because presence still keys off d >= 0.0
# and the raw hardware view must keep showing what the chip actually reports.
_enc_cont = {}       # ch -> {"cont": unwrapped deg, "last": last raw deg}
_cont_open = {}      # ch -> position of ENC_OPEN[ch] in the CURRENT continuous frame


def unwrapped_deg(ch, raw):
    """Raw 0..360 -> continuous degrees. Idempotent within a sample."""
    st = _enc_cont.get(ch)
    if st is None:
        _enc_cont[ch] = {"cont": raw, "last": raw}
        return raw
    st["cont"] += _wrap180(raw - st["last"])
    st["last"] = raw
    return st["cont"]


def _open_in_cont_frame(ch, raw):
    """Where this channel's open mark sits in the continuous frame.

    The continuous frame is re-seeded every time the bridge starts, so a
    persisted open mark (stored raw) has to be located in it exactly once. That
    mapping uses the shortest arc, which is sound because a finger's mechanical
    ROM is well under 180 deg - the assumption is only made here, at anchor time,
    never again per sample.
    """
    a = _cont_open.get(ch)
    if a is None:
        cont = _enc_cont[ch]["cont"]
        o = ENC_OPEN.get(ch)
        if o is None:
            # still settling a provisional mark (see _seed_open): anchor on the
            # live sample so travel reads 0, and do NOT cache - the real anchor
            # lands the moment the mark commits.
            return cont
        a = _cont_open[ch] = cont - _wrap180(raw - o)
    return a


def reset_enc_channel(ch):
    """Forget everything derived for a channel (it went absent, or was recalibrated)."""
    _enc_cont.pop(ch, None)
    _cont_open.pop(ch, None)


def _wrap180(d):
    """Shortest signed angular difference, so an AS5600 wrap near 0/360 is smooth."""
    return (d + 180.0) % 360.0 - 180.0


# ----- encoder signal conditioning -------------------------------------------
# [BENCH 2026-08-06] The raw AS5600 stream is not fit to drive a twin directly.
# Two problems, and they need different answers:
#
#   1. JITTER. The magnet sits at the edge of the sensor's window (AGC railed at
#      128 on two of the three wired channels), so the last bits are noise. Fed
#      straight into the rig, that noise becomes visible tremor, and any velocity
#      or effort derived from it is worse than useless - differentiating noise
#      amplifies it.
#   2. LAG. A filter heavy enough to kill that tremor while the finger is still
#      would smear a fast flexion into mush, which is exactly the fidelity the
#      twin exists to show.
#
# A fixed low-pass cannot do both: its cutoff is a straight trade of one against
# the other. The One-Euro filter (Casiez, Roussel & Vogel, CHI 2012) adapts the
# cutoff to the measured speed - heavy smoothing when slow, almost none when
# fast - which is precisely the jitter-vs-lag compromise a human limb needs.
#
# ANGLES, NOT NUMBERS: the AS5600 wraps 0 <-> 360, and low-passing across that
# seam injects a 360 deg spike that would snap the twin. Every difference here
# goes through _wrap180 and the state is kept unwrapped, so the seam is invisible.
class _OneEuroAngle:
    """One-Euro filter over a wrapping angle (degrees). State is unwrapped."""

    def __init__(self, min_cutoff, beta, d_cutoff=1.0):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.reset()

    def reset(self):
        self._x = None        # filtered value, UNWRAPPED (may leave 0..360)
        self._dx = 0.0        # filtered rate, deg/s
        self._t = None

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, raw, t):
        if self._x is None or self._t is None:
            self._x, self._t, self._dx = raw, t, 0.0
            return raw % 360.0
        dt = t - self._t
        if dt <= 0.0 or dt > 0.5:
            # a stall, a reconnect or a clock jump: re-seed rather than integrate
            # a bogus velocity through the adaptive cutoff.
            self._x, self._t, self._dx = raw, t, 0.0
            return raw % 360.0
        self._t = t
        # rate on the SHORTEST arc, so a wrap reads as a small step not a 360 jump
        step = _wrap180(raw - self._x)
        dx = step / dt
        self._dx += self._alpha(self.d_cutoff, dt) * (dx - self._dx)
        cutoff = self.min_cutoff + self.beta * abs(self._dx)
        self._x += self._alpha(cutoff, dt) * step
        return self._x % 360.0


ENC_FILTER_ON = True
# Chosen by sweep against the real bench signal (2026-08-06), not by taste. On a
# 0.35 deg-RMS rest signal these give 4.1x jitter reduction with 1.95 deg of lag
# during a 300 deg/s flexion - both better than any (1.2, 0.012)-style default,
# because the low rest cutoff does the smoothing and beta buys the lag back the
# moment the finger actually moves. Re-run the sweep if the magnet seating changes.
ENC_FILTER_MIN_CUTOFF = 0.7   # Hz: the still-hand cutoff. Lower = steadier, laggier.
ENC_FILTER_BETA = 0.06        # speed coupling. Higher = snappier on fast flexion.
_enc_filters = {}


def filter_encoders(enc, t_ms):
    """Condition raw encoder degrees in place-ish; returns a new list.

    Absent channels (negative sentinels) are passed through untouched and drop
    their filter state, so a channel that comes back after a reseat starts clean
    instead of easing in from a stale value it never had.
    """
    if not ENC_FILTER_ON:
        return enc
    t = t_ms / 1000.0
    out = []
    for ch, d in enumerate(enc):
        if d < 0.0:                      # honest absence: never invent a value
            _enc_filters.pop(ch, None)
            reset_enc_channel(ch)        # and drop the unwrap accumulator with it
            out.append(d)
            continue
        f = _enc_filters.get(ch)
        if f is None:
            f = _enc_filters[ch] = _OneEuroAngle(ENC_FILTER_MIN_CUTOFF, ENC_FILTER_BETA)
        out.append(f(d, t))
    return out


def capture_joint_ref(which, enc):
    """Snapshot current raw angles as the 'open' (extended) or 'closed' reference."""
    tgt = ENC_OPEN if which == "open" else ENC_CLOSED
    for ch in ENC_DOF:
        d = enc[ch] if ch < len(enc) else -1.0
        if d >= 0.0:
            tgt[ch] = d
            if which == "open":
                _cont_open.pop(ch, None)   # re-anchor: the open mark just moved
    if which == "open":
        ENC_CLOSED.clear()            # a fresh open invalidates the old closed


def capture_joint_closed(ch, raw):
    """Capture one flexion endpoint without disturbing any other joint.

    The old all-at-once fist capture could record a partly flexed PIP as its
    full-scale endpoint. That short denominator made the twin reach full PIP
    bend halfway through the physical motion. Independent endpoint captures
    keep the scale tied to actual travel and leave MCP/DIP data untouched.
    """
    if ch not in ENC_DOF or ENC_DOF[ch][0] == "abduct":
        return {"ok": False, "error": "channel is not a flexion DOF"}
    if ch not in ENC_OPEN:
        return {"ok": False, "error": "capture the neutral pose first"}
    if raw is None or raw < 0.0:
        return {"ok": False, "error": "encoder is not live"}
    travel = abs(_wrap180(float(raw) - ENC_OPEN[ch]))
    if travel <= 3.0:
        return {"ok": False, "error": "move the joint through its full range first"}
    if travel > 175.0:
        return {"ok": False, "error": "travel exceeds the valid encoder range"}
    ENC_CLOSED[ch] = float(raw)
    _cont_open.pop(ch, None)
    _save_jcal()
    return {"ok": True, "travel": round(travel, 1)}


_jcal_checked = False


def validate_jcal_once(enc):
    """Throw away a persisted calibration that cannot describe the current build.

    [BENCH 2026-08-06] Symptom this exists for: the twin's finger sat frozen at
    its clamp (mcp 16.0 = the abduction limit, pip 100.0 = the flexion limit)
    while all three encoders streamed clean, changing angles. It reads exactly
    like "the encoders do not drive the twin", but the data was arriving fine -
    it was being mapped through open/closed marks captured BEFORE the encoders
    were re-seated, so every live reading fell far outside the calibrated span
    and saturated. Measured at the time: ch8 sat 2.0x its span from the stored
    open mark, ch10 2.5x.

    A calibration is captured as one set in one sweep, so if any channel is
    impossible the whole set belongs to a previous mounting. Discarding it lets
    ENC_OPEN re-seed from the current pose, which gives live (if provisional)
    motion immediately instead of a frozen finger. Silently railing is the worst
    option: it looks like dead hardware.
    """
    global _jcal_checked
    if _jcal_checked or not ENC_OPEN:
        return
    worst = None
    for ch in ENC_DOF:
        if ch not in ENC_OPEN:
            continue
        d = enc[ch] if ch < len(enc) else -1.0
        if d < 0.0:
            return                      # wait until every wired channel reports
        c = ENC_CLOSED.get(ch)
        # abduction has no closed mark; its usable span is the +/-16 deg clamp
        span = abs(_wrap180(c - ENC_OPEN[ch])) if c is not None else 32.0
        excess = abs(_wrap180(d - ENC_OPEN[ch])) / max(span, 5.0)
        if worst is None or excess > worst[1]:
            worst = (ch, excess)
    if worst and worst[1] > 1.5:
        print(f"[calib] STALE calibration discarded: ch{worst[0]} reads "
              f"{worst[1]:.1f}x its calibrated span away from the stored open mark, "
              f"which no finger can do. These marks predate the current mounting. "
              f"Joints will now track live from the present pose - re-run the sweep "
              f"(Calibrate hand) to restore absolute angles.")
        ENC_OPEN.clear()
        ENC_CLOSED.clear()
        _cont_open.clear()
        _seed_buf.clear()      # re-seed provisional marks from settled readings
    _jcal_checked = True


# Provisional open marks are seeded from a SETTLED reading, not one sample.
# A single sample is whatever the channel happened to say on the frame the
# calibration was discarded, and on a weak-magnet channel that can be a long way
# from where the reading settles: ch10 seeded at ~207 deg, settled at ~191, and
# the 16 deg difference railed the abduction clamp at exactly -16.00 for as long
# as the bridge ran. Averaging the first few frames costs nothing and removes a
# whole class of "the joint is stuck at its limit" reports.
_SEED_FRAMES = 12
_seed_buf = {}          # ch -> [raw, ...] until it has enough to commit


def _seed_open(ch, raw):
    """Provisional open mark: the mean of the first _SEED_FRAMES readings."""
    if ch in ENC_OPEN:
        return ENC_OPEN[ch]
    buf = _seed_buf.setdefault(ch, [])
    buf.append(raw)
    if len(buf) < _SEED_FRAMES:
        return raw                            # track from the live sample meanwhile
    # mean on the unit circle, so a channel sitting near the 0/360 seam does not
    # average to the opposite side of the dial
    sx = sum(math.cos(math.radians(v)) for v in buf)
    sy = sum(math.sin(math.radians(v)) for v in buf)
    ENC_OPEN[ch] = math.degrees(math.atan2(sy, sx)) % 360.0
    _cont_open.pop(ch, None)                  # re-anchor against the committed mark
    _seed_buf.pop(ch, None)
    return ENC_OPEN[ch]


def calibrated_joint(ch, raw):
    """raw AS5600 deg -> (joint_id, twin angle) for the mapped DOF."""
    dof, sign = ENC_DOF[ch]
    seg = DOF_SEG[dof]
    o = _seed_open(ch, raw)                   # settled seed until captured explicitly
    # CONTINUOUS travel from the open mark. This is the line that kills the seam
    # flip: `travel` grows monotonically through 360->0, where _wrap180 would
    # have inverted its sign. `den` below stays a wrapped difference on purpose -
    # it is a constant derived from two stationary marks, not a live signal.
    cont = unwrapped_deg(ch, raw)
    travel = cont - _open_in_cont_frame(ch, raw)
    if dof == "abduct":                       # side-to-side: open = centre (0), signed
        d = sign * ABDUCT_SCALE * travel
        return WIRED_FINGER + "_" + seg, max(-16.0, min(16.0, d))
    # flexion: two-point map open -> FLEX_OPEN, closed -> FLEX_CLOSED
    c = ENC_CLOSED.get(ch)
    if c is None:
        val = FLEX_OPEN + max(0.0, sign * travel)              # provisional until closed captured
    else:
        num = travel
        den = _wrap180(c - o)
        t = (num / den) if abs(den) > 1e-3 else 0.0
        closed = DOF_CLOSED.get(dof, FLEX_CLOSED)
        val = FLEX_OPEN + max(0.0, min(1.2, t)) * (closed - FLEX_OPEN)
    return WIRED_FINGER + "_" + seg, max(-10.0, min(DOF_CLOSED.get(dof, FLEX_CLOSED) + 10.0, val))


# ----- range-of-motion sweep: user opens/closes a few times, we learn each -----
# channel's open (start) reference and its farthest excursion (fully closed). The
# result populates ENC_OPEN/ENC_CLOSED, which calibrated_joint() already consumes.
# Persisted so it survives bridge restarts.
_JCAL_FILE = os.path.join(STATE_DIR, ".sensoryhand_joint_calib.json")
_sweep_active = False
_sweep_open = {}     # ch -> raw at sweep start (hand open)
_sweep_closed = {}   # ch -> raw at the farthest excursion (hand closed)
_sweep_exc = {}      # ch -> signed max-|excursion| from open
_sweep_cont_open = {}  # ch -> sweep-start position in the continuous frame


def start_joint_sweep(enc):
    """Begin a sweep: anchor 'open' at the current pose (hand should start OPEN)."""
    global _sweep_active
    _sweep_open.clear(); _sweep_closed.clear(); _sweep_exc.clear(); _sweep_cont_open.clear()
    for ch in ENC_DOF:
        d = enc[ch] if ch < len(enc) else -1.0
        if d >= 0.0:
            _sweep_open[ch] = d
            _sweep_closed[ch] = d
            _sweep_exc[ch] = 0.0
            _sweep_cont_open[ch] = unwrapped_deg(ch, d)
    _sweep_active = True


def update_joint_sweep(enc):
    """Per-sample: track each channel's farthest angular excursion from its open ref
    (sign-agnostic, wrap-safe), so the closed extreme is captured whichever way it turns."""
    if not _sweep_active:
        return
    for ch in list(_sweep_open):
        d = enc[ch] if ch < len(enc) else -1.0
        if d < 0.0:
            continue
        # continuous, for the same reason calibrated_joint is: a sweep that
        # crosses the seam used to fold back on itself and report a fraction of
        # the real travel, which then became the joint's full-scale denominator.
        exc = unwrapped_deg(ch, d) - _sweep_cont_open.get(ch, unwrapped_deg(ch, d))
        if abs(exc) > abs(_sweep_exc[ch]):
            _sweep_exc[ch] = exc
            _sweep_closed[ch] = d


def finish_joint_sweep():
    """End the sweep: commit open + (for flexion DOF with real travel) closed, and persist."""
    global _sweep_active
    _sweep_active = False
    result = {}
    # A sweep in which NOTHING moved must never overwrite a good calibration:
    # it means the sensors were frozen/absent (link down, magnets missing), not
    # that the finger's range is zero.
    if not any(abs(_sweep_exc.get(ch, 0.0)) > 3.0 for ch in _sweep_open):
        print("[calib] sweep discarded: no channel moved > 3 deg (frozen/absent sensors?)")
        return {ch: round(abs(_sweep_exc.get(ch, 0.0)), 1) for ch in _sweep_open}
    for ch in _sweep_open:
        ENC_OPEN[ch] = _sweep_open[ch]
        _cont_open.pop(ch, None)                  # new open mark -> re-anchor the continuous frame
        dof, _ = ENC_DOF[ch]
        travel = abs(_sweep_exc.get(ch, 0.0))
        # ENC_CLOSED is stored raw and its distance from open is recovered with
        # _wrap180, which can only represent travel under 180 deg. A finger cannot
        # physically exceed that, so a sweep reporting more means the channel was
        # spinning free (loose magnet, slipped spool) - refuse it rather than bake
        # in a denominator that silently aliases.
        if travel > 175.0:
            print(f"[calib] ch{ch}: {travel:.0f} deg travel exceeds the 180 deg "
                  f"representable range - closed pose REFUSED (loose magnet?)")
        elif dof != "abduct" and travel > 3.0:    # need real motion to define a closed pose
            ENC_CLOSED[ch] = _sweep_closed[ch]
        result[ch] = round(travel, 1)
    _save_jcal()
    print("[calib] sweep done; travel per channel (deg):", result)
    return result


def _save_jcal():
    try:
        _write_json_atomic(_JCAL_FILE, {"open": ENC_OPEN, "closed": ENC_CLOSED})
    except Exception as e:
        print("[calib] could not save joint calibration:", e)


def _load_jcal():
    try:
        with open(_JCAL_FILE) as f:
            d = json.load(f)
        ENC_OPEN.update({int(k): float(v) for k, v in d.get("open", {}).items()})
        ENC_CLOSED.update({int(k): float(v) for k, v in d.get("closed", {}).items()})
        print("[calib] loaded joint calibration from", _JCAL_FILE)
    except FileNotFoundError:
        pass
    except Exception as e:
        _quarantine_corrupt(_JCAL_FILE, e, "calib")


_load_jcal()


# ----- shared state written by the serial thread, read by the ws server ------
state = {
    "t_ms": 0,
    "enc": [-1.0] * N_CH,      # degrees; <0 means channel not present
    "hq": [1.0, 0.0, 0.0, 0.0],
    "fq": [1.0, 0.0, 0.0, 0.0],
    "tq": [1.0, 0.0, 0.0, 0.0],  # thumb-tip IMU (v4 firmware); identity until live
    "thumb_live": False,
    # full BNO085 report set per sensor (v7 firmware); None on older firmware,
    # which is the honest signal that acceleration is simply not being streamed
    "imu_full": None,
    # Which BNO085 fusion stream currently supplies each pose. Firmware v7
    # exposes both; the host selects the magnet-immune game vector so a stale
    # magnetic heading cannot create a false relative wrist rotation.
    "orientation_source": {"hand": "rotation_vector", "forearm": "rotation_vector",
                           "thumb": "rotation_vector"},
    "imu_live": [0, 0],
    "emg_env": 0.0, "emg_rms": 0.0, "emg_present": False,
    "crown": None,             # 0..1 transparency crown (v3 firmware); None = not streamed
    "activation": {"present": False, "level": 0.0, "direction": 0, "fatigue": 0.0,
                   "onset": False, "quality": "none"},
    "last_rx": 0.0,            # wall time of last valid S line
    "recording": False,
}
state_lock = threading.Lock()
ser_write_lock = threading.Lock()
_ser = {"port": None}
# Firmware capability negotiation: bringup_12ch v2+ answers 'v' with a
# "# ver bringup_12ch <n>" banner and supports EXPLICIT record commands
# ('b' start / 'e' stop, both idempotent). Older firmware only has the 'r'
# toggle, which can silently invert if the bench operator toggled locally -
# so we use b/e whenever the handshake says we can, and fall back otherwise.
_fw = {"explicit_rec": False, "version": 0, "thumb_capable": False}

# ----- Fable activation module: EMG (Teensy pin 14, MyoWare envelope) -> contract -----
# The firmware streams the MyoWare envelope (emg_env, emg_rms, emg_present); this runs
# the Fable activation module (effort_control BayesianAmplitude + auto rest/MVC
# normalization + onset) once per sample in the serial thread and stores the contract.
ACT_ABSENT = {"present": False, "level": 0.0, "direction": 0, "fatigue": 0.0,
              "onset": False, "quality": "none"}
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from fable_activation import FableActivation
    _fa = FableActivation(fs=50.0)
    print("[emg] Fable activation module loaded (bayes=%s)" % _fa.have_bayes)
except Exception as _e:
    _fa = None
    print("[emg] activation module unavailable:", _e)
_emg_recal = False


def run_activation(emg_env, emg_present):
    """Advance the Fable activation filter once per real EMG sample."""
    global _emg_recal
    if _fa is None or not emg_present:
        return dict(ACT_ABSENT)
    if _emg_recal:
        _fa.recalibrate()
        _emg_recal = False
    return _fa.update(emg_env, emg_present)


def trigger_emg_recal():
    global _emg_recal
    _emg_recal = True


def quat_to_rpy(w, x, y, z):
    sinr_cosp = 2 * (w * x + y * z)
    cosr_cosp = 1 - 2 * (x * x + y * y)
    roll = math.atan2(sinr_cosp, cosr_cosp)
    sinp = 2 * (w * y - z * x)
    pitch = math.copysign(math.pi / 2, sinp) if abs(sinp) >= 1 else math.asin(sinp)
    siny_cosp = 2 * (w * z + x * y)
    cosy_cosp = 1 - 2 * (y * y + z * z)
    yaw = math.atan2(siny_cosp, cosy_cosp)
    return [round(math.degrees(roll), 1), round(math.degrees(pitch), 1), round(math.degrees(yaw), 1)]


# ===========================================================================
#  PER-IMU MOUNTING CONFIGURATION  (live, persisted, editable from the console)
# ===========================================================================
# WHY THIS IS DATA AND NOT CODE (2026-08-06): every field below used to be a
# module-level constant edited by hand, which meant one bench observation cost a
# source edit + a bridge restart + a re-tare, and the comment history turned into
# a log of guesses ("reverted", "NOT APPLIED", "best guess is the roll axis").
# The mounting of a sensor is a MEASUREMENT, not a decision, so it now lives in a
# JSON file that the #/imu console surface writes over the normal command channel.
# Nothing here needs a restart, and every change is reversible from the browser.
#
# The pipeline, in order (each stage is separately defeatable):
#   raw -> [align | remap] -> (x) offset -> tare (x) . -> gain -> flip -> displayed
#     align   world-frame quat solved by the 4-tap functional calibration; when
#             set it REPLACES remap (it is the measured answer, not a guess).
#     remap   signed permutation of the quaternion's vector part. For 90-degree
#             axis swaps this is an EXACT frame change (w unchanged). Each entry
#             = (sign, source axis) building the new x,y,z; identity = raw frame.
#     offset  fixed body-frame RIGHT multiply. A conjugation cannot move the rest
#             pose (it preserves identity), so a sensor mounted upside down needs
#             this separate constant factor. It commutes through the incremental
#             world rotation, so it re-seats home WITHOUT disturbing tracking.
#     tare    the held pose captured as identity (see IMU_TARE_* below).
#     gain    display sensitivity; 1.0 = 1:1.
#     flip    reverse the SENSE of rotation about one display axis (handedness).
IMU_KEYS = ("hand", "forearm", "thumb")
AXES = ("x", "y", "z")

# Bench-measured starting point. `hand` and `forearm` are the values that were
# hand-calibrated over 24 candidate permutations and proven on the rig; `thumb`
# is identity because the tip mount has never been calibrated (the tare still
# seats its rest pose meanwhile). These are DEFAULTS: the JSON file wins.
IMU_CFG_DEFAULT = {
    "hand":    {"remap": [[-1, "x"], [-1, "z"], [-1, "y"]],   # calibrated #8/24
                "offset": [1.0, 0.0, 0.0, 0.0], "flip": None, "gain": 1.0, "align": None},
    "forearm": {"remap": [[1, "y"], [1, "z"], [1, "x"]],      # calibrated #13/24
                "offset": [1.0, 0.0, 0.0, 0.0], "flip": None, "gain": 1.0, "align": None},
    "thumb":   {"remap": [[1, "x"], [1, "y"], [1, "z"]],      # identity, uncalibrated
                "offset": [1.0, 0.0, 0.0, 0.0], "flip": None, "gain": 1.0, "align": None},
}
IMU_CFG = copy.deepcopy(IMU_CFG_DEFAULT)
_IMU_CFG_FILE = os.path.join(STATE_DIR, ".takto_imu_cfg.json")


def remap_quat(q, cfg):
    """Signed axis permutation of a quaternion's vector part. `cfg` is three
    (sign, source-axis) pairs; tuples and lists are both accepted so the JSON
    round-trip (which turns tuples into lists) needs no conversion step."""
    w, x, y, z = q
    v = {"x": x, "y": y, "z": z}
    return [w] + [s * v[a] for (s, a) in cfg]


# parity of each axis permutation, for the determinant test in _valid_remap
_PERM_EVEN = {
    ("x", "y", "z"): True,  ("y", "z", "x"): True,  ("z", "x", "y"): True,
    ("x", "z", "y"): False, ("y", "x", "z"): False, ("z", "y", "x"): False,
}


def _valid_remap(r):
    """A remap must be a genuine signed permutation AND a proper ROTATION.

    Two separate checks, both learned the hard way:
      1. three entries, signs in {-1,+1}, each of x/y/z used exactly once. A
         repeated or missing axis is not a frame change at all - it collapses a
         dimension - and a silently-degenerate remap costs a bench afternoon.
      2. determinant +1. Of the 48 signed permutations exactly half are
         reflections (det -1), and no physical mounting can mirror a sensor.
         Accepting one produces a frame that tracks BACKWARDS about an axis,
         which presents as the "real clockwise showed counterclockwise" symptom
         and gets misdiagnosed as a sign-flip problem. Refuse them here so the
         mistake cannot be made from any client."""
    if not isinstance(r, (list, tuple)) or len(r) != 3:
        return False
    seen = set()
    sign_prod = 1
    axes = []
    for e in r:
        if not isinstance(e, (list, tuple)) or len(e) != 2:
            return False
        s, a = e
        if s not in (-1, 1, -1.0, 1.0) or a not in AXES or a in seen:
            return False
        seen.add(a)
        axes.append(a)
        sign_prod *= int(s)
    det = sign_prod * (1 if _PERM_EVEN[tuple(axes)] else -1)
    return det == 1


def _valid_quat(q):
    if not isinstance(q, (list, tuple)) or len(q) != 4:
        return False
    try:
        n = math.sqrt(sum(float(v) * float(v) for v in q))
    except (TypeError, ValueError):
        return False
    return 0.5 < n < 1.5          # loose: normalized on the way in


def _norm_quat(q):
    n = math.sqrt(sum(float(v) * float(v) for v in q)) or 1.0
    return [float(v) / n for v in q]


# Anatomical/mechanical wrist envelope. Flexion/extension and radial/ulnar
# deviation are the two wrist freedoms; pronation/supination is carried by the
# proximal rotating interface. These are pose limits, not collision detection.
WRIST_FLEX_LIMIT_DEG = 70.0
WRIST_DEV_LIMIT_DEG = 20.0
WRIST_PRON_LIMIT_DEG = 90.0


def _quat_from_rpy_rad(roll, pitch, yaw):
    """Intrinsic Z-Y-X Euler -> unit [w,x,y,z], radians."""
    cr, sr = math.cos(roll * 0.5), math.sin(roll * 0.5)
    cp, sp = math.cos(pitch * 0.5), math.sin(pitch * 0.5)
    cy, sy = math.cos(yaw * 0.5), math.sin(yaw * 0.5)
    return _norm_quat([
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    ])


def constrain_wrist_quat(q):
    """Project a tared hand-in-forearm pose onto the physical wrist ROM.

    Returns (q_safe, [flexion, deviation, pronation] degrees, limited). The
    original corrected measurement remains available to clients as raw_quat;
    only the pose used by the digital twin is projected.
    """
    w, x, y, z = _norm_quat(q)
    roll = math.atan2(2.0 * (w * x + y * z),
                      1.0 - 2.0 * (x * x + y * y))
    pitch = math.asin(max(-1.0, min(1.0, 2.0 * (w * y - z * x))))
    yaw = math.atan2(2.0 * (w * z + x * y),
                     1.0 - 2.0 * (y * y + z * z))

    flex_lim = math.radians(WRIST_FLEX_LIMIT_DEG)
    dev_lim = math.radians(WRIST_DEV_LIMIT_DEG)
    pron_lim = math.radians(WRIST_PRON_LIMIT_DEG)
    roll0, pitch0, yaw0 = roll, pitch, yaw

    # A coupled ellipse removes the non-biological corner of an independent
    # +/-70 by +/-20 degree box while preserving the direction of motion.
    radius = math.hypot(roll / flex_lim, pitch / dev_lim)
    if radius > 1.0:
        roll /= radius
        pitch /= radius
    yaw = max(-pron_lim, min(pron_lim, yaw))
    limited = max(abs(roll - roll0), abs(pitch - pitch0), abs(yaw - yaw0)) > 1e-8
    return (_quat_from_rpy_rad(roll, pitch, yaw),
            [round(math.degrees(roll), 2), round(math.degrees(pitch), 2),
             round(math.degrees(yaw), 2)], limited)


def imu_cfg_validate(key, patch):
    """Validate one IMU's patch. Returns (clean_patch, error_or_None). Partial
    patches are the norm: the console sends only the field the user touched."""
    if key not in IMU_KEYS:
        return None, f"unknown imu {key!r} (expected one of {', '.join(IMU_KEYS)})"
    if not isinstance(patch, dict):
        return None, "patch must be an object"
    out = {}
    for k, v in patch.items():
        if k == "remap":
            if not _valid_remap(v):
                return None, ("remap must be 3 (sign, axis) pairs using x/y/z exactly once "
                              "and form a rotation (determinant +1, not a mirror)")
            out["remap"] = [[int(s), a] for (s, a) in v]
        elif k in ("offset", "align"):
            if v is None:
                out[k] = None
            elif not _valid_quat(v):
                return None, f"{k} must be a unit quaternion [w,x,y,z]"
            else:
                out[k] = _norm_quat(v)
        elif k == "flip":
            if v not in (None, "x", "y", "z"):
                return None, "flip must be null or one of x/y/z"
            out["flip"] = v
        elif k == "gain":
            try:
                g = float(v)
            except (TypeError, ValueError):
                return None, "gain must be a number"
            if not 0.0 <= g <= 2.0:
                return None, "gain must be between 0 and 2"
            out["gain"] = g
        else:
            return None, f"unknown field {k!r}"
    return out, None


def imu_cfg_load():
    """Load the persisted mounting config over the defaults. A missing file is
    the normal first-run case (defaults are the bench-proven values). A corrupt
    one is quarantined, not silently ignored, and we fall back to defaults so a
    bad file can never leave the rig with no orientation at all.

    Migration: the forearm's functional alignment used to live in its own file
    (_ALIGN_FILE). If that exists and the new config has no forearm align, it is
    folded in, so an existing bench calibration is not lost on upgrade."""
    global IMU_CFG
    IMU_CFG = copy.deepcopy(IMU_CFG_DEFAULT)
    try:
        with open(_IMU_CFG_FILE) as f:
            d = json.load(f)
        if not isinstance(d, dict):
            raise ValueError("config root is not an object")
        for key in IMU_KEYS:
            clean, err = imu_cfg_validate(key, d.get(key) or {})
            if err:
                raise ValueError(f"{key}: {err}")
            IMU_CFG[key].update(clean)
        print(f"[imu] mounting config loaded from {_IMU_CFG_FILE}")
    except FileNotFoundError:
        pass
    except Exception as e:
        _quarantine_corrupt(_IMU_CFG_FILE, e, "imu")
        IMU_CFG = copy.deepcopy(IMU_CFG_DEFAULT)
    # fold in a pre-existing forearm alignment from the old single-purpose file
    if IMU_CFG["forearm"].get("align") is None:
        try:
            with open(os.path.join(STATE_DIR, ".sensoryhand_imu_align.json")) as f:
                old = json.load(f)
            if _valid_quat(old.get("forearm_align")):
                IMU_CFG["forearm"]["align"] = _norm_quat(old["forearm_align"])
                print("[imu] migrated forearm alignment from the legacy align file")
        except Exception:
            pass


def imu_cfg_save():
    _write_json_atomic(_IMU_CFG_FILE, IMU_CFG)


def imu_cfg_apply(q_raw, key):
    """Stage 1+2 of the pipeline: frame correction then rest-pose offset.
    `align` wins over `remap` when present - it is the measured answer from the
    4-tap calibration, whereas remap is a chosen permutation."""
    c = IMU_CFG.get(key) or IMU_CFG_DEFAULT[key]
    if c.get("align"):
        # Alignment changes the coordinate frame of the measured rotation, so
        # it is M q M^-1. The old left multiply disappeared at the tare stage:
        # conj(M q0) (M q1) == conj(q0) q1, making a "solved" calibration have
        # no effect on tracking axes.
        m = c["align"]
        q = quat_mul(quat_mul(m, q_raw), quat_conj(m))
    else:
        q = remap_quat(q_raw, c["remap"])
    off = c.get("offset")
    if off and off != [1.0, 0.0, 0.0, 0.0]:
        q = quat_mul(q, off)
    return q


# BENCH NOTES kept from the era when the offsets were source constants. They are
# now IMU_CFG[*]["offset"] and are set from the #/imu console surface, but the
# measurements are worth keeping because they say what "correct" looked like:
#
# HAND: measured rest yaw ~-176 deg, i.e. the BNO085 sits ~180 deg about Z from
# the display frame. An offset was written for it but deliberately NOT applied -
# the hand's display was already correct, so applying it would have rotated a
# working frame for no reason. If you ever do apply it, re-check on the bench.
#
# FOREARM (2026-08-06, after a remount): with an identity offset the REST attitude
# measured roll +174.3 deg, i.e. the twin rendered upside down - exactly the
# "the bottom is pointing up" report. The four candidates measured:
#     identity   roll 174.3  pitch  22.8  yaw 176.2   <- inverted
#     180 X      roll  -5.7  pitch  22.8  yaw 176.2   <- upright but facing backwards
#     180 Y      roll   5.7  pitch -22.8  yaw  -3.8   <- upright AND forward
#     180 Z      roll -174.3 pitch -22.8  yaw  -3.8   <- still inverted
# Note this is deliberately NOT fixed by rotating the twin mesh: forearmGroup's
# quaternion is overwritten from the IMU every frame, so a mesh rotation would
# fight the sensor and break again the moment the arm moved. A body-frame right
# multiply re-seats the rest pose and leaves the tracking intact.
#
# The console's offset buttons emit exactly these four candidates, so this
# experiment is now four clicks instead of four edit-restart-retare cycles.
IMU_OFFSET_PRESETS = {
    "identity": [1.0, 0.0, 0.0, 0.0],
    "180x":     [0.0, 1.0, 0.0, 0.0],
    "180y":     [0.0, 0.0, 1.0, 0.0],
    "180z":     [0.0, 0.0, 0.0, 1.0],
}

def quat_mul(a, b):
    """Hamilton product a (x) b, quaternions as [w, x, y, z]."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ]


def quat_conj(q):
    """Inverse of a unit quaternion [w,x,y,z] (its conjugate)."""
    return [q[0], -q[1], -q[2], -q[3]]


def quat_gain(q, g):
    """Scale a rotation's ANGLE about its own axis by g (slerp identity->q by g). g=1 keeps
    it 1:1; g<1 de-exaggerates, so a real hand rotation moves the twin proportionally less.
    Canonicalized to the short way so a small motion stays small."""
    if g >= 0.999:
        return list(q)
    w, x, y, z = q
    if w < 0.0:                       # short way (quaternion double cover)
        w, x, y, z = -w, -x, -y, -z
    if w > 1.0:
        w = 1.0
    half = math.acos(w)               # theta/2 in [0, pi/2]
    s = math.sin(half)
    if s < 1e-6:
        return [1.0, 0.0, 0.0, 0.0]
    k = math.sin(half * g) / s
    return [math.cos(half * g), x * k, y * k, z * k]


def quat_flip_sense(q, ax):
    """Reverse the DIRECTION of rotation about ONE display axis (negate that quaternion
    vector component) - fixes a single-axis handedness mismatch where a real clockwise
    rotation showed as counterclockwise. ax in {'x','y','z'} or None. Rotation about the
    other two axes and the home pose (identity) are unaffected."""
    if not ax:
        return list(q)
    i = {"x": 1, "y": 2, "z": 3}[ax]
    out = list(q)
    out[i] = -out[i]
    return out


# ---- IMU tare: capture the pose the user is holding as the "straight" reference -
# displayed = tare (x) remap(raw), tare = conj(remap(raw)) captured at the tare moment.
# That makes the held pose render as IDENTITY: forearm straight, hand in line with it
# (no collision). Supersedes the fixed offset above; auto-taken once both IMUs are live,
# re-triggerable with {cmd:calibrate, what:imu} while holding the correct pose.
IMU_TARE_HAND = [1.0, 0.0, 0.0, 0.0]
IMU_TARE_FOREARM = [1.0, 0.0, 0.0, 0.0]
IMU_TARE_THUMB = [1.0, 0.0, 0.0, 0.0]
_imu_tare_pending = True
_thumb_tare_pending = True     # thumb can join later than the main pair (hot-plug)

# Display sensitivity and rotation-sense are now IMU_CFG[*]["gain"] / ["flip"]:
#   gain  the shown rotation scaled to this fraction of the real one, applied
#         AFTER the tare so home stays home. 1.0 = 1:1.
#   flip  reverse the SENSE of rotation about one display axis ("x" = roll,
#         "y" = pitch, "z" = yaw, None = off) - the fix for a handedness
#         mismatch where a real clockwise rotation showed counterclockwise.
#         Recorded outcome: flipping the forearm made it rotate OPPOSITE to the
#         hand, so it was reverted. Left at None by default for that reason.

# ============================================================================
#  THE v7 S-LINE TAIL: the full IMU set
# ============================================================================
# Firmware v7 (2026-08-06) appends every report the BNO085 fuses, because the rig
# had been enabling the rotation vector alone and discarding the rest. Layout per
# sensor, in the order hand, forearm, thumb:
#     lin  x,y,z    linear acceleration, m/s^2, GRAVITY ALREADY REMOVED
#     acc  x,y,z    accelerometer, m/s^2, gravity included
#     gyr  x,y,z    rad/s
#     mag  x,y,z    uT
#     grv  x,y,z    gravity vector, m/s^2
#     game w,x,y,z  game rotation vector (magnetometer-immune)
#     ca,cg,cm      calibration accuracy 0..3 (accel, gyro, mag)
#     rotacc        rotation-vector heading accuracy, rad
V7_STRIDE = 23                     # fields per sensor
# where the tail starts: tag + t + encoders + 2 quats + 2 live + 3 emg + crown
#                        + thumb quat + thumb live + motorFlags + motors + crownPresent
V7_BASE = (1 + 1 + N_CH + 8 + 2 + 3 + 1 + 4 + 1 + 1 + 2 * 3 + 1)
MOTOR_DIAG_BASE = V7_BASE + 3 * V7_STRIDE
# v14 appends ONE byte after the 8 v9 diagnostics: the device's own view of the
# SEA / camera-follow prerequisites. Before it existed the bridge could only
# report whether it had SENT an arm sequence, never whether the firmware
# accepted one, so a refused arm and a successful arm looked identical.
SEA_STATE_IDX = MOTOR_DIAG_BASE + 8

# The motor block the firmware has emitted since v6. Until 2026-08-11 the bridge
# parsed straight past it, which is why the console could only ever show
# SIMULATED motors: the real ones were on the wire the whole time. Offsets are
# built from the SAME contract terms as V7_BASE so adding an encoder channel
# upstream can never silently shift them onto an IMU field.
N_MOT_FW = 2
MOT_FLAGS_IDX = (1 + 1 + N_CH + 8 + 2 + 3 + 1 + 4 + 1)      # mflags
MOT_BASE = MOT_FLAGS_IDX + 1                                # pos,vel,mA per motor
CROWN_LIVE_IDX = MOT_BASE + 3 * N_MOT_FW

# The physical rig measures magnetic fields orders of magnitude above Earth's
# field, and a live bench capture showed the forearm 0x05 rotation vector
# changing only 11 times in 149 firmware frames while its 0x08 game vector
# changed 94 times.  Prefer the already-streamed magnet-independent quaternion.
# Firmware is also configured to make 0x08 its primary source; this host-side
# selection keeps deployed v7 devices correct before they are reflashed.
IMU_ORIENTATION_SOURCE = "game"


def _unit_quat_or_none(q):
    """Validate and normalize a streamed w,x,y,z quaternion."""
    if not isinstance(q, (list, tuple)) or len(q) != 4:
        return None
    try:
        v = [float(x) for x in q]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(x) for x in v):
        return None
    n2 = sum(x * x for x in v)
    if n2 < 0.25 or n2 > 2.25:
        return None
    n = math.sqrt(n2)
    return [x / n for x in v]


def select_orientation_quats(hq, fq, tq, imu_full, live_by_key):
    """Choose the pose stream used by tracking and the relative wrist.

    All three returned quaternions come from one firmware frame.  v7 has no
    per-report timestamps, so the bridge deliberately does not interpolate or
    fabricate sub-frame timing.  The firmware-side 0x08 selection makes its
    live watchdog follow this same source after reflash.
    """
    # A firmware live flag is necessary but not sufficient: immediately after
    # boot (and when a BNO085 drops off its bus) the fixed-width serial frame
    # still contains that sensor's zero-initialised quaternion.  Passing
    # [0,0,0,0] downstream is especially destructive: it is not a rotation, yet
    # a delta-angle display reads it as 180 degrees on every 20 ms sample
    # (~9000 deg/s), and three.js can no longer preserve the rigid wrist chain.
    # Normalize the primary stream here and use None as the explicit
    # unavailable value.  The serial owner then holds the last valid pose while
    # dropping the live flag, so bad data can never drive the twin.
    primary = {"hand": hq, "forearm": fq, "thumb": tq}
    selected = {}
    source = {}
    for key in IMU_KEYS:
        q = _unit_quat_or_none(primary.get(key)) if live_by_key.get(key, False) else None
        selected[key] = q
        source[key] = "rotation_vector" if q is not None else "unavailable"
    if IMU_ORIENTATION_SOURCE == "game" and isinstance(imu_full, dict):
        for key in IMU_KEYS:
            if not live_by_key.get(key, False):
                continue
            q = _unit_quat_or_none((imu_full.get(key) or {}).get("game"))
            if q is not None:
                selected[key] = q
                source[key] = "game"
    return selected["hand"], selected["forearm"], selected["thumb"], source

# Wrist-pivot kinematics for the relative pose (mm, twin model frame at the
# tared neutral: +Z distal toward the fingers, +Y dorsal/up, +X thumb side).
# Measured off the physical rig (photos 2026-07-07): forearm module centre to
# the wrist axis ~95 mm; wrist axis to the dorsal hand plate (hand IMU) ~55 mm
# distal, ~10 mm above the axis. Centimetre accuracy is plenty for the twin.
REL_F2W_MM = [0.0, 8.0, 95.0]     # forearm IMU -> wrist pivot (forearm frame)
REL_W2H_MM = [0.0, 10.0, 55.0]    # wrist pivot -> hand IMU (hand frame)
_rel_prev = {"p": None, "dist": None, "t": None, "speed": 0.0, "appr": 0.0}
_rel_quat_hold = [1.0, 0.0, 0.0, 0.0]  # last pose measured with BOTH main IMUs live


# ============================================================================
#  INERTIAL DEAD RECKONING  (position from linear acceleration)
# ============================================================================
# READ THIS BEFORE TRUSTING A NUMBER OUT OF HERE.
#
# Double-integrating acceleration is not a position sensor. Any constant bias b
# in the acceleration becomes a position error of b*t^2/2, so it GROWS WITHOUT
# BOUND and it grows quadratically. The BNO085's linear-acceleration output has a
# residual bias of order 0.01-0.05 m/s^2 once fused and warm, which is
#     0.02 m/s^2  ->  1 cm after 1 s,  25 cm after 5 s,  1 m after 10 s
# and noise integrates on top of that as a random walk. There is no filter that
# removes this, because the accelerometer genuinely cannot tell a small constant
# acceleration from a small tilt error against gravity.
#
# So this class does the two things that actually help, and reports how much it
# had to do them:
#   1. ZUPT (zero-velocity update). When the sensor is demonstrably still - small
#      linear acceleration AND small angular rate for a sustained window - the
#      true velocity is zero, so we set it to zero instead of letting the bias
#      integrate. This bounds the error to whatever accumulates BETWEEN stops,
#      which for hand motion (frequent pauses) is the difference between usable
#      and useless. It also re-estimates the bias from the stationary window.
#   2. A velocity leak. Between stops, velocity decays gently toward zero. This
#      is a lie in the physics but a useful one: it trades a small lag on genuine
#      sustained motion for a large reduction in runaway.
#
# What comes out is honest RELATIVE displacement over a few seconds of motion,
# and `confidence` + `since_zupt_s` say how far from a known-zero the estimate
# has travelled. The UI shows those next to the number, and it re-zeroes on every
# stop. For ABSOLUTE hand-vs-forearm geometry the kinematic chain (REL_F2W_MM +
# REL_W2H_MM rotated by the joint angles) is strictly better and always will be:
# it has no drift at all. This exists to measure what the kinematic chain cannot,
# which is free translation of the whole arm through space.
# These four are TUNED, not guessed - first in simulation, then CORRECTED on the
# real rig, which is the version that matters.
#
# Simulation (0.02 m/s^2 bias, 0.01 m/s^2 noise) picked 0.05 and scored a 180 mm
# out-and-back reach at 179.9 / 180.3 / 209.1 mm for brisk / medium / slow, with
# 0.12 mm of drift over a 10 s standstill (951 mm with ZUPT off).
#
# THE BENCH DISAGREED. Measured on the actual hardware, 600 samples per sensor
# with the rig sitting still (2026-08-06):
#     hand     |lin acc| mean 0.026  p95 0.051  p99 0.054  max 0.066 m/s^2
#     forearm  |lin acc| mean 0.030  p95 0.047  p99 0.054  max 0.066 m/s^2
# i.e. the real sensor's resting noise REACHES the 0.05 threshold. Only 95 % of
# resting samples fell below it, so the continuous-quiet hold kept breaking, ZUPT
# almost never armed, and the hand integrated 3.8 METRES in 26 s while motionless.
# The threshold has to clear the measured noise floor with margin: at 0.08 every
# resting sample is quiet (100 %, against a measured max of 0.066).
#
# The cost is honest and known: 0.08 keeps brisk and medium moves at 179.9 and
# 180.3 mm, and degrades the 3 s slow move to ~110 mm. That is the right trade -
# a ZUPT that never fires makes every reading worthless, whereas a slow-move
# under-read is a documented limit.
#
# THE FLOOR, stated plainly: a sustained acceleration smaller than the sensor's
# own resting noise cannot be separated from it by any amount of filtering. Below
# ~0.08 m/s^2 - a 180 mm move taken slower than about 3 s - the estimate degrades.
# Move deliberately if you want the number to mean something, and re-zero often.
ZUPT_ACC_THRESH   = 0.08     # m/s^2, |linear accel| below this looks stationary
ZUPT_GYR_THRESH   = 0.06     # rad/s, ~3.4 deg/s
ZUPT_HOLD_S       = 0.10     # must stay quiet this long before we believe it
VEL_LEAK_PER_S    = 0.98     # velocity retained per second of free integration
BIAS_LEARN_RATE   = 0.02     # how fast a stationary window pulls the bias estimate


class InertialTracker:
    """Per-sensor strapdown integrator with ZUPT. Positions are in METRES in the
    sensor's own world frame (the frame its fused quaternion refers to)."""

    def __init__(self, name):
        self.name = name
        self.reset()

    def reset(self, keep_bias=False):
        """Re-zero the position. `keep_bias` retains the learned accelerometer
        bias, which is a property of the SENSOR and takes a while to converge -
        throwing it away on every re-zero would make the first seconds after a
        zero the worst-behaved ones."""
        bias = list(self.bias) if keep_bias and hasattr(self, "bias") else [0.0, 0.0, 0.0]
        self.p = [0.0, 0.0, 0.0]
        self.v = [0.0, 0.0, 0.0]
        self.bias = bias
        self.t = None
        self.still = False
        self._quiet_since = None
        self.last_zupt = None
        self.zupts = 0
        self.zero_t = None          # firmware clock at the last re-zero

    def update(self, q, lin, gyr, now):
        """One sample. q = fused quaternion, lin = body-frame linear acceleration
        (m/s^2, gravity removed), gyr = body-frame angular rate (rad/s)."""
        if self.t is None:
            self.t = now
            if self.zero_t is None:
                self.zero_t = now
            return
        dt = now - self.t
        self.t = now
        # A stalled or hiccupping link must not integrate a huge dt: that single
        # step would throw the position metres away and never come back.
        if dt <= 0.0 or dt > 0.25:
            return

        a_mag = math.sqrt(sum(c * c for c in lin))
        g_mag = math.sqrt(sum(c * c for c in gyr))
        quiet = a_mag < ZUPT_ACC_THRESH and g_mag < ZUPT_GYR_THRESH
        if quiet:
            if self._quiet_since is None:
                self._quiet_since = now
            elif now - self._quiet_since >= ZUPT_HOLD_S:
                # believed stationary: velocity is zero by definition, and the
                # acceleration we are still reading is bias, so learn from it.
                if not self.still:
                    self.zupts += 1
                self.still = True
                self.last_zupt = now
                self.v = [0.0, 0.0, 0.0]
                for i in range(3):
                    self.bias[i] += (lin[i] - self.bias[i]) * BIAS_LEARN_RATE
        else:
            self._quiet_since = None
            self.still = False

        if self.still:
            return                      # frozen: do not integrate noise while parked

        # de-bias in the body frame, then rotate into the sensor's world frame
        corrected = [lin[i] - self.bias[i] for i in range(3)]
        a_world = quat_rot_vec(q, corrected)
        leak = VEL_LEAK_PER_S ** dt
        for i in range(3):
            self.v[i] = (self.v[i] + a_world[i] * dt) * leak
            self.p[i] += self.v[i] * dt

    # NOTE ON CLOCKS: everything in this class runs on the FIRMWARE's millisecond
    # clock, which is what update() is fed. The elapsed-time helpers below
    # therefore measure against self.t (the last sample) and take no argument.
    # They used to accept a `now` that callers filled with host wall time, which
    # silently subtracted a firmware timestamp from a unix timestamp and reported
    # a "time since standstill" of about 56 years.
    def since_zupt(self):
        if self.last_zupt is None or self.t is None:
            return None
        return max(0.0, self.t - self.last_zupt)

    def confidence(self):
        """0..1, and deliberately pessimistic. Full confidence only at a
        confirmed standstill; it decays over the first 3 s of free integration
        because that is roughly where the quadratic bias term stops being small."""
        if self.still:
            return 1.0
        s = self.since_zupt()
        if s is None:
            return 0.0                  # never seen a standstill: unreferenced
        return max(0.0, 1.0 - s / 3.0)

    def since_zero(self):
        if self.zero_t is None or self.t is None:
            return None
        return max(0.0, self.t - self.zero_t)

    def snapshot(self):
        s = self.since_zupt()
        z = self.since_zero()
        return {
            "pos_mm":  [round(c * 1000.0, 1) for c in self.p],
            "vel_mm_s": [round(c * 1000.0, 1) for c in self.v],
            "bias": [round(c, 4) for c in self.bias],
            "still": self.still,
            "since_zupt_s": None if s is None else round(s, 2),
            # Time integrating since the last re-zero. This is the number that
            # actually bounds how much you can trust `pos_mm`: ZUPT stops the
            # VELOCITY running away, but position error still accumulates across
            # every moving stretch and never comes back. On the bench a rig left
            # alone for a few minutes read ~90 mm of "displacement" while sitting
            # perfectly still, with a time-since-standstill confidence of 0.99 -
            # which is why that confidence alone was not an honest summary.
            "since_zero_s": None if z is None else round(z, 1),
            "confidence": round(self.confidence(), 2),
            "zupts": self.zupts,
        }


TRACKERS = {k: InertialTracker(k) for k in IMU_KEYS}



def trigger_imu_tare():
    global _imu_tare_pending, _thumb_tare_pending
    _imu_tare_pending = True
    _thumb_tare_pending = True


# ============================================================================
# IMU AXIS ALIGNMENT - the permanent fix for the mirrored forearm.
#
# The two BNO085s are MOUNTED in different orientations (hand: flat on the
# dorsal plate; forearm: vertical on a standoff), so the same physical motion
# used to appear about different, sometimes opposite, twin axes. Hand-tuned
# sign flips cannot fix this reliably (see IMU_FLIP notes above: every guess
# broke another axis). Instead, a 3-step FUNCTIONAL calibration measures the
# same rigid motions with both sensors (wrist held stiff so hand + forearm
# move as one body) and solves the fixed rotation M that maps the forearm's
# world axes onto the hand's display world axes (a two-vector Wahba problem,
# solved by triad construction):
#     base  -> hold neutral (arm straight, palm down), capture rest quats
#     pitch -> whole arm pitched UP 45..90 deg, wrist stiff, hold, capture
#     yaw   -> back near neutral, then whole arm yawed 45..90 deg, hold, capture
#     home  -> back at neutral: re-tare (the usual home capture)
# M persists across restarts (in IMU_CFG[target]["align"]) and is applied as a
# world-frame left-multiply on the raw quat, REPLACING that sensor's remap table.
# Re-run the 4 taps after any remount. Driven over the normal WS command channel:
#     {cmd:"calibrate", what:"imu_align", imu:"forearm"|"thumb",
#      step:"base"|"pitch"|"yaw"|"home"|"reset"}
# The `imu` field is new (2026-08-06): the routine used to be forearm-only, which
# left the thumb with no way to be calibrated at all. UI: the #/imu console surface.
# ============================================================================
_align = {}                       # in-progress capture state


def _vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _vcross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _vnorm(v):
    n = math.sqrt(_vdot(v, v))
    return [x / n for x in v] if n > 1e-9 else None


def quat_rot_vec(q, v):
    """Rotate vector v by unit quaternion q=[w,x,y,z]."""
    w, x, y, z = q
    # t = 2 * (q_vec x v); v' = v + w*t + q_vec x t
    t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])]
    return [
        v[0] + w * t[0] + y * t[2] - z * t[1],
        v[1] + w * t[1] + z * t[0] - x * t[2],
        v[2] + w * t[2] + x * t[1] - y * t[0],
    ]


def _delta_axis(q_now, q_base):
    """World-frame rotation q_now (x) q_base^-1 -> (unit axis, angle_deg)."""
    dq = quat_mul(q_now, quat_conj(q_base))
    w = max(-1.0, min(1.0, dq[0]))
    if w < 0:                                   # short way
        dq = [-c for c in dq]
        w = -w
    ang = 2.0 * math.degrees(math.acos(w))
    ax = _vnorm(dq[1:])
    return ax, ang


def _mat_to_quat(m):
    """3x3 rotation (rows) -> quaternion [w,x,y,z]."""
    tr = m[0][0] + m[1][1] + m[2][2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        return [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]
    i = max(range(3), key=lambda k: m[k][k])
    j, k = (i + 1) % 3, (i + 2) % 3
    s = math.sqrt(max(1e-12, 1.0 + m[i][i] - m[j][j] - m[k][k])) * 2
    q = [0.0, 0.0, 0.0, 0.0]
    q[0] = (m[k][j] - m[j][k]) / s
    q[1 + i] = 0.25 * s
    q[1 + j] = (m[j][i] + m[i][j]) / s
    q[1 + k] = (m[k][i] + m[i][k]) / s
    return q


def _solve_align(a1, a2, b1, b2):
    """Proper rotation M with M a_i ~= b_i (triad method). Returns (quat, residual_deg)."""
    def triad(u1, u2):
        e1 = _vnorm(u1)
        e2 = _vnorm([u2[i] - _vdot(u2, e1) * e1[i] for i in range(3)])
        return e1, e2, _vcross(e1, e2)
    A = triad(a1, a2)
    B = triad(b1, b2)
    # M = sum_i b_i a_i^T  (columns A -> columns B), rows of M:
    m = [[sum(B[c][r] * A[c][s] for c in range(3)) for s in range(3)] for r in range(3)]
    q = _vnorm4(_mat_to_quat(m))
    res = math.degrees(math.acos(max(-1.0, min(1.0, _vdot(_vnorm(quat_rot_vec(q, a2)), _vnorm(b2))))))
    return q, res


def _vnorm4(q):
    n = math.sqrt(sum(c * c for c in q))
    return [c / n for c in q] if n > 1e-9 else [1.0, 0.0, 0.0, 0.0]


def imu_align_step(step, target="forearm"):
    """Advance the functional axis calibration; returns a dict for the ack.

    `target` is the IMU being solved FOR; the hand is the reference frame, so
    calibrating the hand against itself is refused. This used to be hardwired to
    the forearm - the thumb had no way to be calibrated at all and sat on an
    identity remap, which is the reason its mounting was never resolved."""
    if target not in IMU_KEYS:
        return {"step": step, "ok": False, "err": f"unknown imu {target!r}"}
    if target == "hand":
        return {"step": step, "ok": False,
                "err": "the hand IS the reference frame; calibrate forearm or thumb against it"}
    idx = {"forearm": 1, "thumb": 2}[target]
    with state_lock:
        hq_raw = list(state["hq"])
        tq_raw = list(state["fq"]) if target == "forearm" else list(state.get("tq") or [1, 0, 0, 0])
        live = list(state["imu_live"])
        t_live = live[1] if target == "forearm" else bool(state.get("thumb_live"))
    if not (live[0] and t_live):
        return {"step": step, "ok": False, "err": f"the hand and the {target} must both be live"}
    # the hand's proven display frame is the target both other sensors align to
    h_disp = imu_cfg_apply(hq_raw, "hand")
    if step == "reset":
        IMU_CFG[target]["align"] = None
        imu_cfg_save()
        _align.clear()
        return {"step": step, "ok": True, "imu": target}
    if step == "base":
        _align.clear()
        _align["imu"] = target
        _align["hb"] = h_disp; _align["fb"] = tq_raw
        return {"step": step, "ok": True, "imu": target}
    if step in ("pitch", "yaw"):
        if "hb" not in _align:
            return {"step": step, "ok": False, "err": "press base first"}
        if _align.get("imu") != target:
            return {"step": step, "ok": False,
                    "err": f"this run was started for the {_align.get('imu')}; press base again"}
        b, hang = _delta_axis(h_disp, _align["hb"])
        a, fang = _delta_axis(tq_raw, _align["fb"])
        if b is None or a is None or min(hang, fang) < 20.0:
            return {"step": step, "ok": False, "angle_deg": round(min(hang, fang), 1),
                    "err": "rotate further (>=20 deg) and hold"}
        if step == "pitch":
            _align["b1"], _align["a1"] = b, a
            return {"step": step, "ok": True, "angle_deg": round(hang, 1)}
        if "b1" not in _align:
            return {"step": step, "ok": False, "err": "do the pitch step first"}
        if abs(_vdot(b, _align["b1"])) > 0.85:
            return {"step": step, "ok": False, "err": "too parallel to the pitch motion; yaw sideways"}
        q, res = _solve_align(_align["a1"], a, _align["b1"], b)
        IMU_CFG[target]["align"] = q
        try:
            imu_cfg_save()
        except Exception as e:
            print("[imu] could not save alignment:", e)
        print(f"[imu] {target} axis alignment solved (residual {res:.1f} deg)")
        return {"step": step, "ok": True, "imu": target,
                "angle_deg": round(hang, 1), "residual_deg": round(res, 1)}
    if step == "home":
        trigger_imu_tare()
        return {"step": step, "ok": True}
    return {"step": step, "ok": False, "err": "unknown step"}


imu_cfg_load()


# Persist the captured home so it survives bridge restarts (no re-posing every time).
_TARE_FILE = os.path.join(STATE_DIR, ".sensoryhand_imu_tare.json")

def _cfg_signature():
    """A short fingerprint of the mounting configuration a tare was captured
    under. The tare is the INVERSE of a measured pose, so it is only valid for
    the pipeline that produced that pose: change a remap, an offset or an
    alignment and the stored home means nothing."""
    # A tare captured from magnet-fused 0x05 is not a valid home reference for
    # game-vector 0x08 (and vice versa), even when the physical mounting did not
    # change. Include the fusion source so a source change forces a fresh home.
    parts = ["orientation_source=" + IMU_ORIENTATION_SOURCE]
    for k in IMU_KEYS:
        c = IMU_CFG[k]
        parts.append("%s:%s|%s|%s|%.3f|%s" % (
            k, c["remap"], c["offset"], c["flip"], c["gain"],
            "none" if c["align"] is None else [round(v, 4) for v in c["align"]]))
    return ";".join(parts)


def _load_tare():
    """Load the saved home, but ONLY the parts that are still meaningful.

    THE BUG THIS GUARDS (2026-08-06, cost weeks of a distorted twin): the tare
    file recorded three quaternions and nothing else. A home captured on 2026-07-19
    - before the forearm sensor was re-mounted, and while the firmware was looking
    for it at the wrong address so it never reported at all - was reloaded on every
    later start. Its forearm entry was a near-identity placeholder taken against a
    sensor that was not streaming. Loading it also set _imu_tare_pending = False,
    so the bridge never re-tared and the stale reference survived indefinitely.
    The visible symptom was the digital twin: the mock feed (near-identity quats)
    rendered the arm correctly, and the moment real IMUs were connected the
    forearm group took a ~54 deg pitch and the hand a ~176 deg yaw, so the twin
    looked, in the owner's words, distorted and dirty.

    Two records now travel with the tare and both are checked:
      live     which sensors were actually streaming when it was captured. A home
               for a sensor that was not live is not a measurement; it is dropped.
      cfg_sig  the mounting configuration it was captured under. Any change to a
               remap / offset / flip / gain / alignment invalidates it, because
               the tare inverts a pose that pipeline produced.
    Anything dropped leaves that sensor PENDING, so it re-tares on the first
    frame where it is genuinely live instead of silently rendering wrong."""
    global IMU_TARE_HAND, IMU_TARE_FOREARM, IMU_TARE_THUMB
    global _imu_tare_pending, _thumb_tare_pending
    try:
        with open(_TARE_FILE) as f:
            d = json.load(f)
    except FileNotFoundError:
        _imu_tare_pending = True    # no saved home -> auto-tare on the first live frame
        _thumb_tare_pending = True
        return
    except Exception as e:
        _imu_tare_pending = True
        _thumb_tare_pending = True
        _quarantine_corrupt(_TARE_FILE, e, "imu")
        return

    sig = d.get("cfg_sig")
    live = d.get("live") or {}
    # A file written before this guard existed carries neither field. It cannot
    # be shown to be valid, and this is exactly the file that caused the bug, so
    # it is not trusted - re-taring costs one held pose, a wrong home costs days.
    legacy = sig is None and not live
    stale_cfg = (sig is not None and sig != _cfg_signature())

    def take(key, cur):
        if key not in d:
            return cur, True
        if legacy:
            return cur, True
        if stale_cfg:
            return cur, True
        if live and not live.get(key, False):
            return cur, True
        # A tare is a quaternion inverse.  A zero/NaN/non-unit value is not a
        # rotation and annihilates every valid live pose when multiplied below.
        # One pre-fix bridge wrote [0,0,0,0] while the fixed-width firmware
        # fields were empty; trusting that persisted file made both IMUs look
        # live in health while the twin stayed perfectly static.  Treat invalid
        # calibration as missing and capture a fresh home from the next live
        # hand+forearm frame.
        if not _valid_quat(d[key]):
            print(f"[imu] IGNORING invalid saved {key} home (not a unit quaternion); "
                  "re-taring from live data")
            return cur, True
        return _norm_quat(d[key]), False

    IMU_TARE_HAND, pend_h = take("hand", IMU_TARE_HAND)
    IMU_TARE_FOREARM, pend_f = take("forearm", IMU_TARE_FOREARM)
    IMU_TARE_THUMB, _thumb_tare_pending = take("thumb", IMU_TARE_THUMB)
    _imu_tare_pending = pend_h or pend_f

    if legacy:
        why = "no provenance recorded (pre-2026-08-06 file)"
    elif stale_cfg:
        why = "the mounting config changed since it was captured"
    else:
        why = None
    if why:
        print(f"[imu] IGNORING the saved home: {why}. "
              f"Hold the device in its neutral pose - it will re-tare on the next live frame.")
    elif _imu_tare_pending or _thumb_tare_pending:
        dead = [k for k in IMU_KEYS if not live.get(k, False)]
        print(f"[imu] loaded saved home from {_TARE_FILE}; re-taring {', '.join(dead)} "
              f"(not live when the home was captured)")
    else:
        print("[imu] loaded saved home from", _TARE_FILE)


def _save_tare(live_map=None):
    """Persist the home WITH its provenance. `live_map` says which sensors were
    actually streaming at capture; without it we can only record the config."""
    try:
        for key, q in (("hand", IMU_TARE_HAND), ("forearm", IMU_TARE_FOREARM),
                       ("thumb", IMU_TARE_THUMB)):
            # Refuse to persist a calibration that would destroy every pose on
            # the next bridge start.  Non-live sensors keep their previous unit
            # tare and are already marked false in the provenance map.
            if not _valid_quat(q):
                raise ValueError(f"{key} tare is not a unit quaternion")
        payload = {"hand": IMU_TARE_HAND, "forearm": IMU_TARE_FOREARM,
                   "thumb": IMU_TARE_THUMB,
                   "cfg_sig": _cfg_signature(),
                   "when": time.strftime("%Y-%m-%d %H:%M:%S")}
        if live_map is not None:
            payload["live"] = {k: bool(v) for k, v in live_map.items()}
        _write_json_atomic(_TARE_FILE, payload)
    except Exception as e:
        print("[imu] could not save home:", e)

_load_tare()


# ============================================================================
# ECOSYSTEM STATE - one device, one shared session, many clients.
#
# Everything below is the state the three client surfaces (web console, AR,
# Android) must AGREE on. It is mutated only (a) under state_lock from the
# data thread (sample counters) and (b) from the asyncio event-loop thread
# (commands + the broadcast loop), and every mutation is visible to every
# client on the next ~30 Hz snapshot. Acks answer the commanding client only.
# ============================================================================
# Channel-absence convention: the firmware streams raw AS5600 degrees (0..360,
# never negative), so on the LIVE path "deg < 0" means the channel is absent.
# The sim writes signed JOINT-space degrees (abduction is legitimately
# negative), so it marks absence with a distinct sentinel instead.
ENC_ABSENT_SIM = -1000.0


def _enc_ok(d):
    return d > -900.0 if SIM_MODE else d >= 0.0


AR_MODES = ("atelier", "capture", "rhythm", "touch")
# an AR mode change nudges the shared device screen to the matching page
_MODE_NUDGE = {"atelier": "home", "capture": "capture", "rhythm": "operator", "touch": "transparent"}

REC_ROWS_CAP = 120_000          # replay row log ceiling (~33 min at 60 Hz): a
                                # forgotten open-ended recording must not grow
                                # in RAM without bound; the recording itself
                                # keeps running past the cap, uncapped counters

ECO = {
    "mode": "atelier",          # AR experience mode (last writer wins)
    "feedback_on": True,        # TOUCH: wall rendering armed
    "guided": False,            # guided session active (web/Android surface)
    "rep_goal": 20,
    "reps_done": 0,
    "profile": None, "task": None, "notes": None,   # active recording metadata
    "rec_id": None, "rec_start": 0.0, "rec_samples": 0,
    "spark": [],                # effort trace of the active recording (sealed into the take)
    "rows": [],                 # 4D replay sample rows of the active recording
    "rec_env": None,            # environment id the poses referenced (first fresh wins)
    "rows_vision": 0,           # rows whose joints came from the Quest's hand tracking
    "rows_enc": 0,              # rows in which at least one live encoder contributed
    "contacts": [],             # hand-vs-room contact events of the active recording
}

# column layout of a replay row (kept in ONE place; the take_data payload
# carries it so clients never hardcode indices).
# 2026-07-20: +3 THUMB columns appended at the END (34 -> 37): the Quest's own
# hand tracking measures the thumb ([palmar abduction, MCP flexion, IP flexion]
# deg) even though the physical rig is thumb-out. Appending keeps every
# pre-existing index stable; cells are None when no vision thumb was seen.
# 2026-08-06: +7 INERTIAL columns appended at the END (37 -> 44). Until now the
# only source of TRANSLATION in a take was px/py/pz, which come from the Quest's
# vision - so every take recorded without a headset had a hand that rotated but
# never moved through space. Firmware v7 streams linear acceleration, so the
# bridge can integrate a displacement and log it as a second, headset-free
# translation source. It DRIFTS (see InertialTracker), which is why the
# confidence rides along in the row and the replay labels which source it drew.
# Millimetres, to match the rest of the inertial payload; None on pre-v7 takes.
ROW_COLS = (["t_ms"] + ["%s_%s" % (f, s) for f in ("index", "middle", "ring", "pinky")
                        for s in ("mcp", "pip", "dip")]
            + ["hq_w", "hq_x", "hq_y", "hq_z", "fq_w", "fq_x", "fq_y", "fq_z",
               "tq_w", "tq_x", "tq_y", "tq_z", "blend", "act",
               "px", "py", "pz", "pq_w", "pq_x", "pq_y", "pq_z",
               "thumb_abd", "thumb_mcp", "thumb_ip",
               "ihx", "ihy", "ihz", "ifx", "ify", "ifz", "i_conf"])
# Resolved once, so nothing downstream indexes a replay row by a hand-counted
# offset (see the traj flag at seal time for what that mistake cost).
_COL_PX = ROW_COLS.index("px")
_COL_IHX = ROW_COLS.index("ihx")
_rep_armed = False

TAKES_FILE = os.path.join(STATE_DIR, ".sensoryhand_takes.json")
takes = []                      # sealed recordings, newest first (shared library)

# ---------------------------------------------------------------------------
# ENVIRONMENT LIBRARY (4D replay): room meshes scanned by the Quest's own
# scene reconstruction (WebXR mesh-detection), uploaded by the AR client and
# replayed by any surface as a wireframe stage. One JSON per environment
# (positions/indices, METERS, y-up, the headset's local-floor space) plus a
# small index. The same space anchors the 6-DoF wrist poses streamed during
# recording, so a take's trajectory and its environment share coordinates.
# ---------------------------------------------------------------------------
ENVS_FILE = os.path.join(STATE_DIR, ".sensoryhand_envs.json")
envs = []                       # [{id, name, created_ms, tris, bbox}], newest first
ENV_MAX_TRIS = 120000           # upload cap: scene meshes beyond this are rejected
ENV_MAX_PTS = 120000            # upload cap for depth point clouds (2026-07-19)

# live 6-DoF pose of the device (wrist) in the environment space, streamed by
# the AR client while a recording runs. Fresh = newer than POSE_FRESH_S.
# RIGHT HAND ONLY: the rig is worn on the right hand; poses tagged "left" are
# dropped at the door so vision of the other hand can never steer the twin.
POSE = {"pos": None, "quat": None, "env": None, "t_wall": 0.0,
        # optional per-finger [abduction, MCP, PIP] degrees measured by the
        # HEADSET's hand tracking (a real vision sensor). Used to fill the
        # take's joint columns when the physical rig's encoders are absent:
        # precedence encoders > quest vision > sim, labelled on the take.
        "joints": None}
POSE_FRESH_S = 0.35
_pose_rejects = {"left": 0, "warned": False}

# MULTIMODAL WORLD FUSION (IMU x Quest): the Quest's wrist tracking is the
# drift-free absolute anchor; the IMU wrist-lever model carries the pose
# through OCCLUSION (the whole point of on-device sensing). At every fresh
# vision sample we store the anchor (Quest pose + the IMU state at that
# instant); while vision is lost, the wrist dead-reckons as
#   pos = anchor_pos + R(Wf_a) * (rel_now - rel_anchor)      [forearm frame]
#   quat = A (x) hq,   A = anchor_qquat (x) conj(anchor_hq)  [frame alignment]
# under the stated assumption that the forearm holds still while occluded
# (resting posture, the rehab norm). The next fresh Quest sample REPLACES the
# dead-reckoned pose outright: drift is corrected the moment vision returns.
WORLD = {"anchor": None, "src": "none"}


def _env_path(env_id):
    return os.path.join(STATE_DIR, ".sensoryhand_env_%s.json" % env_id)


def _take_data_path(take_id):
    return os.path.join(STATE_DIR, ".sensoryhand_takedata_%s.json" % take_id)


def _next_state_id(kind):
    """Next take/env number = 1 + the highest number seen in the in-memory
    index AND in the data files on disk, so IDs never collide with (and
    overwrite) an old recording even if the index was lost or corrupted."""
    items, pat = ((takes, ".sensoryhand_takedata_take_*.json") if kind == "take"
                  else (envs, ".sensoryhand_env_env_*.json"))
    n = 0
    for it in items:
        m = re.search(r"(\d+)$", str(it.get("id", "")))
        if m:
            n = max(n, int(m.group(1)))
    for p in glob.glob(os.path.join(STATE_DIR, pat)):
        m = re.search(r"(\d+)\.json$", p)
        if m:
            n = max(n, int(m.group(1)))
    return n + 1


def _load_envs():
    global envs
    try:
        with open(ENVS_FILE) as f:
            envs = list(json.load(f).get("envs", []))
        print(f"[envs] loaded {len(envs)} environments")
    except FileNotFoundError:
        envs = []
    except Exception as e:
        envs = []
        _quarantine_corrupt(ENVS_FILE, e, "envs")


def _save_envs():
    try:
        _write_json_atomic(ENVS_FILE, {"envs": envs})
    except Exception as e:
        print("[envs] could not save index:", e)


ENV_MAX_OBJECTS = 512           # a real room reports single digits; this is a guard

# ---------------------------------------------------------------------------
# HAND x ROOM CONTACTS (2026-07-30). The AR client crosses fingertip positions
# with the scanned room's labelled objects (app/src/world/contact.js) and ships
# sealed events here while a take records. One event = one fingertip resting on
# one labelled object for at least 80 ms.
#
# `src` is the PROVENANCE of the hand pose that produced the event and is the
# only thing that makes a count quotable:
#   device     - the physical rig's encoders posed the hand
#   quest-hand - the headset's optical hand tracking
#   mock       - the desktop mock stream (SIM, never a measurement)
# The bridge never assigns src; it stores what the client declared, and rejects
# anything outside this set so an unlabelled event cannot slip through.
# ---------------------------------------------------------------------------
CONTACT_COLS = ["t_ms", "dev_ms", "dur_ms", "tip", "obj", "label", "min_dist_m", "src"]
CONTACT_SRC = ("device", "quest-hand", "mock")
CONTACT_TIPS = ("index", "middle", "ring", "pinky")
CONTACT_MAX = 4096              # per-take cap; overflow is counted, not silent


def _clean_contacts(events):
    """Validate a batch of contact events. Malformed events are dropped."""
    if not isinstance(events, list):
        return []
    out = []
    for e in events[:CONTACT_MAX]:
        if not isinstance(e, dict):
            continue
        try:
            tip = str(e["tip"])
            src = str(e["src"])
            if tip not in CONTACT_TIPS or src not in CONTACT_SRC:
                continue
            dev = e.get("dev_ms")
            out.append({
                # t_ms = HEADSET clock (performance.now); dev_ms = TEENSY clock
                # (snap.t_ms at contact open), null when no snapshot was live.
                # Align takes on dev_ms. Never on t_ms.
                "t_ms": int(e["t_ms"]),
                "dev_ms": None if dev is None else int(dev),
                "dur_ms": max(0, int(e.get("dur_ms", 0))),
                "tip": tip,
                "obj": str(e["obj"])[:40],
                "label": str(e.get("label") or "unlabelled")[:40],
                "min_dist_m": round(float(e.get("min_dist_m", 0.0)), 4),
                "src": src,
            })
        except Exception:
            continue
    return out


def _contact_labels(events):
    """{'table': 14, 'chair': 2} - the human-readable line of a session."""
    m = {}
    for e in events:
        m[e["label"]] = m.get(e["label"], 0) + 1
    return m


def _contact_sources(events):
    """{'device': 14} - so a mixed-source take can never be quoted as one."""
    m = {}
    for e in events:
        m[e["src"]] = m.get(e["src"], 0) + 1
    return m

# canonical object record, mirrored from the AR client's world/sceneObjects.js:
#   {id, label, source, bounded, confidence, pos[3], quat[4] (w,x,y,z), size[3]}
# METRES, local-floor. Anything malformed is DROPPED, never repaired into a
# plausible-looking box: a fabricated table is worse than a missing one.
def _clean_objects(objects):
    if not isinstance(objects, list):
        return []
    out = []
    for o in objects[:ENV_MAX_OBJECTS]:
        if not isinstance(o, dict):
            continue
        try:
            pos = [float(v) for v in o["pos"]]
            quat = [float(v) for v in o["quat"]]
            size = [float(v) for v in o["size"]]
            if len(pos) != 3 or len(quat) != 4 or len(size) != 3:
                continue
            if not all(abs(v) < 1e4 for v in pos + quat + size):
                continue
            out.append({
                "id": str(o["id"])[:40],
                "label": str(o.get("label") or "unlabelled")[:40],
                "source": str(o.get("source") or "unknown")[:16],
                "bounded": bool(o.get("bounded")),
                "confidence": max(0.0, min(1.0, float(o.get("confidence", 1.0)))),
                "pos": [round(v, 3) for v in pos],
                "quat": [round(v, 4) for v in quat],
                "size": [round(v, 3) for v in size],
            })
        except Exception:
            continue
    return out


def _clean_anchor(anchor):
    """{handle, matrix[16] column-major, space, units} or None."""
    if not isinstance(anchor, dict):
        return None
    try:
        m = [float(v) for v in anchor["matrix"]]
        h = str(anchor["handle"])[:256]
        if len(m) != 16 or not h or not all(abs(v) < 1e4 for v in m):
            return None
        return {"handle": h, "matrix": [round(v, 5) for v in m],
                "space": str(anchor.get("space") or "local-floor")[:24],
                "units": str(anchor.get("units") or "m")[:8]}
    except Exception:
        return None


def env_save(name, positions, indices, source="ar", points=None, weights=None,
             objects=None, anchor=None):
    """Store one scanned environment; returns its meta entry (or raises).

    2026-07-19: an environment now carries EITHER a triangle mesh (positions +
    indices, the scene-reconstruction backbone) OR a depth POINT CLOUD
    (points, flat xyz, optional parallel per-point observation-count weights)
    OR both. The cloud is the primary 4D-replay product on the Quest 3S; the
    mesh remains valid on its own so every pre-existing env keeps working.

    2026-07-30: it may ALSO carry `objects` (the labelled scene inventory the AR
    client harvests from XRMesh/XRPlane semanticLabel) and `anchor` (a WebXR
    persistent-anchor handle plus the anchor's pose at save time, which is what
    lets a later session relocate this exact room). Both are optional and
    additive: every pre-existing env keeps loading unchanged."""
    n_tri = len(indices) // 3
    pts = points or []
    n_pts = len(pts) // 3
    if n_tri and (n_tri > ENV_MAX_TRIS or len(positions) % 3):
        raise ValueError("bad mesh: %d tris" % n_tri)
    if n_pts and (n_pts > ENV_MAX_PTS or len(pts) % 3):
        raise ValueError("bad cloud: %d pts" % n_pts)
    if n_tri < 1 and n_pts < 1:
        raise ValueError("empty environment (no tris, no points)")
    xs = list(positions[0::3]) + list(pts[0::3])
    ys = list(positions[1::3]) + list(pts[1::3])
    zs = list(positions[2::3]) + list(pts[2::3])
    meta = {
        "id": "env_%04d" % _next_state_id("env"),
        "name": (name or "Environment").strip()[:60] or "Environment",
        "created_ms": int(time.time() * 1000), "tris": n_tri, "pts": n_pts,
        "source": source,
        "bbox": [[round(min(xs), 3), round(min(ys), 3), round(min(zs), 3)],
                 [round(max(xs), 3), round(max(ys), 3), round(max(zs), 3)]],
    }
    payload = {"id": meta["id"], "name": meta["name"],
               "positions": [round(v, 4) for v in positions],
               "indices": list(indices)}
    if n_pts:
        payload["points"] = [round(v, 3) for v in pts]     # mm quantization
        if weights and len(weights) == n_pts:
            payload["weights"] = [max(1, min(65535, int(w))) for w in weights]
    objs = _clean_objects(objects)
    if objs:
        payload["objects"] = objs
        meta["objects"] = len(objs)
        meta["labels"] = sorted({o["label"] for o in objs})
    anc = _clean_anchor(anchor)
    if anc:
        payload["anchor"] = anc
        meta["anchored"] = True
    _write_json_atomic(_env_path(meta["id"]), payload)
    envs.insert(0, meta)
    _save_envs()
    return meta


def _sim_environment():
    """--sim fixture: a small procedural lab room (floor + two walls + a bench)
    so the replay pipeline is fully testable without a headset. Meters, y-up."""
    P, I = [], []

    def quad(a, b, c, d):
        i = len(P) // 3
        P.extend(a); P.extend(b); P.extend(c); P.extend(d)
        I.extend([i, i + 1, i + 2, i, i + 2, i + 3])

    def box(cx, cy, cz, sx, sy, sz):
        x0, x1 = cx - sx / 2, cx + sx / 2
        y0, y1 = cy - sy / 2, cy + sy / 2
        z0, z1 = cz - sz / 2, cz + sz / 2
        quad([x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0])
        quad([x0,y0,z1],[x0,y1,z1],[x1,y1,z1],[x1,y0,z1])
        quad([x0,y0,z0],[x0,y1,z0],[x0,y1,z1],[x0,y0,z1])
        quad([x1,y0,z0],[x1,y0,z1],[x1,y1,z1],[x1,y1,z0])
        quad([x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1])
        quad([x0,y0,z0],[x0,y0,z1],[x1,y0,z1],[x1,y0,z0])

    # floor 4x3 m as a 8x6 grid of quads (wireframe reads as a lab grid)
    for gx in range(8):
        for gz in range(6):
            x0, z0 = -2.0 + gx * 0.5, -1.5 + gz * 0.5
            quad([x0,0,z0],[x0+0.5,0,z0],[x0+0.5,0,z0+0.5],[x0,0,z0+0.5])
    # two walls
    for gx in range(8):
        x0 = -2.0 + gx * 0.5
        quad([x0,0,-1.5],[x0,2.2,-1.5],[x0+0.5,2.2,-1.5],[x0+0.5,0,-1.5])
    for gz in range(6):
        z0 = -1.5 + gz * 0.5
        quad([-2.0,0,z0],[-2.0,0,z0+0.5],[-2.0,2.2,z0+0.5],[-2.0,2.2,z0])
    box(0.6, 0.38, -0.9, 1.6, 0.76, 0.7)      # workbench
    box(0.6, 0.80, -1.05, 0.5, 0.08, 0.35)    # instrument on the bench
    return P, I


def _sim_point_cloud(P, I, target=4000):
    """--sim fixture: sample the sim room's surfaces into a SYNTHETIC depth
    cloud (points + observation-count weights) so the point-cloud replay path
    is fully testable without a headset. Lives only in envs labelled
    source="sim" - never mixed into a real capture."""
    tris, total = [], 0.0
    for i in range(0, len(I), 3):
        a, b, c = I[i] * 3, I[i + 1] * 3, I[i + 2] * 3
        o = (P[a], P[a + 1], P[a + 2])
        u = (P[b] - o[0], P[b + 1] - o[1], P[b + 2] - o[2])
        v = (P[c] - o[0], P[c + 1] - o[1], P[c + 2] - o[2])
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
             u[0] * v[1] - u[1] * v[0])
        area = 0.5 * math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
        tris.append((o, u, v, area))
        total += area
    pts, w, k = [], [], 0
    for (o, u, v, area) in tris:
        for _ in range(max(1, int(target * area / max(1e-9, total)))):
            k += 1
            r1 = (k * 0.7548776662) % 1.0        # low-discrepancy, deterministic
            r2 = (k * 0.5698402910) % 1.0
            if r1 + r2 > 1.0:
                r1, r2 = 1.0 - r1, 1.0 - r2
            pts.extend([round(o[0] + u[0] * r1 + v[0] * r2, 3),
                        round(o[1] + u[1] * r1 + v[1] * r2, 3),
                        round(o[2] + u[2] * r1 + v[2] * r2, 3)])
            w.append(1 + (k % 7))
    return pts, w


# ============================================================
#  THE ON-DEVICE WATCH FACE  (DATA_CONTRACT "watch", 2026-07-30)
# ============================================================
# The face/colorway catalog comes from the firmware's production registry.
# The bridge never invents entries, so a
# face that does not exist in the firmware cannot be selected from any UI.
WATCH_CATALOG = {"faces": [], "states": []}
_WATCH_CATALOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "..", "watch", "catalog.json")


def _load_watch_catalog():
    global WATCH_CATALOG
    try:
        with open(_WATCH_CATALOG_PATH, "r") as fh:
            data = json.load(fh)
        if isinstance(data.get("faces"), list) and data["faces"]:
            WATCH_CATALOG = {"faces": data["faces"], "states": data.get("states", [])}
            return
        raise ValueError("catalog has no faces")
    except Exception as e:
        print(f"[watch] CATALOG MISSING ({e}); watch commands will be rejected. "
              f"Restore software/watch/catalog.json.")


_load_watch_catalog()

# face + colorway currently selected. `persisted` is true only once the DEVICE
# has echoed the selection back, so a UI can never claim the screen changed
# when nothing is attached.
WATCH = {"face": "thesis", "colorway": "sapphire",
         "persisted": False, "source": "host", "dirty": False}


def _watch_face_index(face_id):
    for i, f in enumerate(WATCH_CATALOG["faces"]):
        if f.get("id") == face_id:
            return i
    return -1


def _watch_cw_index(face_id, cw_id):
    i = _watch_face_index(face_id)
    if i < 0:
        return -1
    for j, c in enumerate(WATCH_CATALOG["faces"][i].get("colorways", [])):
        if c.get("id") == cw_id:
            return j
    return -1


def _watch_default_cw(face_id):
    i = _watch_face_index(face_id)
    if i < 0:
        return None
    cws = WATCH_CATALOG["faces"][i].get("colorways", [])
    return cws[0]["id"] if cws else None


# each face remembers its own last colorway, so switching away and back does
# not silently reset a choice
WATCH_LAST_CW = {}


def _watch_public():
    # Include the selected catalog style in every snapshot.  The website's
    # live 240 px twin cannot faithfully draw a colorway from ids alone, and it
    # must not maintain a second, stale catalog table of its own.
    face = None
    colorway = None
    fi = _watch_face_index(WATCH["face"])
    if fi >= 0:
        face = WATCH_CATALOG["faces"][fi]
        for entry in face.get("colorways", []):
            if entry.get("id") == WATCH["colorway"]:
                colorway = entry
                break
    out = {"face": WATCH["face"], "colorway": WATCH["colorway"],
           "persisted": bool(WATCH["persisted"]), "source": WATCH["source"]}
    if face:
        out["face_name"] = face.get("name", WATCH["face"])
    if colorway:
        out.update({"colorway_name": colorway.get("name", WATCH["colorway"]),
                    "rgb": colorway.get("rgb", []),
                    "canonical": bool(colorway.get("canonical", False))})
    return out


def _sim_pose(now_s):
    """--sim fixture: the wrist sweeping a slow figure-eight over the bench."""
    a = now_s * 0.45
    return ([0.6 + 0.45 * math.sin(a), 0.95 + 0.10 * math.sin(2.1 * a),
             -0.85 + 0.28 * math.sin(2.0 * a) * math.cos(a)],
            [math.cos(a / 2), 0.0, math.sin(a / 2), 0.0])


def _load_takes():
    global takes
    try:
        with open(TAKES_FILE) as f:
            takes = list(json.load(f).get("takes", []))
        print(f"[takes] loaded {len(takes)} takes from {TAKES_FILE}")
    except FileNotFoundError:
        takes = []
    except Exception as e:
        takes = []
        _quarantine_corrupt(TAKES_FILE, e, "takes")


def _save_takes():
    try:
        _write_json_atomic(TAKES_FILE, {"takes": takes})
    except Exception as e:
        print("[takes] could not save library:", e)


def _downsample(seq, n=120):
    """Fixed-length preview of a recorded trace (mean-of-bucket, honest shape)."""
    if not seq:
        return []
    if len(seq) <= n:
        return [round(v, 3) for v in seq]
    out = []
    for i in range(n):
        a = (i * len(seq)) // n
        b = max(a + 1, ((i + 1) * len(seq)) // n)
        chunk = seq[a:b]
        out.append(round(sum(chunk) / len(chunk), 3))
    return out


def _joint_row_cols(joints, vj, sim_mode):
    """The take's 12 joint columns for one row, plus whether vision was used.

    Contract precedence: real encoders > quest vision > sim.
    - sim mode: the synthetic pipeline ranks BELOW real vision, so a fresh
      vision frame fills the whole row.
    - device mode: PER JOINT - a live encoder wins its own column and a dead
      one takes the fresh vision value. (Previously the whole row was gated
      on device_up, so with 3 of 12 encoders live the 9 unwired joints
      logged 0.0 labelled "encoders" while real vision was discarded.)
      Only when neither source exists does a column keep the 0.0 placeholder.
    """
    if vj and sim_mode:
        cols = []
        for f in FINGERS:
            a = vj.get(f) or (0.0, 0.0, 0.0)
            cols += [round(a[0], 2), round(a[1], 2), round(a[2], 2)]
        return cols, True
    cols, used_vision = [], False
    for i, f in enumerate(FINGERS):
        va = vj.get(f) if vj else None
        for k in range(3):
            j = joints[3 * i + k]
            if j.get("ok"):
                cols.append(round(j["deg"], 2))
            elif va is not None:
                cols.append(round(float(va[k]), 2))
                used_vision = True
            else:
                cols.append(0.0)
    return cols, used_vision


def record_start(profile_name, task, notes):
    """Begin the one shared recording. Idempotent: a second start joins the
    running take instead of restarting it. Returns (take_id, newly_started)."""
    with state_lock:
        if state["recording"]:
            return ECO["rec_id"], False
        state["recording"] = True
        ECO["rec_id"] = "take_%04d" % _next_state_id("take")
        ECO["rec_start"] = time.time()
        ECO["rec_samples"] = 0
        ECO["spark"] = []
        ECO["rows"] = []
        ECO["rec_env"] = None
        ECO["rows_vision"] = 0
        ECO["rows_enc"] = 0
        ECO["contacts"] = []
        ECO["profile"] = profile_name or "Operator"
        ECO["task"] = task or "unlabelled"
        ECO["notes"] = notes or ""
        take_id = ECO["rec_id"]
    send_teensy(b"b" if _fw["explicit_rec"] else b"r")   # idempotent start when the fw can
    return take_id, True


def record_stop():
    """Stop and seal the shared recording into the take library.
    Returns the sealed take dict, or None if nothing was recording."""
    with state_lock:
        if not state["recording"]:
            return None
        state["recording"] = False
        dur = max(0.0, time.time() - ECO["rec_start"])
        rows = ECO["rows"]; ECO["rows"] = []
        rec_env = ECO["rec_env"]; ECO["rec_env"] = None
        rows_vision = ECO["rows_vision"]; ECO["rows_vision"] = 0
        rows_enc = ECO["rows_enc"]; ECO["rows_enc"] = 0
        contacts = ECO["contacts"]; ECO["contacts"] = []
        take = {
            "id": ECO["rec_id"], "profile": ECO["profile"], "task": ECO["task"],
            "created_ms": int(state["t_ms"]), "duration_s": round(dur, 1),
            "samples": ECO["rec_samples"], "quality": "good",
            "spark": _downsample(ECO["spark"]),
        }
        if ECO["notes"]:
            take["notes"] = ECO["notes"]
        ECO["rec_id"] = None
    # 4D replay: seal the host-side sample log next to the library. traj =
    # at least one row carried a fresh 6-DoF pose (AR wrist stream / sim).
    if rows:
        take["has_data"] = True
        # Indexed BY NAME. This used to be r[-7], a negative index that happened
        # to land on pq_w back when the row ended with the thumb columns; the
        # moment anything was appended it silently started reading a different
        # field. ROW_COLS is the contract, so ask it.
        take["traj"] = any(r[_COL_PX] is not None for r in rows)
        # a second, independent translation source (v7 inertial). Kept separate
        # from `traj` so the existing meaning of that flag - "the headset saw
        # this take" - does not quietly change under old clients.
        take["traj_inertial"] = any(r[_COL_IHX] is not None for r in rows)
        # HONESTY LABEL: where the finger-joint columns actually came from.
        # encoders = the physical rig's AS5600s; quest-hand = the headset's
        # hand-tracking (real vision, used when the rig is absent); sim = the
        # synthetic device. Majority-of-rows decides; the count ships too.
        if SIM_MODE and rows_vision <= len(rows) / 2:
            take["joint_source"] = "sim"
        elif rows_vision > len(rows) / 2 or (rows_vision > 0 and rows_enc == 0):
            take["joint_source"] = "quest-hand"
        elif rows_enc > 0:
            take["joint_source"] = "encoders"
        else:
            # no sensor ever contributed a value: placeholders only. Never
            # call that "encoders" (label addition; surfaces render the string)
            take["joint_source"] = "none"
        if rows_vision:
            take["vision_joint_rows"] = rows_vision
        if rec_env:
            take["env"] = rec_env
        # HAND x ROOM (2026-07-30): contact events the AR client sealed against
        # the scanned room's labelled objects. Summarised on the take meta (so
        # the library can show "table 14 / chair 2" without opening the data
        # file) and stored in full next to the rows.
        if contacts:
            take["contacts"] = len(contacts)
            take["contact_labels"] = _contact_labels(contacts)
            take["contact_src"] = _contact_sources(contacts)
        try:
            payload = {"id": take["id"], "cols": ROW_COLS, "rows": rows}
            if contacts:
                payload["contacts"] = contacts
                payload["contact_cols"] = CONTACT_COLS
            _write_json_atomic(_take_data_path(take["id"]), payload)
        except Exception as e:
            print("[takes] could not save replay data:", e)
            take["has_data"] = False
    send_teensy(b"e" if _fw["explicit_rec"] else b"r")   # idempotent stop when the fw can
    takes.insert(0, take)
    _save_takes()
    return take


def _note_sample_locked():
    """Per real sensor sample (50 Hz), caller HOLDS state_lock: recording counters."""
    if state["recording"]:
        ECO["rec_samples"] += 1


def _update_reps(joints):
    """Server-side repetition counting from the MCP-flexion channel, with
    hysteresis (arm above 65 % of travel, count on release below 30 %), so
    every client sees the same rep count. Runs once per broadcast tick."""
    global _rep_armed
    with state_lock:
        active = ECO["guided"] or ECO["mode"] == "rhythm"
    if not active:
        _rep_armed = False
        return
    best = None
    for j in joints:                       # prefer the wired finger, else any live flexion
        if j["id"].endswith("_pip") and j["ok"]:
            if j["id"].startswith(WIRED_FINGER) or best is None:
                best = j["deg"]
    if best is None:
        return
    norm = (best - FLEX_OPEN) / max(1e-6, FLEX_CLOSED - FLEX_OPEN)
    if norm > 0.65 and not _rep_armed:
        _rep_armed = True
    elif norm < 0.30 and _rep_armed:
        _rep_armed = False
        with state_lock:
            ECO["reps_done"] += 1


_load_takes()
_load_envs()


def _ensure_sim_env():
    """--sim: guarantee one environment exists so replay is testable headset-free."""
    if SIM_MODE and not envs:
        P, I = _sim_environment()
        pts, w = _sim_point_cloud(P, I)
        meta = env_save("Sim Lab", P, I, source="sim", points=pts, weights=w)
        print(f"[envs] sim environment '{meta['name']}' "
              f"({meta['tris']} tris, {meta['pts']} pts)")


# ----- mirror-therapy targets (web mirror surface streams these at ~60 Hz) ----
MIRROR = {"targets": None, "assist": 0.0, "t": 0.0}

# Camera-led follow is intentionally separate from the old mirror visualisation
# above.  That path exists for the twin/simulator; this one reaches the
# firmware's two-independent-DOF SEA controller.  It starts disarmed on every
# bridge start and after every loss of camera tracking.  Browser vision may
# *suggest* a target, but it can never issue raw-current commands.
CAMERA_FOLLOW = {
    "armed": False, "zeroed": False, "directions": False,
    "target": None, "zero": None, "actual": None, "t": 0.0,
    "error_since": None, "direction_values": {}, "probe": None,
    "reason": "disarmed",
    # v14 confirmation. `armed` above is what the bridge REQUESTED; the firmware
    # is the only thing that knows whether it accepted. `arm_pending` holds the
    # deadline for that confirmation and `arm_tries` bounds the retries.
    "arm_pending": None, "arm_tries": 0,
}
# The arm request can legitimately be refused for one tick: taking the bus or a
# momentarily stale joint sample. Retry a few times over this window, then stop
# and say so, rather than reporting an arm that never happened.
CAMERA_FOLLOW_ARM_WINDOW_S = 1.5
CAMERA_FOLLOW_ARM_TRIES = 5
CAMERA_FOLLOW_FRESH_S = 0.25
CAMERA_FOLLOW_ERROR_DEG = 28.0
CAMERA_FOLLOW_ERROR_HOLD_S = 2.0
# Conservative first-session excursion.  These are not anatomical ROM claims;
# they are a deliberately small, software-enforced starting envelope while the
# wearer validates cable routing, neutral and direction.  A calibrated therapy
# profile can widen them later, never this browser command.
CAMERA_FOLLOW_LIMIT = {"mcp_deg": 35.0, "pip_deg": 45.0}


def _camera_follow_write(line):
    """One complete safe firmware command, sharing the serial writer lock."""
    send_teensy((line + "\n").encode())


def _camera_follow_disarm(reason="disarmed"):
    # Order matters: disable the SEA law before torque so a delayed target can
    # never be applied while the torque register is transitioning.
    _camera_follow_write("M,x,0")
    _camera_follow_write("M,e,0")
    CAMERA_FOLLOW.update(armed=False, target=None, error_since=None, probe=None,
                         reason=reason, arm_pending=None, arm_tries=0)


def _camera_follow_device():
    """The firmware's own SEA readiness, or None when it cannot be trusted.

    This is the authority. The bridge's own flags describe what it ASKED for.

    STALE STATE IS NOT DEVICE STATE. `state["motors_fw"]` holds the last frame
    ever parsed, and nothing clears it when the link drops, so a Teensy that has
    physically left the USB bus kept "reporting" its last known prerequisites -
    on 2026-08-16 that surfaced as directions:true from a board that was no
    longer plugged in. A reading older than the snapshot's own liveness window
    is not evidence about the device now.
    """
    with state_lock:
        mf = state.get("motors_fw")
        last_rx = state.get("last_rx") or 0.0
    if not last_rx or (time.time() - last_rx) >= 1.0:
        return None
    return (mf or {}).get("sea")


def _camera_follow_arm_tick(now):
    """Confirm (or honestly fail) a pending arm request.

    The old code sent the arm sequence and immediately reported success. The
    firmware can refuse: it requires mode 4, a captured zero, both direction
    signs, AND a joint sample younger than 150 ms. A refusal produced a console
    that said "following" while the controller sat at zero current. Now the
    request is pending until the device itself reports armed.
    """
    pend = CAMERA_FOLLOW.get("arm_pending")
    if not pend:
        return
    dev = _camera_follow_device()
    if dev is None:                      # v13 firmware cannot confirm; say so once
        CAMERA_FOLLOW.update(arm_pending=None, armed=True,
                             reason="armed (firmware v13 cannot confirm; flash v14)")
        return
    if dev.get("armed"):
        CAMERA_FOLLOW.update(armed=True, arm_pending=None, arm_tries=0,
                             error_since=None, reason="armed; awaiting camera target")
        return
    if now >= pend:
        _camera_follow_disarm("device refused to arm: %s" % _camera_follow_block_reason(dev))
        return
    # Not armed yet and still inside the window: re-issue the single arm line
    # once the prerequisite it was missing (usually joint freshness) is back.
    if dev.get("joint_fresh") and CAMERA_FOLLOW["arm_tries"] < CAMERA_FOLLOW_ARM_TRIES:
        CAMERA_FOLLOW["arm_tries"] += 1
        _camera_follow_write("M,x,1")


_CFDIR_FILE = os.path.join(STATE_DIR, ".takto_follow_directions.json")


def _save_directions():
    """Persist measured direction signs.

    A direction is a MEASUREMENT of how this hardware is wired, not session
    state: it costs a real motor pull to obtain and it does not change until the
    tendons are re-routed. It was being kept only in memory, so every bridge
    restart silently threw it away and sent the wearer back to the direction
    step to re-pull the finger for an answer that was already known.
    """
    try:
        _write_json_atomic(_CFDIR_FILE, {"directions": CAMERA_FOLLOW["direction_values"]})
    except Exception as e:
        print("[follow] could not persist directions:", e)


def _load_directions():
    try:
        with open(_CFDIR_FILE) as f:
            d = (json.load(f) or {}).get("directions") or {}
    except FileNotFoundError:
        return
    except Exception as e:
        _quarantine_corrupt(_CFDIR_FILE, e, "follow-directions")
        return
    clean = {k: int(v) for k, v in d.items() if k in ("mcp", "pip") and int(v) in (-1, 1)}
    if clean:
        CAMERA_FOLLOW["direction_values"] = clean
        print("[follow] loaded measured directions %s from %s" % (clean, _CFDIR_FILE))


def _push_directions_to_device():
    """Re-send known signs to a firmware that has forgotten them (reflash/reboot).

    The firmware holds seaDir in RAM, so a reflash clears it while the bridge
    still knows the measured answer. Sending it back costs nothing and is
    refused by the firmware unless torque is off, which is the safe state.
    """
    dv = CAMERA_FOLLOW["direction_values"]
    if dv.get("mcp") in (-1, 1) and dv.get("pip") in (-1, 1):
        _camera_follow_write("M,d,%d,%d" % (dv["mcp"], dv["pip"]))
        return True
    return False


_load_directions()     # defined here, not at import top: it needs CAMERA_FOLLOW


def _cf_prereq():
    """(zeroed, directions) with the DEVICE preferred over the bridge's request.

    The command guards below used to read the bridge's own flags, which survive a
    reflash while the firmware's do not: after flashing v14 the bridge still said
    "neutral captured" for a device that had just lost it. Ask the device.
    """
    dev = _camera_follow_device()
    if dev is None:
        return bool(CAMERA_FOLLOW["zeroed"]), bool(CAMERA_FOLLOW["directions"])
    # BOTH origins or neither. The firmware keeps its own seaJointZero across a
    # bridge restart, so the device can report "zeroed" while this process has no
    # reference at all. That combination used to pass the prerequisite and then
    # disarm one tick later with a misleading "joint feedback unavailable" - the
    # encoders were fine, the bridge simply had no neutral to measure against.
    # It is also unsafe on its own terms: the tracking-error supervisor would be
    # comparing to a different origin than the controller is regulating to.
    return bool(dev.get("zeroed")) and CAMERA_FOLLOW["zero"] is not None, \
        bool(dev.get("directions"))


def _camera_follow_block_reason(dev):
    """Name the missing prerequisite instead of a generic failure."""
    if not dev.get("zeroed"):
        return "no neutral captured on the device"
    if CAMERA_FOLLOW["zero"] is None:
        return "no neutral on this bridge (restarted since): press Set neutral again"
    if not dev.get("directions"):
        return "motor directions not identified on the device"
    if not dev.get("joint_fresh"):
        return "joint feedback stale (check ch8/ch9 encoders)"
    return "check torque and mode 4 preconditions"


def _camera_follow_pose():
    """Return the *measured* wired-index MCP/PIP angles, or None.

    This is intentionally shared by neutral capture, safety supervision and
    web telemetry.  It never falls back to raw AS5600 values: an uncalibrated
    angle is not a valid anatomical measurement and must never close the loop.
    """
    with state_lock:
        enc = list(state.get("enc", []))
    if len(enc) <= 9 or enc[8] < 0.0 or enc[9] < 0.0:
        return None
    try:
        return (calibrated_joint(8, enc[8])[1], calibrated_joint(9, enc[9])[1])
    except Exception:
        return None


# Direction probe, RAMPED (2026-08-16).
#
# The original probe was a fixed 12 mA / 150 ms pulse. That is a rigid-tendon
# test, and this transmission is no longer rigid: with the series-elastic
# element fitted, a short low-current pulse is absorbed as spring extension and
# the joint never moves, so a correctly-wired motor reported "no joint
# response". Measured on this bench 2026-08-10, breakaway needed roughly 80 mA
# commanded against 25 mA of holding current, so 12 mA was never going to move
# anything through a spring.
#
# The probe now RAMPS and stops at the first clear joint motion. The ceiling is
# deliberately the SAME 30 mA the follow law itself is clamped to, so the test
# can never apply a force the controller would not: it proves the direction
# under exactly the authority the arm step is about to grant.
# The ceiling was 30 mA (the follow law's own clamp) until the bench proved on
# 2026-08-16 that it cannot start these gearboxes: 30 mA commanded, 30 mA drawn,
# joint moved 0.01 deg. Breakaway measured ~80 mA on 2026-08-10 while only ~25 mA
# sustains motion. The probe therefore ramps into the firmware's BOUNDED mode-2
# breakaway window (M,K), which the firmware caps at 95 mA and 250 ms per arming
# and refuses outside mode 2 - so the follow law's sustained limit is untouched.
PROBE_MA_START = 8.0
PROBE_MA_SUSTAINED = 30.0  # below here no kick is needed
PROBE_MA_MAX = 90.0        # above measured breakaway, under the firmware's 95 mA kick ceiling
PROBE_MA_STEP = 3.0        # gentle: ~28 small steps rather than a dozen big ones
PROBE_STEP_S = 0.18        # and slow, so force creeps up instead of stepping up
PROBE_KICK_MS = 250        # must match/undercut the firmware's KICK_MAX_MS
# ONSET, not travel. The first run detected at 0.7 deg while already at 90 mA and
# the joint then coasted to 1.53 deg - far more motion than a direction test
# needs, and it felt like a yank. The encoder's own noise floor here is ~0.01 deg,
# so 0.15 deg is still 15x noise while catching the micro-creep that precedes
# breakaway: in that same trace the joint was already creeping at 71 mA.
PROBE_ONSET_DEG = 0.15
# Hard excursion stop. Whatever happens, this test never moves a joint further
# than this before it de-energizes.
PROBE_ABORT_DEG = 2.0
PROBE_HOLD_S = 0.40        # dwell at the ceiling before declaring no response


def _probe_stop(p):
    """Always leave the bus de-energized, whatever the outcome."""
    _camera_follow_write("M,c,%d,0" % p["motor"])
    _camera_follow_write("M,e,0")


def _probe_raw_pose():
    """UNCLAMPED continuous MCP/PIP encoder degrees, for motion detection only.

    calibrated_joint() floors its output at the open mark (max(0.0, ...)), which
    is right for a twin and a controller and WRONG for detecting whether a motor
    moved anything: a joint resting a hair on the extension side of its open mark
    reads a hard 0.00 and stays there no matter how far the motor pulls it
    further into extension. That is exactly what the PIP probe hit on
    2026-08-16 - it drew 91 mA and reported 0.00 deg of motion, which is
    indistinguishable from a dead tendon.

    The continuous unwrapped angle has no floor and no ceiling, so motion is
    visible in BOTH directions. Supervision and display keep using the
    calibrated value; only this test uses the raw one.
    """
    with state_lock:
        enc = list(state.get("enc", []))
    if len(enc) <= 9 or enc[8] < 0.0 or enc[9] < 0.0:
        return None
    # unwrapped_deg is idempotent within a sample (a repeat adds _wrap180(0)),
    # so sharing the accumulator with calibrated_joint() is safe.
    return (unwrapped_deg(8, enc[8]), unwrapped_deg(9, enc[9]))


def _camera_follow_probe_tick(now):
    """Advance one ramped direction probe without trusting a UI guess.

    A manual open-to-closed exercise calibrates the camera and encoder ranges,
    but it cannot reveal whether positive current pulls flexion or extension.
    This test observes the *encoder's* response to a known selected motor and
    ends torque-off; a no-motion result stays unclassified rather than guessing.
    """
    p = CAMERA_FOLLOW.get("probe")
    if not p:
        return
    if p["phase"] == "ramp":
        # Excursion guard runs on EVERY tick, not just on step boundaries, so an
        # unexpectedly fast joint is caught between steps rather than after one.
        pose_now = _probe_raw_pose()
        i = 0 if p["axis"] == "mcp" else 1
        if pose_now is not None and abs(pose_now[i] - p["start"][i]) >= PROBE_ABORT_DEG:
            p["moved"] = pose_now[i] - p["start"][i]
            _probe_stop(p)
            p.update(phase="settle", t=now)
            return
        if now - p["t"] < PROBE_STEP_S:
            return
        pose = pose_now
        moved = None if pose is None else pose[i] - p["start"][i]
        if moved is not None:
            p["moved"] = moved
        # Record what the motor ACTUALLY draws, rather than assuming the commanded
        # current is delivered. Whatever pretension the SEA already carries is part
        # of this reading; it is measured here, never taken from the spring theory.
        with state_lock:
            _m = ((state.get("motors_fw") or {}).get("m") or {}).get(p["motor"])
        if _m is not None:
            read_ma = abs(float(_m.get("ma", 0.0)))
            if read_ma > p.get("peak_read_ma", 0.0):
                p["peak_read_ma"] = read_ma
        if moved is not None and abs(moved) >= PROBE_ONSET_DEG:
            _probe_stop(p)                       # answer found: stop pulling at once
            p.update(phase="settle", t=now)
            return
        if p["ma"] >= PROBE_MA_MAX:
            if now - p["max_since"] >= PROBE_HOLD_S:
                _probe_stop(p)
                p.update(phase="settle", t=now)
            return
        p["ma"] = min(PROBE_MA_MAX, p["ma"] + PROBE_MA_STEP)
        p["peak"] = p["ma"]
        if p["ma"] >= PROBE_MA_MAX:
            p["max_since"] = now
        # Above the sustained cap the firmware will clamp unless a breakaway
        # window is armed, and that window is re-armed on EVERY step so it can
        # only stay open while this ramp is actively advancing. Stop stepping and
        # it closes itself within PROBE_KICK_MS.
        if p["ma"] > PROBE_MA_SUSTAINED:
            _camera_follow_write("M,K,%.0f,%d" % (p["ma"], PROBE_KICK_MS))
        _camera_follow_write("M,c,%d,%.0f" % (p["motor"], p["ma"]))
        p["t"] = now
        return
    if p["phase"] != "settle" or now - p["t"] < 0.30:
        return
    pose = _probe_raw_pose()          # unclamped: see _probe_raw_pose
    CAMERA_FOLLOW["probe"] = None
    if pose is None:
        CAMERA_FOLLOW["reason"] = "direction test failed: joint feedback unavailable"
        return
    i = 0 if p["axis"] == "mcp" else 1
    delta = pose[i] - p["start"][i]
    if abs(delta) < PROBE_ONSET_DEG:
        # Distinguish "the motor never energized" from "it pulled and nothing
        # moved". Blaming cable tension for a refused torque-on sends the wearer
        # to re-tension a tendon that was never driven.
        with state_lock:
            _mf = state.get("motors_fw") or {}
        _diag = (_mf.get("diagnostic") or {}).get("cause")
        if _mf.get("fault") or (_diag and _diag != "none"):
            CAMERA_FOLLOW["reason"] = ("direction test could not drive the motor (%s)"
                                       % (_diag or "motor fault"))
        else:
            # MEASURED numbers only. An earlier version printed a force in
            # newtons derived from k_tau/r_spool - that is theory, and with the
            # series spring fitted the real tendon tension is not known to this
            # code. Report the current actually commanded, the current actually
            # read back, and the joint motion actually seen. Nothing inferred.
            CAMERA_FOLLOW["reason"] = (
                "no %s motion: commanded up to %.0f mA, motor read %.0f mA, joint moved "
                "%.2f deg (baseline %.2f deg). Check this motor's tendon routing."
                % (p["axis"].upper(), p.get("peak", PROBE_MA_START),
                   p.get("peak_read_ma", 0.0), p.get("moved", 0.0),
                   p["start"][0 if p["axis"] == "mcp" else 1]))
        return
    CAMERA_FOLLOW["direction_values"][p["axis"]] = 1 if delta > 0.0 else -1
    _save_directions()                      # a measurement, not session state
    dirs = CAMERA_FOLLOW["direction_values"]
    if "mcp" in dirs and "pip" in dirs:
        _camera_follow_write("M,d,%d,%d" % (dirs["mcp"], dirs["pip"]))
        CAMERA_FOLLOW.update(directions=True, reason="motor directions learned")
    else:
        CAMERA_FOLLOW["reason"] = "%s direction learned; test the other joint" % p["axis"].upper()


# ----- SEA control layer (post-thesis; host-side runner, not in this release) -
# The SEA runner is an optional bench-tuning tool that drives the motors from
# the host through a U2D2. When it runs, the Teensy must NOT take the bus
# (single master: the firmware's M,t,1 listens first and refuses); in the
# normal architecture the Teensy owns the bus and this block stays idle. The
# runner connects here as a client: it PUBLISHES its state as
# {"cmd":"sea", "sea":{...}} (~15 Hz) which the bridge mirrors into every
# snapshot while fresh, and it OBEYS the last {"cmd":"sea_target", ...} a UI
# sent, relayed in snapshots as `sea_cmd` (the runner watches `seq`). All
# tensions/extensions inside the frame are ESTIMATES from the identified
# spring model and carry the frame's own `sim`/`label` markers - the bridge
# forwards them verbatim and never invents motor state from them.
SEA = {"frame": None, "t": 0.0}
SEA_CMD = {"seq": 0, "cmd": None}
SEA_FRESH_S = 2.0


# ----- transparency blend: the Apple-crown control --------------------------
# ONE continuous scalar for the whole ecosystem: assist = 0 -> fully
# transparent (the device renders zero force, pure follow), assist = 1 ->
# fully assisted. The PHYSICAL crown (pot, v3 firmware) is the authority the
# moment it moves; a UI `{cmd:"blend", level}` can set it (sim/demo, or a
# bench without the pot), and the next real crown motion reclaims control -
# exactly the crown-vs-software interplay on the Vision Pro. The broadcast
# value is slew-limited so every surface can animate it directly.
BLEND = {"assist": 0.35, "target": 0.35, "source": "ui", "present": False,
         "crown_ref": None, "t": None}
BLEND_SLEW = 2.0                # full travel in 0.5 s: smooth but immediate
CROWN_CLAIM = 0.02              # physical motion this big reclaims authority


def _update_blend(crown, now):
    """Advance the blend one broadcast tick (single caller: build_snapshot)."""
    b = BLEND
    if crown is not None:
        b["present"] = True
        if b["crown_ref"] is None:            # first crown sample: adopt it
            b["source"] = "crown"
            b["crown_ref"] = crown
        if b["source"] == "crown":
            b["target"] = crown
            b["crown_ref"] = crown
        elif abs(crown - b["crown_ref"]) > CROWN_CLAIM:
            b["source"] = "crown"             # the wearer turned the crown: it wins
            b["target"] = crown
            b["crown_ref"] = crown
    dt = 0.0 if b["t"] is None else max(0.0, min(0.2, now - b["t"]))
    b["t"] = now
    step = BLEND_SLEW * dt
    delta = b["target"] - b["assist"]
    b["assist"] += max(-step, min(step, delta))
    return b["assist"]


# ============================================================================
# SIMULATED MOTOR BANK (--sim / --sim-motors)
#
# On the real bench the motor bus is host-owned via U2D2 and NOT bridged here;
# live snapshots keep motors:[] (honest). In sim, this bank gives the ecosystem
# a full motor surface: it honors motor / walls / feedback / mirror commands
# with the same safety posture as the real chain (150 mA hard ceiling, 80 mA
# gentle wall ceiling), so the Control surfaces and TOUCH mode are exercisable
# and testable end to end. A future real backend implements the same methods.
# ============================================================================
KT_NM_PER_A = 0.92              # torque constant [N m/A] (HARDWARE_IO.md)
I_HARD_CAP_MA = 150.0           # absolute current ceiling, same constant as the wire clamp
I_WALL_CAP_MA = 80.0            # gentle ceiling for kinesthetic walls
MOTOR_MODES = ("off", "hold", "assist", "pid")


class SimMotors:
    def __init__(self, ids=("index_drive", "middle_drive")):
        self.m = {}
        for i, mid in enumerate(ids):
            self.m[mid] = {"mode": "off", "torque_on": False, "setpoint_ma": 0.0,
                           "pos": 8.0, "vel": 0.0, "cur": 0.0, "temp": 31.0 + 0.5 * i}
        self.walls = []
        self._last = None

    def command(self, mid, torque=None, mode=None, setpoint_ma=None):
        """Validated operator command; returns (ok, error)."""
        mo = self.m.get(mid)
        if mo is None:
            return False, "unknown motor id"
        if mode is not None:
            if mode not in MOTOR_MODES:
                return False, "unknown mode"
            mo["mode"] = mode
        if torque is not None:
            mo["torque_on"] = bool(torque)
            if not mo["torque_on"]:
                mo["mode"] = "off"
        if setpoint_ma is not None:
            try:
                sp = float(setpoint_ma)
            except (TypeError, ValueError):
                return False, "bad setpoint"
            if not math.isfinite(sp):
                # NaN passes straight through min/max to a BOUND, i.e. the
                # full 150 mA ceiling; it must be a validation error instead.
                return False, "bad setpoint"
            mo["setpoint_ma"] = max(0.0, min(I_HARD_CAP_MA, sp))
        if mo["mode"] != "off" and torque is None:
            mo["torque_on"] = True
        return True, None

    def set_walls(self, walls):
        """Sanitized wall descriptors (TOUCH). Unknown joints are dropped."""
        clean = []
        for w in walls[:8]:
            if not isinstance(w, dict) or w.get("joint") not in self.m:
                continue
            try:
                x = float(w.get("x_wall_deg", 40.0))
                K = float(w.get("K", 0.5))
                B = float(w.get("B", 0.02))
                fm = float(w.get("f_max_ma", I_WALL_CAP_MA))
            except (TypeError, ValueError):
                continue
            if not all(map(math.isfinite, (x, K, B, fm))):
                continue          # NaN passes min/max straight to a bound
            clean.append({
                "joint": w["joint"],
                "x_wall_deg": max(-30.0, min(120.0, x)),
                "K": max(0.0, min(50.0, K)),
                "B": max(0.0, min(5.0, B)),
                "f_max_ma": max(0.0, min(I_WALL_CAP_MA, fm)),
            })
        self.walls = clean

    def step(self, joints_by_id, feedback_on, now):
        """Advance the plant one broadcast tick (single caller: broadcast loop)."""
        dt = 0.0 if self._last is None else max(0.0, min(0.2, now - self._last))
        self._last = now
        mirror_fresh = MIRROR["targets"] and (now - MIRROR["t"]) < 0.5
        for mid, mo in self.m.items():
            finger = mid.split("_")[0]
            jdeg = joints_by_id.get(finger + "_pip")
            # position: the spool follows the finger's MCP flexion with a lag;
            # in mirror mode a fresh target trajectory leads instead.
            target = mo["pos"]
            if mirror_fresh and finger in MIRROR["targets"] and mo["torque_on"]:
                target = 90.0 * max(0.0, min(1.0, float(MIRROR["targets"][finger])))
            elif jdeg is not None:
                target = jdeg
            if dt > 0.0:
                a = 1.0 - math.exp(-dt / 0.15)
                new_pos = mo["pos"] + (target - mo["pos"]) * a
                mo["vel"] = (new_pos - mo["pos"]) / dt
                mo["pos"] = new_pos
            # current: an active wall dominates (kinesthetic rendering), else
            # the operator setpoint, else a small holding current.
            cur = 0.0
            wall = next((w for w in self.walls if w["joint"] == mid), None)
            self_wall_live = False
            if wall and feedback_on and jdeg is not None and jdeg > wall["x_wall_deg"]:
                pen_rad = (jdeg - wall["x_wall_deg"]) * math.pi / 180.0
                tau = wall["K"] * pen_rad + wall["B"] * abs(mo["vel"]) * math.pi / 180.0
                cur = min(wall["f_max_ma"], (tau / KT_NM_PER_A) * 1000.0)
                self_wall_live = True
            elif mo["torque_on"]:
                if mo["mode"] in ("assist", "pid"):
                    cur = mo["setpoint_ma"]
                elif mo["mode"] == "hold":
                    cur = min(mo["setpoint_ma"], 15.0) if mo["setpoint_ma"] else 12.0
            mo["cur"] = max(0.0, min(I_HARD_CAP_MA, cur))
            mo["wall_live"] = self_wall_live
            # temperature: rises with current squared, cools toward ambient
            if dt > 0.0:
                mo["temp"] += (6.0 * (mo["cur"] / I_HARD_CAP_MA) ** 2 - (mo["temp"] - 31.0) * 0.05) * dt
                mo["temp"] = max(29.0, min(48.0, mo["temp"]))

    def motors_snapshot(self):
        """DATA_CONTRACT dialect (web console + Android)."""
        out = []
        for mid, mo in self.m.items():
            out.append({"id": mid, "pos_deg": round(mo["pos"], 2), "vel_dps": round(mo["vel"], 2),
                        "current_ma": round(mo["cur"], 1), "temp_c": round(mo["temp"], 1),
                        "voltage_v": 12.0, "torque_on": mo["torque_on"], "mode": mo["mode"]})
        return out

    def actuators_snapshot(self):
        """HARDWARE_IO dialect (AR experience)."""
        out = []
        for mid, mo in self.m.items():
            if mo.get("wall_live"):
                fb = "wall"
            elif mo["torque_on"]:
                fb = "pure"
            else:
                fb = "off"
            out.append({"id": mid, "pos_deg": round(mo["pos"], 2), "vel_dps": round(mo["vel"], 2),
                        "current_ma": round(mo["cur"], 1), "temp_c": round(mo["temp"], 1),
                        "torque_on": mo["torque_on"], "feedback_mode": fb})
        return out


MOTORS = None                   # SimMotors in sim mode; None on the real bench (honest)


# ============================================================================
# SIMULATED DEVICE (--sim): a 50 Hz full-system living scene written into the
# SAME `state` the serial thread writes, so calibration, activation, snapshot
# building, recording, and rep counting all run the production code path.
# ============================================================================
def enable_sim_pipeline():
    """Deterministic identity calibration for the synthetic scene (the sim
    writes joint-space degrees directly, so the bench calibration must not
    remap them). Mirrors bench_replay.py's proven setup."""
    global _imu_tare_pending, _thumb_tare_pending, IMU_TARE_HAND, IMU_TARE_FOREARM, IMU_TARE_THUMB
    global IMU_CFG, ENC_JOINT_SPACE_DIRECT
    global _JCAL_FILE, _TARE_FILE, _IMU_CFG_FILE
    # Sim persistence goes to .sim-suffixed files: a calibrate click during a
    # --sim demo must never overwrite the REAL bench calibration in STATE_DIR
    # (it used to wipe joint_calib to {} and tare over the bench IMU home).
    if not _JCAL_FILE.endswith(".sim"):
        _JCAL_FILE += ".sim"
        _TARE_FILE += ".sim"
        _IMU_CFG_FILE += ".sim"
    ENC_DOF.clear()
    ENC_JOINT_SPACE_DIRECT = True
    ENC_OPEN.clear(); ENC_CLOSED.clear(); _cont_open.clear()
    with state_lock:
        state["enc"] = [ENC_ABSENT_SIM] * N_CH   # sim absence sentinel from frame zero
    _imu_tare_pending = False
    _thumb_tare_pending = False
    IMU_TARE_HAND = [1.0, 0.0, 0.0, 0.0]
    IMU_TARE_FOREARM = [1.0, 0.0, 0.0, 0.0]
    IMU_TARE_THUMB = [1.0, 0.0, 0.0, 0.0]
    # The sim writes display-frame quaternions directly, so every mounting
    # correction must be identity or the synthetic scene would be re-rotated.
    IMU_CFG = copy.deepcopy(IMU_CFG_DEFAULT)
    for k in IMU_KEYS:
        IMU_CFG[k] = {"remap": [[1, "x"], [1, "y"], [1, "z"]],
                      "offset": [1.0, 0.0, 0.0, 0.0], "flip": None, "gain": 1.0, "align": None}


def _quat_from_rpy_deg(roll, pitch, yaw):
    r, p, y = math.radians(roll) * 0.5, math.radians(pitch) * 0.5, math.radians(yaw) * 0.5
    cr, sr = math.cos(r), math.sin(r)
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy]


def sim_thread(hz=50.0):
    """Synthetic full-system scene: four fingers in slow, staggered open/close
    cycles, two breathing IMUs, EMG effort through the real activation filter."""
    t0 = time.time()
    dt = 1.0 / hz
    SPLAY = [9.0, 2.5, -4.0, -10.0]            # neutral abduction, index..pinky
    try:      # tests speed the scene up so rep/record cycles finish in seconds
        speed = max(0.1, min(20.0, float(os.environ.get("SENSORYHAND_SIM_SPEED", "1"))))
    except ValueError:
        speed = 1.0
    print("[sim] synthetic device running (12 joints, 2 IMUs, EMG)")
    while True:
        t = (time.time() - t0) * speed
        enc = [ENC_ABSENT_SIM] * N_CH           # ch12/13 spare, honestly absent
        curls = []
        for fi in range(4):
            phase = t * 0.6 + fi * 0.4
            curl = 0.5 - 0.5 * math.cos(phase)
            curls.append(curl)
            jig = math.sin(t * 2.0 + fi) * 0.4
            b = fi * 3
            enc[b + 0] = SPLAY[fi] * (1.0 - 0.75 * curl) + math.sin(t * 0.9 + fi * 1.7) * 1.2
            enc[b + 1] = 90.0 * curl + jig                     # MCP flexion: full 0..90
            enc[b + 2] = 110.0 * (0.8 * curl + 0.2 * curl * curl) + jig  # PIP: 0..110, trails the MCP
        breathe = math.sin(t * 0.5)
        hq = _quat_from_rpy_deg(3.0 + breathe * 2.0, -5.0 + math.sin(t * 0.33) * 1.5, 8.0 + breathe * 3.0)
        fq = _quat_from_rpy_deg(1.0, 0.5 * math.sin(t * 0.2), 3.0)
        # thumb tip: an opposition arc that follows the grasp (roll toward the
        # fingers as the hand closes) plus a small independent wander
        tq = _quat_from_rpy_deg(-30.0 + 25.0 * curls[0] + 4.0 * math.sin(t * 0.7),
                                12.0 + 22.0 * curls[0],
                                -18.0 + 6.0 * math.sin(t * 0.45))
        # MyoWare-scale envelope in ADC counts (the activation filter's native
        # units: rest floor ~90, strong contraction ~+420, small live jitter so
        # the auto rest/MVC normalization locks on like it does on the bench)
        emg_env = 90.0 + 420.0 * curls[0] + 6.0 * math.sin(t * 37.0)
        act = run_activation(emg_env, True)
        with state_lock:
            state["t_ms"] = int(t * 1000)
            state["enc"] = enc
            state["hq"] = hq
            state["fq"] = fq
            state["tq"] = tq
            state["thumb_live"] = True
            state["imu_live"] = [1, 1]
            state["emg_env"] = emg_env
            state["emg_rms"] = emg_env * 0.7
            state["emg_present"] = True
            state["activation"] = act
            state["last_rx"] = time.time()
            _note_sample_locked()
        update_joint_sweep(enc)
        time.sleep(dt)


def serial_thread(port_name, baud):
    """Open the Teensy, turn streaming on, parse S lines into `state`."""
    while True:
        try:
            # write_timeout: a wedged device (full OS buffer) must raise into
            # send_teensy's except instead of blocking the caller forever
            # while it holds ser_write_lock.
            ser = serial.Serial(port_name, baud, timeout=1, write_timeout=1)
        except Exception as e:
            print(f"[serial] open failed ({e}); retry in 2s")
            time.sleep(2); continue
        _ser["port"] = ser
        print(f"[serial] connected {port_name}; enabling stream")
        with state_lock:
            WATCH["dirty"] = True        # replay the selection to the fresh device
            WATCH["persisted"] = False   # until it echoes, nothing is confirmed
        try:
            with ser_write_lock:
                ser.write(b"v\nj\n")        # version handshake + stream ON
            last_assert = time.time()
            last_rescan = 0.0
            rescan_backoff = 2.0
            last_dui = 0.0
            last_sea_joint = 0.0
            best_enc = 0
            best_imu = 0
            while True:
                nowd = time.time()
                # Do not rely solely on the firmware's longer host watchdog:
                # camera-led motion has its own short liveness contract.  A
                # frozen tab, revoked camera permission or lost tracking
                # therefore drops torque within 250 ms rather than holding the
                # last pose while the browser recovers.
                if (CAMERA_FOLLOW["armed"] and CAMERA_FOLLOW["target"] is not None
                        and nowd - CAMERA_FOLLOW["t"] > CAMERA_FOLLOW_FRESH_S):
                    _camera_follow_disarm("camera target timeout")
                _camera_follow_arm_tick(nowd)
                # The DEVICE can disarm itself without telling anyone: a hardware
                # alarm, a sustained bus miss, or (v14) host silence while driving
                # all drop torque in firmware. If the bridge kept its own `armed`
                # flag true after that, every surface would keep reporting that
                # the finger was following while nothing was energized. Believe
                # the device.
                _dev_sea = _camera_follow_device()
                if (CAMERA_FOLLOW["armed"] and not CAMERA_FOLLOW.get("arm_pending")
                        and _dev_sea is not None and not _dev_sea.get("armed")):
                    _camera_follow_disarm("device disarmed itself (check motor fault)")
                if CAMERA_FOLLOW["armed"]:
                    pose = _camera_follow_pose()
                    if CAMERA_FOLLOW["zero"] is None:
                        # Not a sensor problem. Name it correctly: the encoders can
                        # be streaming perfectly and this still be true after a
                        # bridge restart.
                        _camera_follow_disarm("no neutral on this bridge: press Set neutral again")
                    elif pose is None:
                        _camera_follow_disarm("joint feedback unavailable (ch8/ch9 not reporting)")
                    else:
                        actual = {"mcp_deg": pose[0] - CAMERA_FOLLOW["zero"][0],
                                  "pip_deg": pose[1] - CAMERA_FOLLOW["zero"][1]}
                        CAMERA_FOLLOW["actual"] = actual
                        target = CAMERA_FOLLOW["target"]
                        if target is not None:
                            err = max(abs(actual["mcp_deg"] - target["mcp_deg"]),
                                      abs(actual["pip_deg"] - target["pip_deg"]))
                            if err > CAMERA_FOLLOW_ERROR_DEG:
                                if CAMERA_FOLLOW["error_since"] is None:
                                    CAMERA_FOLLOW["error_since"] = nowd
                                elif nowd - CAMERA_FOLLOW["error_since"] > CAMERA_FOLLOW_ERROR_HOLD_S:
                                    _camera_follow_disarm("tracking error: check cable routing/directions")
                            else:
                                CAMERA_FOLLOW["error_since"] = None
                _camera_follow_probe_tick(nowd)
                if nowd - last_dui > 0.15:          # push device_ui down to the on-wrist screen
                    last_dui = nowd
                    try:
                        with ser_write_lock:
                            ser.write(("D,%d,%d,%d\n" % (_dui.get("fw_idx", 1), _dui.get("fw_elapsed", 0), _dui.get("fw_mot", 0))).encode())
                    except Exception:
                        pass
                if WATCH["dirty"]:              # a UI changed the face: send it down
                    fi = _watch_face_index(WATCH["face"])
                    ci = _watch_cw_index(WATCH["face"], WATCH["colorway"])
                    if fi >= 0 and ci >= 0:
                        try:
                            with ser_write_lock:
                                ser.write(("W,%d,%d\n" % (fi, ci)).encode())
                            with state_lock:
                                WATCH["dirty"] = False   # persisted waits for the echo
                        except Exception:
                            pass
                    else:
                        with state_lock:
                            WATCH["dirty"] = False
                # Feed the firmware's two-independent-DOF SEA mode with the
                # *calibrated* anatomical MCP/PIP angles at the sensor cadence.
                # This command has no torque effect: MODE 4 remains zero-current
                # until a separate, explicit neutral/direction/arm sequence.
                # Keeping this bridge-to-Teensy link alive lets the firmware
                # reject a stale host sample rather than moving blind.
                if nowd - last_sea_joint >= 0.020:
                    with state_lock:
                        _sea_enc = list(state.get("enc", []))
                    if len(_sea_enc) > 9 and _sea_enc[8] >= 0.0 and _sea_enc[9] >= 0.0:
                        try:
                            _mcp = calibrated_joint(8, _sea_enc[8])[1]
                            _pip = calibrated_joint(9, _sea_enc[9])[1]
                            with ser_write_lock:
                                ser.write(("M,j,%.3f,%.3f\n" % (_mcp, _pip)).encode())
                            last_sea_joint = nowd
                        except Exception:
                            # A calibration can be edited while the bridge is
                            # live.  Skipping that frame is safer than emitting
                            # raw magnet angles as anatomy.
                            pass
                raw = ser.readline()
                if not raw:
                    # keep asserting stream-on in case it was toggled off
                    if time.time() - last_assert > 3:
                        with ser_write_lock:
                            ser.write(b"j\n")
                        last_assert = time.time()
                    continue
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("# ver"):
                    try:
                        _fw["version"] = int(line.split()[-1])
                    except ValueError:
                        _fw["version"] = 1
                    _fw["explicit_rec"] = _fw["version"] >= 2
                    print(f"[serial] firmware v{_fw['version']} "
                          f"(record: {'explicit b/e' if _fw['explicit_rec'] else 'legacy r toggle'})")
                    # The banner means the device just (re)booted, so its RAM copy
                    # of the direction signs is gone. Hand back the measured ones
                    # rather than making the wearer pull the finger again for an
                    # answer that is already on disk.
                    if _push_directions_to_device():
                        print("[follow] restored measured directions to the device")
                    continue
                if line.startswith("E,watch,"):
                    # the device confirming what it applied and saved:
                    # E,watch,<faceIdx>,<colorwayIdx>,<ok>
                    ep = line.split(",")
                    if len(ep) >= 5:
                        try:
                            fi, ci, ok = int(ep[2]), int(ep[3]), int(ep[4])
                        except ValueError:
                            continue
                        faces = WATCH_CATALOG["faces"]
                        if ok == 1 and 0 <= fi < len(faces):
                            cws = faces[fi].get("colorways", [])
                            if 0 <= ci < len(cws):
                                with state_lock:
                                    WATCH["face"] = faces[fi]["id"]
                                    WATCH["colorway"] = cws[ci]["id"]
                                    WATCH_LAST_CW[faces[fi]["id"]] = cws[ci]["id"]
                                    WATCH["persisted"] = True
                                    WATCH["source"] = "device"
                        else:
                            print(f"[watch] device rejected face {fi}/{ci}")
                    continue
                if line.startswith("E,"):
                    # on-device crown/button: E,<action>[,<dir-or-screen>]
                    ep = line.split(",")
                    if len(ep) >= 2 and ep[1] in ("nav", "press", "screen", "home", "cal"):
                        device_command(ep[1],
                                       direction=(ep[2] if ep[1] == "nav" and len(ep) > 2 else None),
                                       screen=(ep[2] if ep[1] == "screen" and len(ep) > 2 else None),
                                       source="device")
                    continue
                if not line.startswith("S,"):
                    continue
                p = line.split(",")
                # 1 tag + 1 t + 14 enc + 8 quat + 2 live = 26
                if len(p) < 26:
                    continue
                try:
                    t = int(float(p[1]))
                    enc = filter_encoders([float(x) for x in p[2:2 + N_CH]], t)
                    hq = [float(x) for x in p[2 + N_CH:2 + N_CH + 4]]
                    fq = [float(x) for x in p[2 + N_CH + 4:2 + N_CH + 8]]
                    il = [int(float(p[24])), int(float(p[25]))]
                    # EMG fields (env, rms, present) appended by the updated firmware;
                    # absent on the old firmware -> emg_present stays False (honest).
                    emg_env = float(p[26]) if len(p) > 26 else 0.0
                    emg_rms = float(p[27]) if len(p) > 27 else 0.0
                    emg_present = len(p) > 28 and int(float(p[28])) == 1
                    # crown pot (v3 firmware): 0..1000 -> 0..1; absent on older firmware
                    crown = max(0.0, min(1.0, int(float(p[29])) / 1000.0)) if len(p) > 29 else None
                    # thumb-tip IMU (v4 firmware): quat + live flag, appended after crown
                    if len(p) > 34:
                        tq = [float(p[30]), float(p[31]), float(p[32]), float(p[33])]
                        thumb_live = int(float(p[34])) == 1
                        _fw["thumb_capable"] = True
                    else:
                        tq, thumb_live = None, False
                    # ---- v6 firmware: the real motor block (pos/vel/current) ----
                    # Absent (not zeroed) on older firmware, so a client can tell
                    # "not streamed" from "streamed and reading zero".
                    motors_fw = None
                    if len(p) > CROWN_LIVE_IDX:
                        mf = int(float(p[MOT_FLAGS_IDX]))
                        motors_fw = {"flags": mf, "taken": bool(mf & 1),
                                     "torque": bool(mf & 2), "mode": (mf >> 2) & 7,
                                     # v13 moves fault from bit 4 to bit 5 because bit 4
                                     # now represents mode 4 (the two-independent-DOF SEA loop).
                                     # Old v12-and-earlier frames only use modes 0..3, so
                                     # their bit 4 remains a backwards-compatible fault.
                                     "fault": bool((mf & 32) or ((mf & 16) and ((mf >> 2) & 7) != 4)), "m": {}}
                        for _k in range(N_MOT_FW):
                            _b = MOT_BASE + 3 * _k
                            motors_fw["m"][_k + 1] = {
                                "pos": float(p[_b]), "vel": float(p[_b + 1]),
                                "ma": float(p[_b + 2])}
                        # v9 append-only diagnostics.  A v8 device remains fully
                        # supported; its aggregate fault flag is simply all we
                        # can know until it is flashed.
                        if len(p) >= MOTOR_DIAG_BASE + 8:
                            _d = [int(float(x)) for x in p[MOTOR_DIAG_BASE:MOTOR_DIAG_BASE + 8]]
                            _names = {
                                0: "none", 1: "configuration write", 2: "feedback seed",
                                3: "torque acknowledgement", 4: "sustained bus miss",
                                5: "servo hardware alarm", 6: "bus-watchdog rearm",
                                # v14: mode 4 was driving the finger and the host
                                # went silent for 600 ms. De-energized on purpose.
                                7: "host silence while driving (camera follow)",
                            }
                            motors_fw["diagnostic"] = {
                                "cause_code": _d[0], "cause": _names.get(_d[0], "unknown"),
                                "consecutive_misses": _d[1], "hardware_error": _d[2:4],
                                "total_misses": _d[4], "fast_fallbacks": _d[5],
                                "direct_fallbacks": _d[6],
                                "fast_read": bool(_d[7] & 1),
                                "indirect_read": bool(_d[7] & 2),
                            }
                        # v14 append-only: the DEVICE's own SEA readiness. This is
                        # the authority for camera-follow state from here on; the
                        # bridge's own flags are only a fallback for v13 firmware.
                        if len(p) > SEA_STATE_IDX:
                            _s = int(float(p[SEA_STATE_IDX]))
                            motors_fw["sea"] = {
                                "zeroed": bool(_s & 1), "armed": bool(_s & 2),
                                "directions": bool(_s & 4), "joint_fresh": bool(_s & 8),
                            }
                    # ---- v7 firmware: the FULL IMU set, 23 fields per sensor ----
                    # The offset is COMPUTED from the contract above, not written
                    # as a literal, so adding a motor or an encoder channel
                    # upstream cannot silently shift this tail and start reading
                    # motor current as an acceleration.
                    imu_full = None
                    if len(p) >= V7_BASE + 3 * V7_STRIDE:
                        imu_full = {}
                        for si, sk in enumerate(IMU_KEYS):
                            b = V7_BASE + si * V7_STRIDE
                            f = [float(x) for x in p[b:b + V7_STRIDE]]
                            imu_full[sk] = {
                                "lin":  f[0:3],    # linear acceleration, gravity removed
                                "acc":  f[3:6],    # accelerometer, gravity included
                                "gyr":  f[6:9],    # rad/s
                                "mag":  f[9:12],   # uT
                                "grv":  f[12:15],  # gravity vector
                                "game": f[15:19],  # game rotation vector (mag-immune)
                                "accuracy": {"acc": int(f[19]), "gyr": int(f[20]),
                                             "mag": int(f[21])},
                                "rot_accuracy_rad": f[22],
                            }
                        _fw["full_imu"] = True
                except Exception:
                    continue
                live_map = {"hand": bool(il[0]), "forearm": bool(il[1]),
                            "thumb": bool(thumb_live)}
                hq, fq, tq, orientation_source = select_orientation_quats(
                    hq, fq, tq, imu_full, live_map)
                # A sensor which claims live but supplies neither a valid game
                # nor primary quaternion is not live for pose purposes.  Keep
                # the last good state value below, and propagate the effective
                # flags so every client reports the dropout honestly.
                live_map = {"hand": live_map["hand"] and hq is not None,
                            "forearm": live_map["forearm"] and fq is not None,
                            "thumb": live_map["thumb"] and tq is not None}
                il = [int(live_map["hand"]), int(live_map["forearm"])]
                thumb_live = live_map["thumb"]
                # advance the Fable activation filter once per real sample (outside the lock)
                act = run_activation(emg_env, emg_present)
                # Strapdown integration, once per real sample and OUTSIDE the lock
                # (it is pure arithmetic on per-tracker state). Driven by the
                # firmware's own millisecond clock rather than host wall time, so
                # a scheduling hiccup on this machine cannot fake an acceleration.
                if imu_full:
                    t_s = t / 1000.0
                    raw_q = {"hand": hq, "forearm": fq,
                             "thumb": tq or [1.0, 0.0, 0.0, 0.0]}
                    for sk in IMU_KEYS:
                        if live_map[sk]:
                            d = imu_full[sk]
                            TRACKERS[sk].update(raw_q[sk], d["lin"], d["gyr"], t_s)
                        else:
                            # a dropped sensor must not resume integrating across
                            # the gap as if nothing happened
                            TRACKERS[sk].t = None
                with state_lock:
                    state["imu_full"] = imu_full
                    state["motors_fw"] = motors_fw
                    state["orientation_source"] = orientation_source
                    state["t_ms"] = t
                    state["enc"] = enc
                    # Hold last valid pose across a dropout.  Replacing it with
                    # the firmware's zero-filled placeholder produced the live
                    # ~9000 deg/s forearm reading at rest.
                    if hq is not None:
                        state["hq"] = hq
                    if fq is not None:
                        state["fq"] = fq
                    state["imu_live"] = il
                    state["emg_env"] = emg_env
                    state["emg_rms"] = emg_rms
                    state["emg_present"] = emg_present
                    state["crown"] = crown
                    if tq is not None:
                        state["tq"] = tq
                    state["thumb_live"] = thumb_live
                    state["activation"] = act
                    state["last_rx"] = time.time()
                    _note_sample_locked()        # shared recording counters (all clients)
                update_joint_sweep(enc)          # ROM sweep: capture open/closed extremes
                # Hot-plug recovery WITHOUT a routine stall.  A sensor that was
                # missing on the very first frame used to be forgotten forever:
                # best_imu started at zero, immediately became one, and only a
                # later DROP could trigger R.  Retry while either required
                # hand/forearm IMU is absent, with exponential backoff.  A
                # healthy rig never receives a rescan, and a hard wiring fault
                # cannot hitch the stream every 1.5 s as the old fixed cadence
                # did.
                n_enc_live = sum(1 for x in enc if x >= 0.0)
                n_imu_live = int(il[0]) + int(il[1])
                now = time.time()
                dropped = n_enc_live < best_enc or n_imu_live < best_imu
                missing_required_imu = n_imu_live < 2
                retry_due = missing_required_imu and now - last_rescan >= rescan_backoff
                if (dropped and now - last_rescan > 2.0) or retry_due:
                    with ser_write_lock:
                        ser.write(b"R\n")
                    last_rescan = now
                    rescan_backoff = min(30.0, rescan_backoff * 2.0)
                    best_enc, best_imu = n_enc_live, n_imu_live
                else:
                    if n_enc_live > best_enc:
                        best_enc = n_enc_live
                    if n_imu_live > best_imu:
                        best_imu = n_imu_live
                    if not missing_required_imu:
                        rescan_backoff = 2.0
        except Exception as e:
            print(f"[serial] lost link ({e}); reconnecting")
            try: ser.close()
            except Exception: pass
            _ser["port"] = None
            time.sleep(1)


_DOOM = {"seen": False}          # easter egg: latch so we log the first relay only


def send_teensy(cmd_byte):
    ser = _ser.get("port")
    if not ser:
        return
    try:
        with ser_write_lock:
            ser.write(cmd_byte)
    except Exception as e:
        print("[serial] write failed:", e)


# ---- tendon calibration + guarded position control --------------------------
# The spools now carry real tendons, so "enable torque" is a step that can break
# hardware. tendon.TendonCal owns that sequence (centre -> range -> proven
# zero-motion power-up -> slewed move inside a safe band) and every surface just
# sends it an action name. It writes M-lines through send_teensy, so it shares
# the same serial lock as everything else and cannot interleave a partial line.
def _tendon_send(line):
    send_teensy((line + "\n").encode())


def _tendon_motors():
    with state_lock:
        return state.get("motors_fw")


def _tendon_encoders():
    with state_lock:
        return state.get("enc")


# The physical tendon is on Dynamixel ID 1.  ID 2 is present on the bus but is
# not the wired spool and must never be selected by the public jog screen.
TENDON = tendon.TendonCal(_tendon_send, _tendon_motors, _tendon_encoders,
                          os.path.join(STATE_DIR, ".sensoryhand_tendon_cal.json"),
                          motor_id=1)


# ----- device screen UI: one state, owned here, broadcast to web twin + AR -----
# The physical GC9A01, the browser device-screen twin, and the AR app all render the
# SAME `device_ui`. Inputs: the on-device pot/encoder (nav), website actions, AR actions,
# and auto-transitions (boot->home, fault->safe, recording->capture).
DEVICE_MODES = ["home", "transparent", "capture", "operator", "calibrate"]
_dui = {"screen": "boot", "mode": "transparent", "menu_index": 1,
        "boot_start": None, "rec_start": None, "cal": False, "source": "device"}
_DUI_SCREENS = ("boot", "home", "transparent", "capture", "operator",
                "saved", "calibrate", "safe")
# Old web/AR clients used pages which never existed in the face engine.  Accept
# them at the boundary, but canonicalise immediately so the Teensy is never
# asked to show a phantom stage.
_DUI_ALIASES = {"ready": "home", "position": "operator", "playback": "saved",
                "summary": "saved", "fault": "safe"}


def device_command(action, direction=None, screen=None, source="website"):
    """Drive the device screen from any input source (pot/encoder, website, AR)."""
    s = _dui
    s["source"] = source
    if action == "screen":
        screen = _DUI_ALIASES.get(screen, screen)
    if action == "screen" and screen in _DUI_SCREENS:
        s["screen"] = screen
    elif action == "home":
        s["screen"] = "home"
    elif action == "cal":
        s["cal"] = bool(screen) if screen is not None else True
    elif action == "nav":
        # The streamlined public console exposes only left/right arrows.  Its
        # old navigation merely moved a hidden Home carousel and required a
        # centre press to enter the selected mode, leaving the visible arrows
        # apparently dead.  Make each arrow a complete, reversible mode switch.
        current = s["screen"] if s["screen"] in DEVICE_MODES else s["mode"]
        try:
            idx = DEVICE_MODES.index(current)
        except ValueError:
            idx = s.get("menu_index", 0) % len(DEVICE_MODES)
        idx = (idx + (1 if direction == "cw" else -1)) % len(DEVICE_MODES)
        s["menu_index"] = idx
        s["mode"] = DEVICE_MODES[idx]
        s["screen"] = s["mode"]
    elif action == "press":
        if s["screen"] == "home":
            s["mode"] = DEVICE_MODES[s["menu_index"]]
            s["screen"] = s["mode"]
        else:
            s["screen"] = "home"


def build_device_ui(device_up, rec, n_imu, n_live, act, joints):
    now = time.time()
    s = _dui
    if s["boot_start"] is None:
        s["boot_start"] = now
    if s["screen"] == "boot" and (now - s["boot_start"]) >= 2.0:
        s["screen"] = "home"
    if rec and s["rec_start"] is None:
        s["rec_start"] = now
    if not rec:
        s["rec_start"] = None
    # effective screen (auto-overrides layered over the selected screen)
    screen = s["screen"]
    if not device_up:
        screen = "safe"
    elif rec:
        screen = "capture"
    elif s["cal"] and screen not in ("boot", "safe"):
        screen = "calibrate"
    jm = {j["id"]: j for j in joints}
    mp = jm.get("index_pip", {})
    ang = max(0.0, min(90.0, mp.get("deg", 0.0))) if mp.get("ok") else 0.0
    rec_sec = (now - s["rec_start"]) if s["rec_start"] else 0.0
    lvl = act.get("level", 0.0) if act.get("present") else 0.0
    # firmware screen index (status UI): connecting0 ready1 transparent2 capture3 operator4 saved5 calib6 safe7
    _FW = {"connecting": 0, "boot": 1, "home": 1, "ready": 1,
           "transparent": 2, "capture": 3, "operator": 4,
           "saved": 5, "calibrate": 6, "safe": 7}
    s["fw_idx"] = _FW.get(screen, 1)
    s["fw_elapsed"] = int(rec_sec)
    s["fw_mot"] = 0    # motor bus is host-owned/not bridged yet -> MOT lamp red; set from count in P2
    # an auto-override means the screen being SHOWN is not the one that was
    # asked for; surfacing which and why is the difference between a control
    # that works and one that looks broken
    override = None
    if not device_up:
        override = "no device"
    elif rec:
        override = "recording"
    elif s["cal"] and s["screen"] not in ("boot", "safe"):
        override = "calibrating"
    return {
        "screen": screen, "mode": s["mode"], "menuIndex": s["menu_index"], "modes": DEVICE_MODES,
        "requested": s["screen"], "override": override, "screens": list(_DUI_SCREENS),
        "health": {"imu": n_imu > 0, "enc": n_live > 0, "drv": False, "lnk": device_up},
        "boot": min(1.0, (now - s["boot_start"]) / 2.0),
        "angleDeg": round(ang, 0), "targetDeg": 62,
        "effort": round(lvl, 3), "assist": lvl > 0.15,
        "recSec": round(rec_sec, 1), "recording": rec, "takeName": "rec-live",
        "calStep": 0, "calProgress": 0.0,
        "faultReason": "no data" if not device_up else "all torque off",
        "source": s["source"],
    }


def build_snapshot(hz):
    with state_lock:
        s = dict(state)
        enc = list(s["enc"]); hq = list(s["hq"]); fq = list(s["fq"]); il = list(s["imu_live"])
        rec = s["recording"]; last_rx = s["last_rx"]; t = s["t_ms"]
        act = dict(s.get("activation", ACT_ABSENT))
        crown = s.get("crown")
        tq_raw = list(s.get("tq", [1.0, 0.0, 0.0, 0.0]))
        thumb_live = bool(s.get("thumb_live"))
        imu_full_raw = s.get("imu_full")
        orientation_source = dict(s.get("orientation_source", {}))
        eco = {k: ECO[k] for k in ("mode", "feedback_on", "guided", "rep_goal", "reps_done",
                                   "profile", "task", "rec_id", "rec_start", "rec_samples")}
    device_up = (time.time() - last_rx) < 1.0 if last_rx else False
    if not device_up and not SIM_MODE:
        # Link loss: the last-received readings must not keep parading as
        # live sensors (frozen values previously stayed ok:true forever).
        enc = [-1.0] * len(enc)
        il = [0, 0]
        thumb_live = False
        imu_full_raw = None         # no link, no acceleration: say so, do not integrate
        act = dict(ACT_ABSENT)     # frozen EMG must not read as live effort
        crown = None               # a dead pot must not hold crown authority
        if BLEND["source"] == "crown":
            BLEND["source"] = "ui"           # release authority; a live crown re-claims
            BLEND["present"] = False
            BLEND["crown_ref"] = None
        WORLD["anchor"] = None     # never dead-reckon a wrist pose from a dead IMU
        WORLD["src"] = "none"

    # the wired finger's DOF come from ch8/9/10 (calibrated), overriding the
    # default channel map so the twin moves that finger, not scattered joints.
    validate_jcal_once(enc)
    joint_override = {}
    joint_calibrated = {}
    for ch in ENC_DOF:
        d = enc[ch] if ch < len(enc) else -1.0
        if d >= 0.0:
            jid, val = calibrated_joint(ch, d)
            joint_override[jid] = val
            dof, _ = ENC_DOF[ch]
            joint_calibrated[jid] = ch in ENC_OPEN and (dof == "abduct" or ch in ENC_CLOSED)

    joints = []
    n_live = 0
    for f in FINGERS:
        for seg in SEGMENTS:
            jid = f + "_" + seg
            if jid in joint_override:
                d = joint_override[jid]; ok = True
            elif SIM_MODE or ENC_JOINT_SPACE_DIRECT:
                ch = JOINT2CH[jid]
                if ch in ENC_DOF:
                    d = -1.0; ok = False   # wired channel: only drives the wired finger, not its default joint
                else:
                    d = enc[ch] if ch < len(enc) else -1000.0
                    ok = _enc_ok(d)
            else:
                # Hardware channels without a measured channel/zero/direction/
                # range remain visible in encoders[], but raw 0..360 magnet
                # angles are not allowed to drive anatomical joint nodes.
                d = -1.0; ok = False
            if ok:
                n_live += 1
            joints.append({"id": jid, "deg": round(d, 2) if ok else 0.0, "ok": ok,
                           "calibrated": bool(ok and (joint_calibrated.get(jid) or SIM_MODE or
                                                       ENC_JOINT_SPACE_DIRECT))})

    # raw hardware view: every physical channel 0..13, honest presence, plus the
    # joint it currently maps to (so the enc->finger mapping is visible directly).
    encoders = []
    n_enc = 0
    for ch in range(N_CH):
        d = enc[ch] if ch < len(enc) else -1000.0
        ok = _enc_ok(d)
        if ok:
            n_enc += 1
        if ch in ENC_DOF:
            joint_name = WIRED_FINGER + "_" + DOF_SEG[ENC_DOF[ch][0]]
        elif SIM_MODE or ENC_JOINT_SPACE_DIRECT:
            joint_name = CH2JOINT.get(ch)
        else:
            joint_name = None       # fitted sensor, mapping not measured yet
        encoders.append({"ch": ch, "deg": round(d, 2) if ok else -1.0, "ok": ok,
                         "joint": joint_name})

    global _imu_tare_pending, IMU_TARE_HAND, IMU_TARE_FOREARM
    # Stages 1+2 (align-or-remap, then the body-frame offset) are one call now, so
    # the hand, the forearm and the thumb all go through IDENTICAL code. They used
    # to differ - only the forearm got an offset applied, and the hand's was dead
    # config - which is why setting the hand offset appeared to do nothing.
    hq_r = imu_cfg_apply(hq, "hand")
    fq_r = imu_cfg_apply(fq, "forearm")
    if _imu_tare_pending and il[0] and il[1]:
        # Live flags alone are insufficient: old fixed-width frames could carry
        # a live bit beside a zero quaternion.  Only a genuine pair of rotations
        # may become the persistent home.
        if _valid_quat(hq_r) and _valid_quat(fq_r):
            IMU_TARE_HAND = quat_conj(_norm_quat(hq_r))
            IMU_TARE_FOREARM = quat_conj(_norm_quat(fq_r))
            _imu_tare_pending = False
            # provenance travels with the home (see _load_tare): which sensors were
            # genuinely streaming, and under which mounting config.
            _save_tare({"hand": bool(il[0]), "forearm": bool(il[1]),
                        "thumb": bool(thumb_live)})
    hq = quat_mul(IMU_TARE_HAND, hq_r)       # tare: left-multiply by the captured reference
    fq = quat_mul(IMU_TARE_FOREARM, fq_r)
    hq = quat_gain(hq, IMU_CFG["hand"]["gain"])      # sensitivity (1.0 = 1:1)
    fq = quat_gain(fq, IMU_CFG["forearm"]["gain"])
    hq = quat_flip_sense(hq, IMU_CFG["hand"]["flip"])
    fq = quat_flip_sense(fq, IMU_CFG["forearm"]["flip"])
    hand = {"quat": [round(v, 4) for v in hq], "rpy_deg": quat_to_rpy(*hq),
            "live": bool(il[0]), "source": orientation_source.get("hand", "unavailable")}
    forearm = {"quat": [round(v, 4) for v in fq], "rpy_deg": quat_to_rpy(*fq),
               "live": bool(il[1]), "source": orientation_source.get("forearm", "unavailable")}
    n_imu = int(il[0]) + int(il[1]) + (1 if thumb_live else 0)

    # ---- thumb-tip IMU (v4): tared world frame + pose relative to the hand.
    # The device mechanism stays thumb-out (locked scope); this is pure
    # SENSING of the wearer's thumb, so the frame is emitted only while the
    # sensor is actually reporting (absent = honestly absent).
    global _thumb_tare_pending, IMU_TARE_THUMB
    thumb = None
    if thumb_live:
        tq_r = imu_cfg_apply(tq_raw, "thumb")
        if _thumb_tare_pending:
            IMU_TARE_THUMB = quat_conj(tq_r)   # held pose (thumb extended) -> identity
            _thumb_tare_pending = False
            _save_tare({"hand": bool(il[0]), "forearm": bool(il[1]), "thumb": True})
        tqd = quat_mul(IMU_TARE_THUMB, tq_r)
        rel_thumb = quat_mul(quat_conj(hq), tqd)   # thumb expressed in the HAND frame
        thumb = {"quat": [round(v, 4) for v in tqd],
                 "rpy_deg": quat_to_rpy(*tqd),
                 "rel_quat": [round(v, 4) for v in rel_thumb]}

    # ---- relative hand-vs-forearm pose (the forearm is the static reference).
    # Orientation: q_rel = fq^-1 (x) hq, expressed in the forearm body frame
    # (identity at the tared neutral). Translation: the hand cannot translate
    # freely; it pivots about the WRIST, so the relative orientation moves the
    # hand-IMU point along a lever arm. Frame convention matches the twins'
    # model: +Z distal (fingers), +Y dorsal (up), +X thumb side. Units mm.
    global _rel_quat_hold
    rel_live = bool(il[0] and il[1])
    if rel_live:
        q_rel_raw = quat_mul(quat_conj(fq), hq)
        q_rel_valid = _unit_quat_or_none(q_rel_raw)
        if q_rel_valid is not None:
            _rel_quat_hold = q_rel_valid
        else:
            rel_live = False
            q_rel_raw = list(_rel_quat_hold)
    else:
        # Relative wrist orientation is a two-sensor measurement.  When either
        # side is absent, freeze the last valid pair rather than interpreting
        # absolute hand motion against a fabricated identity forearm.
        q_rel_raw = list(_rel_quat_hold)
    q_rel, wrist_deg, wrist_limited = constrain_wrist_quat(q_rel_raw)
    p = [REL_F2W_MM[i] + quat_rot_vec(q_rel, REL_W2H_MM)[i] for i in range(3)]
    dist = math.sqrt(_vdot(p, p))
    nowr = time.time()
    if _rel_prev["t"] is not None and nowr > _rel_prev["t"]:
        dtr = nowr - _rel_prev["t"]
        dp = [p[i] - _rel_prev["p"][i] for i in range(3)]
        sp = math.sqrt(_vdot(dp, dp)) / dtr            # |v| of the hand point
        ap = (dist - _rel_prev["dist"]) / dtr          # d(dist)/dt, - = closing
        k = 0.35                                       # EMA: readable, not jumpy
        _rel_prev["speed"] += (sp - _rel_prev["speed"]) * k
        _rel_prev["appr"] += (ap - _rel_prev["appr"]) * k
    _rel_prev.update(p=p, dist=dist, t=nowr)
    rel = {
        "quat": [round(v, 4) for v in q_rel],
        "raw_quat": [round(v, 4) for v in q_rel_raw],
        "wrist_deg": wrist_deg,
        "limited": wrist_limited,
        "limits_deg": {"flexion": WRIST_FLEX_LIMIT_DEG,
                       "deviation": WRIST_DEV_LIMIT_DEG,
                       "pronation": WRIST_PRON_LIMIT_DEG},
        "pos_mm": [round(v, 1) for v in p],
        "pos0_mm": [round(REL_F2W_MM[i] + REL_W2H_MM[i], 1) for i in range(3)],
        "dist_mm": round(dist, 1),
        "speed_mm_s": round(_rel_prev["speed"], 1),
        "approach_mm_s": round(_rel_prev["appr"], 1),
        "aligned": IMU_CFG["forearm"]["align"] is not None,
        "live": rel_live,
        "held": not rel_live,
    }

    # ---- inertial dead reckoning (v7 firmware only) -------------------------
    # Per-sensor integrated position, plus the hand-relative-to-forearm vector
    # the operator actually wants to plot. Both sensors integrate in their OWN
    # world frame, and those frames differ by exactly the rotation the 4-tap
    # alignment solves, so the forearm's displacement is rotated into the hand's
    # frame before differencing. Without an alignment the two frames are not
    # comparable, and `frames_aligned` says so rather than quietly returning a
    # number that mixes them.
    inertial = None
    if imu_full_raw:
        f_align = IMU_CFG["forearm"]["align"]
        # Liveness rides WITH the data. The firmware always emits three sensor
        # blocks, so an unfitted thumb streams a full row of zeros - which a
        # client cannot distinguish from a fitted sensor sitting perfectly still.
        # It showed up immediately on the bench as a thumb reading "MOVING" with
        # 0.000 everywhere.
        live_by_key = {"hand": bool(il[0]), "forearm": bool(il[1]), "thumb": bool(thumb_live)}
        for k, d in imu_full_raw.items():
            d["live"] = live_by_key.get(k, False)
        per = {k: TRACKERS[k].snapshot() for k in IMU_KEYS}
        for k in IMU_KEYS:
            per[k]["live"] = live_by_key.get(k, False)
        ph = TRACKERS["hand"].p
        pf = TRACKERS["forearm"].p
        pf_in_hand = quat_rot_vec(f_align, pf) if f_align else list(pf)
        d = [(ph[i] - pf_in_hand[i]) * 1000.0 for i in range(3)]   # mm
        conf = min(TRACKERS["hand"].confidence(),
                   TRACKERS["forearm"].confidence())
        inertial = {
            "per_imu": per,
            "rel_pos_mm": [round(v, 1) for v in d],
            "rel_dist_mm": round(math.sqrt(sum(v * v for v in d)), 1),
            "confidence": round(conf, 2),
            "frames_aligned": f_align is not None,
            # longest integration run of the pair: the honest bound on the number
            "since_zero_s": max((per[k].get("since_zero_s") or 0.0)
                                for k in ("hand", "forearm")),
            # Said out loud in the payload so no consumer can present this as a
            # position measurement: it is dead reckoning between standstills.
            "method": "strapdown double integration of linear acceleration, ZUPT-corrected",
            "drifts": True,
        }

    # ---- multimodal world fusion (see WORLD above): Quest anchors, IMU
    # bridges occlusion, next vision sample snaps drift away.
    if SIM_MODE:
        # sim vision: continuous wrist stream with a 2 s OCCLUSION window every
        # 9 s, so the fusion's quest->imu->quest handover is always exercised.
        # A client that streamed within the last 3 s OWNS vision (the fixture
        # stays quiet), so a real/emulated headset sees its own occlusions.
        client_recent = POSE.get("src") == "client" and (nowr - POSE["t_wall"]) < 3.0
        if not client_recent and (nowr % 9.0) < 7.0:
            sp, sq = _sim_pose(nowr)
            # joints=None: the fixture must never revive a stale client
            # hand-tracking packet as if it were fresh vision
            POSE.update(pos=sp, quat=sq, env=(envs[0]["id"] if envs else None),
                        joints=None, t_wall=nowr, src="sim")
    pose_fresh = (nowr - POSE["t_wall"]) < POSE_FRESH_S and POSE["pos"] is not None
    if pose_fresh:
        A = quat_mul(POSE["quat"], quat_conj(hq))          # IMU world -> Quest world
        WORLD["anchor"] = {"qpos": list(POSE["pos"]), "qquat": list(POSE["quat"]),
                           "rel_p": list(p), "A": A,
                           "Wf": quat_mul(A, fq)}          # forearm orientation, Quest frame
        WORLD["src"] = "quest"
        world = {"pos_m": [round(v, 4) for v in POSE["pos"]],
                 "quat": [round(v, 4) for v in POSE["quat"]],
                 "source": "quest-fused", "occluded": False}
    elif WORLD["anchor"] is not None:
        an = WORLD["anchor"]
        dq_mm = [p[i] - an["rel_p"][i] for i in range(3)]  # lever-model delta, forearm frame
        dw = quat_rot_vec(an["Wf"], dq_mm)                 # into the Quest world frame
        WORLD["src"] = "imu"
        world = {"pos_m": [round(an["qpos"][i] + dw[i] / 1000.0, 4) for i in range(3)],
                 "quat": [round(v, 4) for v in quat_mul(an["A"], hq)],
                 "source": "imu-model", "occluded": True}
    else:
        WORLD["src"] = "none"
        world = {"pos_m": None, "quat": None, "source": "none", "occluded": False}

    # ---- ecosystem layers: reps, motors (sim bank or honest absence), spark --
    now = time.time()
    _update_reps(joints)
    assist = _update_blend(crown, now)
    blend = {"assist": round(assist, 3), "transparent": round(1.0 - assist, 3),
             "source": BLEND["source"], "present": BLEND["present"] or SIM_MODE}
    if MOTORS:
        jm_deg = {j["id"]: j["deg"] for j in joints if j["ok"]}
        MOTORS.step(jm_deg, eco["feedback_on"], now)
        motors_list = MOTORS.motors_snapshot()
        actuators_list = MOTORS.actuators_snapshot()
    else:
        motors_list, actuators_list = [], []
    motors_up = bool(MOTORS)
    # REAL motors, when the firmware is streaming them (v6+). This used to be
    # sim-only, so on the bench the console showed no motors at all while the
    # Teensy was streaming their position, velocity and current the whole time.
    with state_lock:
        _mfw = state.get("motors_fw")
    if _mfw:
        # The firmware gives us *measured* position, velocity and current.  Use
        # the shared web-contract names here; the former pos/vel/cur aliases
        # made the Operator look empty despite valid servo telemetry.
        _mode_names = {0: "idle", 1: "assist", 2: "current", 3: "jog", 4: "sea"}
        motors_list = [
            {"id": f"spool_{mid}", "mode": _mode_names.get(_mfw["mode"], "idle"),
             "torque_on": _mfw["torque"],
             "pos_deg": m["pos"], "vel_dps": m["vel"], "current_ma": m["ma"],
             # Temperature and supply voltage are not read in the 2 kHz
             # firmware loop.  Keep them explicitly absent rather than make up
             # a healthy-looking value; the inspector explains this.
             "temp_c": None, "voltage_v": None,
             "sim": False, "bus_taken": _mfw["taken"], "fault": _mfw["fault"],
             "diagnostic": _mfw.get("diagnostic")}
            for mid, m in sorted(_mfw["m"].items())]
        motors_up = True
    if rec:
        # effort trace for the take preview: activation when present, else the
        # preferred (wired) finger's flexion normalized to its travel
        if act.get("present"):
            v = act.get("level", 0.0)
        else:
            cand = [j for j in joints if j["id"].endswith("_pip") and j["ok"]]
            pref = next((j for j in cand if j["id"].startswith(WIRED_FINGER)),
                        cand[0] if cand else None)
            v = 0.0 if pref is None else max(0.0, min(1.0, (pref["deg"] - FLEX_OPEN) /
                                                      (FLEX_CLOSED - FLEX_OPEN)))
        with state_lock:
            ECO["spark"].append(round(float(v), 3))
            if len(ECO["spark"]) > 24000:          # keep the whole story, halve the rate
                ECO["spark"] = ECO["spark"][::2]

    src = "sim" if SIM_MODE else "teensy"
    main_imu_ok = bool(il[0] and il[1])
    imu_total = 3 if (_fw['thumb_capable'] or SIM_MODE) else 2
    motor_detail = "host-owned (not bridged)"
    if _mfw:
        motor_detail = (f"firmware {len(motors_list)}/{len(motors_list)} · "
                        + ("torque on" if _mfw["torque"] else "bus idle"))
    elif motors_up:
        motor_detail = f"sim {len(motors_list)}/{len(motors_list)}"

    health = [
        {"stream": "encoders", "ok": n_live > 0, "rate_hz": hz, "detail": f"{n_live}/12"},
        # The digital wrist is a paired measurement: one main IMU is not a
        # degraded-success state.  Thumb remains optional, but hand+forearm are
        # both required before the IMU health gate turns green.
        {"stream": "imu", "ok": main_imu_ok, "rate_hz": hz if main_imu_ok else 0,
         "detail": f"main {int(bool(il[0])) + int(bool(il[1]))}/2 · {n_imu}/{imu_total}"},
        {"stream": "activation", "ok": act.get("present", False),
         "rate_hz": hz if act.get("present") else 0,
         "detail": ("EMG pin14 " + str(act.get("quality", ""))) if act.get("present") else "no EMG (pin 14)"},
        {"stream": "motors", "ok": motors_up, "rate_hz": hz if motors_up else 0,
         "detail": motor_detail},
        {"stream": "link", "ok": device_up, "rate_hz": hz,
         "detail": src if device_up else "no data"},
        {"stream": "tracking", "ok": world["source"] != "none",
         "rate_hz": hz if world["source"] != "none" else 0,
         "detail": {"quest-fused": "quest-fused (right wrist)",
                    "imu-model": "imu-only (occluded)",
                    "none": "no vision anchor"}[world["source"]]},
    ]

    device_ui = build_device_ui(device_up, rec, n_imu, n_live, act, joints)
    device_ui["health"]["drv"] = motors_up
    device_ui["blend"] = blend["assist"]      # the on-wrist screen shows the crown level too
    _dui["fw_mot"] = sum(1 for m in motors_list if m["torque_on"])

    act_out = dict(act)
    act_out["channels"] = [act.get("level", 0.0)] if act.get("present") else []

    # The firmware's own SEA readiness (v14+), or None on older builds. Read once
    # per snapshot so every field below describes the same instant.
    _cf_dev = _camera_follow_device()

    # Encoder-range calibration state, per flexion channel. A surface that offers
    # a calibration step needs to know which endpoints actually exist; until now
    # only the operator wizard tracked that, locally, so any other view had to
    # assume. Spans are MEASURED from the captured marks, never assumed from the
    # mechanical ROM constants.
    _range_cal = {}
    for _ch, _jid in ((8, "index_pip"), (9, "index_dip")):
        _o, _c = ENC_OPEN.get(_ch), ENC_CLOSED.get(_ch)
        _range_cal[_jid] = {
            "channel": _ch,
            "open": _o is not None,
            "closed": _c is not None,
            "span_deg": round(abs(_wrap180(_c - _o)), 1) if (_o is not None and _c is not None) else None,
        }

    elapsed_ms = int((now - eco["rec_start"]) * 1000) if rec else 0
    snap = {
        "kind": "snap", "t_ms": t,
        "state": "running" if rec else ("ready" if device_up else "fault"),
        "mode": eco["mode"],
        "safety": "ok" if device_up else "fault",
        "blend": blend,
        "link": {"device": device_up, "motors": motors_up, "clients": len(CLIENTS),
                 "lan": LAN_IP, "port": WS_PORT},
        "hand": hand, "forearm": forearm, "rel": rel, "world": world,
        "orientation_source": orientation_source,
        # the full BNO085 report set, and what it integrates to. Both are absent
        # (not zeroed) on pre-v7 firmware, so a client can tell "not streamed"
        # from "streamed and reading zero".
        "imu_full": imu_full_raw,
        "inertial": inertial,
        "joints": joints, "encoders": encoders,
        "activation": act_out,
        "motors": motors_list,
        # Published so the camera surface can show the physical controller's
        # state, not merely its own optimistic UI state.  Targets become stale
        # after 250 ms; this is the same window that protects the firmware from
        # a frozen tab or lost camera stream.
        "camera_follow": {
            # The DEVICE is the authority on all three prerequisites whenever it
            # reports them (firmware v14+). The bridge's own flags are what it
            # requested, which is not the same thing and used to be published as
            # if it were. `confirmed` tells a UI which of the two it is seeing.
            # With the device DOWN nothing is satisfied, whatever either side
            # remembers: falling back to the bridge's own flags here would be the
            # same optimism this layer exists to remove, only worse, because the
            # hardware is not even present.
            "armed": (bool(_cf_dev["armed"]) if _cf_dev else CAMERA_FOLLOW["armed"]) and device_up,
            "zeroed": (bool(_cf_dev["zeroed"]) if _cf_dev else CAMERA_FOLLOW["zeroed"]) and device_up,
            "directions": (bool(_cf_dev["directions"]) if _cf_dev
                           else CAMERA_FOLLOW["directions"]) and device_up,
            "joint_fresh": bool(_cf_dev["joint_fresh"]) if _cf_dev else None,
            "confirmed": _cf_dev is not None,
            "arming": bool(CAMERA_FOLLOW.get("arm_pending")),
            # Per-axis learned signs and which probe is in flight, so the UI can
            # show a MEASURED direction instead of asking the wearer to guess one.
            "direction_values": dict(CAMERA_FOLLOW.get("direction_values") or {}),
            "probing": (CAMERA_FOLLOW.get("probe") or {}).get("axis"),
            # Which encoder endpoints exist, and the span actually measured
            # between them. The follow's own targets run through the same
            # calibration, so a surface that can arm should be able to see it.
            "range_cal": _range_cal,
            "target": CAMERA_FOLLOW["target"],
            "actual": CAMERA_FOLLOW["actual"],
            "fresh": bool(CAMERA_FOLLOW["target"] and (now - CAMERA_FOLLOW["t"]) < CAMERA_FOLLOW_FRESH_S),
            "limit": dict(CAMERA_FOLLOW_LIMIT),
            "reason": ("device link down: check the USB cable to the Teensy"
                       if not device_up else CAMERA_FOLLOW["reason"]),
        },
        "tendon": TENDON.public(),
        "actuators": actuators_list,
        "device_ui": device_ui,
        "watch": _watch_public(),
        "health": health,
        "session": {"recording": rec, "paused": False, "id": eco["rec_id"],
                    "profile": eco["profile"], "task": eco["task"], "storage": "sd",
                    "elapsed_ms": elapsed_ms, "samples": eco["rec_samples"],
                    "quality": "good"},
        "reps": {"done": eco["reps_done"], "goal": eco["rep_goal"],
                 "active": eco["guided"] or eco["mode"] == "rhythm"},
    }
    if thumb:
        snap["thumb"] = thumb          # present only while the tip sensor reports

    # SEA control layer: present only while the sea runner publishes (fresh
    # < 2 s). The frame is forwarded verbatim - its `sim` and `label:
    # "estimated"` markers are the honesty contract; motors[] stays honest
    # (the runner owns the bus, this bridge still does not).
    if SEA["frame"] is not None and (now - SEA["t"]) < SEA_FRESH_S:
        snap["sea"] = SEA["frame"]
    if SEA_CMD["cmd"] is not None:
        snap["sea_cmd"] = SEA_CMD["cmd"]

    # ---- 4D replay: host-side sample log. One compact row per broadcast tick
    # while recording, sealed into a per-take data file on stop. Pose comes
    # from the AR client's wrist stream (or the sim fixture) when fresh.
    if rec:
        # (sim self-posing now happens every tick in the fusion block above)
        fresh = (now - POSE["t_wall"]) < POSE_FRESH_S and POSE["pos"] is not None
        row = [int(t)]
        # finger columns: real encoders when the rig reports; else the
        # headset's hand-tracking (real vision) when the AR client streams it;
        # else whatever the pipeline carries (sim, labelled on the take).
        vj = POSE["joints"] if fresh else None
        jcols, used_vision = _joint_row_cols(joints, vj, SIM_MODE)
        row += jcols                                                 # 12 joints
        used_enc = any(j.get("ok") for j in joints)
        row += [round(v, 4) for v in hand["quat"]]
        row += [round(v, 4) for v in forearm["quat"]]
        row += [round(v, 4) for v in (thumb["rel_quat"] if thumb else [0, 0, 0, 0])]
        row.append(round(blend["assist"], 3))
        row.append(round(act.get("level", 0.0), 3))
        if fresh:
            row += [round(v, 4) for v in POSE["pos"]]
            row += [round(v, 4) for v in POSE["quat"]]
        else:
            row += [None] * 7
        # thumb columns (2026-07-20): only the headset's vision measures the
        # thumb (the rig is thumb-out); None whenever no fresh vision thumb.
        th = (vj or {}).get("thumb") if fresh else None
        row += ([round(float(v), 2) for v in th] if th else [None] * 3)
        # inertial translation (v7 firmware): the headset-free motion source.
        # None rather than zeros on older firmware, so a replay can tell "this
        # take had no acceleration data" from "the hand genuinely did not move".
        iner = snap.get("inertial")
        if iner:
            hp = iner["per_imu"]["hand"]["pos_mm"]
            fp = iner["per_imu"]["forearm"]["pos_mm"]
            row += [hp[0], hp[1], hp[2], fp[0], fp[1], fp[2], iner["confidence"]]
        else:
            row += [None] * 7
        with state_lock:
            if len(ECO["rows"]) < REC_ROWS_CAP:
                ECO["rows"].append(row)
                # source counters track LOGGED rows only, so the label always
                # describes the data actually in the file
                if used_vision:
                    ECO["rows_vision"] += 1
                if used_enc:
                    ECO["rows_enc"] += 1
                if len(ECO["rows"]) == REC_ROWS_CAP:
                    print(f"[takes] replay row log capped at {REC_ROWS_CAP} rows "
                          "(~33 min at 60 Hz); recording continues, further rows "
                          "are not logged (a forgotten recording used to grow "
                          "without bound until RAM ran out)")
            if fresh and POSE["env"]:
                ECO["rec_env"] = POSE["env"]   # last fresh env wins (the room you ended in)
    return snap


# ============================================================================
# MULTI-CLIENT HUB
#
# One broadcast loop builds ONE snapshot per tick. That loop is the only place
# derived shared state advances (IMU tare capture, relative-pose EMA, sim
# motors, rep counting), so N clients see identical physics instead of racing
# it. Each client gets a single writer task fed by (a) a bounded reliable
# queue for acks + take pushes and (b) a latest-wins snapshot slot: a slow
# client drops frames instead of stalling the hub or growing memory, and a
# fast client never waits on a slow one.
# ============================================================================
SIM_MODE = False
CLIENTS = set()

def _lan_ip():
    """Best-effort LAN address for QR pairing.

    Connecting a UDP socket sends no packets: it only asks the kernel which
    local interface would be used to reach the target, which is what we want.
    The target is TEST-NET-1 (RFC 5737), a reserved documentation address, so
    this never references or contacts a third-party service.
    """
    import socket as _s
    try:
        sk = _s.socket(_s.AF_INET, _s.SOCK_DGRAM)
        sk.connect(("192.0.2.1", 80))
        ip = sk.getsockname()[0]
        sk.close()
        return ip
    except Exception:
        return None

LAN_IP = _lan_ip()
_hub_started = False
_client_seq = [0]


class ClientSession:
    def __init__(self, ws):
        self.ws = ws
        _client_seq[0] += 1
        self.n = _client_seq[0]
        self.outbox = deque(maxlen=64)      # reliable messages (acks, takes)
        self.latest = None                  # latest-wins snapshot text
        self.wake = asyncio.Event()
        try:
            self.remote = "%s:%s" % ws.remote_address[:2]
        except Exception:
            self.remote = "?"

    def queue(self, msg):
        self.outbox.append(msg if isinstance(msg, str) else wire_json(msg))
        self.wake.set()

    def offer_snap(self, text):
        self.latest = text
        self.wake.set()


def wire_json(obj):
    """Wire-path JSON: compact separators. Identical semantics to json.dumps,
    ~12% fewer bytes on every websocket frame (and proportionally less encode
    here + JSON.parse work in every client at 60 Hz; biggest on the multi-MB
    env/take pushes). Persistence files keep the default format on purpose."""
    return json.dumps(obj, separators=(",", ":"))


def broadcast(msg):
    """Reliable push to every connected client (take-library changes)."""
    text = msg if isinstance(msg, str) else wire_json(msg)
    for c in list(CLIENTS):
        c.queue(text)


async def _client_writer(c):
    try:
        while True:
            await c.wake.wait()
            c.wake.clear()
            while c.outbox:
                await c.ws.send(c.outbox.popleft())
            if c.latest is not None:
                text, c.latest = c.latest, None
                await c.ws.send(text)
    except Exception:
        pass          # connection closed; the reader side tears the client down


async def _broadcast_loop():
    # drift-free absolute schedule: sleeping a fixed 1/HZ AFTER the build work
    # made the real rate HZ-minus-work and let jitter accumulate; anchoring to
    # t0 + n/HZ keeps the cadence exact and the queueing delay minimal
    loop = asyncio.get_running_loop()
    period = 1.0 / HZ
    next_t = loop.time() + period
    while True:
        try:
            text = wire_json(build_snapshot(HZ))
            for c in list(CLIENTS):
                c.offer_snap(text)
        except Exception as e:
            print("[ws] snapshot build failed:", e)
        delay = next_t - loop.time()
        if delay < -1.0:                 # fell far behind (debugger, laptop sleep)
            next_t = loop.time() + period
            delay = period
        await asyncio.sleep(max(0.0, delay))
        next_t += period


def _ensure_hub():
    global _hub_started
    if not _hub_started:
        _hub_started = True
        _ensure_sim_env()
        asyncio.get_running_loop().create_task(_broadcast_loop())


def _ack(c, **kw):
    c.queue({"kind": "ack", **kw})


def handle_command(c, raw):
    """Validate + apply one client command. Ecosystem rule: state-changing
    commands mutate the ONE shared session (visible to every client on the
    next snapshot); acks answer only the commanding client."""
    try:
        cmd = json.loads(raw)
    except Exception:
        return
    if not isinstance(cmd, dict):
        return
    name = cmd.get("cmd")
    if name == "ping":
        return

    # ---- per-IMU mounting configuration (the #/imu console surface) ----------
    # The whole point of this command is that a mounting correction is a bench
    # OBSERVATION, so it must be settable while looking at the sensor, take
    # effect on the very next frame, and persist without a restart. Every reply
    # broadcasts the full config, so two open consoles never disagree.
    if name == "imu_cfg":
        action = cmd.get("action", "get")
        if action == "get":
            _ack(c, event="imu_cfg", ok=True, cfg=IMU_CFG, presets=IMU_OFFSET_PRESETS)
            return
        if action == "reset":
            who = cmd.get("imu")
            if who in (None, "all"):
                for k in IMU_KEYS:
                    IMU_CFG[k] = copy.deepcopy(IMU_CFG_DEFAULT[k])
            elif who in IMU_KEYS:
                IMU_CFG[who] = copy.deepcopy(IMU_CFG_DEFAULT[who])
            else:
                _ack(c, event="imu_cfg", ok=False, error=f"unknown imu {who!r}")
                return
            imu_cfg_save()
            broadcast({"kind": "imu_cfg", "cfg": IMU_CFG})
            _ack(c, event="imu_cfg", ok=True, cfg=IMU_CFG)
            return
        if action == "set":
            who = cmd.get("imu")
            clean, err = imu_cfg_validate(who, cmd.get("patch") or {})
            if err:
                # Refusing loudly matters here: a silently-dropped bad remap is
                # indistinguishable from "this setting does nothing", which is
                # how the previous round of orientation work lost its afternoons.
                _ack(c, event="imu_cfg", ok=False, imu=who, error=err)
                return
            # setting a remap by hand means the user is overriding the solved
            # alignment; clear it, or the align would keep winning and the new
            # remap would look like it did nothing.
            if "remap" in clean and IMU_CFG[who].get("align") is not None:
                IMU_CFG[who]["align"] = None
            IMU_CFG[who].update(clean)
            imu_cfg_save()
            broadcast({"kind": "imu_cfg", "cfg": IMU_CFG})
            _ack(c, event="imu_cfg", ok=True, imu=who, cfg=IMU_CFG)
            return
        _ack(c, event="imu_cfg", ok=False, error=f"unknown action {action!r}")
        return

    # ---- re-zero the inertial trackers -------------------------------------
    # Dead reckoning has no absolute origin, so "where is the hand" only means
    # anything relative to a moment the operator chose. The learned accelerometer
    # bias survives: it belongs to the sensor, not to the reference point.
    if name == "imu_zero":
        for k in IMU_KEYS:
            TRACKERS[k].reset(keep_bias=True)
        _ack(c, event="imu_zero", ok=True)
        return

    if name == "calibrate":
        what = cmd.get("what")
        # Captures need LIVE sensor data: with the link down, state["enc"] still
        # holds the last-received (frozen) degrees, and a capture would persist
        # them over the real bench calibration with a success ack. (The IMU tare
        # is inherently gated on the live flags; the encoder path was not.)
        if what in ("imu", "neutral", "joints_open", "joints_closed", "joint_closed",
                    "sweep_start", "sweep_stop") and not SIM_MODE:
            with state_lock:
                lr = state["last_rx"]
            if not lr or (time.time() - lr) >= 1.0:
                _ack(c, event="error", error="calibration needs a live device")
                return
        if what == "imu_align":
            # 4-tap functional axis calibration (see imu_align_step). `imu`
            # defaults to the forearm so pre-2026-08-06 clients keep working.
            res = imu_align_step(cmd.get("step", ""), cmd.get("imu", "forearm"))
            _ack(c, event="imu_align", **res)
            if res.get("ok"):
                broadcast({"kind": "imu_cfg", "cfg": IMU_CFG})
        elif what == "imu":
            trigger_imu_tare()    # capture the current pose as the aligned reference
            _ack(c, event="calibrated")
        elif what == "neutral":
            # arm-flat, fingers-extended pose = the zero: tare both IMUs AND set
            # the flexion OPEN (extended) reference in one capture.
            trigger_imu_tare()
            with state_lock:
                enc_now = list(state["enc"])
            capture_joint_ref("open", enc_now)
            _ack(c, event="calibrated")
        elif what == "joint_closed":
            try:
                ch = int(cmd.get("channel"))
            except (TypeError, ValueError):
                _ack(c, event="error", error="invalid encoder channel")
                return
            with state_lock:
                enc_now = list(state["enc"])
            raw = enc_now[ch] if 0 <= ch < len(enc_now) else None
            res = capture_joint_closed(ch, raw)
            if res.get("ok"):
                _ack(c, event="calibrated", channel=ch, travel={ch: res["travel"]})
            else:
                _ack(c, event="error", error=res["error"])
        elif what in ("joints_open", "joints_closed"):
            with state_lock:
                enc_now = list(state["enc"])
            which = "open" if what == "joints_open" else "closed"
            capture_joint_ref(which, enc_now)
            travel = {}
            if which == "closed":
                for ch in ENC_DOF:
                    o, cl = ENC_OPEN.get(ch), ENC_CLOSED.get(ch)
                    if o is not None and cl is not None:
                        travel[ch] = round(abs(_wrap180(cl - o)), 1)
                _save_jcal()      # persist the two-point calibration
            _ack(c, event="calibrated", travel=travel)
        elif what in ("joints", "range"):
            ENC_OPEN.clear(); ENC_CLOSED.clear(); _cont_open.clear()   # restart the finger calibration
            _ack(c, event="calibrated")
        elif what == "sweep_start":
            with state_lock:
                enc_now = list(state["enc"])
            start_joint_sweep(enc_now)       # anchor open at the current (open) pose
        elif what == "sweep_stop":
            res = finish_joint_sweep()
            _ack(c, event="calibrated", travel=res)
        elif what == "emg":
            trigger_emg_recal()   # forget rest/MVC; next rest + max contraction re-scale
        else:
            _ack(c, event="error", error="unknown calibration")
        return

    if name == "device":          # device screen nav/state (pot/encoder, web, or AR)
        action = cmd.get("action")
        if action not in ("nav", "press", "home", "screen", "cal"):
            _ack(c, event="error", error="unknown_device_action", cmd="device")
            return
        scr = cmd.get("screen")
        # only "screen" carries a screen NAME; "cal" reuses the field as a flag,
        # which older AR clients rely on, so it is left alone
        canonical_scr = _DUI_ALIASES.get(scr, scr) if isinstance(scr, str) else scr
        if action == "screen" and canonical_scr not in _DUI_SCREENS:
            _ack(c, event="error", error="unknown_screen", cmd="device")
            return
        if action == "nav" and cmd.get("dir") not in ("cw", "ccw"):
            _ack(c, event="error", error="unknown_direction", cmd="device")
            return
        device_command(action, direction=cmd.get("dir"), screen=canonical_scr,
                       source=cmd.get("source", "website"))
        with state_lock:
            _ack(c, event="device", action=action, requested=_dui["screen"],
                 mode=_dui["mode"], source=_dui["source"])
        return

    if name == "record":
        action = cmd.get("action")
        if action == "start":
            prof = cmd.get("profile") or cmd.get("patient") or {}
            pname = prof.get("name") if isinstance(prof, dict) else str(prof)
            task = cmd.get("task") or cmd.get("session")     # AR labels via "session"
            notes = cmd.get("notes") or cmd.get("note")
            take_id, _started = record_start(pname, task, notes)
            _ack(c, event="rec_started", id=take_id)
        elif action == "stop":
            take = record_stop()
            _ack(c, event="rec_stopped", id=take["id"] if take else None)
            if take:
                broadcast({"kind": "takes", "takes": takes})
        return

    if name == "tendon":          # guarded tendon calibration (web Calibration card)
        # Every safety rule lives in tendon.TendonCal, not here and not in the
        # UI: the console only names a step. Refusals come back as an error ack
        # so the operator sees WHY rather than a button that quietly does nothing.
        # The jog surface sends a relative ``delta``.  Passing only ``to`` and
        # ``home`` made every otherwise-valid +/- press reach TendonCal without
        # its magnitude, where it was correctly refused as "jog needs a delta".
        ok, err = TENDON.action(cmd.get("action") or "status",
                                to=cmd.get("to"), home=bool(cmd.get("home")),
                                delta=cmd.get("delta"))
        if not ok:
            _ack(c, event="error", error=err)
        else:
            _ack(c, event="tendon", phase=TENDON.public()["phase"])
        broadcast({"kind": "tendon", "tendon": TENDON.public()})
        return

    if name == "motor":           # operator dev tool (web Control / Android Control)
        if MOTORS is None:
            _ack(c, event="error", error="motors not bridged on this host")
            return
        ok, err = MOTORS.command(cmd.get("id"), torque=cmd.get("torque"),
                                 mode=cmd.get("mode"), setpoint_ma=cmd.get("setpoint_ma"))
        if not ok:
            _ack(c, event="error", error=err)
        return

    if name == "guided":          # guided session (web Guided / Android Session)
        with state_lock:
            if cmd.get("action") == "start":
                ECO["guided"] = True
                ECO["reps_done"] = 0
                g = cmd.get("goal")
                if isinstance(g, (int, float)) and 1 <= g <= 999:
                    ECO["rep_goal"] = int(g)
            else:
                ECO["guided"] = False
        return

    if name == "mode":            # AR experience mode; nudges the shared device screen
        m = cmd.get("mode")
        if m in AR_MODES:
            with state_lock:
                if m != ECO["mode"] and m in ("rhythm", "capture"):
                    ECO["reps_done"] = 0     # fresh count for a fresh activity
                ECO["mode"] = m
            device_command("screen", screen=_MODE_NUDGE.get(m), source="ar")
        return

    if name == "goal":            # AR rep goal
        g = cmd.get("value")
        if isinstance(g, (int, float)) and 1 <= g <= 999:
            with state_lock:
                ECO["rep_goal"] = int(g)
        return

    if name == "feedback":        # AR TOUCH arm/disarm
        with state_lock:
            ECO["feedback_on"] = bool(cmd.get("on"))
        return

    if name == "blend":           # UI-set transparency; real crown motion reclaims it
        lv = cmd.get("level")
        if isinstance(lv, (int, float)) and 0.0 <= lv <= 1.0:
            BLEND["source"] = "ui"
            BLEND["target"] = float(lv)
            BLEND["present"] = True
            with state_lock:
                BLEND["crown_ref"] = state.get("crown")   # motions are measured from here
        return

    if name == "sea":             # the SEA runner publishes its control state
        f = cmd.get("sea")
        if isinstance(f, dict):
            SEA["frame"] = f
            SEA["t"] = time.time()
        return

    if name == "watch":           # the on-device face engine (face + colorway)
        if not WATCH_CATALOG["faces"]:
            _ack(c, event="error", error="catalog_unavailable", cmd="watch")
            return
        face = cmd.get("face")
        cw = cmd.get("colorway")
        if cmd.get("action") == "list" or (face is None and cw is None):
            c.queue({"kind": "watch_catalog", **WATCH_CATALOG})
            _ack(c, event="watch", **_watch_public())
            return
        # validate BOTH before changing anything: a rejected command must leave
        # the device showing exactly what it was showing
        new_face = WATCH["face"]
        if face is not None:
            if not isinstance(face, str) or _watch_face_index(face) < 0:
                _ack(c, event="error", error="unknown_face", cmd="watch")
                return
            new_face = face
        new_cw = cw
        if new_cw is None:
            new_cw = (WATCH_LAST_CW.get(new_face) if face is not None
                      else WATCH["colorway"])
            if new_cw is None or _watch_cw_index(new_face, new_cw) < 0:
                new_cw = _watch_default_cw(new_face)
        if not isinstance(new_cw, str) or _watch_cw_index(new_face, new_cw) < 0:
            _ack(c, event="error", error="unknown_colorway", cmd="watch")
            return
        with state_lock:
            WATCH["face"] = new_face
            WATCH["colorway"] = new_cw
            WATCH_LAST_CW[new_face] = new_cw
            WATCH["persisted"] = False        # only the device's echo sets this
            WATCH["source"] = "host"
            WATCH["dirty"] = True             # push on the next serial tick
        _ack(c, event="watch", **_watch_public())
        return

    if name == "sea_target":      # UI -> SEA runner relay (bench view)
        act = cmd.get("action")
        if act not in (None, "home", "run", "stop"):
            _ack(c, event="error", error="unknown sea action")
            return
        clean = {}
        tgt = cmd.get("target")
        if isinstance(tgt, dict):
            for k in ("mcp_deg", "pip_deg"):
                v = tgt.get(k)
                if isinstance(v, (int, float)) and math.isfinite(v):
                    clean[k] = max(-10.0, min(110.0, float(v)))
        SEA_CMD["seq"] += 1
        SEA_CMD["cmd"] = {"seq": SEA_CMD["seq"]}
        if act:
            SEA_CMD["cmd"]["action"] = act
        if clean:
            SEA_CMD["cmd"]["target"] = clean
        _ack(c, event="sea_cmd", seq=SEA_CMD["seq"])
        return

    if name == "camera_follow":
        # Camera-to-wearable gateway.  It is deliberately a small state
        # machine, not a generic serial passthrough: all motion remains inside
        # firmware mode 4's independent MCP/PIP impedance loop and its 30 mA,
        # fresh-joint, bus-watchdog and hardware-fault protections.
        action = cmd.get("action")
        if _ser.get("port") is None:
            _ack(c, event="error", error="Teensy link is down; camera follow remains disarmed")
            return
        if action == "neutral":
            # A neutral is only valid torque-off.  It is explicitly requested
            # after the wearer puts both joints in their relaxed pose.
            pose = _camera_follow_pose()
            if pose is None:
                _ack(c, event="error", error="MCP/PIP encoder feedback is unavailable")
                return
            _camera_follow_disarm("capturing neutral")
            _camera_follow_write("M,z,1")
            # The firmware only accepts M,z with torque OFF and a joint sample
            # younger than 150 ms, so this can be refused. Record the bridge-side
            # zero (needed for the `actual` display) but let the device's own
            # seaState decide whether `zeroed` is true - see build_snapshot.
            CAMERA_FOLLOW.update(zeroed=True, zero=pose, actual={"mcp_deg": 0.0, "pip_deg": 0.0},
                                 reason="neutral requested")
            _ack(c, event="camera_follow", **CAMERA_FOLLOW)
            return
        if action == "directions":
            # The UI requires an explicit human confirmation that a prior
            # low-current ID test established these signs.  Guessing a sign is
            # unsafe: it can make corrective motion pull the wrong cable.
            d = cmd.get("directions")
            if (not cmd.get("confirmed") or not isinstance(d, dict)
                    or d.get("mcp") not in (-1, 1) or d.get("pip") not in (-1, 1)):
                _ack(c, event="error", error="confirm measured MCP/PIP directions first")
                return
            _camera_follow_disarm("directions updated")
            _camera_follow_write("M,d,%d,%d" % (d["mcp"], d["pip"]))
            CAMERA_FOLLOW.update(directions=True, reason="directions confirmed")
            _ack(c, event="camera_follow", **CAMERA_FOLLOW)
            return
        if action == "identify":
            axis = cmd.get("axis")
            if axis not in ("mcp", "pip"):
                _ack(c, event="error", error="choose MCP or PIP for direction learning")
                return
            if not _cf_prereq()[0]:
                _ack(c, event="error", error="capture relaxed neutral before direction learning")
                return
            if CAMERA_FOLLOW.get("probe") is not None:
                _ack(c, event="error", error="direction learning is already running")
                return
            pose = _probe_raw_pose()      # the probe's own unclamped reference
            if pose is None:
                _ack(c, event="error", error="MCP/PIP encoder feedback is unavailable")
                return
            # Motor 1 owns MCP, motor 2 owns PIP.  This is an identification
            # pulse, not a range command: it is only 12 mA for 150 ms and is
            # zeroed/torque-off by _camera_follow_probe_tick immediately after.
            motor = 1 if axis == "mcp" else 2
            # BASELINE IS MEASURED, NOT ASSUMED. Whatever this joint and this
            # motor read right now - including any pretension the fitted SEA
            # already carries - is the reference the probe reports deltas from.
            # No spring model, no theoretical tension, no threshold the hardware
            # has to match.
            with state_lock:
                _m0 = ((state.get("motors_fw") or {}).get("m") or {}).get(motor) or {}
            base_ma = abs(float(_m0.get("ma", 0.0)))
            _camera_follow_disarm("learning %s direction" % axis.upper())
            _camera_follow_write("M,t,1")
            _camera_follow_write("M,m,2")
            _camera_follow_write("M,c,%d,%.0f" % (motor, PROBE_MA_START))
            _camera_follow_write("M,e,1")
            CAMERA_FOLLOW["probe"] = {"axis": axis, "motor": motor, "start": pose,
                                      "phase": "ramp", "t": time.time(),
                                      "ma": PROBE_MA_START, "peak": PROBE_MA_START,
                                      "base_ma": base_ma, "peak_read_ma": base_ma,
                                      "moved": 0.0, "max_since": time.time()}
            _ack(c, event="camera_follow", **CAMERA_FOLLOW)
            return
        if action == "arm":
            # Firmware v13 is the first build with mode 4.  Refuse to send a
            # torque-on sequence to an older controller that would interpret
            # the command differently.
            if _fw.get("version", 0) < 13:
                _ack(c, event="error", error="camera follow needs firmware v13 or newer")
                return
            _z, _d = _cf_prereq()
            if not _z or not _d:
                _ack(c, event="error",
                     error="capture neutral and measure both directions first"
                           if not _z else "measure both motor directions first")
                return
            # Selecting mode 4 is harmless until this ordered sequence reaches
            # the device.  The firmware itself also rejects arm unless both
            # calibrated joint samples are fresh and both direction signs exist.
            # M,t,1 is idempotent from firmware v14 on. On v13 it re-ran the full
            # bus detect (a >100 ms blocking scan) which starved the 50 Hz joint
            # stream, so the M,x,1 immediately below failed its freshness check
            # and the arm silently did nothing.
            _camera_follow_write("M,x,0")
            _camera_follow_write("M,t,1")
            _camera_follow_write("M,m,4")
            _camera_follow_write("M,e,1")
            _camera_follow_write("M,x,1")
            # NOT armed until the device says so. _camera_follow_arm_tick()
            # confirms, retries within the window, and fails honestly.
            CAMERA_FOLLOW.update(armed=False, error_since=None, arm_tries=0,
                                 arm_pending=time.time() + CAMERA_FOLLOW_ARM_WINDOW_S,
                                 reason="arming; waiting for the device to confirm")
            _ack(c, event="camera_follow", **CAMERA_FOLLOW)
            return
        if action == "stop":
            _camera_follow_disarm("stopped by operator")
            _ack(c, event="camera_follow", **CAMERA_FOLLOW)
            return
        if action == "target":
            target = cmd.get("target")
            if not CAMERA_FOLLOW["armed"]:
                _ack(c, event="error", error="camera follow is not armed")
                return
            if not isinstance(target, dict):
                _camera_follow_disarm("invalid camera target")
                _ack(c, event="error", error="invalid camera target")
                return
            try:
                mcp, pip = float(target.get("mcp_deg")), float(target.get("pip_deg"))
            except (TypeError, ValueError):
                _camera_follow_disarm("invalid camera target")
                _ack(c, event="error", error="invalid camera target")
                return
            if not (math.isfinite(mcp) and math.isfinite(pip)):
                _camera_follow_disarm("invalid camera target")
                _ack(c, event="error", error="invalid camera target")
                return
            # The vision target is clamped at the bridge AND again in firmware.
            # 10 Hz is enough for a deliberate rehabilitation movement and
            # keeps the UI camera workload from starving the motor scheduler.
            mcp = max(0.0, min(CAMERA_FOLLOW_LIMIT["mcp_deg"], mcp))
            pip = max(0.0, min(CAMERA_FOLLOW_LIMIT["pip_deg"], pip))
            _camera_follow_write("M,r,%.2f,%.2f" % (mcp, pip))
            CAMERA_FOLLOW.update(target={"mcp_deg": mcp, "pip_deg": pip}, t=time.time(),
                                 reason="following healthy index")
            _ack(c, event="camera_follow", **CAMERA_FOLLOW)
            return
        _ack(c, event="error", error="unknown camera follow action")
        return

    if name == "walls":           # AR TOUCH wall descriptors, streamed 50-60 Hz
        if MOTORS is not None:
            w = cmd.get("walls")
            MOTORS.set_walls(w if isinstance(w, list) else [])
        return

    if name == "mirror":          # web mirror-therapy targets, streamed ~60 Hz
        tg = cmd.get("targets")
        if isinstance(tg, dict):
            clean = {}
            for f in FINGERS:
                v = tg.get(f)
                if isinstance(v, (int, float)) and math.isfinite(v):
                    clean[f] = max(0.0, min(1.0, float(v)))
            MIRROR["targets"] = clean or None
            MIRROR["t"] = time.time()
            a = cmd.get("assist")
            if isinstance(a, (int, float)) and math.isfinite(a):
                MIRROR["assist"] = max(0.0, min(1.0, float(a)))
        return

    if name == "pose":            # AR wrist 6-DoF stream (env space), <=30 Hz
        # RIGHT HAND ONLY: the rig lives on the right hand. A pose tagged with
        # any other handedness is vision of the WRONG hand - dropped here so
        # it can never anchor the fusion or a trajectory. (Untagged = right,
        # for the sim and pre-tag clients.)
        handed = cmd.get("hand")
        if handed is not None and handed != "right":
            _pose_rejects["left"] += 1
            if not _pose_rejects["warned"]:
                _pose_rejects["warned"] = True
                print(f"[pose] dropping non-right hand poses (hand={handed!r}); "
                      "the rig is right-hand only")
            return
        p, q = cmd.get("pos"), cmd.get("quat")
        if (isinstance(p, list) and len(p) == 3 and isinstance(q, list) and len(q) == 4
                and all(isinstance(v, (int, float)) and math.isfinite(v) for v in p + q)):
            # optional finger articulation measured by the headset's own hand
            # tracking: {finger: [abduction, MCP, PIP]} degrees. Validated and
            # clamped; all four fingers or the packet's joints are ignored.
            vj = None
            j = cmd.get("joints")
            if isinstance(j, dict):
                vj = {}
                for f in ("index", "middle", "ring", "pinky"):
                    a = j.get(f)
                    if (isinstance(a, list) and len(a) == 3 and
                            all(isinstance(v, (int, float)) and math.isfinite(v) for v in a)):
                        vj[f] = [max(-30.0, min(30.0, float(a[0]))),
                                 max(0.0, min(120.0, float(a[1]))),
                                 max(0.0, min(135.0, float(a[2])))]
                if len(vj) != 4:
                    vj = None
                # OPTIONAL thumb (2026-07-20): [palmar abduction, MCP flexion,
                # IP flexion] deg from the headset's hand tracking. The four
                # fingers stay the validity gate; a packet without a thumb is
                # still a full packet (WebXR loses the thumb often).
                th = j.get("thumb")
                if (vj is not None and isinstance(th, list) and len(th) == 3 and
                        all(isinstance(v, (int, float)) and math.isfinite(v) for v in th)):
                    vj["thumb"] = [max(-40.0, min(80.0, float(th[0]))),
                                   max(0.0, min(90.0, float(th[1]))),
                                   max(0.0, min(100.0, float(th[2])))]
            POSE.update(pos=[float(v) for v in p], quat=[float(v) for v in q],
                        env=(str(cmd["env"])[:24] if cmd.get("env") else POSE["env"]),
                        joints=vj, t_wall=time.time(), src="client")
        return

    if name == "contact":         # AR uploads hand-vs-room contact events
        evs = _clean_contacts(cmd.get("events"))
        if not evs:
            _ack(c, event="error", error="contact: no valid events")
            return
        with state_lock:
            if not state["recording"]:
                dropped = len(evs)          # nothing to attach them to
                evs = []
            else:
                room = CONTACT_MAX - len(ECO["contacts"])
                dropped = max(0, len(evs) - room)
                if room > 0:
                    ECO["contacts"].extend(evs[:room])
                evs = evs[:max(0, room)]
            total = len(ECO["contacts"])
        _ack(c, event="contacts", n=len(evs), dropped=dropped, total=total)
        if evs:
            print("[contact] +%d (%s) total=%d client #%d"
                  % (len(evs), ",".join(sorted(_contact_labels(evs))), total, c.n), flush=True)
        return

    if name == "env_save":        # AR uploads the Quest depth cloud + scene mesh
        # LOUD on stdout AND in the diag log, success OR reject (2026-07-20):
        # a silent env_save was why nobody could tell whether a real room ever
        # reached this bridge.
        src = str(cmd.get("source", "ar"))[:12]
        try:
            pos = cmd.get("positions"); idx = cmd.get("indices")
            pts = cmd.get("points"); w = cmd.get("weights")
            if not (isinstance(pos, list) and isinstance(idx, list)):
                pos, idx = [], []
            if not isinstance(pts, list):
                pts = []
            if not pos and not pts:
                raise ValueError("positions/points missing")
            meta = env_save(cmd.get("name"), [float(v) for v in pos],
                            [int(v) for v in idx], source=src,
                            points=[float(v) for v in pts],
                            weights=(w if isinstance(w, list) else None),
                            objects=cmd.get("objects"), anchor=cmd.get("anchor"))
            _ack(c, event="env_saved", id=meta["id"], tris=meta["tris"], pts=meta["pts"],
                 objects=meta.get("objects", 0), anchored=bool(meta.get("anchored")))
            broadcast({"kind": "envs", "envs": envs})
            print(f"[env] SAVED {meta['id']} source={meta['source']} "
                  f"pts={meta['pts']} tris={meta['tris']} "
                  f"objects={meta.get('objects', 0)} "
                  f"anchored={bool(meta.get('anchored'))} name={meta['name']!r} "
                  f"from client #{c.n} -> {_env_path(meta['id'])}", flush=True)
            diag_append({"via": "bridge", "event": "env_save_ok", "id": meta["id"],
                         "source": meta["source"], "pts": meta["pts"],
                         "tris": meta["tris"], "name": meta["name"],
                         "objects": meta.get("objects", 0),
                         "labels": meta.get("labels", []),
                         "anchored": bool(meta.get("anchored")),
                         "client": c.n})
        except Exception as e:
            _ack(c, event="error", error="env_save: %s" % e)
            print(f"[env] REJECTED env_save from client #{c.n} source={src}: {e}", flush=True)
            diag_append({"via": "bridge", "event": "env_save_reject", "source": src,
                         "error": str(e), "client": c.n})
        return

    if name == "diag":            # client capture diagnostics -> rolling log file
        # The AR page ships its full envDiag() at every scan transition. The
        # bridge stores it verbatim (plus a one-line stdout echo) so a failed
        # attempt is reconstructed from ~/.sensoryhand_diag.log, never from
        # the owner reading a HUD.
        d = cmd.get("diag") or {}
        t = d.get("transport") or {}
        diag_append({"via": "bridge-ws", "client": c.n, "msg": cmd})
        print(f"[diag] {str(cmd.get('event','?')):<16} phase={str(d.get('phase','-')):<9} "
              f"pts={d.get('pts', 0)} tris={d.get('tris', 0)} "
              f"depthFrames={d.get('depthFrames', 0)} "
              f"transport={t.get('kind', '-')}{'+live' if t.get('connected') else ''} "
              f"client #{c.n}", flush=True)
        return

    if name == "env_list":        # explicit refresh (also pushed on join/change)
        c.queue({"kind": "envs", "envs": envs})
        return

    if name == "env_get":         # full mesh, private to the requester
        env_id = str(cmd.get("id") or "")
        try:
            with open(_env_path(env_id)) as f:
                payload = json.load(f)
            payload["kind"] = "env"
            c.queue(payload)
        except Exception:
            _ack(c, event="error", error="unknown env", id=env_id)
        return

    if name == "take_data":       # replay rows of a sealed take, private
        take_id = str(cmd.get("id") or "")
        try:
            with open(_take_data_path(take_id)) as f:
                payload = json.load(f)
            payload["kind"] = "take_data"
            tmeta = next((t for t in takes if t["id"] == take_id), None)
            if tmeta and tmeta.get("env"):
                payload["env"] = tmeta["env"]
            if tmeta and tmeta.get("joint_source"):
                payload["joint_source"] = tmeta["joint_source"]
            c.queue(payload)
        except Exception:
            _ack(c, event="error", error="no replay data", id=take_id)
        return

    if name == "doom":            # easter egg: forward the game key bitmask to the Teensy
        # The website's DOOM controller sends {cmd:"doom", keys:<mask>} whenever the
        # pressed-key set changes. <mask> is the OR of the K_* bits defined by
        # the DOOM firmware image (not in this release). We relay it as one "G,<mask>\n"
        # line; a full-state mask means a dropped packet never sticks a key down.
        # In --sim (no Teensy) send_teensy is a no-op, so the browser preview still
        # plays its own copy of the game - the device just isn't driven.
        keys = cmd.get("keys", 0)
        if isinstance(keys, bool) or not isinstance(keys, (int, float)):
            return
        mask = int(keys) & 0x0FFF          # 12-bit DK_* mask (see dg_config.h)
        send_teensy(("G,%d\n" % mask).encode())
        if not _DOOM["seen"]:
            _DOOM["seen"] = True
            print("[doom] easter egg engaged - relaying key masks to the device")
        return

    _ack(c, event="error", error="unknown_cmd", cmd=str(name)[:32])


async def ws_handler(ws, *args):
    _ensure_hub()
    c = ClientSession(ws)
    CLIENTS.add(c)
    print(f"[ws] client #{c.n} connected from {c.remote} ({len(CLIENTS)} online)")
    c.queue({"kind": "takes", "takes": takes})      # library sync on join
    c.queue({"kind": "envs", "envs": envs})         # environment library too
    c.queue({"kind": "watch_catalog", **WATCH_CATALOG})   # the watch-face catalog
    c.queue({"kind": "imu_cfg", "cfg": IMU_CFG,           # per-IMU mounting config
             "presets": IMU_OFFSET_PRESETS})
    writer = asyncio.get_running_loop().create_task(_client_writer(c))
    try:
        async for msg in ws:
            try:
                handle_command(c, msg)
            except Exception as e:
                print(f"[ws] command error from client #{c.n}:", e)
    except Exception:
        pass
    finally:
        writer.cancel()
        CLIENTS.discard(c)
        print(f"[ws] client #{c.n} disconnected ({len(CLIENTS)} online)")


async def main_async(host, port, ssl_ctx=None):
    scheme = "wss" if ssl_ctx else "ws"
    # max_size raised for env_save: a Quest scene mesh serializes to a few MB
    # (default 1 MiB would sever the AR client mid-upload)
    async with websockets.serve(ws_handler, host, port, ssl=ssl_ctx,
                                max_size=32 * 1024 * 1024):
        _ensure_hub()
        src = "sim" if SIM_MODE else "teensy"
        print(f"[ws] ecosystem host ({src}) on {scheme}://{host}:{port}/ws")
        print(f"[ws]   web console: http://localhost:8096/?ws={scheme}://localhost:{port}/ws")
        print(f"[ws]   AR desktop:  http://localhost:8097/?ws={scheme}://localhost:{port}/ws")
        print(f"[ws]   Android:     enter this machine's LAN IP (needs --ws-host 0.0.0.0)")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="TAKTO ONE ecosystem host bridge")
    ap.add_argument("--port", default=None, help="Teensy serial port (e.g. /dev/cu.usbmodem*)")
    ap.add_argument("--sim", action="store_true",
                    help="no hardware: synthetic full-system device (12 joints, 2 IMUs, EMG, sim motors)")
    ap.add_argument("--sim-motors", type=int, default=2, metavar="N",
                    help="simulated motors with --sim (0-4, default 2); live mode never fakes motors")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--ws-host", default="127.0.0.1",
                    help="bind address; 0.0.0.0 to serve phones/headsets on the LAN")
    ap.add_argument("--ws-port", type=int, default=8765)
    ap.add_argument("--hz", type=int, default=HZ)   # default 60 (latency pass); tests pin 30
    ap.add_argument("--takes-file", default=None, help="override the take-library JSON path")
    # optional TLS (a self-signed cert/key pair works): an https
    # page on the Quest may only open wss:// sockets (mixed content rule)
    ap.add_argument("--ssl-cert", default=None, help="PEM cert -> serve wss://")
    ap.add_argument("--ssl-key", default=None, help="PEM key for --ssl-cert")
    # encoder conditioning (see _OneEuroAngle). Exposed because the right cutoff
    # depends on how well the magnets are seated, which changes between builds.
    ap.add_argument("--raw-encoders", action="store_true",
                    help="disable One-Euro encoder filtering and stream the raw AS5600 angles")
    ap.add_argument("--enc-min-cutoff", type=float, default=ENC_FILTER_MIN_CUTOFF,
                    help="Hz, still-hand cutoff; lower = steadier but laggier (default %(default)s)")
    ap.add_argument("--enc-beta", type=float, default=ENC_FILTER_BETA,
                    help="speed coupling; higher = snappier on fast flexion (default %(default)s)")
    args = ap.parse_args()

    # module scope: these ARE the globals filter_encoders() reads, no declaration needed
    ENC_FILTER_ON = not args.raw_encoders
    ENC_FILTER_MIN_CUTOFF = args.enc_min_cutoff
    ENC_FILTER_BETA = args.enc_beta
    print(f"[enc] filter {'OFF (raw)' if not ENC_FILTER_ON else f'One-Euro min_cutoff={ENC_FILTER_MIN_CUTOFF} Hz beta={ENC_FILTER_BETA}'}")

    if bool(args.port) == bool(args.sim):
        ap.error("pick ONE data source: --port /dev/cu.usbmodem* (bench) or --sim (no hardware)")

    if args.takes_file:
        TAKES_FILE = args.takes_file
        _load_takes()

    ssl_ctx = None
    if args.ssl_cert and args.ssl_key:
        import ssl as _ssl
        ssl_ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(args.ssl_cert, args.ssl_key)

    HZ = args.hz
    WS_PORT = args.ws_port
    if args.sim:
        SIM_MODE = True
        enable_sim_pipeline()
        n = max(0, min(4, args.sim_motors))
        if n:
            MOTORS = SimMotors(("index_drive", "middle_drive", "ring_drive", "pinky_drive")[:n])
        th = threading.Thread(target=sim_thread, daemon=True)
    else:
        th = threading.Thread(target=serial_thread, args=(args.port, args.baud), daemon=True)
    th.start()
    try:
        asyncio.run(main_async(args.ws_host, args.ws_port, ssl_ctx))
    except KeyboardInterrupt:
        print("\n[bridge] stopped")
