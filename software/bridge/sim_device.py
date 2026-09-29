"""
sim_device.py - a line-level TAKTO ONE (firmware v17) for `teensy_bridge.py --sim`.

It is a fake DEVICE, not a fake bridge state: it produces exactly the text the
real Teensy prints - v17 `S,` lines at 100 Hz (raw game quaternions with a
random per-boot heading reference, mounting rotations, gyro, gravity-free
acceleration, preintegrated dv, stability classes, boot id, SD flags, and the
v17 timing tail: t_us, the age of each IMU's quaternion, the encoder sweep
time; every IMU is sampled on its own report clock, see
motion_synth.SampledSensors), `E,`
events (neutral countdown/hold/done, SD record start/stop) and the `F,`
protocol over an in-memory SD card - and the bridge parses them with the same
code it uses on hardware. Commands the bridge writes (`v`, `j`, `b`, `e`, `N`,
`F,...`) arrive through write(), like bytes on a serial port.

The arm is motion_synth's kinematic right arm running a 36 s choreography with
shoulder motion; when the bridge asks for a neutral (`N`), the simulated wearer
does what a person would: moves into the neutral pose during the 3 s
countdown and holds still until the device reports done.

Encoders: the sim streams its 12 finger joints in JOINT-space degrees offset
by SIM_ENC_BIAS (so they are positive, like AS5600 readings); the bridge's sim
mode subtracts the bias again. That is the only sim-specific encoding.
"""
import math
import random
import threading
import time
from collections import deque

import motion
import motion_synth as ms
from sdcard import SD_COLUMNS, crc32_hex

N_CH = 14
SIM_ENC_BIAS = 180.0
FW_VERSION = 17
RATE_HZ = 100.0
SPLAY = [9.0, 2.5, -4.0, -10.0]


def fmt(v, d):
    return ("%." + str(d) + "f") % v


def _pose_lerp(a, b, w):
    p = ms.Pose()
    for k in ms.Pose.__slots__:
        va, vb = getattr(a, k), getattr(b, k)
        if isinstance(va, list):
            setattr(p, k, [x * (1.0 - w) + y * w for x, y in zip(va, vb)])
        else:
            setattr(p, k, va * (1.0 - w) + vb * w)
    return p


