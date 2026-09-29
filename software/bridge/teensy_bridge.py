#!/usr/bin/env python3
"""
teensy_bridge.py - the TAKTO ONE ecosystem host bridge.

Connects every surface (web console, AR, phone app) to the Teensy over
ws://<host>:8765/ws. Shared state, calibration and recorded sessions are owned
by this process; one snapshot is broadcast to all clients at 60 Hz (--hz).

Data sources (pick one):
  --port /dev/cu.usbmodemXXX   the live device (firmware 'j' = stream ON). It
      prints one `S,` line per frame - 100 Hz on firmware v16, 50 Hz before -
      with 14 encoders, three BNO085s (game rotation vector, gyro, linear
      acceleration, ...), EMG, crown, the motor block (bridged read-only since
      v6), on v16 the SD/boot/dv/stability tail and on v17 the timing tail
      (t_us, quaternion ages, encoder sweep; software/MOTION_PIPELINE.md
      sections 5 and 8 are the contract). Sensors the firmware reports absent
      are sent ok:false (honest).
  --sim   no hardware: sim_device.SimDevice, a LINE-LEVEL v16 device (raw game
      quaternions with a random per-boot heading, mounting rotations, gyro, dv,
      stability, E-events, an in-memory SD card) whose text goes through the
      same parser and pipeline as the hardware. Motors stay simulated (SimMotors).

Per device frame (serial/sim thread): parse -> encoders -> legacy IMU display
-> motion.BodyModel (the contract's `body` block) -> the fast pose lane (opt-in
clients, 100 Hz) -> one recorded take row + the take's raw stream sidecar.
The broadcast loop only packages the latest derived state.

Run:
    python teensy_bridge.py --port /dev/cu.usbmodemXXXX
    python teensy_bridge.py --sim
    (add --ws-host 0.0.0.0 to serve the phone / headset on the LAN)
See software/bridge/README.md.
"""
import argparse, asyncio, copy, glob, gzip, json, math, os, re, threading, time, sys
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tendon
import motion
import sdcard
import research

# Written into every take's provenance. Bump when the derived rows change meaning.
BRIDGE_VERSION = "2026.09-v17"


def _git_rev():
    """Short commit of the checkout this bridge runs from (+ "-dirty"), or None."""
    try:
        import subprocess
        here = os.path.dirname(os.path.abspath(__file__))
        rev = subprocess.run(["git", "-C", here, "rev-parse", "--short", "HEAD"], capture_output=True,
                             text=True, timeout=2).stdout.strip()
        if not rev:
            return None
        dirty = subprocess.run(["git", "-C", here, "status", "--porcelain", "--", "."],
                               capture_output=True, text=True, timeout=2).stdout.strip()
        return rev + ("-dirty" if dirty else "")
    except Exception:
        return None


GIT_REV = _git_rev()

# Snapshot broadcast rate. Firmware v16 samples at 100 Hz; the snapshot carries
# the latest frame at 60 Hz (a fresh sample waits at most one 16.7 ms tick).
# Recording does NOT ride on this tick: take rows are written once per DEVICE
# frame in the serial thread. Overridable: --hz / bench_replay.
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
# channel -> finger. The default is the one wired index finger above; a full
# 12-encoder map (4 fingers x abduction / MCP flexion / PIP flexion) is learned
# with map_encoders.py (or set with {"cmd":"enc_map","action":"set"}) and
# persisted in .takto_enc_map.json, which replaces BOTH tables at start-up.
ENC_FINGER = {ch: WIRED_FINGER for ch in ENC_DOF}
ENC_DOFS = ("abduct", "mcpflex", "pipflex")


def enc_joint_id(ch):
    """The twin joint a mapped encoder channel drives (wire naming)."""
    return ENC_FINGER.get(ch, WIRED_FINGER) + "_" + DOF_SEG[ENC_DOF[ch][0]]
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

# The encoder state above (and the seed/sweep state below) is advanced by the
# serial thread for every frame AND read by the event loop (camera-follow
# neutral/probe, calibration commands). "Idempotent within a sample" only holds
# when two callers cannot interleave the read-modify-write of `cont`, so every
# function that touches it runs under this re-entrant lock.
_enc_lock = threading.RLock()


def _enc_locked(fn):
    def wrapped(*a, **kw):
        with _enc_lock:
            return fn(*a, **kw)
    wrapped.__name__ = fn.__name__
    wrapped.__doc__ = fn.__doc__
    return wrapped



@_enc_locked
def unwrapped_deg(ch, raw):
    """Raw 0..360 -> continuous degrees. Idempotent within a sample."""
    st = _enc_cont.get(ch)
    if st is None:
        _enc_cont[ch] = {"cont": raw, "last": raw}
        return raw
    st["cont"] += _wrap180(raw - st["last"])
    st["last"] = raw
    return st["cont"]


@_enc_locked
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


@_enc_locked
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


@_enc_locked
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


@_enc_locked
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


@_enc_locked
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


@_enc_locked
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


@_enc_locked
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


@_enc_locked
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
    return ENC_FINGER.get(ch, WIRED_FINGER) + "_" + seg, joint_value(dof, sign, travel, o, ENC_CLOSED.get(ch))


def joint_value(dof, sign, travel, open_raw, closed_raw):
    """Pure mapping of continuous travel from the open mark to a twin angle.
    Shared by the live path (calibrated_joint) and the offline SD import, so an
    imported take and a live one can never map the same encoder differently."""
    if dof == "abduct":                       # side-to-side: open = centre (0), signed
        d = sign * ABDUCT_SCALE * travel
        return max(-16.0, min(16.0, d))
    # flexion: two-point map open -> FLEX_OPEN, closed -> FLEX_CLOSED
    if closed_raw is None:
        val = FLEX_OPEN + max(0.0, sign * travel)              # provisional until closed captured
    else:
        den = _wrap180(closed_raw - open_raw)
        t = (travel / den) if abs(den) > 1e-3 else 0.0
        closed = DOF_CLOSED.get(dof, FLEX_CLOSED)
        val = FLEX_OPEN + max(0.0, min(1.2, t)) * (closed - FLEX_OPEN)
    return max(-10.0, min(DOF_CLOSED.get(dof, FLEX_CLOSED) + 10.0, val))


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


@_enc_locked
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


@_enc_locked
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


@_enc_locked
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


# ----- the encoder channel map (which finger / DOF each channel measures) -----
_ENC_MAP_FILE = os.path.join(STATE_DIR, ".takto_enc_map.json")


def enc_map_public():
    return {str(ch): {"finger": ENC_FINGER.get(ch, WIRED_FINGER), "dof": ENC_DOF[ch][0],
                      "sign": ENC_DOF[ch][1]} for ch in sorted(ENC_DOF)}


def enc_map_validate(m):
    """{"<ch>": {"finger","dof","sign"}} -> {ch: (finger, dof, sign)}, or raise.
    Every finger/DOF pair may be claimed by one channel only."""
    out, seen = {}, set()
    for k, v in (m or {}).items():
        ch = int(k)
        if not 0 <= ch < N_CH:
            raise ValueError(f"channel {ch} out of range")
        f, dof = v.get("finger"), v.get("dof")
        sign = float(v.get("sign", 1.0))
        if f not in FINGERS or dof not in ENC_DOFS or sign not in (1.0, -1.0):
            raise ValueError(f"channel {ch}: bad finger/dof/sign {v}")
        if (f, dof) in seen:
            raise ValueError(f"{f} {dof} mapped twice")
        seen.add((f, dof))
        out[ch] = (f, dof, sign)
    return out


def enc_map_apply(m, save=True):
    """Replace the channel map. A channel whose finger/DOF changed loses its
    open/closed marks (they described a different joint)."""
    new = enc_map_validate(m)
    with _enc_lock:
        for ch in list(ENC_DOF):
            if ch not in new or new[ch][:2] != (ENC_FINGER.get(ch, WIRED_FINGER), ENC_DOF[ch][0]):
                ENC_OPEN.pop(ch, None); ENC_CLOSED.pop(ch, None)
        ENC_DOF.clear(); ENC_FINGER.clear()
        for ch, (f, dof, sign) in new.items():
            ENC_DOF[ch] = (dof, sign)
            ENC_FINGER[ch] = f
    if save:
        _write_json_atomic(_ENC_MAP_FILE, {"channels": enc_map_public()})
        _save_jcal()
    print("[encmap] channel map:", {ch: f"{ENC_FINGER[ch]}/{ENC_DOF[ch][0]}" for ch in sorted(ENC_DOF)})


def _load_enc_map():
    try:
        with open(_ENC_MAP_FILE) as f:
            d = json.load(f)
        enc_map_apply(d.get("channels", {}), save=False)
    except FileNotFoundError:
        pass
    except Exception as e:
        _quarantine_corrupt(_ENC_MAP_FILE, e, "encmap")


_load_enc_map()


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
    "last_line": 0.0,          # wall time of ANY device line (S, E, F, #): link liveness
    "recording": False,
    # Per-device-frame derived state (legacy IMU display quats, joints, body
    # block, rel inputs), computed ONCE per frame in the serial/sim thread by
    # ingest_frame() and only packaged by build_snapshot().
    "derived": None,
}
state_lock = threading.Lock()

# Device-side recording/power state (firmware v16 S-line tail + E-events).
# Surfaces get it as the snapshot `device` block (MOTION_PIPELINE.md s.7).
DEVICE = {
    "fw": None, "boot_id": None, "flags": None,
    "sd_present": None, "sd_recording": False, "sd_take": 0, "sd_rows": 0,
    "standby": False, "auto_record": None, "neutral_running": False, "host_link": None,
    "last_error": None,        # {"text", "t"}: SD failures and other device error lines
    "messages": deque(maxlen=16),   # recent human-readable device lines (">>>", "#", ...)
    "last_t_ms": None,         # device clock of the last frame (reboot detection pre-v16)
}
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

    _STATE = ("p", "v", "bias", "still", "_quiet_since", "last_zupt", "zupts", "zero_t")

    def export_state(self):
        """Integrator state (a take's raw sidecar keeps it, so a re-derivation
        continues the displacement exactly where the live one stood)."""
        return {k: (list(getattr(self, k)) if isinstance(getattr(self, k), list) else getattr(self, k))
                for k in self._STATE}

    def import_state(self, st):
        for k in self._STATE:
            if isinstance(st, dict) and k in st:
                v = st[k]
                setattr(self, k, list(v) if isinstance(v, list) else v)

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
    """Re-home NOW (the imu_align 'home' step): an immediate capture from the
    last 0.5 s of frames, seating the body neutral and the legacy display home
    together. It used to only raise a flag that the next frame consumed in
    whatever pose the arm happened to be in; a capture now refuses a moving
    arm, and it is per device boot like every neutral."""
    body_call(lambda bm: _neutral_result(bm.capture_neutral(window_s=0.5, kind="imu"), "imu"))


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
    """Read the saved home as a CANDIDATE; nothing is applied here.

    THE BUG THIS GUARDS (2026-08-06, cost weeks of a distorted twin): the tare
    file recorded three quaternions and nothing else, and a stale home was
    reloaded on every later start. Two records have travelled with the tare
    since then (which sensors were live, the mounting config it was captured
    under), and both are still checked.

    THE SECOND BUG (2026-09, motion pipeline v16): even a valid-looking home is
    meaningless after a power cycle. The game rotation vector re-chooses its
    heading reference at every boot, so a tare captured in one boot and
    reloaded in the next rotates the whole twin by an arbitrary heading. The
    tare now carries the device `boot_id` and is adopted only when the device
    reports the SAME boot (_tare_adopt_for_boot, called on the first frame that
    carries a boot id). Firmware without a boot id (pre-v16) never gets a tare
    from disk: it re-homes at the next neutral, which costs one held pose."""
    global _TARE_CANDIDATE, _imu_tare_pending, _thumb_tare_pending
    _imu_tare_pending = True
    _thumb_tare_pending = True
    _TARE_CANDIDATE = None
    try:
        with open(_TARE_FILE) as f:
            d = json.load(f)
    except FileNotFoundError:
        return
    except Exception as e:
        _quarantine_corrupt(_TARE_FILE, e, "imu")
        return
    sig = d.get("cfg_sig")
    live = d.get("live") or {}
    if sig is None and not live:
        print("[imu] IGNORING the saved home: no provenance recorded (pre-2026-08-06 file)")
        return
    if sig is not None and sig != _cfg_signature():
        print("[imu] IGNORING the saved home: the mounting config changed since it was captured")
        return
    if d.get("boot_id") is None:
        print("[imu] IGNORING the saved home: it carries no device boot id, so it cannot be "
              "shown to belong to this power-up of the device")
        return
    cand = {"boot_id": d.get("boot_id")}
    for key in IMU_KEYS:
        q = d.get(key)
        if key in d and (not live or live.get(key, False)) and _valid_quat(q):
            cand[key] = _norm_quat(q)
    _TARE_CANDIDATE = cand
    print("[imu] saved home found for device boot %s; it is used only if the device "
          "still reports that boot" % cand["boot_id"])


def _tare_adopt_for_boot(boot_id):
    """The device told us its boot id: adopt the saved home only if it is the
    same boot. Returns True when adopted."""
    global _TARE_CANDIDATE, IMU_TARE_HAND, IMU_TARE_FOREARM, IMU_TARE_THUMB
    global _imu_tare_pending, _thumb_tare_pending, _tare_state
    cand, _TARE_CANDIDATE = _TARE_CANDIDATE, None
    if not cand or boot_id is None or cand.get("boot_id") != boot_id:
        if cand:
            print("[imu] saved home belongs to device boot %s, the device is on boot %s: "
                  "discarded (new heading reference)" % (cand.get("boot_id"), boot_id))
        return False
    if "hand" in cand and "forearm" in cand:
        IMU_TARE_HAND, IMU_TARE_FOREARM = cand["hand"], cand["forearm"]
        _imu_tare_pending = False
        _tare_state = "calibrated"
    if "thumb" in cand:
        IMU_TARE_THUMB = cand["thumb"]
        _thumb_tare_pending = False
    print("[imu] saved home adopted (same device boot %s)" % boot_id)
    return True


def _save_tare(live_map=None):
    """Persist the home WITH its provenance: which sensors were live, the
    mounting config, and the device boot it is valid for."""
    try:
        for key, q in (("hand", IMU_TARE_HAND), ("forearm", IMU_TARE_FOREARM),
                       ("thumb", IMU_TARE_THUMB)):
            # Refuse to persist a calibration that would destroy every pose on
            # the next bridge start.
            if not _valid_quat(q):
                raise ValueError(f"{key} tare is not a unit quaternion")
        payload = {"hand": IMU_TARE_HAND, "forearm": IMU_TARE_FOREARM,
                   "thumb": IMU_TARE_THUMB,
                   "cfg_sig": _cfg_signature(),
                   "boot_id": DEVICE.get("boot_id"),
                   "when": time.strftime("%Y-%m-%d %H:%M:%S")}
        if live_map is not None:
            payload["live"] = {k: bool(v) for k, v in live_map.items()}
        _write_json_atomic(_TARE_FILE, payload)
    except Exception as e:
        print("[imu] could not save home:", e)


_TARE_CANDIDATE = None
_tare_state = "none"          # "none" | "provisional" | "calibrated" (this boot)
_load_tare()


# ============================================================================
# THE BODY MODEL (software/MOTION_PIPELINE.md): motion.BodyModel turns the raw
# game quaternions into segment orientations in the shared body frame, the
# arm model into elbow/wrist/palm positions, and owns the per-boot neutral.
#
# Threading: the model is advanced ONLY by the thread that ingests device
# frames (serial or sim). Commands from the event loop never touch it
# directly: they queue a call in BODY_REQ, which the ingest thread runs before
# the next frame, and results come back as broadcasts.
#
# Persistence (.takto_body.json): the wrist flexion axis (a physical property
# of how the hand IMU sits, kept across power cycles) and the last REAL neutral
# together with the device boot it belongs to (kept across bridge restarts,
# discarded the moment the device reports another boot).
# ============================================================================
_BODY_FILE = os.path.join(STATE_DIR, ".takto_body.json")
BODY_REQ = deque()                # callables run by the ingest thread (FIFO)
# forearm_flip: the forearm module's "forward" is 180 deg from the legacy prior,
# and the forearm defines forward for the whole twin.
# [BENCH 2026-09-29] measured, not assumed, in two steps:
#  1. while hand and forearm rotated together, their pitch and roll came out
#     mirrored against each other (co-rotation votes 351 vs 7 over two
#     sessions): exactly one of the two priors points backwards;
#  2. with the two made consistent, the wearer saw the whole twin tilt and
#     twist opposite to the arm (side to side correct): the body frame itself
#     was backwards, i.e. the FOREARM prior. The IMU config notes below had
#     already measured it ("180 Y <- upright AND forward", never applied).
# The hand is right as it is; the model's co-rotation self-check re-verifies
# it against the forearm at every neutral and turns it (hand_flip) if a
# remount ever breaks that.
FOREARM_FLIP_DEFAULT = True
HAND_FLIP_DEFAULT = False
BODY_PERSIST = {"wrist_axis": None, "neutral": None, "arm": {}, "hand_flip": HAND_FLIP_DEFAULT,
                "forearm_flip": FOREARM_FLIP_DEFAULT}
_BODY_NEUTRAL_CANDIDATE = None    # a persisted neutral waiting for the device's boot id


def body_priors():
    """Mounting priors M_s (S <- segment) from the live IMU_CFG (remap/align/offset)."""
    return {k: motion.mounting_prior(IMU_CFG[k]) for k in IMU_KEYS}


def rig_mountings():
    """How the sensors really sit, as the body model understands it: the
    priors with the measured hand flip. The simulator mounts its IMUs so."""
    p = body_priors()
    for k, default in (("hand", HAND_FLIP_DEFAULT), ("forearm", FOREARM_FLIP_DEFAULT)):
        if BODY_PERSIST.get(k + "_flip", default):
            p[k] = motion.qnorm(motion.qmul(p[k], motion.FLIP_UP))
    return p


def _body_load():
    global BODY_PERSIST, _BODY_NEUTRAL_CANDIDATE
    try:
        with open(_BODY_FILE) as f:
            d = json.load(f)
        if not isinstance(d, dict):
            raise ValueError("not an object")
        wa = d.get("wrist_axis")
        if wa is not None and (not isinstance(wa, list) or len(wa) != 3 or motion.valid_vec(wa) is None):
            raise ValueError("bad wrist_axis")
        arm = d.get("arm") if isinstance(d.get("arm"), dict) else {}
        hf = d.get("hand_flip", HAND_FLIP_DEFAULT)
        ff = d.get("forearm_flip", FOREARM_FLIP_DEFAULT)
        BODY_PERSIST = {"wrist_axis": wa, "neutral": d.get("neutral"),
                        "arm": {k: float(v) for k, v in arm.items() if k in ("L_ua", "L_fa")
                                and isinstance(v, (int, float)) and 0.1 <= v <= 0.6},
                        "hand_flip": hf if isinstance(hf, bool) else HAND_FLIP_DEFAULT,
                        "forearm_flip": ff if isinstance(ff, bool) else FOREARM_FLIP_DEFAULT}
        _BODY_NEUTRAL_CANDIDATE = d.get("neutral")
    except FileNotFoundError:
        pass
    except Exception as e:
        _quarantine_corrupt(_BODY_FILE, e, "body")