class SimDevice:
    def __init__(self, priors, seed=None, speed=1.0, emit=None, preload=True, t_offset_s=0.0):
        self.rng = random.Random(seed)
        self.speed = speed
        # device clock at power-up (s); tests start it just before the 32-bit
        # micros() wrap (71.58 min) to exercise the host's unwrap
        self.t_offset_s = float(t_offset_s)
        self.emit = emit or (lambda line: None)
        self.boot()
        self.cmd_q = deque()
        self.lock = threading.Lock()
        self.files = {}                 # "TAKES/TK00001.CSV" -> [lines]
        self.auto_record = True
        self.rec = None                 # {"path", "take", "rows", "t0", "lines"}
        self.rec_seq = 1
        self.priors = priors
        self._make_arm()
        self.transfer = None            # deque of lines being sent (S stream paused)
        self._preload = preload
        self._preloaded = False

    # ------------------------------------------------------------------
    def boot(self):
        self.boot_id = self.rng.randint(1, 65535)
        self.t0 = time.time()
        self.streaming = False
        self.neutral = None             # {"phase", "t0", "hold0", "sum", "n"}
        self.neutral_have = None        # (t_ms, [12 floats])
        self.pose_override = None       # (t_start, t_hold_end) of a neutral the wearer obeys

    def _make_arm(self):
        rng = self.rng
        mount = {k: ms.perturb(self.priors[k], 1.5, rng) for k in ms.KEYS}
        heading = {k: rng.uniform(-math.pi, math.pi) for k in ms.KEYS}
        self.arm = ms.Arm()
        self.sensors = ms.Sensors(self.arm, self._pose, mount, heading,
                                  seed=rng.randint(0, 10 ** 6), noise=True)
        self.sampler = ms.SampledSensors(self.sensors, seed=rng.randint(0, 10 ** 6))
        self.enc_rng = random.Random(rng.randint(0, 10 ** 6))

    def reboot(self):
        """Simulated power cycle: new boot id, new heading references. A take
        that was recording is cut off without its end line (like a brownout);
        the host link stays open, so streaming resumes (the bridge would
        re-send 'j' after 3 s of silence anyway)."""
        self.rec = None
        self.t_offset_s = 0.0
        self.boot()
        self.streaming = True
        self._make_arm()
        self.emit("# boot_id %u  auto-record %s  SD present" % (self.boot_id, "on" if self.auto_record else "off"))

    # ------------------------------------------------------------------
    def now_s(self):
        return (time.time() - self.t0) * self.speed + self.t_offset_s

    def now_ms(self):
        return int(self.now_s() * 1000.0)

    # ---- v17 timing -------------------------------------------------------
    def frame_at(self, t, dt):
        """The device frame at device time t (s): every IMU at its own latest
        report, plus the v17 timing block."""
        fr = self.sampler.frame(t, dt)
        fr["timing"] = self._timing(t, fr.get("qage_us"))
        return fr

    def _timing(self, t, qage=None):
        # a 12-channel AS5600 sweep over the I2C muxes: ~2..3 ms
        enc_us = int(max(1800, min(3200, self.enc_rng.gauss(2450, 180))))
        return {"t_us": int(round(t * 1e6)) & 0xFFFFFFFF,
                "qage_us": dict(qage) if qage else {k: 1000 for k in ms.KEYS},
                "enc_us": enc_us}

    def _timing_fields(self, fr, t):
        tm = fr.get("timing") or self._timing(t, fr.get("qage_us"))
        qa = tm["qage_us"]
        return [str(tm["t_us"]), str(qa.get("hand") or 0), str(qa.get("forearm") or 0),
                str(qa.get("thumb") or 0), str(tm["enc_us"])]

    def _pose(self, t):
        base = ms.demo_loop(t)
        ov = self.pose_override
        if ov is None:
            return base
        t_start, t_end = ov
        if t < t_start:
            return base
        if t_end is not None and t > t_end:
            w = max(0.0, 1.0 - (t - t_end) / 1.5)          # ease back into the loop
        else:
            w = ms.smooth01((t - t_start) / 2.0)            # get into the pose in 2 s
        return _pose_lerp(base, ms.Pose(), w)

    # ------------------------------------------------------------------
    def write(self, data):
        """Bytes from the bridge (like a serial port)."""
        try:
            text = data.decode("utf-8", "replace")
        except AttributeError:
            text = str(data)
        with self.lock:
            # single-byte commands (b / e / r / v / j) arrive with or without "\n"
            for part in text.replace("\r", "").split("\n"):
                if part:
                    self.cmd_q.append(part)

    def _commands(self, t_ms):
        with self.lock:
            cmds = list(self.cmd_q)
            self.cmd_q.clear()
        for c in cmds:
            if c.startswith("F,"):
                self._file_cmd(c)
            elif c == "v":
                self.emit("# ver bringup_12ch %d" % FW_VERSION)
            elif c == "j":
                self.streaming = True
            elif c == "b":
                self._rec_start(t_ms, from_device=False)
            elif c == "e":
                self._rec_stop(t_ms)
            elif c == "r":
                if self.rec:
                    self._rec_stop(t_ms)
                else:
                    self._rec_start(t_ms, from_device=False)
            elif c == "N":
                self._neutral_start(t_ms)
            elif c == "X,reboot":
                self.reboot()
            # D, M, W, R, G, Q: accepted and ignored by the simulated device

    # ---- neutral --------------------------------------------------------
    def _neutral_start(self, t_ms):
        self.neutral = {"phase": 1, "t0": t_ms, "hold0": None, "sum": None, "n": 0}
        # the simulated wearer obeys: into the neutral pose, hold until done
        self.pose_override = (t_ms / 1000.0, None)
        self.emit("E,neutral,start")
        self._rec_event(t_ms, "neutral,start")

    def _neutral_step(self, t_ms, fr):
        n = self.neutral
        if n is None:
            return
        if n["phase"] == 1:
            if t_ms - n["t0"] >= 3000:
                n.update(phase=2, hold0=t_ms, sum=[[0.0] * 4 for _ in range(3)], n=0)
            return
        moving = any(motion.vlen(fr["gyr"][k]) > 0.35 for k in ("hand", "forearm"))
        if moving:
            if t_ms - n["t0"] > 10000:
                self.neutral = None
                self.pose_override = None
                self.emit("E,neutral,abort,moving")
                self._rec_event(t_ms, "neutral,abort,moving")
                return
            n.update(hold0=t_ms, sum=[[0.0] * 4 for _ in range(3)], n=0)
        for i, k in enumerate(ms.KEYS):
            q = fr["q"][k]
            s = n["sum"][i]
            d = sum(q[c] * s[c] for c in range(4))
            sg = 1.0 if (n["n"] == 0 or d >= 0) else -1.0
            for c in range(4):
                s[c] += sg * q[c]
        n["n"] += 1
        if t_ms - n["hold0"] >= 2000 and n["n"] > 0:
            vals = []
            for s in n["sum"]:
                vals += motion.qnorm(s)
            self.neutral_have = (t_ms, vals)
            self.neutral = None
            self.pose_override = (self.pose_override[0], t_ms / 1000.0)
            nf = ",".join(fmt(v, 5) for v in vals)
            self.emit("E,neutral,done,%d,%s" % (t_ms, nf))
            self._rec_event(t_ms, "neutral,done,%s" % nf)

    # ---- SD card --------------------------------------------------------
    def _rec_start(self, t_ms, from_device):
        if self.rec is not None:
            return
        path = "TAKES/TK%05u.CSV" % self.rec_seq
        while path in self.files:
            self.rec_seq += 1
            path = "TAKES/TK%05u.CSV" % self.rec_seq
        take = self.rec_seq
        self.rec_seq += 1
        lines = ["# takto take v1",
                 "# fw=%d boot=%u take=%u source=%s rate_hz=%d start_ms=%d"
                 % (FW_VERSION, self.boot_id, take, "device" if from_device else "host", RATE_HZ, t_ms)]
        if self.neutral_have is not None:
            lines.append("# neutral=%d,%s" % (self.neutral_have[0],
                                              ",".join(fmt(v, 5) for v in self.neutral_have[1])))
        lines.append(",".join(SD_COLUMNS))
        self.files[path] = lines
        self.rec = {"path": path, "take": take, "rows": 0, "t0": t_ms, "lines": lines}
        self.emit(">>> RECORDING to %s" % path)
        self.emit("E,rec,start,%u,%s" % (take, "device" if from_device else "host"))
        if from_device:
            self._neutral_start(t_ms)

    def _rec_stop(self, t_ms):
        r = self.rec
        if r is None:
            return
        ms_ = t_ms - r["t0"]
        r["lines"].append("# end rows=%d ms=%d" % (r["rows"], ms_))
        self.rec = None
        self.emit(">>> STOPPED. %d rows over %.1f s saved to SD (%s)." % (r["rows"], ms_ / 1000.0, r["path"]))
        self.emit("E,rec,stop,%u,%d,%d" % (r["take"], r["rows"], ms_))

    def _rec_event(self, t_ms, body):
        if self.rec is not None:
            self.rec["lines"].append("#E,%d,%s" % (t_ms, body))

    def _file_cmd(self, c):
        if c.startswith("F,list"):
            self._ensure_preload()
            for path in sorted(self.files):
                self.emit("F,item,%s,%d" % (path, len(self._bytes(path))))
            self.emit("F,end,%d" % len(self.files))
        elif c.startswith("F,get,"):
            path = c[6:].strip()
            self._ensure_preload()
            if self.rec is not None and self.rec["path"] == path:
                self.emit("F,err,busy")
                return
            if path not in self.files:
                self.emit("F,err,nofile")
                return
            data = self._bytes(path)
            out = deque(["F,begin,%s,%d" % (path, len(data))])
            for ln in data.decode().split("\n")[:-1]:
                out.append("F,d," + ln)
            out.append("F,done,%s,%d,%s" % (path, len(data), crc32_hex(data)))
            self.transfer = out               # the S stream pauses while this drains
        elif c.startswith("F,auto"):
            if c.startswith("F,auto,"):
                self.auto_record = c[7:].strip() != "0"
            self.emit("F,auto,%d" % (1 if self.auto_record else 0))
        else:
            self.emit("F,err,unknown")

    def _bytes(self, path):
        return ("\n".join(self.files[path]) + "\n").encode()

    # ---- preloaded standalone takes (a power-bank session) --------------------
    def _ensure_preload(self):
        if self._preloaded or not self._preload:
            return
        self._preloaded = True
        self._synth_take("TAKES/TK00090.CSV", 90, ms.demo_loop, dur=14.0, device_neutral=True)
        self._synth_take("TAKES/TK00091.CSV", 91, ms.shoulder_motion, dur=12.0, device_neutral=False)

    def _synth_take(self, path, take, pose_fn, dur, device_neutral):
        """A take recorded standalone (earlier boot of the device): synthetic
        but in the exact file format, with its own neutral."""
        rng = random.Random(take)
        boot = rng.randint(1, 65535)
        mount = {k: ms.perturb(self.priors[k], 1.5, rng) for k in ms.KEYS}
        heading = {k: rng.uniform(-math.pi, math.pi) for k in ms.KEYS}
        sens = ms.Sensors(ms.Arm(), lambda t: pose_fn(t) if t >= 3.0 else ms.Pose(), mount,
                          heading, seed=take, noise=True)
        sampler = ms.SampledSensors(sens, seed=take + 1)
        lines = ["# takto take v1",
                 "# fw=%d boot=%u take=%u source=device rate_hz=100 start_ms=5000" % (FW_VERSION, boot, take)]
        # the neutral: the hold is the first 3 s (the wearer holds the pose)
        q_avg = {k: motion.qaverage([sens.raw_quat(k, 0.5 + 0.01 * i) for i in range(200)]) for k in ms.KEYS}
        nf = ",".join(fmt(v, 5) for k in ms.KEYS for v in q_avg[k])
        if not device_neutral:
            lines.append("# neutral=%d,%s" % (4000, nf))
        lines.append(",".join(SD_COLUMNS))
        dt = 0.01
        n = int(dur / dt)
        for i in range(n):
            t = (i + 1) * dt
            fr = sampler.frame(t, dt)
            t_ms = 5000 + int(round(t * 1000))
            fr["timing"] = self._timing(t_ms / 1000.0, fr.get("qage_us"))
            lines.append(self._row(t_ms, fr, t))
            if device_neutral and i == 0:
                lines.append("#E,%d,neutral,start" % t_ms)
            if device_neutral and abs(t - 2.5) < 1e-9:
                lines.append("#E,%d,neutral,done,%s" % (t_ms, nf))
        lines.append("# end rows=%d ms=%d" % (n, int(dur * 1000)))
        self.files[path] = lines
        return sens

    # ---- frame builders ---------------------------------------------------
    def _fingers(self, t):
        enc = [None] * N_CH                 # ch12/13 spare: honestly absent
        curls = []
        for fi in range(4):
            phase = t * 0.6 + fi * 0.4
            curl = 0.5 - 0.5 * math.cos(phase)
            curls.append(curl)
            jig = math.sin(t * 2.0 + fi) * 0.4
            b = fi * 3
            enc[b + 0] = SPLAY[fi] * (1.0 - 0.75 * curl) + math.sin(t * 0.9 + fi * 1.7) * 1.2
            enc[b + 1] = 90.0 * curl + jig
            enc[b + 2] = 110.0 * (0.8 * curl + 0.2 * curl * curl) + jig
        enc = [e + SIM_ENC_BIAS if e is not None else -1.0 for e in enc]
        emg_env = 90.0 + 420.0 * curls[0] + 6.0 * math.sin(t * 37.0)
        return enc, emg_env

    def _imu_block(self, fr, k, t):
        """23 fields: lin, acc, gyr, mag, grv, game, ca, cg, cm, rotacc."""
        q = fr["q"].get(k)
        if q is None:
            return ["0.000"] * 15 + ["0.0000"] * 4 + ["0", "0", "0", "0.0000"]
        lin = fr["lin"][k]
        g_s = motion.qrot(motion.qconj(q), [0.0, 0.0, 9.81])      # gravity reaction, sensor frame
        acc = motion.vadd(lin, g_s)
        gyr = fr["gyr"][k]
        out = [fmt(v, 3) for v in lin] + [fmt(v, 3) for v in acc] + [fmt(v, 4) for v in gyr]
        out += ["0.00", "0.00", "0.00"] + [fmt(v, 3) for v in g_s] + [fmt(v, 4) for v in q]
        out += ["3", "3", "0", "0.0000"]
        return out

    def _row(self, t_ms, fr, t):
        """One SD row, firmware recWrite() layout."""
        enc, emg = self._fingers(t)
        f = [str(t_ms)] + [fmt(e, 2) for e in enc]
        for k in ("hand", "forearm"):
            f += [fmt(v, 4) for v in fr["q"][k]]
        f += [fmt(emg, 1), fmt(emg * 0.7, 1), "0"]
        f += [fmt(v, 4) for v in fr["q"]["thumb"]] + ["1"]
        f += ["0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "-1"]
        for k in ms.KEYS:
            f += self._imu_block(fr, k, t)
        f += ["1", "1", "1", "1"]
        for k in ms.KEYS:
            f += [fmt(v, 5) for v in fr["dv"][k]]
        f += [str(fr["stab"][k]) for k in ms.KEYS]
        f += self._timing_fields(fr, t)                                  # v17
        return ",".join(f)

    def _sline(self, t_ms, fr, t):
        enc, emg = self._fingers(t)
        f = ["S", str(t_ms)] + [fmt(e, 2) for e in enc]
        for k in ("hand", "forearm"):
            f += [fmt(v, 4) for v in fr["q"][k]]
        f += ["1", "1", fmt(emg, 1), fmt(emg * 0.7, 1), "1", "0"]
        f += [fmt(v, 4) for v in fr["q"]["thumb"]] + ["1"]
        f += ["0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "-1"]      # mflags, 2 motors, crown_live
        for k in ms.KEYS:
            f += self._imu_block(fr, k, t)
        f += ["0"] * 8 + ["0"]                                           # v9 diag, v14 sea
        flags = (1 if self.rec else 0) | 2 | 8 | (16 if self.auto_record else 0) | (32 if self.neutral else 0)
        f += [str(flags), str(self.rec["take"] if self.rec else 0),
              str(self.rec["rows"] if self.rec else 0), str(self.boot_id)]
        for k in ms.KEYS:
            f += [fmt(v, 5) for v in fr["dv"][k]]
        f += [str(fr["stab"][k]) for k in ms.KEYS]
        f += [str(fr["dv_n"][k]) for k in ms.KEYS]
        f += self._timing_fields(fr, t)                                  # v17: 140..144
        return ",".join(f)

    # ---- the device loop ----------------------------------------------------
    def run(self, stop=None):
        period = 1.0 / RATE_HZ
        self.emit("# boot_id %u  auto-record %s  SD present" % (self.boot_id, "on" if self.auto_record else "off"))
        next_t = time.time()
        last_t = None
        while stop is None or not stop.is_set():
            t_s = self.now_s()
            t_ms = int(t_s * 1000.0)
            self._commands(t_ms)
            if self.transfer is not None:
                # a file transfer blocks the device loop: no S lines, no rows
                for _ in range(250):
                    if not self.transfer:
                        break
                    self.emit(self.transfer.popleft())
                if not self.transfer:
                    self.transfer = None
            else:
                t = t_s
                if last_t is None or t_ms > int(last_t * 1000.0):
                    dt = 0.01 if last_t is None else (t - last_t)
                    last_t = t
                    fr = self.frame_at(t, dt)
                    self._neutral_step(t_ms, fr)
                    if self.rec is not None:
                        self.rec["lines"].append(self._row(t_ms, fr, t))
                        self.rec["rows"] += 1
                        if self.rec["rows"] >= 60000:          # 10 min cap on the fake card
                            self._rec_stop(t_ms)
                    if self.streaming:
                        self.emit(self._sline(t_ms, fr, t))
            next_t += period / max(0.1, self.speed) if self.speed < 1.0 else period
            delay = next_t - time.time()
            if delay < -0.5:
                next_t = time.time()
                delay = 0.0
            time.sleep(max(0.0, delay))