def _body_save():
    try:
        _write_json_atomic(_BODY_FILE, BODY_PERSIST)
    except Exception as e:
        print("[body] could not save:", e)


def _make_body():
    bm = motion.BodyModel(body_priors(), cfg=dict(BODY_PERSIST.get("arm") or {}),
                          wrist_axis=BODY_PERSIST.get("wrist_axis"),
                          hand_flip=BODY_PERSIST.get("hand_flip", HAND_FLIP_DEFAULT),
                          forearm_flip=BODY_PERSIST.get("forearm_flip", FOREARM_FLIP_DEFAULT))
    return bm


_body_load()
BODY = _make_body()


def body_call(fn):
    """Queue fn(BODY) for the ingest thread (thread-safe; deque.append is atomic)."""
    BODY_REQ.append(fn)


# ============================================================================
# ECOSYSTEM STATE - one device, one shared session, many clients.
#
# Everything below is the state the three client surfaces (web console, AR,
# Android) must AGREE on. It is mutated only (a) under state_lock from the
# data thread (sample counters) and (b) from the asyncio event-loop thread
# (commands + the broadcast loop), and every mutation is visible to every
# client on the next 60 Hz snapshot. Acks answer the commanding client only.
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

REC_ROWS_CAP = 720_000          # 2 h at 100 Hz. Rows are spooled to a file in
                                # STATE_DIR as they arrive (constant RAM); the cap
                                # only bounds the disk a forgotten recording can
                                # take. The recording itself keeps running past it.

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
    # per-device-frame row spool (see record_start / _record_row)
    "spool": None,              # open file handle of the running take's rows
    "spool_path": None,
    "rows_n": 0, "last_row_t": None, "any_traj": False, "any_inertial": False,
    "sd_take": None,            # the device's SD take number recording alongside
    # research-grade takes (MOTION_PIPELINE.md s.8)
    "raw": None,                # research.RawWriter of the running take (ingest thread writes)
    "raw_path": None,
    "raw_pending": False,       # opened by the ingest thread at the take's first frame
    "qacc": None,               # research.QualityAccumulator of the running take
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
               "ihx", "ihy", "ihz", "ifx", "ify", "ifz", "i_conf"]
            # 2026-09 (motion pipeline, MOTION_PIPELINE.md s.7): +15 BODY columns
            # appended at the END (44 -> 59): elbow + wrist positions (m, body
            # frame), forearm + hand body quaternions, calibration state
            # (0 none, 1 provisional, 2 calibrated). Rows are now written once per
            # DEVICE frame, so t_ms never repeats.
            + motion.B_COLS
            # 2026-09 (research-grade takes, MOTION_PIPELINE.md s.8): +32 RAW
            # columns appended at the END (59 -> 91): device timing (t_us, the
            # three quaternion ages, the encoder sweep), the bridge receive time
            # (rx_ms, Unix epoch ms), the unfiltered encoder degrees (-1 absent)
            # and the raw game quaternions, so every derived column can be
            # recomputed from the row itself (see research.RAW_COLS).
            + research.RAW_COLS)
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


_RESERVED_IDS = set()          # take ids allocated to an SD import in progress


def _next_state_id(kind):
    """Next take/env number = 1 + the highest number seen in the in-memory
    index AND in the data files on disk, so IDs never collide with (and
    overwrite) an old recording even if the index was lost or corrupted."""
    items, pat = ((takes, ".sensoryhand_takedata_take_*.json") if kind == "take"
                  else (envs, ".sensoryhand_env_env_*.json"))
    n = 0
    live_ids = [{"id": ECO.get("rec_id")}] + [{"id": r} for r in _RESERVED_IDS] if kind == "take" else []
    for it in list(items) + live_ids:
        m = re.search(r"(\d+)$", str(it.get("id", "") or ""))
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


def _spool_path(take_id):
    return os.path.join(STATE_DIR, ".sensoryhand_takedata_%s.rows.partial" % take_id)


def _raw_path(take_id, ext=".raw.txt.gz"):
    """The take's raw device stream: `.raw.txt.gz` for a live take (every S/E
    line with its receive time), `.sd.csv.gz` for an SD import (the card file)."""
    return os.path.join(STATE_DIR, ".sensoryhand_takedata_%s%s" % (take_id, ext))


def _meta_path(take_id):
    """The take's research metadata (take.json: quality, provenance, columns)."""
    return os.path.join(STATE_DIR, ".sensoryhand_takedata_%s.meta.json" % take_id)


def _take_raw_file(take_id):
    for ext in (".raw.txt.gz", ".sd.csv.gz"):
        p = _raw_path(take_id, ext)
        if os.path.exists(p):
            return p
    return None


def _nominal_hz():
    """The firmware's own frame rate: 100 Hz from v16 (fw_flags present), 50 before."""
    return 100.0 if ((_fw.get("version") or 0) >= 16 or DEVICE.get("flags") is not None) else 50.0


def provenance(source="live", fw=None, boot_id=None):
    """Everything a derived row depends on besides the device stream: firmware
    and boot, this bridge's version, the encoder map and marks, the IMU
    mounting (config, priors, wrist axis), the body-model parameters and the
    encoder filter. Stored per take; rederive.py re-applies it."""
    pri = body_priors()
    cfg = dict(motion.DEFAULT_CFG)
    cfg.update(BODY_PERSIST.get("arm") or {})
    return {
        "fw": fw if fw is not None else (DEVICE.get("fw") or _fw.get("version") or None),
        "boot_id": boot_id if boot_id is not None else DEVICE.get("boot_id"),
        "bridge_version": BRIDGE_VERSION, "git": GIT_REV, "source": source, "sim": bool(SIM_MODE),
        "enc_map": {
            "channels": enc_map_public(),
            "open": {str(ch): round(v, 4) for ch, v in ENC_OPEN.items()},
            "closed": {str(ch): round(v, 4) for ch, v in ENC_CLOSED.items()},
            "joint_space_direct": bool(ENC_JOINT_SPACE_DIRECT),
            "sim_bias_deg": SIM_ENC_BIAS if SIM_MODE else None,
            "filter": {"on": bool(ENC_FILTER_ON), "min_cutoff_hz": ENC_FILTER_MIN_CUTOFF,
                       "beta": ENC_FILTER_BETA},
        },
        "imu_mounting": {
            "cfg": copy.deepcopy(IMU_CFG),
            "priors": {k: [round(float(x), 7) for x in pri[k]] for k in IMU_KEYS},
            "wrist_axis": BODY_PERSIST.get("wrist_axis"),
            "hand_flip": bool(BODY_PERSIST.get("hand_flip", HAND_FLIP_DEFAULT)),
            "forearm_flip": bool(BODY_PERSIST.get("forearm_flip", FOREARM_FLIP_DEFAULT)),
            "orientation_source": IMU_ORIENTATION_SOURCE,
        },
        "body_params": {k: cfg[k] for k in ("L_ua", "L_fa", "f_imu_to_wrist", "hand_offset",
                                            "heading_bleed_tau_s", "zupt_acc", "zupt_gyr",
                                            "zupt_hold_s", "vel_leak_per_s", "acc_deadband",
                                            "acc_deadband_per_rad_s", "acc_deadband_v",
                                            "relax_after_s", "relax_tau_s", "max_elev_deg",
                                            "inertial", "still_rad_s", "neutral_max_spread_deg")},
        "row_cols": len(ROW_COLS),
    }


def apply_provenance(prov):
    """rederive.py: make this process derive exactly like the bridge that
    recorded the take (encoder map + marks, IMU mounting, wrist axis, arm
    lengths, encoder filter, sim encoding). Never called inside the bridge."""
    global ENC_JOINT_SPACE_DIRECT, ENC_FILTER_ON, ENC_FILTER_MIN_CUTOFF, ENC_FILTER_BETA, SIM_MODE
    if not isinstance(prov, dict):
        return
    em = prov.get("enc_map") or {}
    ENC_DOF.clear(); ENC_FINGER.clear(); ENC_OPEN.clear(); ENC_CLOSED.clear()
    for k, v in (em.get("channels") or {}).items():
        ENC_DOF[int(k)] = (v["dof"], float(v.get("sign", 1.0)))
        ENC_FINGER[int(k)] = v.get("finger", WIRED_FINGER)
    for k, v in (em.get("open") or {}).items():
        ENC_OPEN[int(k)] = float(v)
    for k, v in (em.get("closed") or {}).items():
        ENC_CLOSED[int(k)] = float(v)
    ENC_JOINT_SPACE_DIRECT = bool(em.get("joint_space_direct"))
    flt = em.get("filter") or {}
    ENC_FILTER_ON = bool(flt.get("on", True))
    ENC_FILTER_MIN_CUTOFF = float(flt.get("min_cutoff_hz", ENC_FILTER_MIN_CUTOFF))
    ENC_FILTER_BETA = float(flt.get("beta", ENC_FILTER_BETA))
    SIM_MODE = bool(prov.get("sim"))
    im = prov.get("imu_mounting") or {}
    if isinstance(im.get("cfg"), dict):
        for k in IMU_KEYS:
            if isinstance(im["cfg"].get(k), dict):
                IMU_CFG[k] = copy.deepcopy(im["cfg"][k])
    BODY_PERSIST["wrist_axis"] = im.get("wrist_axis")
    # takes recorded before the hand-frame fix derived without it
    BODY_PERSIST["hand_flip"] = bool(im.get("hand_flip", False))
    BODY_PERSIST["forearm_flip"] = bool(im.get("forearm_flip", False))
    bp = prov.get("body_params") or {}
    BODY_PERSIST["arm"] = {k: float(bp[k]) for k in ("L_ua", "L_fa") if isinstance(bp.get(k), (int, float))}


# ---- the raw sidecar (ingest thread) ----------------------------------------
RAW_RING = deque(maxlen=110)      # the last ~1 s of S/E lines: a take's pre-roll
RAW_PREROLL_S = 1.0
_raw_lock = threading.Lock()      # the ingest thread writes, record_stop closes
_raw_neutral_ref = [None]         # the BODY.neutral object last annotated


def _raw_begin(now):
    """Called by the ingest thread for each frame while recording: opens the
    take's raw sidecar at the first one (with the pre-roll, the provenance,
    the neutral in force and the model state). True while the sidecar is open."""
    if ECO.get("raw") is not None:
        return True
    if not ECO.get("raw_pending"):
        return False
    ECO["raw_pending"] = False
    n = BODY.neutral
    pre = [(rx, ln) for (rx, ln) in list(RAW_RING) if now - rx <= RAW_PREROLL_S]
    RAW_RING.clear()
    meta = {
        "take": ECO.get("rec_id"), "created_unix_ms": int(now * 1000),
        "provenance": provenance("live"),
        "nominal_hz": _nominal_hz(),
        "boot_id": DEVICE.get("boot_id"),
        "neutral": ({"t": n["t"], "kind": n["kind"], "provisional": bool(n["provisional"]),
                     "q0": {k: (list(v) if v is not None else None) for k, v in n["q0"].items()},
                     "spread": n.get("spread")} if n is not None else None),
        "state0": dict(BODY.export_state(),
                       trackers={k: TRACKERS[k].export_state() for k in IMU_KEYS}),
        "preroll": sum(1 for _rx, ln in pre if ln.startswith("S,")),
        "cols": len(ROW_COLS),
    }
    try:
        w = research.RawWriter(ECO["raw_path"], meta)
        for rx, ln in pre:
            w.write(rx, ln)
    except Exception as e:
        print("[takes] cannot open the raw stream sidecar:", e)
        return False
    _raw_neutral_ref[0] = n
    with _raw_lock:
        ECO["raw"] = w
    return True


def _raw_write(rx, line):
    with _raw_lock:
        w = ECO.get("raw")
        if w is None:
            return
        try:
            w.write(rx if rx is not None else time.time(), line)
        except Exception as e:
            print("[takes] raw stream write failed:", e)
            ECO["raw"] = None


def _raw_neutral_note(phase, rx):
    """Annotate a body-neutral change in the raw stream (see _body_step)."""
    if ECO.get("raw") is None:
        return
    n = BODY.neutral
    if n is _raw_neutral_ref[0]:
        return
    _raw_neutral_ref[0] = n
    if n is None:
        return                 # a reboot: the S-line's boot id says so
    _raw_write(rx, research.neutral_line(phase, n["t"], n["kind"], n["provisional"], n["q0"]))


# ---- the fast pose lane (MOTION_PIPELINE.md s.8) ------------------------------
# Built in the ingest thread per device frame, handed to the event loop through
# ONE latest-wins slot (at most one pending call_soon_threadsafe), and from
# there into each opted-in client's own latest-wins slot. No queue anywhere can
# grow: a slow loop or a slow client drops stale poses (counted), never delays
# fresh ones.
POSE_LANE = {"clients": 0, "seq": 0, "coalesced": 0}
_pose_slot = {"text": None, "rx": 0.0, "scheduled": False}
_pose_lock = threading.Lock()
LINK_STATS = {"rx_off": deque(maxlen=600),     # (receive - device) ms, last ~6 s of frames
              "lat": deque(maxlen=4096),       # (tx wall s, tx - rx ms) per pose sent
              "built": deque(maxlen=1024),     # wall s of every pose built
              "cache": None, "cache_t": 0.0}


def _r4(v):
    return [round(float(x), 4) for x in v]


def pose_message(fr, derived, rx, seq):
    """The pose-lane message for one frame, as a dict (tx is added at send)."""
    b = derived["body"]
    th = derived.get("thumb")
    wd = b.get("wrist_deg") or {}
    tm = fr.get("timing")
    return {"kind": "pose", "t": fr["t"], "us": tm["t_us"] if tm else None, "seq": seq,
            "rx": round(rx * 1000.0, 1),
            "cal": 2 if b.get("calibrated") else (1 if b.get("provisional") else 0),
            "live": bool(b.get("live")),
            "e": _r4(b["elbow_m"]), "w": _r4(b["wrist_m"]), "h": _r4(b["hand_m"]),
            "fq": _r4(b["forearm_quat"]), "hq": _r4(b["hand_quat"]),
            "wd": [wd.get("flex"), wd.get("dev"), wd.get("pro")],
            "j": [round(j["deg"], 2) if j.get("ok") else None for j in derived["joints"]],
            "tq": _r4(th["rel_quat"]) if th else None}


def _pose_publish(fr, derived, now):
    loop = _LOOP
    if loop is None:
        return
    # serialised ONCE here, without its closing brace: the writer appends tx
    text = wire_json(pose_message(fr, derived, now, POSE_LANE["seq"]))[:-1]
    with _pose_lock:
        if _pose_slot["text"] is not None:
            POSE_LANE["coalesced"] += 1
        _pose_slot["text"] = text
        _pose_slot["rx"] = now
        need = not _pose_slot["scheduled"]
        _pose_slot["scheduled"] = True
    LINK_STATS["built"].append(now)
    if need:
        try:
            loop.call_soon_threadsafe(_pose_dispatch)
        except RuntimeError:
            with _pose_lock:
                _pose_slot["scheduled"] = False


def _pose_dispatch():
    """Event loop: move the latest pose into every opted-in client's slot."""
    with _pose_lock:
        text, rx = _pose_slot["text"], _pose_slot["rx"]
        _pose_slot["text"] = None
        _pose_slot["scheduled"] = False
    if text is None:
        return
    for c in list(CLIENTS):
        if c.pose:
            c.offer_pose(text, rx)


def _pose_sent(tx, rx):
    lat = (tx - rx) * 1000.0
    LINK_STATS["lat"].append((tx, lat))
    q = ECO.get("qacc")
    if q is not None:
        q.add_latency(lat)


def _timing_now(tm):
    if not tm:
        return {"imu_age_ms": None, "enc_sweep_ms": None}
    qa = tm.get("qage_us") or {}
    return {"imu_age_ms": {k: (round(qa[k] / 1000.0, 2) if qa.get(k) else None) for k in IMU_KEYS},
            "enc_sweep_ms": round(tm.get("enc_us", 0) / 1000.0, 3) if tm.get("enc_us") else None}


def link_stats(now):
    """snapshot link.* timing (cached 0.5 s): pose-lane latency median/p95
    over the last 5 s, pose-lane and device frame rates, serial jitter."""
    c = LINK_STATS
    if c["cache"] is not None and now - c["cache_t"] < 0.5:
        return c["cache"]
    lat = [v for (tx, v) in list(c["lat"]) if now - tx <= 5.0]
    p50, p95 = research.percentiles(lat)
    built = [t for t in list(c["built"]) if now - t <= 2.0]
    pose_hz = ((len(built) - 1) / (built[-1] - built[0])) if (len(built) > 2 and built[-1] > built[0]) else 0.0
    offs = [o for (t, o) in list(c["rx_off"]) if now - t <= 6.0]
    jit = None
    if len(offs) > 10:
        lo = min(offs)
        j50, j95 = research.percentiles([o - lo for o in offs])
        jit = {"median": round(j50, 2), "p95": round(j95, 2)}
    fresh = bool(offs) and (now - list(c["rx_off"])[-1][0]) < 1.0
    out = {"latency_ms": ({"median": round(p50, 3), "p95": round(p95, 3), "n": len(lat), "window_s": 5}
                          if lat else None),
           "pose_hz": round(pose_hz, 1),
           "pose_clients": POSE_LANE["clients"],
           "pose_coalesced": POSE_LANE["coalesced"],
           "frame_hz": round(_frame_rate["hz"], 2) if (_frame_rate.get("hz") and fresh) else None,
           "serial_jitter_ms": jit if fresh else None}
    c["cache"], c["cache_t"] = out, now
    return out


def record_start(profile_name, task, notes):
    """Begin the one shared recording. Idempotent: a second start joins the
    running take instead of restarting it. Returns (take_id, newly_started).

    Rows are appended by the ingest thread once per DEVICE frame
    (_record_row) into a spool file, so a long take costs no RAM and a 100 Hz
    device is never sampled at the 60 Hz snapshot rate (which used to write
    duplicated t_ms rows)."""
    with state_lock:
        if state["recording"]:
            return ECO["rec_id"], False
        take_id = "take_%04d" % _next_state_id("take")
        try:
            spool = open(_spool_path(take_id), "w", buffering=1 << 16)
        except OSError as e:
            print("[takes] cannot open the row spool:", e)
            spool = None
        state["recording"] = True
        ECO["rec_id"] = take_id
        ECO["rec_start"] = time.time()
        ECO["rec_samples"] = 0
        ECO["spark"] = []
        ECO["rows"] = []
        ECO["spool"] = spool
        ECO["spool_path"] = _spool_path(take_id)
        ECO["rows_n"] = 0
        ECO["last_row_t"] = None
        ECO["any_traj"] = False
        ECO["any_inertial"] = False
        ECO["sd_take"] = None
        ECO["rec_env"] = None
        ECO["rows_vision"] = 0
        ECO["rows_enc"] = 0
        ECO["contacts"] = []
        ECO["profile"] = profile_name or "Operator"
        ECO["task"] = task or "unlabelled"
        ECO["notes"] = notes or ""
        # research: the raw sidecar opens at the take's first device frame
        # (ingest thread), the quality accumulates per recorded row
        ECO["raw_path"] = _raw_path(take_id)
        ECO["raw_pending"] = True
        ECO["qacc"] = research.QualityAccumulator(nominal_hz=_nominal_hz())
    send_teensy(b"b" if _fw["explicit_rec"] else b"r")   # idempotent start when the fw can
    return take_id, True


def _record_row(row, used_vision, used_enc, fresh_env, qinfo=None):
    """Append one row of the running take (ingest thread, once per device
    frame). A repeated device t_ms is dropped: rows are never duplicated."""
    with state_lock:
        if not state["recording"] or ECO["spool"] is None:
            return
        qacc = ECO.get("qacc")
        if ECO["last_row_t"] is not None and row[0] <= ECO["last_row_t"]:
            if qacc is not None:
                qacc.dup += 1
            return
        if ECO["rows_n"] >= REC_ROWS_CAP:
            if ECO["rows_n"] == REC_ROWS_CAP:
                ECO["rows_n"] += 1
                print(f"[takes] row log capped at {REC_ROWS_CAP} rows (2 h at 100 Hz); "
                      "the recording continues, further rows are not logged")
            return
        try:
            ECO["spool"].write(json.dumps(row, separators=(",", ":")) + "\n")
        except Exception as e:
            print("[takes] row spool write failed:", e)
            return
        ECO["last_row_t"] = row[0]
        ECO["rows_n"] += 1
        if qacc is not None and qinfo is not None:
            if qacc.frames == 0:
                if qinfo.get("qage_us") is not None:
                    qacc.clock = "t_us"
                qacc.set_neutral(research.neutral_info(BODY.neutral, qinfo["t_dev_us"] / 1e6))
            qacc.add(**qinfo)
        if row[_COL_PX] is not None:
            ECO["any_traj"] = True
        if row[_COL_IHX] is not None:
            ECO["any_inertial"] = True
        if used_vision:
            ECO["rows_vision"] += 1
        if used_enc:
            ECO["rows_enc"] += 1
        if fresh_env:
            ECO["rec_env"] = fresh_env      # last fresh env wins (the room you ended in)


def _write_take_data(take_id, spool_path, contacts):
    """Seal a spooled take into the take-data JSON ({id, cols, rows[, contacts]}),
    streaming line by line so a long take never has to fit in RAM twice."""
    path = _take_data_path(take_id)
    tmp = path + ".tmp"
    n = 0
    with open(tmp, "w") as out:
        # one row per line (still one JSON document): research.iter_take_rows
        # streams it back without loading a 2 h take whole
        out.write('{"id":%s,"cols":%s,"rows":[\n' % (json.dumps(take_id), json.dumps(ROW_COLS)))
        with open(spool_path) as src:
            for line in src:
                line = line.strip()
                if not line:
                    continue
                out.write((",\n" if n else "") + line)
                n += 1
        out.write("\n]")
        if contacts:
            out.write(',"contacts":%s,"contact_cols":%s' % (json.dumps(contacts), json.dumps(CONTACT_COLS)))
        out.write("}")
    os.replace(tmp, path)
    return n


def record_stop():
    """Stop and seal the shared recording into the take library.
    Returns the sealed take dict, or None if nothing was recording."""
    with state_lock:
        if not state["recording"]:
            return None
        state["recording"] = False
        dur = max(0.0, time.time() - ECO["rec_start"])
        spool, spool_path = ECO["spool"], ECO["spool_path"]
        ECO["spool"] = None
        ECO["spool_path"] = None
        n_rows = min(ECO["rows_n"], REC_ROWS_CAP)
        any_traj, any_inertial = ECO["any_traj"], ECO["any_inertial"]
        rec_env = ECO["rec_env"]; ECO["rec_env"] = None
        rows_vision = ECO["rows_vision"]; ECO["rows_vision"] = 0
        rows_enc = ECO["rows_enc"]; ECO["rows_enc"] = 0
        contacts = ECO["contacts"]; ECO["contacts"] = []
        sd_take = ECO["sd_take"]
        qacc = ECO["qacc"]; ECO["qacc"] = None
        ECO["raw_pending"] = False
        take = {
            "id": ECO["rec_id"], "profile": ECO["profile"], "task": ECO["task"],
            "created_ms": int(state["t_ms"]), "duration_s": round(dur, 1),
            "samples": ECO["rec_samples"], "quality": "good",
            "spark": _downsample(ECO["spark"]),
            "rate_hz": _fw.get("rate_hz") or (100 if (_fw.get("version") or 0) >= 16 else 50),
            "source": "live",
        }
        cal = (BODY_STATUS.get("status") if isinstance(BODY_STATUS, dict) else None)
        if cal:
            take["body_cal"] = cal
        if sd_take:
            take["sd_take"] = sd_take
        if ECO["notes"]:
            take["notes"] = ECO["notes"]
        ECO["rec_id"] = None
    if spool is not None:
        try:
            spool.close()
        except Exception:
            pass
    with _raw_lock:
        raw = ECO["raw"]
        ECO["raw"] = None
    RAW_RING.clear()
    # research: quality (computed from the rows just recorded), provenance,
    # the raw device stream
    quality = qacc.finish() if qacc is not None else None
    if quality is not None:
        take["quality"] = quality
        if quality.get("rate_hz"):
            take["rate_hz"] = quality["rate_hz"]
    prov = provenance("live")
    take["fw"] = prov["fw"]
    take["boot_id"] = prov["boot_id"]
    take["bridge_version"] = BRIDGE_VERSION
    if raw is not None:
        size = raw.close({"rows": n_rows, "lines": raw.lines})
        take["raw"] = {"file": take["id"] + ".raw.txt.gz", "bytes": size, "lines": raw.lines,
                       "format": research.RAW_FORMAT}
    # 4D replay: seal the host-side sample log next to the library. traj =
    # at least one row carried a fresh 6-DoF pose (AR wrist stream / sim).
    if n_rows and spool_path:
        take["has_data"] = True
        take["traj"] = any_traj
        # a second, independent translation source (v7 inertial). Kept separate
        # from `traj` so the existing meaning of that flag - "the headset saw
        # this take" - does not quietly change under old clients.
        take["traj_inertial"] = any_inertial
        take["body"] = True           # rows carry the b_* body columns
        take["joint_source"] = _joint_source_label(n_rows, rows_vision, rows_enc)
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
            take["rows"] = _write_take_data(take["id"], spool_path, contacts)
        except Exception as e:
            print("[takes] could not save replay data:", e)
            take["has_data"] = False
    if spool_path:
        try:
            os.remove(spool_path)
        except OSError:
            pass
    send_teensy(b"e" if _fw["explicit_rec"] else b"r")   # idempotent stop when the fw can
    _write_research_meta(take, prov, quality)
    takes.insert(0, take)
    _save_takes()
    return take


def _write_research_meta(take, prov, quality):
    try:
        _write_json_atomic(_meta_path(take["id"]), research.take_json(
            take, prov, quality, raw_name=(take["raw"]["file"] if take.get("raw") else None)))
        take["research"] = True
    except Exception as e:
        print("[takes] could not write the research metadata:", e)


def _joint_source_label(n_rows, rows_vision, rows_enc):
    """HONESTY LABEL: where the finger-joint columns actually came from.
    encoders = the physical rig's AS5600s; quest-hand = the headset's hand
    tracking (real vision, used when the rig is absent); sim = the synthetic
    device. Majority-of-rows decides; the count ships too."""
    if SIM_MODE and rows_vision <= n_rows / 2:
        return "sim"
    if rows_vision > n_rows / 2 or (rows_vision > 0 and rows_enc == 0):
        return "quest-hand"
    if rows_enc > 0:
        return "encoders"
    # no sensor ever contributed a value: placeholders only. Never call that
    # "encoders" (label addition; surfaces render the string)
    return "none"


def _note_sample_locked():
    """Per real device frame (100 Hz on v16), caller HOLDS state_lock: recording counters."""
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
# On the real bench the firmware owns the motor bus and streams its measured
# motor block (v6+), which the snapshot reports read-only as spool_1/spool_2;
# nothing here fakes a real motor. In sim, this bank gives the ecosystem
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
# SIMULATED DEVICE (--sim): sim_device.SimDevice prints the same text a v16
# Teensy prints; handle_line() below parses it exactly as it parses the serial
# port, so the IMU pipeline, the body model, E-events, recording and the SD
# library all run the production code. Only two sim-specific shims remain:
# encoders arrive in joint space (+SIM_ENC_BIAS) and the zero-filled motor
# block is ignored so the simulated motor bank (SimMotors) keeps its role.
# ============================================================================
SIM_DEVICE = None
SIM_ENC_BIAS = 180.0
_LOOP = None                      # the asyncio loop (set in main_async): threads broadcast through it


def _emit(msg):
    """Broadcast from a non-event-loop thread (serial / sim / worker)."""
    loop = _LOOP
    if loop is None:
        return
    try:
        loop.call_soon_threadsafe(broadcast, msg)
    except RuntimeError:
        pass


def _on_loop(fn, *a):
    """Run fn(*a) on the event loop (mutations of the take library etc.)."""
    loop = _LOOP
    if loop is None:
        fn(*a)
        return
    try:
        loop.call_soon_threadsafe(fn, *a)
    except RuntimeError:
        pass


def enable_sim_pipeline():
    """Sim persistence goes to .sim-suffixed files: a calibrate click during a
    --sim demo must never overwrite the REAL bench calibration in STATE_DIR.
    The simulated device streams joint-space finger angles, so the bench
    encoder map is replaced by the direct joint map. IMUs are NOT special-cased
    any more: the sim device emits raw sensor-frame data mounted like the bench
    priors, and it goes through the real mounting / neutral / body pipeline."""
    global ENC_JOINT_SPACE_DIRECT, _JCAL_FILE, _TARE_FILE, _IMU_CFG_FILE, _BODY_FILE, BODY, _ENC_MAP_FILE
    if not _JCAL_FILE.endswith(".sim"):
        _JCAL_FILE += ".sim"
        _ENC_MAP_FILE += ".sim"
        _TARE_FILE += ".sim"
        _IMU_CFG_FILE += ".sim"
        _BODY_FILE += ".sim"
    ENC_DOF.clear()
    ENC_JOINT_SPACE_DIRECT = True
    ENC_OPEN.clear(); ENC_CLOSED.clear(); _cont_open.clear()
    with state_lock:
        state["enc"] = [ENC_ABSENT_SIM] * N_CH   # sim absence sentinel from frame zero
    imu_cfg_load()
    _load_tare()
    _body_load()
    BODY = _make_body()


def sim_thread(hz=100.0):
    """Run the line-level simulated device; its output goes through handle_line()."""
    global SIM_DEVICE
    import sim_device
    try:      # tests speed the scene up so rep/record cycles finish in seconds
        speed = max(0.1, min(20.0, float(os.environ.get("SENSORYHAND_SIM_SPEED", "1"))))
    except ValueError:
        speed = 1.0
    dev = sim_device.SimDevice(rig_mountings(), speed=speed, emit=_sim_line)
    SIM_DEVICE = dev
    print("[sim] line-level v17 device running (100 Hz S-lines, boot_id %d, 3 IMUs, "
          "12 joints, EMG, SD card)" % dev.boot_id)
    dev.write(b"v\nj\n")                    # the same handshake the serial thread sends
    dev.run()


def _sim_line(line):
    try:
        handle_line(line)
    except Exception as e:
        print("[sim] line handling failed:", e)


# ----------------------------------------------------------------------------
# S-line parsing (pure: a list of fields -> a frame dict)
# ----------------------------------------------------------------------------
V16_BASE = SEA_STATE_IDX + 1          # 121: fw_flags (MOTION_PIPELINE.md s.5)
V17_BASE = V16_BASE + 19              # 140: t_us, qage x3, enc_us (MOTION_PIPELINE.md s.8)


def parse_s_line(line):
    """Parse one `S,` line into a frame dict, or None if it is not a frame.
    Every group is length-gated, so any firmware from v1 to v17 parses.

    fr["t_dev_us"] is the frame's device time in microseconds since boot:
    t_us unwrapped across its 32-bit wrap (research.unwrap_us) on v17, else
    t_ms * 1000. fr["timing"] carries the v17 tail or None."""
    p = line.split(",")
    # 1 tag + 1 t + 14 enc + 8 quat + 2 live = 26
    if len(p) < 26 or p[0] != "S":
        return None
    try:
        fr = {"t": int(float(p[1]))}
        fr["enc"] = [float(x) for x in p[2:2 + N_CH]]
        fr["hq"] = [float(x) for x in p[2 + N_CH:2 + N_CH + 4]]
        fr["fq"] = [float(x) for x in p[2 + N_CH + 4:2 + N_CH + 8]]
        fr["il"] = [int(float(p[24])), int(float(p[25]))]
        # EMG fields (env, rms, present); absent on old firmware -> not present
        fr["emg_env"] = float(p[26]) if len(p) > 26 else 0.0
        fr["emg_rms"] = float(p[27]) if len(p) > 27 else 0.0
        fr["emg_present"] = len(p) > 28 and int(float(p[28])) == 1
        # crown pot (v3): 0..1000 -> 0..1. v6+ says whether a crown is wired at
        # all (crown_live, idx 42: 1 present, -1 none); an unwired crown streams
        # 0, which must not claim crown authority over the blend.
        crown = max(0.0, min(1.0, int(float(p[29])) / 1000.0)) if len(p) > 29 else None
        fr["crown_live"] = None
        if len(p) > CROWN_LIVE_IDX:
            fr["crown_live"] = int(float(p[CROWN_LIVE_IDX])) == 1
            if not fr["crown_live"]:
                crown = None
        fr["crown"] = crown
        # thumb-tip IMU (v4): quat + live flag
        if len(p) > 34:
            fr["tq"] = [float(p[30]), float(p[31]), float(p[32]), float(p[33])]
            fr["thumb_live"] = int(float(p[34])) == 1
        else:
            fr["tq"], fr["thumb_live"] = None, False
        # ---- v6 firmware: the real motor block (pos/vel/current) ----
        motors_fw = None
        if len(p) > CROWN_LIVE_IDX:
            mf = int(float(p[MOT_FLAGS_IDX]))
            motors_fw = {"flags": mf, "taken": bool(mf & 1),
                         "torque": bool(mf & 2), "mode": (mf >> 2) & 7,
                         # v13 moves fault from bit 4 to bit 5 because bit 4
                         # now represents mode 4 (the two-independent-DOF SEA loop).
                         "fault": bool((mf & 32) or ((mf & 16) and ((mf >> 2) & 7) != 4)), "m": {}}
            for _k in range(N_MOT_FW):
                _b = MOT_BASE + 3 * _k
                motors_fw["m"][_k + 1] = {"pos": float(p[_b]), "vel": float(p[_b + 1]),
                                          "ma": float(p[_b + 2])}
            if len(p) >= MOTOR_DIAG_BASE + 8:
                _d = [int(float(x)) for x in p[MOTOR_DIAG_BASE:MOTOR_DIAG_BASE + 8]]
                _names = {
                    0: "none", 1: "configuration write", 2: "feedback seed",
                    3: "torque acknowledgement", 4: "sustained bus miss",
                    5: "servo hardware alarm", 6: "bus-watchdog rearm",
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
            if len(p) > SEA_STATE_IDX:
                _s = int(float(p[SEA_STATE_IDX]))
                motors_fw["sea"] = {"zeroed": bool(_s & 1), "armed": bool(_s & 2),
                                    "directions": bool(_s & 4), "joint_fresh": bool(_s & 8)}
        fr["motors_fw"] = motors_fw
        # ---- v7 firmware: the FULL IMU set, 23 fields per sensor ----
        imu_full = None
        if len(p) >= V7_BASE + 3 * V7_STRIDE:
            imu_full = {}
            for si, sk in enumerate(IMU_KEYS):
                b = V7_BASE + si * V7_STRIDE
                f = [float(x) for x in p[b:b + V7_STRIDE]]
                imu_full[sk] = {
                    "lin": f[0:3], "acc": f[3:6], "gyr": f[6:9], "mag": f[9:12],
                    "grv": f[12:15], "game": f[15:19],
                    "accuracy": {"acc": int(f[19]), "gyr": int(f[20]), "mag": int(f[21])},
                    "rot_accuracy_rad": f[22],
                }
        fr["imu_full"] = imu_full
        # ---- v16: device state, boot id, preintegrated dv, stability ----
        v16 = None
        if len(p) >= V16_BASE + 4:
            v16 = {"flags": int(float(p[V16_BASE])), "take": int(float(p[V16_BASE + 1])),
                   "rows": int(float(p[V16_BASE + 2])), "boot_id": int(float(p[V16_BASE + 3])),
                   "dv": None, "stab": None, "dv_n": None}
            if len(p) >= V16_BASE + 13:
                v16["dv"] = {k: [float(x) for x in p[V16_BASE + 4 + 3 * i:V16_BASE + 7 + 3 * i]]
                             for i, k in enumerate(IMU_KEYS)}
            if len(p) >= V16_BASE + 16:
                v16["stab"] = {k: int(float(p[V16_BASE + 13 + i])) for i, k in enumerate(IMU_KEYS)}
            if len(p) >= V16_BASE + 19:
                v16["dv_n"] = {k: int(float(p[V16_BASE + 16 + i])) for i, k in enumerate(IMU_KEYS)}
        fr["v16"] = v16
        # ---- v17: device timing (t_us, quaternion ages, encoder sweep) ----
        timing = None
        if len(p) >= V17_BASE + 5:
            timing = {"t_us": int(float(p[V17_BASE])),
                      "qage_us": {k: int(float(p[V17_BASE + 1 + i])) for i, k in enumerate(IMU_KEYS)},
                      "enc_us": int(float(p[V17_BASE + 4]))}
        fr["timing"] = timing
        fr["t_dev_us"] = research.unwrap_us(fr["t"], timing["t_us"] if timing else None)
    except (ValueError, IndexError):
        return None
    return fr


def imu_sample_times(fr):
    """{imu: device seconds the orientation in this frame was sampled} (v17:
    frame time - qage; a zero age means "no quaternion yet"), or {}."""
    tm = fr.get("timing")
    if not tm or fr.get("t_dev_us") is None:
        return {}
    out = {}
    for k in IMU_KEYS:
        a = tm["qage_us"].get(k)
        out[k] = (fr["t_dev_us"] - a) / 1e6 if a and a > 0 else None
    return out


# ----------------------------------------------------------------------------
# per-frame ingest (serial / sim thread): everything derived from ONE device
# frame is computed here, once, and the snapshot only packages it
# ----------------------------------------------------------------------------
BODY_STATUS = {"status": "none"}
_last_raw = {"hand": None, "forearm": None, "thumb": None}
_frame_rate = {"t_prev": None, "hz": None, "dt": None}
NEUTRAL_UI = {"phase": None, "t0": None, "source": None, "want_enc_open": False,
              "last_sent": None, "hold_t0": None, "result": None}
# a firmware older than v16 has no N command: the bridge runs the countdown
# itself and captures from its own frames (host timing, same pose rules)
NEUTRAL_COUNTDOWN_S = 3.0
NEUTRAL_HOLD_S = 2.0


def _joints_from_enc(enc):
    """Encoder degrees -> the joints[] and encoders[] lists (honest presence)."""
    validate_jcal_once(enc)
    joint_override, joint_calibrated = {}, {}
    for ch in ENC_DOF:
        d = enc[ch] if ch < len(enc) else -1.0
        if d >= 0.0:
            jid, val = calibrated_joint(ch, d)
            joint_override[jid] = val
            dof, _ = ENC_DOF[ch]
            joint_calibrated[jid] = ch in ENC_OPEN and (dof == "abduct" or ch in ENC_CLOSED)
    joints, n_live = [], 0
    for f in FINGERS:
        for seg in SEGMENTS:
            jid = f + "_" + seg
            if jid in joint_override:
                d = joint_override[jid]; ok = True
            elif SIM_MODE or ENC_JOINT_SPACE_DIRECT:
                ch = JOINT2CH[jid]
                if ch in ENC_DOF:
                    d = -1.0; ok = False
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
    encoders, n_enc = [], 0
    for ch in range(N_CH):
        d = enc[ch] if ch < len(enc) else -1000.0
        ok = _enc_ok(d)
        if ok:
            n_enc += 1
        if ch in ENC_DOF:
            joint_name = enc_joint_id(ch)
        elif SIM_MODE or ENC_JOINT_SPACE_DIRECT:
            joint_name = CH2JOINT.get(ch)
        else:
            joint_name = None       # fitted sensor, mapping not measured yet
        encoders.append({"ch": ch, "deg": round(d, 2) if ok else -1.0, "ok": ok, "joint": joint_name})
    return joints, n_live, encoders, n_enc


def _legacy_tare_from(q0, provisional):
    """Seat the legacy display home (hand/forearm/thumb keys) on the SAME
    averaged raw quaternions the body neutral used, so the two agree."""
    global IMU_TARE_HAND, IMU_TARE_FOREARM, IMU_TARE_THUMB
    global _imu_tare_pending, _thumb_tare_pending, _tare_state
    qh, qf, qt = q0.get("hand"), q0.get("forearm"), q0.get("thumb")
    if qh is None or qf is None:
        return
    th = imu_cfg_apply(qh, "hand")
    tf = imu_cfg_apply(qf, "forearm")
    if not (_valid_quat(th) and _valid_quat(tf)):
        return
    IMU_TARE_HAND = quat_conj(_norm_quat(th))
    IMU_TARE_FOREARM = quat_conj(_norm_quat(tf))
    _imu_tare_pending = False
    if qt is not None:
        tt = imu_cfg_apply(qt, "thumb")
        if _valid_quat(tt):
            IMU_TARE_THUMB = quat_conj(_norm_quat(tt))
            _thumb_tare_pending = False
    _tare_state = "provisional" if provisional else "calibrated"
    if not provisional:
        _save_tare({"hand": True, "forearm": True, "thumb": qt is not None})


def _legacy_imu_display(live_map):
    """The pre-body-model display quaternions (snapshot hand/forearm/thumb):
    align-or-remap, offset, tare, gain, flip - now for the thumb too (its gain
    and flip used to be silently ignored)."""
    global IMU_TARE_THUMB, _thumb_tare_pending
    hq_raw = _last_raw["hand"] or [1.0, 0.0, 0.0, 0.0]
    fq_raw = _last_raw["forearm"] or [1.0, 0.0, 0.0, 0.0]
    hq = quat_mul(IMU_TARE_HAND, imu_cfg_apply(hq_raw, "hand"))
    fq = quat_mul(IMU_TARE_FOREARM, imu_cfg_apply(fq_raw, "forearm"))
    hq = quat_flip_sense(quat_gain(hq, IMU_CFG["hand"]["gain"]), IMU_CFG["hand"]["flip"])
    fq = quat_flip_sense(quat_gain(fq, IMU_CFG["forearm"]["gain"]), IMU_CFG["forearm"]["flip"])
    thumb = None
    if live_map.get("thumb") and _last_raw["thumb"] is not None:
        tq_r = imu_cfg_apply(_last_raw["thumb"], "thumb")
        if _thumb_tare_pending and BODY.has_heading():
            # the thumb joined after the neutral (hot-plug): seat its home the
            # first time it has been still for a second - never while moving
            ss = BODY.still_since.get("thumb")
            if ss is not None and BODY.t is not None and BODY.t - ss >= 1.0 and _valid_quat(tq_r):
                IMU_TARE_THUMB = quat_conj(_norm_quat(tq_r))
                _thumb_tare_pending = False
        tqd = quat_mul(IMU_TARE_THUMB, tq_r)
        tqd = quat_flip_sense(quat_gain(tqd, IMU_CFG["thumb"]["gain"]), IMU_CFG["thumb"]["flip"])
        rel_thumb = quat_mul(quat_conj(hq), tqd)       # thumb expressed in the HAND frame
        thumb = {"quat": [round(v, 4) for v in tqd], "rpy_deg": quat_to_rpy(*tqd),
                 "rel_quat": [round(v, 4) for v in rel_thumb],
                 "home": "pending" if _thumb_tare_pending else _tare_state}
    return hq, fq, thumb


def _on_device_boot(boot_id, reason):
    """The device (re)booted, or we learned its boot id for the first time.
    Everything tied to the old heading reference is dropped."""
    global IMU_TARE_HAND, IMU_TARE_FOREARM, IMU_TARE_THUMB, _tare_state
    global _imu_tare_pending, _thumb_tare_pending, _rel_quat_hold, _BODY_NEUTRAL_CANDIDATE
    global _TARE_CANDIDATE
    prev = DEVICE.get("boot_id")
    DEVICE["boot_id"] = boot_id
    if boot_id is None or prev != boot_id:
        had = BODY.neutral is not None
        if not BODY.set_boot(boot_id):
            BODY.reset_boot(boot_id)
    else:
        had = False
    IMU_TARE_HAND = [1.0, 0.0, 0.0, 0.0]
    IMU_TARE_FOREARM = [1.0, 0.0, 0.0, 0.0]
    IMU_TARE_THUMB = [1.0, 0.0, 0.0, 0.0]
    _imu_tare_pending = True
    _thumb_tare_pending = True
    _tare_state = "none"
    _rel_quat_hold = [1.0, 0.0, 0.0, 0.0]
    for k in IMU_KEYS:
        TRACKERS[k].reset(keep_bias=True)
    adopted = False
    if boot_id is not None:
        cand, _BODY_NEUTRAL_CANDIDATE = _BODY_NEUTRAL_CANDIDATE, None
        if cand and cand.get("boot_id") == boot_id and BODY.import_neutral(cand):
            adopted = True
            _legacy_tare_from(BODY.neutral["q0"], provisional=False)
            print("[body] neutral restored for device boot %s (captured before this bridge start)" % boot_id)
        elif cand:
            print("[body] saved neutral is for device boot %s, device is on %s: discarded"
                  % (cand.get("boot_id"), boot_id))
        if adopted:
            # the legacy home was just re-seated from the same neutral's averages
            _TARE_CANDIDATE = None
        else:
            _tare_adopt_for_boot(boot_id)
    if prev is not None or reason != "first":
        print("[device] %s: boot %s -> %s (neutral %s)" % (reason, prev, boot_id,
                                                           "dropped" if had else "none to drop"))
        _emit({"kind": "ack", "event": "device_boot", "boot_id": boot_id, "previous": prev,
               "reason": reason, "neutral_dropped": bool(had)})


def _device_frame_meta(fr, now):
    """v16 tail -> DEVICE; reboot detection (boot id, or the clock going back)."""
    v16 = fr.get("v16")
    t = fr["t"]
    last_t = DEVICE.get("last_t_ms")
    if v16 is not None:
        boot = v16["boot_id"]
        if boot != DEVICE.get("boot_id"):
            _on_device_boot(boot, "first" if DEVICE.get("boot_id") is None else "device rebooted")
        fl = v16["flags"]
        DEVICE.update(fw=max(17 if fr.get("timing") else 16, _fw.get("version") or 16), flags=fl,
                      sd_recording=bool(fl & 1), sd_present=bool(fl & 2), standby=bool(fl & 4),
                      host_link=bool(fl & 8), auto_record=bool(fl & 16),
                      neutral_running=bool(fl & 32), sd_take=v16["take"], sd_rows=v16["rows"])
        # list the card once per boot, so sd_takes has content without a click
        if DEVICE["sd_present"] and _LOOP is not None and SD_STATE.get("listed_boot") != boot:
            SD_STATE["listed_boot"] = boot
            try:
                asyncio.run_coroutine_threadsafe(sd_list(), _LOOP)
            except RuntimeError:
                pass
    elif last_t is not None and t < last_t - 1000:
        # pre-v16: no boot id, but the device clock starts again at every boot
        _on_device_boot(None, "device clock restarted (reboot)")
    DEVICE["last_t_ms"] = t
    # the device clock in ms, at microsecond resolution on v17 (t_us)
    td = fr["t_dev_us"] / 1000.0 if fr.get("t_dev_us") is not None else float(t)
    fp = _frame_rate["t_prev"]
    if fp is not None and 0 < td - fp < 500:
        # average the PERIOD (not 1/period, which a jittery frame biases upward)
        dtm = float(td - fp)
        _frame_rate["dt"] = dtm if _frame_rate.get("dt") is None else _frame_rate["dt"] + 0.02 * (dtm - _frame_rate["dt"])
        _frame_rate["hz"] = 1000.0 / _frame_rate["dt"]
    _frame_rate["t_prev"] = td
    # serial delivery jitter: receive time minus device time (the constant
    # clock offset cancels against the window minimum in the snapshot)
    LINK_STATS["rx_off"].append((now, now * 1000.0 - td))


def _body_step(fr, hq, fq, tq, live_map, raw_line=None, rx=None):
    """Advance the body model by one device frame (ingest thread only).

    While a take records, the raw sidecar gets this frame's S-line here, with
    any change of the body neutral annotated around it in stream order (`#N,b`
    before the frame for a change made between frames, `#N,a` after it for one
    made inside the frame's update), so rederive.py can replay the take
    exactly (research.RawWriter)."""
    while BODY_REQ:
        fn = BODY_REQ.popleft()
        try:
            fn(BODY)
        except Exception as e:
            print("[body] request failed:", e)
    if raw_line is not None:
        _raw_neutral_note("b", rx)
        _raw_write(rx, raw_line)
    imu_full = fr.get("imu_full") or {}
    v16 = fr.get("v16") or {}
    dv = v16.get("dv") or {}
    dvn = v16.get("dv_n") or {}
    stab = v16.get("stab") or {}
    q = {"hand": hq if live_map["hand"] else None,
         "forearm": fq if live_map["forearm"] else None,
         "thumb": tq if live_map["thumb"] else None}
    t_dev = fr["t_dev_us"] / 1e6 if fr.get("t_dev_us") is not None else fr["t"] / 1000.0
    bf = {"t": t_dev, "q": q, "ts": imu_sample_times(fr),
          "gyr": {k: (imu_full.get(k) or {}).get("gyr") if live_map[k] else None for k in IMU_KEYS},
          "lin": {k: (imu_full.get(k) or {}).get("lin") if live_map[k] else None for k in IMU_KEYS},
          # a dv with zero integrated reports is "no data", not "no motion"
          "dv": {k: (dv.get(k) if (live_map[k] and dvn.get(k, 1) != 0) else None) for k in IMU_KEYS},
          "dv_n": {k: dvn.get(k) for k in IMU_KEYS},
          "stab": {k: (stab.get(k) if stab.get(k) not in (None, 255) else None) for k in IMU_KEYS}}
    BODY.update(bf)
    if raw_line is not None:
        _raw_neutral_note("a", rx)
    for kind, res in BODY.pop_events():
        _body_event(kind, res)
    BODY_STATUS["status"] = BODY.status()


def _body_event(kind, res):
    if kind == "neutral_auto":
        _legacy_tare_from(BODY.neutral["q0"], provisional=True)
        print("[body] provisional neutral (arm still 1.5 s): %s" % res.get("report"))
        _emit({"kind": "ack", "event": "neutral", "phase": "provisional", "ok": True,
               "report": res.get("report")})
    elif kind == "neutral":
        _neutral_result(res, NEUTRAL_UI.get("source") or "device")
    elif kind == "wrist_axis":
        if res.get("ok"):
            BODY_PERSIST["wrist_axis"] = res["axis_sensor"]
            if res.get("neutral_resolved") and BODY.neutral is not None:
                BODY_PERSIST["neutral"] = BODY.export_neutral()
            _body_save()
        print("[body] wrist axis: %s" % res)
        _emit(dict({"kind": "ack", "event": "wrist_axis", "phase": "done" if res.get("ok") else "failed"},
                   **res))
    elif kind == "hand_frame":
        BODY_PERSIST["hand_flip"] = BODY.hand_flip
        BODY_PERSIST["wrist_axis"] = (list(BODY.wrist_axis) if BODY.wrist_axis is not None else None)
        if BODY.neutral is not None and not BODY.neutral["provisional"]:
            BODY_PERSIST["neutral"] = BODY.export_neutral()
        if res.get("corrected"):
            _body_save()
        print("[body] hand frame %s: %s" % ("CORRECTED" if res.get("corrected") else "verified", res))
        _emit(dict({"kind": "ack", "event": "hand_frame"}, **res))


def _neutral_result(res, source):
    """A neutral solve finished (device event or bridge capture)."""
    if res.get("ok"):
        q0 = BODY.neutral["q0"]
        _legacy_tare_from(q0, provisional=False)
        BODY_PERSIST["neutral"] = BODY.export_neutral()
        _body_save()
        if NEUTRAL_UI.get("want_enc_open"):
            # contract step 4: the encoder "open" reference, from the pose the
            # wearer just held (fingers extended) - only for a neutral the
            # console asked for, exactly as the old calibrate/neutral did
            with state_lock:
                enc_now = list(state["enc"])
            capture_joint_ref("open", enc_now)
        NEUTRAL_UI.update(phase="done", result=res, want_enc_open=False)
        print("[body] neutral captured (%s): %s" % (source, res.get("report")))
        _emit({"kind": "ack", "event": "neutral", "phase": "done", "t": 0, "ok": True,
               "source": source, "report": res.get("report"), "spread_deg": res.get("spread_deg")})
    else:
        NEUTRAL_UI.update(phase="abort", result=res, want_enc_open=False)
        print("[body] neutral refused (%s): %s" % (source, res.get("reason")))
        _emit({"kind": "ack", "event": "neutral", "phase": "abort", "t": 0, "ok": False,
               "source": source, "reason": res.get("reason")})


def neutral_begin(source):
    """Start the countdown/hold UI state (device-driven on v16, host-driven before)."""
    NEUTRAL_UI.update(phase="countdown", t0=time.time(), source=source,
                      last_sent=("countdown", int(NEUTRAL_COUNTDOWN_S)), hold_t0=None, result=None)
    _emit({"kind": "ack", "event": "neutral", "phase": "countdown", "t": int(NEUTRAL_COUNTDOWN_S),
           "source": source})


def _neutral_ui_tick(now):
    """Countdown/hold progress acks, once per second (broadcast loop)."""
    ui = NEUTRAL_UI
    if ui["phase"] not in ("countdown", "hold"):
        return
    el = now - ui["t0"]
    if el < NEUTRAL_COUNTDOWN_S:
        phase, left = "countdown", NEUTRAL_COUNTDOWN_S - el
    else:
        phase, left = "hold", max(0.0, NEUTRAL_COUNTDOWN_S + NEUTRAL_HOLD_S - el)
    key = (phase, int(math.ceil(left)))
    if key != ui["last_sent"]:
        ui["last_sent"] = key
        ui["phase"] = phase
        broadcast({"kind": "ack", "event": "neutral", "phase": phase, "t": int(math.ceil(left)),
                   "source": ui["source"]})
    if ui["source"] == "bridge" and el >= NEUTRAL_COUNTDOWN_S + NEUTRAL_HOLD_S and ui.get("hold_t0") is None:
        # host-timed fallback: capture the last 2 s of frames
        ui["hold_t0"] = now
        ui["phase"] = "solving"
        body_call(lambda bm: _neutral_result(bm.capture_neutral(window_s=NEUTRAL_HOLD_S, kind="bridge"),
                                             "bridge"))
    elif ui["source"] != "bridge" and el > 15.0:
        ui["phase"] = "abort"
        broadcast({"kind": "ack", "event": "neutral", "phase": "abort", "t": 0, "ok": False,
                   "source": ui["source"], "reason": "timeout: the device never reported done"})


def _device_event(ep, line):
    """E,rec,* / E,neutral,* / E,standby,* (serial / sim thread)."""
    kind = ep[1]
    if kind == "rec" and len(ep) >= 3:
        what = ep[2]
        if what == "start":
            take = int(ep[3]) if len(ep) > 3 and ep[3].isdigit() else None
            src = ep[4] if len(ep) > 4 else None
            DEVICE.update(sd_recording=True, sd_take=take or 0)
            with state_lock:
                if state["recording"] and ECO.get("sd_take") is None and src == "host":
                    ECO["sd_take"] = take
            _emit({"kind": "ack", "event": "sd_rec", "phase": "start", "take": take, "source": src,
                   "name": ("TAKES/TK%05u.CSV" % take) if take is not None else None})
        elif what == "stop":
            vals = [int(x) if x.isdigit() else None for x in ep[3:6]]
            take, rows, ms = (vals + [None] * 3)[:3]
            DEVICE.update(sd_recording=False, sd_take=0)
            _on_loop(_sd_take_closed, take, rows, ms)
            _emit({"kind": "ack", "event": "sd_rec", "phase": "stop", "take": take, "rows": rows,
                   "ms": ms, "name": ("TAKES/TK%05u.CSV" % take) if take is not None else None})
        elif what == "fail":
            reason = ep[3] if len(ep) > 3 else "unknown"
            DEVICE["last_error"] = {"text": "SD recording failed: %s" % reason, "t": time.time(),
                                    "code": "sd_" + reason}
            _emit({"kind": "ack", "event": "sd_rec", "phase": "fail", "reason": reason})
        return
    if kind == "neutral" and len(ep) >= 3:
        what = ep[2]
        if what == "start":
            src = NEUTRAL_UI["source"] if (NEUTRAL_UI["phase"] == "requested") else "device"
            want = NEUTRAL_UI.get("want_enc_open") if src != "device" else False
            neutral_begin(src)
            NEUTRAL_UI["want_enc_open"] = want
        elif what == "done":
            try:
                t_ms = float(ep[3])
                vals = [float(x) for x in ep[4:16]]
            except (ValueError, IndexError):
                t_ms, vals = None, []
            q_avg = None
            if len(vals) == 12:
                q_avg = {"hand": vals[0:4], "forearm": vals[4:8], "thumb": vals[8:12]}
                # the device averages the thumb even when it is not fitted; a
                # thumb that was not live contributes nothing
                if not (BODY.live.get("thumb") or _last_raw["thumb"] is not None):
                    q_avg["thumb"] = None
            if t_ms is None:
                _neutral_result({"ok": False, "reason": "malformed E,neutral,done"}, "device")
                return
            if NEUTRAL_UI["phase"] not in ("countdown", "hold", "requested"):
                NEUTRAL_UI["source"] = "device"
            NEUTRAL_UI["phase"] = "solving"
            res = BODY.request_device_neutral(t_ms / 1000.0, q_avg=q_avg)
            if res.get("ok") is not None:
                _neutral_result(res, NEUTRAL_UI.get("source") or "device")
        elif what == "abort":
            why = ep[3] if len(ep) > 3 else "aborted"
            NEUTRAL_UI.update(phase="abort", want_enc_open=False)
            _emit({"kind": "ack", "event": "neutral", "phase": "abort", "t": 0, "ok": False,
                   "source": "device", "reason": {"moving": "moved during the hold",
                                                  "imu": "a main IMU dropped out"}.get(why, why)})
        return
    if kind == "standby" and len(ep) >= 3:
        DEVICE["standby"] = ep[2] == "1"
        _emit({"kind": "ack", "event": "standby", "on": DEVICE["standby"]})


def _sd_take_closed(take, rows, ms):
    """E,rec,stop: annotate the bridge take recorded alongside (event loop)."""
    if take is None:
        return
    for tk in takes:
        if tk.get("sd_take") == take:
            tk["sd_name"] = "TAKES/TK%05u.CSV" % take
            tk["sd_rows"] = rows
            tk["sd_ms"] = ms
            _save_takes()
            broadcast({"kind": "takes", "takes": takes})
            return


_ERR_RE = re.compile(r"\bfail(ed|ure|s)?\b|\berror\b|\bno sd\b|\bcannot\b|could not|"
                     r"not found|\bmissing\b", re.I)


def _device_message(line):
    """A human-readable device line. Kept (last 16) for the snapshot; the ones
    that report a failure become health + a broadcast, never silently dropped."""
    now = time.time()
    with state_lock:                   # the snapshot copies this deque on another thread
        DEVICE["messages"].append({"t": round(now, 3), "text": line[:200]})
    m = re.match(r"#\s*boot_id\s+(\d+)", line)
    if m:
        return
    if _ERR_RE.search(line) and not line.startswith("# ver"):
        DEVICE["last_error"] = {"text": line[:200], "t": now}
        _emit({"kind": "ack", "event": "device_msg", "level": "error", "text": line[:200]})


def handle_line(line):
    """ONE device line, from the serial port or the simulated device. Returns
    the parsed frame for S-lines (the serial thread uses it for rescans)."""
    line = line.rstrip("\r\n")
    now = time.time()
    with state_lock:
        state["last_line"] = now
    if not line:
        return None
    if line.startswith("S,"):
        fr = parse_s_line(line)
        if fr is None:
            return None
        ingest_frame(fr, now, line)
        return fr
    if line.startswith("F,"):
        if SD is not None:
            SD.feed(line)
        return None
    if line.startswith("# ver"):
        try:
            _fw["version"] = int(line.split()[-1])
        except ValueError:
            _fw["version"] = 1
        _fw["explicit_rec"] = _fw["version"] >= 2
        if SD is not None:
            SD.chunked = _fw["version"] >= 18     # verifiable chunked SD transfer
        print(f"[serial] firmware v{_fw['version']} "
              f"(record: {'explicit b/e' if _fw['explicit_rec'] else 'legacy r toggle'})")
        # The banner means the device just (re)booted or answered 'v': its RAM
        # copy of the direction signs may be gone. Hand back the measured ones.
        if _push_directions_to_device():
            print("[follow] restored measured directions to the device")
        return None
    if line.startswith("E,watch,"):
        # the device confirming what it applied and saved: E,watch,<face>,<cw>,<ok>
        ep = line.split(",")
        if len(ep) >= 5:
            try:
                fi, ci, ok = int(ep[2]), int(ep[3]), int(ep[4])
            except ValueError:
                return None
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
        return None
    if line.startswith("E,"):
        RAW_RING.append((now, line))
        if ECO.get("raw") is not None:
            _raw_write(now, line)
        ep = line.split(",")
        if len(ep) >= 2 and ep[1] in ("rec", "neutral", "standby"):
            _device_event(ep, line)
        elif len(ep) >= 2 and ep[1] in ("nav", "press", "screen", "home", "cal"):
            # on-device crown/button: E,<action>[,<dir-or-screen>]
            device_command(ep[1],
                           direction=(ep[2] if ep[1] == "nav" and len(ep) > 2 else None),
                           screen=(ep[2] if ep[1] == "screen" and len(ep) > 2 else None),
                           source="device")
        return None
    _device_message(line)
    return None


def ingest_frame(fr, now, line=None):
    """Everything one device frame changes. Runs in the serial / sim thread.
    `line` is the S-line as received (kept in the take's raw sidecar)."""
    t = fr["t"]
    if fr.get("t_dev_us") is None:
        fr["t_dev_us"] = int(t) * 1000
    with state_lock:
        rec = state["recording"]
    raw_line = None
    if line is not None:
        if rec and _raw_begin(now):
            raw_line = line
        else:
            RAW_RING.append((now, line))
    _stale["cleared"] = False
    _device_frame_meta(fr, now)
    if SIM_MODE:
        fr["motors_fw"] = None                # the sim's motor block is zero-filled: SimMotors own motors
        raw_enc = [(d if d >= 0.0 else -1.0) for d in fr["enc"]]
        enc = [(d - SIM_ENC_BIAS) if d >= 0.0 else ENC_ABSENT_SIM for d in filter_encoders(raw_enc, t)]
    else:
        enc = filter_encoders(fr["enc"], t)
    if fr["tq"] is not None:
        _fw["thumb_capable"] = True
    if fr["imu_full"] is not None:
        _fw["full_imu"] = True
    if _frame_rate["hz"]:
        _fw["rate_hz"] = int(round(_frame_rate["hz"]))
    il = fr["il"]
    live_map = {"hand": bool(il[0]), "forearm": bool(il[1]), "thumb": bool(fr["thumb_live"])}
    hq, fq, tq, orientation_source = select_orientation_quats(
        fr["hq"], fr["fq"], fr["tq"], fr["imu_full"], live_map)
    # A sensor which claims live but supplies neither a valid game nor primary
    # quaternion is not live for pose purposes (see select_orientation_quats).
    live_map = {"hand": live_map["hand"] and hq is not None,
                "forearm": live_map["forearm"] and fq is not None,
                "thumb": live_map["thumb"] and tq is not None}
    for k, q in (("hand", hq), ("forearm", fq), ("thumb", tq)):
        if q is not None:
            _last_raw[k] = q
    il = [int(live_map["hand"]), int(live_map["forearm"])]
    act = run_activation(fr["emg_env"], fr["emg_present"])
    # Strapdown integration (legacy `inertial` block), on the firmware clock.
    # Each IMU on its own sample clock (v17: frame time - qage), so a frame
    # that re-reports an old sample integrates nothing.
    imu_full = fr["imu_full"]
    if imu_full:
        t_s = fr["t_dev_us"] / 1e6
        ts = imu_sample_times(fr)
        raw_q = {"hand": hq, "forearm": fq, "thumb": tq or [1.0, 0.0, 0.0, 0.0]}
        for sk in IMU_KEYS:
            if live_map[sk]:
                d = imu_full[sk]
                TRACKERS[sk].update(raw_q[sk], d["lin"], d["gyr"], ts.get(sk) if ts.get(sk) is not None else t_s)
            else:
                TRACKERS[sk].t = None
    # the body model (the contract), then the legacy display derived from it
    _body_step(fr, hq, fq, tq, live_map, raw_line, now)
    hq_d, fq_d, thumb = _legacy_imu_display(live_map)
    body = dict(BODY.body())
    body_rel = BODY.display_rel() if BODY.has_heading() else None
    joints, n_live, encoders, n_enc = _joints_from_enc(enc)
    derived = {"t": t, "joints": joints, "n_live": n_live, "encoders": encoders, "n_enc": n_enc,
               "hand_q": hq_d, "forearm_q": fq_d, "thumb": thumb, "body": body,
               "body_rel": body_rel, "tare": _tare_state}
    # the fast pose lane: built here, the moment the frame is in, and handed
    # to the event loop (never blocks this thread; latest-wins)
    POSE_LANE["seq"] += 1
    if POSE_LANE["clients"] > 0:
        _pose_publish(fr, derived, now)
    with state_lock:
        state["imu_full"] = imu_full
        state["timing"] = fr.get("timing")
        state["motors_fw"] = fr["motors_fw"]
        state["orientation_source"] = orientation_source
        state["t_ms"] = t
        state["enc"] = enc
        # Hold last valid pose across a dropout (never the zero-filled placeholder)
        if hq is not None:
            state["hq"] = hq
        if fq is not None:
            state["fq"] = fq
        if tq is not None:
            state["tq"] = tq
        state["imu_live"] = il
        state["thumb_live"] = live_map["thumb"]
        state["emg_env"] = fr["emg_env"]
        state["emg_rms"] = fr["emg_rms"]
        state["emg_present"] = fr["emg_present"]
        state["crown"] = fr["crown"]
        state["activation"] = act
        state["last_rx"] = now
        state["derived"] = derived
        rec = state["recording"]
        _note_sample_locked()        # shared recording counters (all clients)
    update_joint_sweep(enc)          # ROM sweep: capture open/closed extremes
    if rec:
        _record_frame(t, derived, act, imu_full, live_map, fr=fr, sel=(hq, fq, tq), rx=now)
    return derived


def raw_cols(fr, sel, live_map, rx):
    """The research.RAW_COLS cells of one frame: device timing, receive time,
    the unfiltered encoder degrees as streamed (-1 absent) and the raw game
    quaternions the pipeline used (None when that IMU was not live)."""
    tm = fr.get("timing")
    if tm:
        qa = tm["qage_us"]
        out = [tm["t_us"], qa.get("hand"), qa.get("forearm"), qa.get("thumb"), tm["enc_us"]]
    else:
        out = [None] * 5
    out.append(round(rx * 1000.0, 1) if rx is not None else None)
    enc = list(fr.get("enc") or [])[:N_CH]
    enc += [-1.0] * (N_CH - len(enc))
    out += [round(d, 2) if (d is not None and d >= 0.0) else -1.0 for d in enc]
    for k, q in zip(IMU_KEYS, sel):
        out += ([round(v, 6) for v in q] if (q is not None and live_map.get(k)) else [None] * 4)
    return out


def _record_frame(t, derived, act, imu_full, live_map, fr=None, sel=(None, None, None), rx=None):
    """One take row for this device frame (ROW_COLS order)."""
    now = time.time()
    with state_lock:
        pose = dict(POSE)
    fresh = (now - pose["t_wall"]) < POSE_FRESH_S and pose["pos"] is not None
    joints = derived["joints"]
    vj = pose["joints"] if fresh else None
    jcols, used_vision = _joint_row_cols(joints, vj, SIM_MODE)
    used_enc = any(j.get("ok") for j in joints)
    row = [int(t)] + jcols
    row += [round(v, 4) for v in derived["hand_q"]]
    row += [round(v, 4) for v in derived["forearm_q"]]
    th = derived["thumb"]
    row += [round(v, 4) for v in (th["rel_quat"] if th else [0, 0, 0, 0])]
    row.append(round(BLEND["assist"], 3))
    row.append(round(act.get("level", 0.0), 3))
    if fresh:
        row += [round(v, 4) for v in pose["pos"]]
        row += [round(v, 4) for v in pose["quat"]]
    else:
        row += [None] * 7
    thv = (vj or {}).get("thumb") if fresh else None
    row += ([round(float(v), 2) for v in thv] if thv else [None] * 3)
    if imu_full and live_map["hand"] and live_map["forearm"]:
        hp, fp = TRACKERS["hand"].p, TRACKERS["forearm"].p
        conf = min(TRACKERS["hand"].confidence(), TRACKERS["forearm"].confidence())
        row += [round(hp[0] * 1000, 1), round(hp[1] * 1000, 1), round(hp[2] * 1000, 1),
                round(fp[0] * 1000, 1), round(fp[1] * 1000, 1), round(fp[2] * 1000, 1), round(conf, 2)]
    else:
        row += [None] * 7
    row += BODY.take_cols()
    row += raw_cols(fr or {"t": t}, sel, live_map, rx)
    b = derived["body"]
    qinfo = {"t_dev_us": (fr or {}).get("t_dev_us", int(t) * 1000),
             "imu_live": live_map,
             "enc_ok": [d is not None and d >= 0.0 for d in ((fr or {}).get("enc") or [])],
             "cal": 2 if b.get("calibrated") else (1 if b.get("provisional") else 0),
             "pos_src": "vision" if fresh else b.get("pos_source", "arm"),
             "qage_us": ((fr or {}).get("timing") or {}).get("qage_us"),
             "enc_us": ((fr or {}).get("timing") or {}).get("enc_us"),
             "rx_ms": rx * 1000.0 if rx is not None else None}
    _record_row(row, used_vision, used_enc, pose["env"] if (fresh and pose["env"]) else None, qinfo)


def clear_stale_device_state(reason):
    """Link loss: the last-received readings must not keep parading as live
    sensors. Called by the serial thread when the port drops or the stream
    stops, so every consumer (not only the snapshot) sees the absence."""
    with state_lock:
        state["enc"] = [(-1.0 if not SIM_MODE else ENC_ABSENT_SIM)] * N_CH
        state["imu_live"] = [0, 0]
        state["thumb_live"] = False
        state["imu_full"] = None
        state["timing"] = None
        state["motors_fw"] = None
        state["crown"] = None
        state["emg_present"] = False
        state["activation"] = dict(ACT_ABSENT)
        d = state.get("derived")
        if d is not None:
            d = dict(d)
            d["joints"] = [dict(j, ok=False, deg=0.0) for j in d["joints"]]
            d["encoders"] = [dict(e, ok=False, deg=-1.0) for e in d["encoders"]]
            d["n_live"] = d["n_enc"] = 0
            b = dict(d["body"])
            b["live"] = False
            d["body"] = b
            d["thumb"] = None
            state["derived"] = d
    for k in IMU_KEYS:
        TRACKERS[k].t = None
    print("[serial] stale device state cleared (%s)" % reason)


SD = None                         # sdcard.SdClient, created in main


def serial_thread(port_name, baud):
    """Open the Teensy, turn streaming on, and hand every line to handle_line()."""
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
                # An SD file transfer blocks the device loop (the S stream
                # pauses): keep the line quiet so nothing interleaves with it.
                sd_busy = SD is not None and SD.busy
                if sd_busy:
                    last_dui = nowd
                    last_sea_joint = nowd
                if nowd - last_dui > 0.15:          # push device_ui down to the on-wrist screen
                    last_dui = nowd
                    try:
                        with ser_write_lock:
                            ser.write(("D,%d,%d,%d\n" % (_dui.get("fw_idx", 1), _dui.get("fw_elapsed", 0), _dui.get("fw_mot", 0))).encode())
                    except Exception:
                        pass
                if WATCH["dirty"] and not sd_busy:   # a UI changed the face: send it down
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
                    # keep asserting stream-on in case it was toggled off (never
                    # in the middle of an SD transfer)
                    if time.time() - last_assert > 3 and not sd_busy:
                        with ser_write_lock:
                            ser.write(b"j\n")
                        last_assert = time.time()
                    _stale_watch()
                    continue
                fr = handle_line(raw.decode("utf-8", "replace"))
                if fr is None:
                    _stale_watch()
                    continue
                il = fr["il"]
                # Hot-plug recovery WITHOUT a routine stall.  A sensor that was
                # missing on the very first frame used to be forgotten forever:
                # best_imu started at zero, immediately became one, and only a
                # later DROP could trigger R.  Retry while either required
                # hand/forearm IMU is absent, with exponential backoff.  A
                # healthy rig never receives a rescan, and a hard wiring fault
                # cannot hitch the stream every 1.5 s as the old fixed cadence
                # did.
                n_enc_live = sum(1 for x in fr["enc"] if x >= 0.0)
                n_imu_live = int(bool(il[0])) + int(bool(il[1]))
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
            clear_stale_device_state("serial link lost")
            _stale["cleared"] = True
            time.sleep(1)


_stale = {"cleared": False}


def _stale_watch():
    """The port is open but frames stopped (unplugged hub, device reset, a
    stalled SD transfer): after 1 s, clear the stale sensor state once."""
    with state_lock:
        lr = state["last_rx"]
    if lr and time.time() - lr > 1.0:
        if not _stale["cleared"] and not (SD is not None and SD.busy):
            clear_stale_device_state("no frames for 1 s")
            _stale["cleared"] = True
    else:
        _stale["cleared"] = False


_DOOM = {"seen": False}          # easter egg: latch so we log the first relay only


def send_teensy(cmd_byte):
    if SIM_DEVICE is not None:
        # --sim: the simulated device reads the same bytes a Teensy would
        # (it ignores motor/screen lines, exactly as a no-op port did before)
        SIM_DEVICE.write(cmd_byte)
        return
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


def _sd_recent_failure():
    err = DEVICE.get("last_error")
    return bool(err and str(err.get("code", "")).startswith("sd_") and time.time() - err["t"] < 60)


def _sd_health_detail(device_up):
    if DEVICE.get("flags") is None:
        return "firmware without SD reporting (v16 needed)"
    if SD is not None and SD.transfer():
        tr = SD.transfer()
        return "reading %s" % tr["name"]
    err = DEVICE.get("last_error")
    if err and time.time() - err["t"] < 60:
        return err["text"]
    if not DEVICE.get("sd_present"):
        return "no SD card"
    if DEVICE.get("sd_recording") and device_up:
        return "recording TK%05u · %d rows" % (DEVICE.get("sd_take") or 0, DEVICE.get("sd_rows") or 0)
    return "card present"


def _device_block(device_up, data_fresh):
    """The contract's snapshot `device` block (MOTION_PIPELINE.md s.7), plus
    additive diagnostics. With the link down nothing is claimed as running."""
    sdt = SD.transfer() if SD is not None else None
    v16 = DEVICE.get("flags") is not None
    with state_lock:
        msgs = list(DEVICE["messages"])[-5:]
    return {
        "fw": DEVICE.get("fw") or _fw.get("version") or None,
        "boot_id": DEVICE.get("boot_id"),
        "sd_present": DEVICE.get("sd_present") if v16 else None,
        "sd_recording": bool(DEVICE.get("sd_recording")) and device_up,
        "sd_take": (DEVICE.get("sd_take") or 0) if device_up else 0,
        "sd_rows": (DEVICE.get("sd_rows") or 0) if device_up else 0,
        "standby": bool(DEVICE.get("standby")),
        "standalone_auto_record": DEVICE.get("auto_record") if v16 else (SD.auto if SD else None),
        "neutral_running": bool(DEVICE.get("neutral_running")) and device_up,
        # additive
        "link": bool(device_up), "streaming": bool(data_fresh),
        "host_link": DEVICE.get("host_link"),
        "rate_hz": _fw.get("rate_hz"),
        "transfer": sdt,
        "neutral": {"phase": NEUTRAL_UI.get("phase"), "source": NEUTRAL_UI.get("source")},
        "last_error": DEVICE.get("last_error"),
        "messages": msgs,
    }


def build_snapshot(hz):
    now_w = time.time()
    with state_lock:
        s = dict(state)
        il = list(s["imu_live"])
        rec = s["recording"]; last_rx = s["last_rx"]; t = s["t_ms"]
        last_line = s.get("last_line") or 0.0
        act = dict(s.get("activation", ACT_ABSENT))
        crown = s.get("crown")
        thumb_live = bool(s.get("thumb_live"))
        imu_full_raw = s.get("imu_full")
        orientation_source = dict(s.get("orientation_source", {}))
        der = s.get("derived")
        enc_state = list(s["enc"])
        eco = {k: ECO[k] for k in ("mode", "feedback_on", "guided", "rep_goal", "reps_done",
                                   "profile", "task", "rec_id", "rec_start", "rec_samples")}
    data_fresh = (now_w - last_rx) < 1.0 if last_rx else False
    sd_busy = SD is not None and SD.busy
    # The link is up while the device talks at all: an SD transfer pauses the
    # S stream on purpose, which is not a fault (the sensors are simply not
    # being sampled, and are reported so).
    device_up = data_fresh or bool(sd_busy and last_line and (now_w - last_line) < 3.0)
    if not data_fresh:
        # Link loss (or a transfer): the last-received readings must not keep
        # parading as live sensors (frozen values previously stayed ok:true).
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
    if der is None:
        jl, nl, el, ne = _joints_from_enc(enc_state)
        der = {"joints": jl, "n_live": nl, "encoders": el, "n_enc": ne,
               "hand_q": [1.0, 0.0, 0.0, 0.0], "forearm_q": [1.0, 0.0, 0.0, 0.0],
               "thumb": None, "body": BODY.body(), "body_rel": None, "tare": _tare_state}
    joints, n_live = der["joints"], der["n_live"]
    encoders = der["encoders"]
    if not data_fresh:
        joints = [dict(j, ok=False, deg=0.0) for j in joints]
        encoders = [dict(e, ok=False, deg=-1.0) for e in encoders]
        n_live = 0
    body = dict(der["body"])
    if not data_fresh:
        body["live"] = False

    # Legacy display frames (align-or-remap, offset, tare, gain, flip), computed
    # per device frame in ingest_frame. The tare is seated at the same moment as
    # the body neutral (provisional or calibrated) and is per device boot.
    hq, fq = list(der["hand_q"]), list(der["forearm_q"])
    hand = {"quat": [round(v, 4) for v in hq], "rpy_deg": quat_to_rpy(*hq),
            "live": bool(il[0]), "source": orientation_source.get("hand", "unavailable"),
            "tare": der.get("tare")}
    forearm = {"quat": [round(v, 4) for v in fq], "rpy_deg": quat_to_rpy(*fq),
               "live": bool(il[1]), "source": orientation_source.get("forearm", "unavailable"),
               "tare": der.get("tare")}
    n_imu = int(il[0]) + int(il[1]) + (1 if thumb_live else 0)

    # thumb-tip IMU (v4): present only while the sensor reports
    thumb = der.get("thumb") if thumb_live else None

    # ---- relative hand-vs-forearm pose. With a body neutral (provisional or
    # calibrated) rel.quat IS the body model's hand-in-forearm rotation, soft-
    # limited to the anatomical envelope for display, so every view agrees.
    # Before any neutral it falls back to the legacy tared pair.
    global _rel_quat_hold
    rel_live = bool(il[0] and il[1])
    br = der.get("body_rel")
    if br is not None:
        q_rel, wrist_deg, wrist_limited, q_rel_raw = list(br[0]), list(br[1]), br[2], list(br[3])
        rel_source = "body"
        if rel_live:
            _rel_quat_hold = q_rel_raw
        rel_limits = {"flexion": 80.0, "extension": 70.0, "deviation": 20.0, "radial": 20.0,
                      "ulnar": 35.0, "pronation": 90.0}
    else:
        rel_source = "legacy"
        rel_limits = {"flexion": WRIST_FLEX_LIMIT_DEG, "deviation": WRIST_DEV_LIMIT_DEG,
                      "pronation": WRIST_PRON_LIMIT_DEG}
        if rel_live:
            q_rel_raw = quat_mul(quat_conj(fq), hq)
            q_rel_valid = _unit_quat_or_none(q_rel_raw)
            if q_rel_valid is not None:
                _rel_quat_hold = q_rel_valid
            else:
                rel_live = False
                q_rel_raw = list(_rel_quat_hold)
        else:
            # Relative wrist orientation is a two-sensor measurement: freeze the
            # last valid pair rather than invent an identity forearm.
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
        "limits_deg": rel_limits,
        "source": rel_source,
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
        {"stream": "tracking", "ok": world["source"] != "none" or BODY.vision_fresh(),
         "rate_hz": hz if (world["source"] != "none" or BODY.vision_fresh()) else 0,
         "detail": {"quest-fused": "quest-fused (right wrist)",
                    "imu-model": "imu-only (occluded)",
                    "none": "camera: upper arm" if BODY.vision_fresh() else "no vision anchor"}[world["source"]]},
        {"stream": "body", "ok": bool(body.get("calibrated")) and bool(body.get("live")),
         "rate_hz": hz if body.get("live") else 0,
         "detail": ("calibrated" if body.get("calibrated") else
                    ("provisional: calibrate, hold your hand flat" if body.get("provisional")
                     else "no neutral yet")) + (" · " + body.get("pos_source", "") if body.get("live") else "")},
        {"stream": "sd", "ok": bool(DEVICE.get("sd_present")) and not _sd_recent_failure(),
         "rate_hz": 0,
         "detail": _sd_health_detail(device_up)},
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
        "link": dict({"device": device_up, "motors": motors_up, "clients": len(CLIENTS),
                      "paused": "sd_transfer" if (sd_busy and not data_fresh) else None,
                      "lan": LAN_IP, "port": WS_PORT},
                     # timing (MOTION_PIPELINE.md s.8): pose-lane latency (tx - rx,
                     # median/p95 over 5 s), pose-lane + device frame rates,
                     # serial delivery jitter, and the newest frame's IMU sample
                     # ages / encoder sweep (v17; None before)
                     **link_stats(now_w), **_timing_now(s.get("timing") if data_fresh else None)),
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
        # the shared body model (MOTION_PIPELINE.md s.7) and the device's own
        # recording / power state
        "body": body,
        "device": _device_block(device_up, data_fresh),
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

    # Recording is NOT done here any more: take rows are written once per
    # DEVICE frame by ingest_frame (_record_frame), so a 100 Hz device is never
    # resampled at the snapshot rate and t_ms never repeats.
    return snap


# ============================================================================
# NEUTRAL / WRIST-AXIS COMMANDS and THE SD TAKE LIBRARY
# ============================================================================
def start_neutral_capture(enc_open=True, source="console"):
    """Begin a neutral capture. Firmware v16 runs it on the device (`N`: 3-2-1
    countdown on screen + buzzer, 2 s still hold, E,neutral,done with the
    averaged raw quaternions). Older firmware: the bridge runs the same
    countdown/hold on host time and averages its own frames."""
    ui = NEUTRAL_UI
    if ui["phase"] in ("requested", "countdown", "hold", "solving") and ui["t0"] \
            and time.time() - ui["t0"] < 15.0:
        return {"ok": False, "error": "a neutral capture is already running"}
    if DEVICE.get("flags") is not None:
        ui.update(phase="requested", source=source, t0=time.time(), last_sent=None,
                  hold_t0=None, result=None, want_enc_open=enc_open)
        send_teensy(b"N\n")
        return {"ok": True, "via": "device"}
    neutral_begin("bridge")
    ui["want_enc_open"] = enc_open
    return {"ok": True, "via": "bridge"}


def _neutral_request_watch(now):
    """A v16 device that never answers N (standby, busy) must not leave the
    capture 'requested' forever."""
    ui = NEUTRAL_UI
    if ui["phase"] == "requested" and ui["t0"] and now - ui["t0"] > 3.0:
        ui.update(phase="abort", want_enc_open=False)
        broadcast({"kind": "ack", "event": "neutral", "phase": "abort", "t": 0, "ok": False,
                   "source": ui["source"], "reason": "the device did not start the capture "
                   "(standby, or firmware without N)"})


def _wa_start(bm, duration):
    res = bm.start_wrist_axis(duration)
    _emit({"kind": "ack", "event": "wrist_axis", "phase": "capturing", "t": duration,
           "frame_known": bm.has_heading(), **res})


def _wa_reset(bm):
    bm.wrist_axis = None
    BODY_PERSIST["wrist_axis"] = None
    n = bm.neutral
    if n is not None and not n["provisional"]:
        bm.capture_neutral(t_end=n["t"], kind=n["kind"], q_avg=n["q0"])
        BODY_PERSIST["neutral"] = bm.export_neutral()
    _body_save()
    _emit({"kind": "ack", "event": "wrist_axis", "phase": "reset", "ok": True})


def _body_reprior(bm):
    """The mounting config changed (console #/imu): new priors; a real neutral
    is re-solved from its stored raw averages (same boot, same pose)."""
    bm.prior = body_priors()
    n = bm.neutral
    if n is not None:
        bm.capture_neutral(t_end=n["t"], kind=n["kind"], q_avg=n["q0"], provisional=n["provisional"])


# ---- SD library -------------------------------------------------------------
_SD_IMPORTS_FILE = os.path.join(STATE_DIR, ".takto_sd_imports.json")
SD_STATE = {"busy": None, "items": None, "listed_boot": None}   # busy = name being imported/listed
SD_IMPORTS = {}                                   # name -> {"take", "bytes"}


def _sd_imports_load():
    global SD_IMPORTS
    try:
        with open(_SD_IMPORTS_FILE) as f:
            d = json.load(f)
        SD_IMPORTS = {str(k): v for k, v in (d.get("imports") or {}).items() if isinstance(v, dict)}
    except FileNotFoundError:
        pass
    except Exception as e:
        _quarantine_corrupt(_SD_IMPORTS_FILE, e, "sd")


def _sd_imports_save():
    try:
        _write_json_atomic(_SD_IMPORTS_FILE, {"imports": SD_IMPORTS})
    except Exception as e:
        print("[sd] could not save the import index:", e)


def sd_takes_msg():
    items = []
    for name, size in (SD_STATE["items"] or []):
        imp = SD_IMPORTS.get(name)
        taken = imp["take"] if (imp and imp.get("bytes") == size
                                and any(t.get("id") == imp["take"] for t in takes)) else None
        items.append({"name": name, "file": name.rsplit("/", 1)[-1], "bytes": size,
                      "imported_take": taken})
    return {"kind": "sd_takes", "items": items, "busy": bool(SD_STATE["busy"]),
            "busy_name": SD_STATE["busy"], "listed": SD_STATE["items"] is not None,
            "auto": (DEVICE.get("auto_record") if DEVICE.get("flags") is not None
                     else (SD.auto if SD is not None else None))}


def _sd_guard(for_import):
    if SD is None:
        return "no device link"
    if SIM_DEVICE is None and _ser.get("port") is None:
        return "the device is not connected"
    if DEVICE.get("flags") is None and not SIM_MODE:
        return "the SD library needs firmware v16"
    if SD.busy or SD_STATE["busy"]:
        return "an SD transfer is already running"
    if for_import:
        if state["recording"] or DEVICE.get("sd_recording"):
            return "stop the recording first (a transfer pauses the device loop)"
        if CAMERA_FOLLOW.get("armed"):
            return "camera follow is armed; stop it first (a transfer pauses the joint stream)"
    return None


async def sd_list(c=None):
    err = _sd_guard(False)
    if err:
        if c is not None:
            _ack(c, event="error", error="sd: " + err)
        broadcast(sd_takes_msg())
        return
    SD_STATE["busy"] = "list"
    try:
        items = await asyncio.to_thread(SD.list)
        SD_STATE["items"] = items
    except sdcard.SdError as e:
        if c is not None:
            _ack(c, event="error", error="sd list: %s" % e)
    finally:
        SD_STATE["busy"] = None
    broadcast(sd_takes_msg())


async def sd_set_auto(c, on):
    err = _sd_guard(False)
    if err:
        _ack(c, event="error", error="sd: " + err)
        return
    SD_STATE["busy"] = "auto"
    try:
        val = await asyncio.to_thread(SD.set_auto, bool(on))
        _ack(c, event="sd_auto", ok=True, on=val)
    except sdcard.SdError as e:
        _ack(c, event="error", error="sd auto: %s" % e)
    finally:
        SD_STATE["busy"] = None
    broadcast(sd_takes_msg())


async def sd_import(c, name):
    err = _sd_guard(True)
    if err:
        _ack(c, event="error", error="sd import: " + err)
        return
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_./-]{1,64}", name) or ".." in name:
        _ack(c, event="error", error="sd import: bad file name")
        return
    SD_STATE["busy"] = name
    broadcast(sd_takes_msg())
    take_id = None
    loop = asyncio.get_running_loop()

    last_pct = [-1]

    def prog(frac):
        pct = int(max(0, min(99, frac * 100)))
        if pct == last_pct[0]:
            return
        last_pct[0] = pct
        loop.call_soon_threadsafe(broadcast, {"kind": "ack", "event": "sd_import", "name": name,
                                              "pct": pct})
    try:
        text = await asyncio.to_thread(                      # the file's lines, CRC-verified
            SD.get, name, lambda got, total: prog(0.6 * (got / total if total else 0.0)))
        prog(0.6)
        take_id = "take_%04d" % _next_state_id("take")
        _RESERVED_IDS.add(take_id)
        take = await asyncio.to_thread(import_sd_take, text, name, take_id,
                                       lambda f: prog(0.6 + 0.4 * f))
        takes.insert(0, take)
        _save_takes()
        SD_IMPORTS[name] = {"take": take_id, "bytes": (SD.last_get or {}).get("bytes"),
                            "crc": (SD.last_get or {}).get("crc")}
        _sd_imports_save()
        broadcast({"kind": "takes", "takes": takes})
        broadcast({"kind": "ack", "event": "sd_import", "name": name, "pct": 100})
        broadcast({"kind": "ack", "event": "sd_imported", "name": name, "take": take_id,
                   "neutral": take.get("neutral"), "rows": take.get("rows")})
        print("[sd] imported %s -> %s (%s rows, neutral %s)" % (name, take_id, take.get("rows"),
                                                                 take.get("neutral")))
    except sdcard.SdError as e:
        broadcast({"kind": "ack", "event": "sd_import", "name": name, "pct": None, "ok": False,
                   "error": str(e)})
        _ack(c, event="error", error="sd import %s: %s" % (name, e))
    except Exception as e:
        print("[sd] import failed:", e)
        broadcast({"kind": "ack", "event": "sd_import", "name": name, "pct": None, "ok": False,
                   "error": str(e)})
        _ack(c, event="error", error="sd import %s: %s" % (name, e))
    finally:
        if take_id:
            _RESERVED_IDS.discard(take_id)
        SD_STATE["busy"] = None
        send_teensy(b"j\n")            # make sure the stream is back on after a stalled transfer
    broadcast(sd_takes_msg())


class _OfflineJoints:
    """The live encoder -> joint mapping, re-run on a recorded take with its
    OWN state (filters, unwrap, open seed), so an import never touches the
    live encoder calibration. Uses the bridge's current marks."""

    def __init__(self):
        self.dof = dict(ENC_DOF)
        self.finger = dict(ENC_FINGER)
        self.open = dict(ENC_OPEN)
        self.closed = dict(ENC_CLOSED)
        self.filters = {}
        self.cont = {}
        self.anchor = {}
        self.seed = {}

    def __call__(self, enc_raw, t_ms):
        enc = []
        for ch, d in enumerate(enc_raw):
            if d is None or d < 0.0:
                self.filters.pop(ch, None)
                self.cont.pop(ch, None)
                self.anchor.pop(ch, None)
                enc.append(-1.0)
                continue
            f = self.filters.get(ch)
            if f is None:
                f = self.filters[ch] = _OneEuroAngle(ENC_FILTER_MIN_CUTOFF, ENC_FILTER_BETA)
            enc.append(f(d, t_ms / 1000.0) if ENC_FILTER_ON else d)
        cols = [0.0] * 12
        oks = [False] * 12
        if SIM_MODE or ENC_JOINT_SPACE_DIRECT:
            for jid, ch in JOINT2CH.items():
                if ch in self.dof:
                    continue
                d = enc[ch] if ch < len(enc) else -1.0
                if d >= 0.0:
                    i = list(JOINT2CH).index(jid)
                    cols[i] = round(d - (SIM_ENC_BIAS if SIM_MODE else 0.0), 2)
                    oks[i] = True
        for ch, (dof, sign) in self.dof.items():
            d = enc[ch] if ch < len(enc) else -1.0
            if d < 0.0:
                continue
            st = self.cont.get(ch)
            if st is None:
                st = self.cont[ch] = {"cont": d, "last": d}
            else:
                st["cont"] += _wrap180(d - st["last"])
                st["last"] = d
            o = self.open.get(ch)
            if o is None:
                buf = self.seed.setdefault(ch, [])
                buf.append(d)
                if len(buf) >= _SEED_FRAMES:
                    sx = sum(math.cos(math.radians(v)) for v in buf)
                    sy = sum(math.sin(math.radians(v)) for v in buf)
                    o = self.open[ch] = math.degrees(math.atan2(sy, sx)) % 360.0
            if o is None:
                travel = 0.0
                o = d
            else:
                a = self.anchor.get(ch)
                if a is None:
                    a = self.anchor[ch] = st["cont"] - _wrap180(d - o)
                travel = st["cont"] - a
            val = joint_value(dof, sign, travel, o, self.closed.get(ch))
            jid = self.finger.get(ch, WIRED_FINGER) + "_" + DOF_SEG[dof]
            i = list(JOINT2CH).index(jid)
            cols[i] = round(val, 2)
            oks[i] = True
        return cols, oks


_SHORT = {"hand": "h", "forearm": "f", "thumb": "t"}


def sd_row_frame(r, idx, boot=None):
    """One SD take row (parsed floats, columns by name) -> the frame dict
    parse_s_line() builds from an S-line, so an SD take and a live stream go
    through ONE offline pipeline (OfflineDeriver)."""
    def g(key):
        i = idx.get(key)
        return None if i is None else r[i]

    def vec(keys):
        v = [g(k) for k in keys]
        return None if any(x is None for x in v) else v

    t_ms = g("t_ms")
    enc = [g("enc%02d" % ch) for ch in range(N_CH)]
    enc = [(-1.0 if v is None else v) for v in enc]
    fr = {"t": int(t_ms), "enc": enc,
          "hq": vec(["h_qw", "h_qx", "h_qy", "h_qz"]) or [0.0, 0.0, 0.0, 0.0],
          "fq": vec(["f_qw", "f_qx", "f_qy", "f_qz"]) or [0.0, 0.0, 0.0, 0.0],
          "tq": vec(["t_qw", "t_qx", "t_qy", "t_qz"]),
          "emg_env": g("emg_env") or 0.0, "emg_rms": g("emg_rms") or 0.0,
          "emg_present": bool(g("emg_present")), "motors_fw": None}
    live = {}
    for k in IMU_KEYS:
        lv = g(_SHORT[k] + "_live")
        if lv is None:                        # pre-v16 file: v15 flags where they exist
            lv = g("thumb_live") if k == "thumb" else 1.0
        live[k] = bool(lv) and lv > 0.5
    fr["il"] = [int(live["hand"]), int(live["forearm"])]
    fr["thumb_live"] = live["thumb"] and fr["tq"] is not None
    crown, crown_live = g("crown"), g("crown_live")
    fr["crown_live"] = None if crown_live is None else crown_live == 1
    fr["crown"] = (max(0.0, min(1.0, crown / 1000.0)) if (crown is not None and crown_live == 1) else None)
    imu_full = None
    if idx.get("hand_lax") is not None:
        imu_full = {}
        for k in IMU_KEYS:
            n = k
            imu_full[k] = {
                "lin": vec(["%s_lax" % n, "%s_lay" % n, "%s_laz" % n]),
                "acc": vec(["%s_ax" % n, "%s_ay" % n, "%s_az" % n]),
                "gyr": vec(["%s_gx" % n, "%s_gy" % n, "%s_gz" % n]),
                "mag": vec(["%s_mx" % n, "%s_my" % n, "%s_mz" % n]),
                "grv": vec(["%s_grx" % n, "%s_gry" % n, "%s_grz" % n]),
                "game": vec(["%s_gqw" % n, "%s_gqx" % n, "%s_gqy" % n, "%s_gqz" % n]),
                "accuracy": {"acc": g("%s_cal_a" % n), "gyr": g("%s_cal_g" % n), "mag": g("%s_cal_m" % n)},
                "rot_accuracy_rad": g("%s_rotacc" % n)}
    fr["imu_full"] = imu_full
    dv = {k: vec(["%s_dvx" % _SHORT[k], "%s_dvy" % _SHORT[k], "%s_dvz" % _SHORT[k]]) for k in IMU_KEYS}
    stab = {}
    for k in IMU_KEYS:
        st = g("%s_stab" % _SHORT[k])
        stab[k] = int(st) if st is not None else 255
    fr["v16"] = {"flags": None, "take": None, "rows": None, "boot_id": boot,
                 "dv": dv if any(v is not None for v in dv.values()) else None,
                 "stab": stab, "dv_n": None}
    timing = None
    if g("t_us") is not None:
        timing = {"t_us": int(g("t_us")),
                  "qage_us": {k: int(g("%s_qage_us" % _SHORT[k]) or 0) for k in IMU_KEYS},
                  "enc_us": int(g("enc_us") or 0)}
    fr["timing"] = timing
    fr["t_dev_us"] = research.unwrap_us(fr["t"], timing["t_us"] if timing else None)
    return fr


class OfflineDeriver:
    """The live per-frame pipeline (encoders -> joints, IMU selection -> body
    model -> legacy display -> strapdown trackers -> the take row + quality)
    re-run on a recorded stream with its OWN state, so neither an SD import
    nor a re-derivation touches the live bridge. Mirrors ingest_frame /
    _record_frame column for column; what it cannot know offline is said so:
    `act` is 0 (the EMG activation module is live-only), `blend` comes from
    the crown when the device reports one (else 0.35), and the headset
    columns are empty. Reads the calibration globals (encoder map and marks,
    IMU config, wrist axis, arm lengths); rederive.py sets them from the
    take's provenance first."""

    def __init__(self, take_id, path=None, boot=None, nominal_hz=None, keep_rows=False):
        self.bm = motion.BodyModel(body_priors(), cfg=dict(BODY_PERSIST.get("arm") or {}),
                                   wrist_axis=BODY_PERSIST.get("wrist_axis"),
                                   hand_flip=BODY_PERSIST.get("hand_flip", HAND_FLIP_DEFAULT),
                          forearm_flip=BODY_PERSIST.get("forearm_flip", FOREARM_FLIP_DEFAULT))
        self.bm.set_boot(boot)
        self.bm.auto_neutral = False
        self.joints = _OfflineJoints()
        self.trackers = {k: InertialTracker(k) for k in IMU_KEYS}
        self.tare = self._tare_of(None)
        self._neutral_ref = None
        self.q = research.QualityAccumulator(nominal_hz=nominal_hz)
        self.take_id = take_id
        self.path = path
        self.out = None
        self.rows = [] if keep_rows else None
        if path:
            self.out = open(path + ".tmp", "w")
            self.out.write('{"id":%s,"cols":%s,"rows":[\n' % (json.dumps(take_id), json.dumps(ROW_COLS)))
        self.n = 0
        self.last_t = None
        self.t_first = None
        self.spark = []
        self.any_iner = False
        self.any_enc = False
        self.pip_i = list(JOINT2CH).index(WIRED_FINGER + "_pip")

    @staticmethod
    def _tare_of(q0):
        out = {}
        for k in IMU_KEYS:
            q = q0.get(k) if q0 else None
            tq = imu_cfg_apply(q, k) if q is not None else None
            out[k] = quat_conj(_norm_quat(tq)) if (tq is not None and _valid_quat(tq)) else [1.0, 0.0, 0.0, 0.0]
        return out

    def set_neutral(self, t_s, q0, kind, provisional=False, spread=None):
        res = self.bm.capture_neutral(t_end=t_s, kind=kind, q_avg=q0, provisional=provisional)
        if res.get("ok") and spread is not None:
            self.bm.neutral["spread"] = spread
        return bool(res.get("ok"))

    def frame(self, fr, rx=None, emit=True, before=None, after=None):
        """One device frame. `before`/`after` run just before / after the body
        model's update (neutral changes replayed in stream order). Returns the
        row written, or None (pre-roll, duplicate)."""
        t_ms = fr["t"]
        if fr.get("t_dev_us") is None:
            fr["t_dev_us"] = int(t_ms) * 1000
        v16 = fr.get("v16") or {}
        boot = v16.get("boot_id")
        if boot is not None and boot != self.bm.boot_id:
            self.bm.set_boot(boot)
        if before is not None:
            before()
        il = fr["il"]
        live_map = {"hand": bool(il[0]), "forearm": bool(il[1]), "thumb": bool(fr.get("thumb_live"))}
        hq, fq, tq, _src = select_orientation_quats(fr["hq"], fr["fq"], fr.get("tq"), fr.get("imu_full"),
                                                    live_map)
        live_map = {"hand": live_map["hand"] and hq is not None,
                    "forearm": live_map["forearm"] and fq is not None,
                    "thumb": live_map["thumb"] and tq is not None}
        imu_full = fr.get("imu_full") or {}
        dv = v16.get("dv") or {}
        dvn = v16.get("dv_n") or {}
        stab = v16.get("stab") or {}
        q = {"hand": hq if live_map["hand"] else None, "forearm": fq if live_map["forearm"] else None,
             "thumb": tq if live_map["thumb"] else None}
        t_dev = fr["t_dev_us"] / 1e6
        ts = imu_sample_times(fr)
        bf = {"t": t_dev, "q": q, "ts": ts,
              "gyr": {k: (imu_full.get(k) or {}).get("gyr") if live_map[k] else None for k in IMU_KEYS},
              "lin": {k: (imu_full.get(k) or {}).get("lin") if live_map[k] else None for k in IMU_KEYS},
              "dv": {k: (dv.get(k) if (live_map[k] and dvn.get(k, 1) != 0) else None) for k in IMU_KEYS},
              "dv_n": {k: dvn.get(k) for k in IMU_KEYS},
              "stab": {k: (stab.get(k) if stab.get(k) not in (None, 255) else None) for k in IMU_KEYS}}
        bm = self.bm
        bm.update(bf)
        if after is not None:
            after()
        bm.pop_events()
        if bm.neutral is not self._neutral_ref:
            self._neutral_ref = bm.neutral
            self.tare = self._tare_of(bm.neutral["q0"] if bm.neutral else None)
        # encoders: the live filter + map, own state (warmed by the pre-roll too)
        cols, oks = self.joints(fr["enc"], t_ms)
        # legacy strapdown trackers, each IMU on its own sample clock
        if fr.get("imu_full"):
            for k in IMU_KEYS:
                if live_map[k] and imu_full.get(k) and imu_full[k].get("lin") and imu_full[k].get("gyr"):
                    qk = {"hand": hq, "forearm": fq, "thumb": tq or [1.0, 0.0, 0.0, 0.0]}[k]
                    self.trackers[k].update(qk, imu_full[k]["lin"], imu_full[k]["gyr"],
                                            ts.get(k) if ts.get(k) is not None else t_dev)
                else:
                    self.trackers[k].t = None
        if not emit:
            return None
        if self.last_t is not None and t_ms <= self.last_t:
            self.q.dup += 1
            return None
        self.last_t = t_ms
        if self.t_first is None:
            self.t_first = t_ms
            if fr.get("timing"):
                self.q.clock = "t_us"
            self.q.set_neutral(research.neutral_info(bm.neutral, t_dev))
        self.any_enc = self.any_enc or any(oks)
        disp = {}
        for k in IMU_KEYS:
            qr = bm.raw[k] or [1.0, 0.0, 0.0, 0.0]
            d = quat_mul(self.tare[k], imu_cfg_apply(qr, k))
            disp[k] = quat_flip_sense(quat_gain(d, IMU_CFG[k]["gain"]), IMU_CFG[k]["flip"])
        th_rel = ([round(v, 4) for v in quat_mul(quat_conj(disp["hand"]), disp["thumb"])]
                  if (live_map["thumb"] and bm.raw["thumb"] is not None) else [0, 0, 0, 0])
        crown = fr.get("crown")
        blend = crown if crown is not None else 0.35
        iner = [None] * 7
        if fr.get("imu_full") and live_map["hand"] and live_map["forearm"]:
            hp, fp = self.trackers["hand"].p, self.trackers["forearm"].p
            conf = min(self.trackers["hand"].confidence(), self.trackers["forearm"].confidence())
            iner = [round(hp[0] * 1000, 1), round(hp[1] * 1000, 1), round(hp[2] * 1000, 1),
                    round(fp[0] * 1000, 1), round(fp[1] * 1000, 1), round(fp[2] * 1000, 1), round(conf, 2)]
            self.any_iner = True
        row = ([int(t_ms)] + cols + [round(v, 4) for v in disp["hand"]]
               + [round(v, 4) for v in disp["forearm"]] + th_rel
               + [round(blend, 3), 0.0] + [None] * 7 + [None] * 3 + iner + bm.take_cols()
               + raw_cols(fr, (hq, fq, tq), live_map, rx))
        b = bm.body()
        tm = fr.get("timing") or {}
        self.q.add(fr["t_dev_us"], imu_live=live_map,
                   enc_ok=[d is not None and d >= 0.0 for d in fr["enc"]],
                   cal=2 if b["calibrated"] else (1 if b["provisional"] else 0),
                   pos_src=b.get("pos_source", "arm"), qage_us=tm.get("qage_us"),
                   enc_us=tm.get("enc_us"), rx_ms=(rx * 1000.0 if rx is not None else None))
        if self.out is not None:
            self.out.write((",\n" if self.n else "") + json.dumps(row, separators=(",", ":")))
        if self.rows is not None:
            self.rows.append(row)
        self.n += 1
        if self.n % 5 == 0:
            self.spark.append(max(0.0, min(1.0, (cols[self.pip_i] - FLEX_OPEN) / (FLEX_CLOSED - FLEX_OPEN)))
                              if oks[self.pip_i] else 0.0)
        return row

    def finish(self):
        if self.out is not None:
            self.out.write("\n]}")
            self.out.close()
            os.replace(self.path + ".tmp", self.path)
            self.out = None
        return {"rows": self.n, "quality": self.q.finish(), "spark": _downsample(self.spark),
                "any_iner": self.any_iner, "any_enc": self.any_enc,
                "duration_s": ((self.last_t or 0) - (self.t_first or 0)) / 1000.0}

    def abort(self):
        if self.out is not None:
            try:
                self.out.close()
                os.remove(self.path + ".tmp")
            except OSError:
                pass
            self.out = None


def import_sd_take(text, name, take_id, progress=None, out_path=None, raw_keep=True, want_prov=False):
    # `text`: the file as a string, or its lines (what SdClient.get returns)
    """Run one SD take file through the SAME pipeline as live data - encoder
    calibration, a FRESH BodyModel (its own neutral, trackers, inertial state),
    the legacy display and the take-row builder (OfflineDeriver) - and write
    it as a normal take, with its quality and provenance. The card file is
    kept as the take's raw stream (`.sd.csv.gz`). Nothing here reads or
    writes the live state beyond the (read-only) calibration constants.
    Worker thread."""
    parsed = sdcard.parse_take_csv(text)
    idx, raw_rows = parsed["idx"], parsed["rows"]
    if not raw_rows:
        raise sdcard.SdError("the take has no rows")
    meta = parsed["meta"]
    ncols = len(parsed["cols"])
    try:
        boot = int(meta.get("boot")) if meta.get("boot") is not None else None
    except ValueError:
        boot = None
    try:
        fw = int(meta.get("fw")) if meta.get("fw") is not None else None
    except ValueError:
        fw = None
    try:
        nominal = float(meta["rate_hz"]) if meta.get("rate_hz") else None
    except ValueError:
        nominal = None

    def rows_iter(step=1):
        for line in raw_rows[::step]:
            yield sdcard.parse_row(line, ncols)

    ti = idx.get("t_live")
    thumb_seen = ti is not None and any(bool(r[ti]) for r in rows_iter(max(1, len(raw_rows) // 200)))
    # ---- neutrals: header > inline events > this bridge's neutral for that boot
    neutrals = []
    if parsed["neutral"]:
        neutrals.append((parsed["neutral"]["t_ms"], parsed["neutral"]["q"], "header"))
    for ev in parsed["events"]:
        if ev["kind"] == "neutral" and ev["args"][:1] == ["done"] and ev.get("q"):
            neutrals.append((ev["t_ms"], ev["q"], "event"))
    neutrals.sort(key=lambda n: n[0])
    rec = BODY_PERSIST.get("neutral")
    if not neutrals and rec and boot is not None and rec.get("boot_id") == boot and rec.get("t") is not None:
        neutrals.append((rec["t"] * 1000.0, rec["q0"], "boot"))
    for i, (t_n, q, src) in enumerate(neutrals):
        q = dict(q)
        if not thumb_seen:
            q["thumb"] = None
        neutrals[i] = (t_n, q, src)

    provisional = None
    if not neutrals:
        # no neutral anywhere: the first 1.5 s still window of the take, used
        # retroactively for the whole take and flagged provisional
        probe = OfflineDeriver(take_id, None, boot=boot)
        probe.bm.auto_neutral = True
        for r in rows_iter():
            if r[idx["t_ms"]] is None:
                continue
            probe.frame(sd_row_frame(r, idx, boot), emit=False)
            if probe.bm.neutral is not None:
                provisional = (probe.bm.neutral["t"], probe.bm.neutral["q0"])
                break

    path = out_path or _take_data_path(take_id)
    d = OfflineDeriver(take_id, path, boot=boot, nominal_hz=nominal)
    applied = {"src": "none", "i": 0}

    def apply(t_n, q, src, prov=False):
        if d.set_neutral(t_n / 1000.0, q, "sd-" + src, provisional=prov):
            applied["src"] = src
            return True
        return False

    if neutrals:
        apply(*neutrals[0])
        applied["i"] = 1
    elif provisional:
        apply(provisional[0] * 1000.0, provisional[1], "auto", prov=True)
    t_i = idx["t_ms"]
    try:
        for ri, r in enumerate(rows_iter()):
            t_ms = r[t_i]
            if t_ms is None:
                continue
            while applied["i"] < len(neutrals) and neutrals[applied["i"]][0] <= t_ms:
                apply(*neutrals[applied["i"]])
                applied["i"] += 1
            d.frame(sd_row_frame(r, idx, boot), rx=None)
            if progress and ri % 1000 == 0:
                progress(ri / max(1, len(raw_rows)))
        res = d.finish()
    except Exception:
        d.abort()
        raise
    src = applied["src"]
    quality = res["quality"]
    if parsed["warnings"]:
        quality["warnings"] = len(parsed["warnings"])
    prov = provenance("sd", fw=fw, boot_id=boot)
    prov["sd"] = {"name": name, "recorded_by": meta.get("source"), "format": meta.get("format"),
                  "columns": len(parsed["cols"]), "end": parsed.get("end")}
    take = {
        "id": take_id, "profile": "SD card", "task": "SD take %s" % (meta.get("take") or name),
        "created_ms": int(time.time() * 1000), "duration_s": round(res["duration_s"], 1),
        "samples": res["rows"], "rows": res["rows"], "quality": quality,
        "spark": res["spark"], "has_data": True, "traj": False,
        "traj_inertial": res["any_iner"], "body": True,
        "joint_source": ("sim" if SIM_MODE else ("encoders" if res["any_enc"] else "none")),
        "source": "sd", "sd_name": name, "sd_take": int(meta["take"]) if str(meta.get("take", "")).isdigit() else None,
        "boot_id": boot, "fw": fw, "bridge_version": BRIDGE_VERSION,
        "rate_hz": quality.get("rate_hz") or (int(float(meta["rate_hz"])) if meta.get("rate_hz") else None),
        "recorded_by": meta.get("source"),
        # where the body neutral came from: header / event (the device's own
        # capture), boot (this bridge's capture for that power-up), auto
        # (provisional: first still 1.5 s), none
        "neutral": {"header": "device", "event": "device", "boot": "bridge",
                    "auto": "provisional"}.get(src, "none"),
        "body_cal": "calibrated" if src in ("header", "event", "boot") else
                    ("provisional" if src == "auto" else "none"),
    }
    if parsed["warnings"]:
        take["warnings"] = parsed["warnings"][:10]
    if raw_keep and out_path is None:
        # the card file itself is this take's raw device stream
        try:
            rp = _raw_path(take_id, ".sd.csv.gz")
            with gzip.open(rp, "wt", compresslevel=6, encoding="utf-8", newline="\n") as f:
                for ln in (text.splitlines() if isinstance(text, str) else text):
                    f.write(ln + "\n")
            take["raw"] = {"file": take_id + ".sd.csv.gz", "bytes": os.path.getsize(rp),
                           "lines": len(raw_rows), "format": "takto take v1 (SD card CSV)"}
        except Exception as e:
            print("[sd] could not keep the card file:", e)
    if out_path is None:
        _write_research_meta(take, prov, quality)
    if progress:
        progress(1.0)
    return (take, prov) if want_prov else take


def derive_raw_take(lines, take_id, out_path, progress=None):
    """Re-derive a live take from its raw sidecar (research.RawWriter) with
    the offline pipeline: the pre-roll warms the filters, the model state of
    the first row is restored, and every neutral change is replayed where it
    happened in the stream. Returns (take meta, provenance). The caller has
    applied the provenance (rederive.py) or accepts the current calibration."""
    rs = research.RawStream(lines)
    meta = rs.meta or {}
    prov = meta.get("provenance") or {}
    boot = meta.get("boot_id")
    d = OfflineDeriver(take_id, out_path, boot=boot, nominal_hz=meta.get("nominal_hz"))
    n0 = meta.get("neutral")
    if n0 and n0.get("q0"):
        d.set_neutral(n0["t"], n0["q0"], n0.get("kind") or "restored", bool(n0.get("provisional")),
                      spread=n0.get("spread"))
    preroll = int(meta.get("preroll") or 0)
    pending = []
    n_s = 0
    it = rs.items()
    nxt = next(it, None)
    try:
        while nxt is not None:
            rx, line = nxt
            nxt = next(it, None)
            if line.startswith("#N"):
                nl = research.parse_neutral_line(line)
                if nl is not None:
                    pending.append(nl)       # an orphan "a" is applied like a "b"
                continue
            if line.startswith("#V"):
                vl = research.parse_vision_line(line)
                if vl is not None:
                    d.bm.vision_sample(vl["shoulder"], vl["elbow"], vl["wrist"], conf=vl["conf"])
                continue
            if not line.startswith("S,"):
                continue
            fr = parse_s_line(line)
            if fr is None:
                continue
            posts = []
            while nxt is not None and nxt[1].startswith("#N,a"):
                nl = research.parse_neutral_line(nxt[1])
                if nl is not None:
                    posts.append(nl)
                nxt = next(it, None)
            first = n_s == preroll
            is_pre = n_s < preroll
            n_s += 1
            if first and meta.get("state0"):
                d.bm.import_state(meta["state0"])
                for k, st in (meta["state0"].get("trackers") or {}).items():
                    if k in d.trackers:
                        d.trackers[k].import_state(st)
            pend, pending = pending, []

            def before(pend=pend):
                for nl in pend:
                    d.set_neutral(nl["t"], nl["q0"], nl["kind"], nl["provisional"])

            def after(posts=posts):
                for nl in posts:
                    d.set_neutral(nl["t"], nl["q0"], nl["kind"], nl["provisional"])
            d.frame(fr, rx=rx / 1000.0, emit=not is_pre, before=before if pend else None,
                    after=after if posts else None)
            if progress and n_s % 1000 == 0:
                progress(n_s)
        res = d.finish()
    except Exception:
        d.abort()
        raise
    q = res["quality"]
    if not rs.complete:
        q["truncated"] = True
    take = {"id": take_id, "source": "rederived", "rows": res["rows"], "samples": res["rows"],
            "duration_s": round(res["duration_s"], 1), "quality": q, "spark": res["spark"],
            "has_data": True, "body": True, "traj_inertial": res["any_iner"],
            "boot_id": boot, "fw": prov.get("fw"), "bridge_version": BRIDGE_VERSION,
            "rederived_from": {"take": meta.get("take"), "bridge_version": prov.get("bridge_version"),
                               "git": prov.get("git")}}
    return take, prov


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
        # the fast pose lane (opt-in): a latest-wins slot, like the snapshot
        self.pose = False
        self.pose_text = None               # pose JSON without its closing brace
        self.pose_rx = 0.0
        self.pose_sent = 0
        self.pose_dropped = 0               # superseded before the socket took them
        # bulk transfers (take_file): a SMALL bounded queue the producer awaits
        # on, drained one chunk per writer pass so poses/snaps interleave
        self.bulk = asyncio.Queue(maxsize=4)
        self.bulk_busy = False
        self.bulk_next = 0.0
        self.bulk_timer = None
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

    def offer_pose(self, text, rx):
        if self.pose_text is not None:
            self.pose_dropped += 1
        self.pose_text = text
        self.pose_rx = rx
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
            if c.pose_text is not None:
                text, rx = c.pose_text, c.pose_rx
                c.pose_text = None
                tx = time.time()
                await c.ws.send(text + ',"tx":%.1f}' % (tx * 1000.0))
                c.pose_sent += 1
                _pose_sent(tx, rx)
            if c.latest is not None:
                text, c.latest = c.latest, None
                await c.ws.send(text)
            if not c.bulk.empty():
                # paced: one chunk per BULK_GAP_S while this client rides the
                # pose lane, so a 40 MB export never parks the twin's poses
                # behind megabytes of socket buffer (~10 MB/s; ~40 MB/s otherwise)
                now = time.monotonic()
                if now >= c.bulk_next:
                    await c.ws.send(c.bulk.get_nowait())
                    c.bulk_next = time.monotonic() + (BULK_GAP_S if c.pose else BULK_GAP_S / 4)
                if not c.bulk.empty() and (c.bulk_timer is None or c.bulk_timer.cancelled()
                                           or c.bulk_timer.when() < asyncio.get_running_loop().time()):
                    c.bulk_timer = asyncio.get_running_loop().call_later(
                        max(0.0, c.bulk_next - time.monotonic()), c.wake.set)
    except Exception:
        pass          # connection closed; the reader side tears the client down


def _pose_clients_recount():
    POSE_LANE["clients"] = sum(1 for c in list(CLIENTS) if c.pose)


# ---- take files (research export) ---------------------------------------------
TAKE_FILE_CHUNK = 192 * 1024        # raw bytes per message (256 KiB of base64)
BULK_GAP_S = 0.02                   # min interval between chunks to a pose-lane client


def _take_csv_file(take_id):
    """Generate the research take.csv (SI units) to a temp file; returns its path."""
    src = _take_data_path(take_id)
    cols, rows, _hdr = research.iter_take_rows(src)
    out = os.path.join(STATE_DIR, ".sensoryhand_takedata_%s.csv.partial" % take_id)
    with open(out, "w", newline="") as f:
        research.write_research_csv(cols, rows, f)
    return out


def _take_meta_bytes(take_id):
    tmeta = next((t for t in takes if t.get("id") == take_id), None)
    try:
        with open(_meta_path(take_id)) as f:
            d = json.load(f)
        if tmeta:                              # labels may have been re-read since
            d["take"] = {k: v for k, v in tmeta.items() if k != "spark"}
    except (OSError, ValueError):
        if tmeta is None:
            raise FileNotFoundError(take_id)
        # a take recorded before research metadata existed: say what is known
        raw = _take_raw_file(take_id)
        d = research.take_json(tmeta, provenance=None, quality=tmeta.get("quality"),
                               raw_name=os.path.basename(raw) if raw else None)
        d["note"] = "recorded before provenance was kept; provenance unknown"
    # names inside the research package (the web zips take.csv, take.json and
    # the raw stream into one folder per take)
    raw = _take_raw_file(take_id)
    d["files"] = {"csv": "take.csv", "json": "take.json",
                  "raw": ("take.raw.txt.gz" if raw.endswith(".raw.txt.gz") else "take.sd.csv.gz") if raw else None}
    return json.dumps(d, indent=1).encode()


async def take_file_send(c, take_id, what):
    """Stream one take file to one client as base64 chunks through its bounded
    bulk queue: constant memory for any size, poses and snapshots keep
    flowing between chunks, and a vanished client ends the transfer."""
    if not re.fullmatch(r"take_\d{1,6}", take_id or ""):
        _ack(c, event="error", cmd="take_file", id=take_id, what=what, error="bad take id")
        return
    if what not in ("raw", "meta", "csv"):
        _ack(c, event="error", cmd="take_file", id=take_id, what=what, error="what: raw | meta | csv")
        return
    if c.bulk_busy:
        _ack(c, event="error", cmd="take_file", id=take_id, what=what,
             error="a take file transfer to this client is already running")
        return
    c.bulk_busy = True
    tmp = None
    try:
        if what == "raw":
            path = _take_raw_file(take_id)
            if path is None:
                raise FileNotFoundError("this take has no raw stream (recorded before v17 research takes)")
            name = take_id + (".raw.txt.gz" if path.endswith(".raw.txt.gz") else ".sd.csv.gz")
            mime = "application/gzip"
        elif what == "csv":
            if not os.path.exists(_take_data_path(take_id)):
                raise FileNotFoundError("no rows for this take")
            tmp = path = await asyncio.to_thread(_take_csv_file, take_id)
            name, mime = take_id + ".csv", "text/csv"
        else:
            data = await asyncio.to_thread(_take_meta_bytes, take_id)
            tmp = path = os.path.join(STATE_DIR, ".sensoryhand_takedata_%s.json.partial" % take_id)
            with open(path, "wb") as f:
                f.write(data)
            name, mime = take_id + ".json", "application/json"
        total = os.path.getsize(path)
        import base64
        with open(path, "rb") as f:
            seq = 0
            sent = 0
            while True:
                buf = f.read(TAKE_FILE_CHUNK)
                sent += len(buf)
                last = sent >= total or not buf
                msg = ('{"kind":"take_file","id":%s,"what":%s,"name":%s,"mime":%s,"bytes":%d,'
                       '"seq":%d,"last":%s,"data":"%s"}' % (json.dumps(take_id), json.dumps(what),
                                                         json.dumps(name), json.dumps(mime), total, seq,
                                                         "true" if last else "false",
                                                         base64.b64encode(buf).decode("ascii")))
                if c not in CLIENTS:
                    return
                await asyncio.wait_for(c.bulk.put(msg), timeout=30.0)
                if c.bulk.qsize() == 1:
                    c.wake.set()
                seq += 1
                if last:
                    break
    except FileNotFoundError as e:
        _ack(c, event="error", cmd="take_file", id=take_id, what=what, error=str(e) or "not found")
    except asyncio.TimeoutError:
        print("[ws] take_file %s/%s to client #%d stalled; abandoned" % (take_id, what, c.n))
    except Exception as e:
        _ack(c, event="error", cmd="take_file", id=take_id, what=what, error=str(e))
    finally:
        c.bulk_busy = False
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


async def _broadcast_loop():
    # drift-free absolute schedule: sleeping a fixed 1/HZ AFTER the build work
    # made the real rate HZ-minus-work and let jitter accumulate; anchoring to
    # t0 + n/HZ keeps the cadence exact and the queueing delay minimal
    loop = asyncio.get_running_loop()
    period = 1.0 / HZ
    next_t = loop.time() + period
    while True:
        try:
            _now = time.time()
            _neutral_ui_tick(_now)
            _neutral_request_watch(_now)
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
            body_call(_body_reprior)          # the body model's mounting priors follow
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
            body_call(_body_reprior)          # the body model's mounting priors follow
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
        if what in ("imu", "neutral", "wrist_axis", "joints_open", "joints_closed", "joint_closed",
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
                body_call(_body_reprior)
                broadcast({"kind": "imu_cfg", "cfg": IMU_CFG})
        elif what == "imu":
            # "This pose is home, now": an immediate capture from the last 0.5 s
            # of frames (refused if the arm moved), seating the body neutral and
            # the legacy display home together. For the guided flow use neutral.
            body_call(lambda bm: _neutral_result(bm.capture_neutral(window_s=0.5, kind="imu"), "imu"))
            _ack(c, event="calibrated", what="imu")
        elif what == "neutral":
            # The body neutral (MOTION_PIPELINE.md s.3): palm down, forearm level
            # and forward, wrist straight, fingers extended. The device counts
            # down and holds; the averaged pose seats the body frame, the legacy
            # home, and (as before) the encoder OPEN reference.
            res = start_neutral_capture(enc_open=True, source="console")
            if res.get("ok"):
                _ack(c, event="neutral", phase="requested", via=res["via"])
            else:
                _ack(c, event="error", error=res.get("error"))
        elif what == "wrist_axis":
            # optional functional step: 5 s of wrist flexion/extension
            dur = cmd.get("seconds", 5.0)
            dur = float(dur) if isinstance(dur, (int, float)) and 3.0 <= dur <= 15.0 else 5.0
            body_call(lambda bm: _wa_start(bm, dur))
            _ack(c, event="wrist_axis", phase="requested", t=dur)
        elif what == "wrist_axis_reset":
            body_call(_wa_reset)
            _ack(c, event="wrist_axis", phase="reset_requested")
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
        if action == "start" and (SD_STATE["busy"] or (SD is not None and SD.busy)):
            _ack(c, event="error", error="an SD transfer is running; record after it finishes")
            return
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

    if name == "sim":             # --sim only: drive the simulated device (tests, demos)
        if not SIM_MODE or SIM_DEVICE is None:
            _ack(c, event="error", error="sim commands need --sim")
            return
        if cmd.get("action") == "reboot":
            SIM_DEVICE.write(b"X,reboot\n")       # power-cycle: new boot id + heading reference
            _ack(c, event="sim", action="reboot")
        else:
            _ack(c, event="error", error="unknown sim action")
        return

    if name == "sd":              # the device's SD take library (MOTION_PIPELINE.md s.6-7)
        action = cmd.get("action", "list")
        loop = asyncio.get_running_loop()
        if action == "list":
            loop.create_task(sd_list(c))
        elif action == "import":
            loop.create_task(sd_import(c, cmd.get("name")))
        elif action == "auto":
            loop.create_task(sd_set_auto(c, bool(cmd.get("on"))))
        else:
            _ack(c, event="error", error="unknown sd action")
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

    if name == "vision":          # a camera pose sample: the upper arm the IMUs cannot see
        try:
            pts = [[float(v) for v in cmd[k]][:3] for k in ("shoulder", "elbow", "wrist")]
            conf = float(cmd.get("conf", 1.0))
            if any(len(p) != 3 or not all(math.isfinite(v) for v in p) for p in pts):
                raise ValueError
        except (KeyError, TypeError, ValueError):
            return                # high-rate stream: a bad sample is dropped, never acked

        def apply(bm, pts=pts, conf=conf):
            if bm.vision_sample(*pts, conf=conf):
                _raw_write(time.time(), research.vision_line(*pts, conf))
        body_call(apply)
        return
    if name == "body_cfg":        # research switches of the body model (live, per session)
        for k in ("inertial", "heading_bleed"):
            if k in cmd:
                BODY.cfg[k] = bool(cmd[k])
        _ack(c, event="body_cfg", ok=True,
             cfg={k: bool(BODY.cfg.get(k)) for k in ("inertial", "heading_bleed")})
        return
    if name == "enc_map":         # which finger / DOF each encoder channel measures
        if cmd.get("action") == "set":
            try:
                enc_map_apply(cmd.get("map") or {})
            except (ValueError, TypeError, AttributeError) as e:
                _ack(c, event="enc_map", ok=False, error=str(e))
                return
        _ack(c, event="enc_map", ok=True, map=enc_map_public())
        return
    if name == "stream":          # opt in/out of the fast pose lane (MOTION_PIPELINE.md s.8)
        if "pose" in cmd:
            c.pose = bool(cmd.get("pose"))
            _pose_clients_recount()
        _ack(c, event="stream", pose=c.pose, hz=_nominal_hz())
        return

    if name == "take_file":       # research export: raw stream / take.json / take.csv, chunked
        asyncio.get_running_loop().create_task(
            take_file_send(c, str(cmd.get("id") or ""), str(cmd.get("what") or "")))
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
    c.queue(sd_takes_msg())                               # the SD library (contract s.7)
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
        _pose_clients_recount()
        print(f"[ws] client #{c.n} disconnected ({len(CLIENTS)} online)")


async def main_async(host, port, ssl_ctx=None):
    scheme = "wss" if ssl_ctx else "ws"
    # max_size raised for env_save: a Quest scene mesh serializes to a few MB
    # (default 1 MiB would sever the AR client mid-upload)
    global _LOOP
    _LOOP = asyncio.get_running_loop()
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
    SD = sdcard.SdClient(send_teensy)
    if args.sim:
        SIM_MODE = True
        enable_sim_pipeline()
        _SD_IMPORTS_FILE += ".sim"
        n = max(0, min(4, args.sim_motors))
        if n:
            MOTORS = SimMotors(("index_drive", "middle_drive", "ring_drive", "pinky_drive")[:n])
        th = threading.Thread(target=sim_thread, daemon=True)
    else:
        th = threading.Thread(target=serial_thread, args=(args.port, args.baud), daemon=True)
    _sd_imports_load()
    th.start()
    try:
        asyncio.run(main_async(args.ws_host, args.ws_port, ssl_ctx))
    except KeyboardInterrupt:
        print("\n[bridge] stopped")
