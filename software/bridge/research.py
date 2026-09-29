"""
research.py - device timing, take quality, the raw device stream and the
research export (MOTION_PIPELINE.md section 8). Dependency-free; shared by the
live bridge (teensy_bridge.py), the offline importer and rederive.py, so a take
recorded live and the same take re-derived offline are measured by ONE
definition.

Contents
  unwrap_us            device micros (32-bit) -> monotonic us since boot
  Hist                 fixed-bin histogram (bounded memory percentiles)
  QualityAccumulator   the take `quality` block (definitions in README.md)
  RawWriter / read_raw the `<take>.raw.txt.gz` sidecar (`<rx_ms>\\t<line>`)
  RESEARCH_COLUMNS     the SI column dictionary of the research take.csv
  write_research_csv   take rows -> take.csv (SI units, documented header)
  iter_take_rows       stream the rows of a take-data file
"""
import gzip
import json
import math
import os

WRAP_US = 1 << 32            # micros() wraps every 2^32 us = 71.58 min
RAW_FORMAT = "takto-raw v1"
QUALITY_VERSION = 1


# ---------------------------------------------------------------------------
# device clock
# ---------------------------------------------------------------------------
def unwrap_us(t_ms, t_us):
    """Monotonic device time in microseconds since boot.

    The firmware stamps every frame with millis() (t_ms, wraps after 49.7 days)
    and micros() (t_us, wraps after 71.6 min). Both count the same crystal, so
    t_us + k * 2^32 must lie within a millisecond or two of t_ms * 1000: the
    wrap count k is recovered from t_ms for EVERY frame independently. This is
    stateless, so it survives a bridge that joins an hours-old device, dropped
    frames across the wrap, and offline re-derivation of any slice of a take.
    Without t_us (firmware < 17) the result is t_ms * 1000."""
    if t_us is None:
        return None if t_ms is None else int(round(float(t_ms) * 1000.0))
    t_us = int(t_us)
    if t_ms is None:
        return t_us
    k = int(round((float(t_ms) * 1000.0 - t_us) / WRAP_US))
    return t_us + k * WRAP_US


# ---------------------------------------------------------------------------
# bounded percentiles
# ---------------------------------------------------------------------------
class Hist:
    """Fixed-width bins over [lo, hi); values outside are clamped into the end
    bins (and counted). Percentiles are bin centres: resolution = `width`."""

    def __init__(self, lo, hi, width):
        self.lo, self.width = float(lo), float(width)
        self.n_bins = max(1, int(math.ceil((hi - lo) / width)))
        self.bins = [0] * self.n_bins
        self.n = 0
        self.clamped = 0
        self.vmin = None
        self.vmax = None
        self.total = 0.0

    def add(self, v):
        if v is None or not math.isfinite(v):
            return
        i = int((v - self.lo) / self.width)
        if i < 0 or i >= self.n_bins:
            self.clamped += 1
            i = 0 if i < 0 else self.n_bins - 1
        self.bins[i] += 1
        self.n += 1
        self.total += v
        self.vmin = v if self.vmin is None or v < self.vmin else self.vmin
        self.vmax = v if self.vmax is None or v > self.vmax else self.vmax

    def pct(self, p):
        if not self.n:
            return None
        want = p / 100.0 * self.n
        acc = 0
        for i, c in enumerate(self.bins):
            acc += c
            if acc >= want and c:
                return self.lo + (i + 0.5) * self.width
        return self.lo + (self.n_bins - 0.5) * self.width

    def summary(self, scale=1.0, nd=3):
        if not self.n:
            return None
        r = lambda v: None if v is None else round(v * scale, nd)
        return {"median": r(self.pct(50)), "p95": r(self.pct(95)), "max": r(self.vmax),
                "mean": r(self.total / self.n), "n": self.n}


def percentiles(values, ps=(50, 95)):
    """Exact percentiles (nearest rank) of a small list; None when empty."""
    v = sorted(x for x in values if x is not None)
    if not v:
        return [None for _ in ps]
    out = []
    for p in ps:
        k = max(0, min(len(v) - 1, int(math.ceil(p / 100.0 * len(v))) - 1))
        out.append(v[k])
    return out


# ---------------------------------------------------------------------------
# take quality
# ---------------------------------------------------------------------------
IMU_KEYS = ("hand", "forearm", "thumb")


class QualityAccumulator:
    """One take's quality, fed once per RECORDED device frame. Definitions
    (also in software/bridge/README.md, "Take quality"):

    frames       rows written (one per device frame; a repeated device time is
                 not a frame and is counted in `dup`)
    duration_s   device time from the first to the last row (t_us when the
                 firmware sends it, else t_ms)
    rate_hz      (frames - 1) / duration_s
    nominal_hz   the firmware's frame rate (100 on v16+, 50 before); the
                 nominal period P = 1 / nominal_hz
    gaps         consecutive rows further apart than 1.5 P (LATE frames: a
                 frame that runs late is caught up by the next one, so a gap
                 is sampling jitter, not necessarily a lost frame)
    dropped      frames actually MISSING: round(duration_s / P) + 1 - frames
                 (never negative). [2026-09-29] The first definition summed
                 the periods spanned by every gap and reported 10-12 % dropped
                 for an SD take that had 8 200 of 8 227 expected frames (0.3 %)
    dropped_pct  dropped / (frames + dropped) * 100
    interval_p99_ms  99th percentile of the row-to-row interval
    max_gap_ms   the largest row-to-row interval
    imu_live_pct per IMU, % of rows in which it delivered a valid quaternion
    enc_live     channels with a valid reading in >= 95 % of rows
                 (enc_live_pct: every channel that was ever valid)
    cal_pct      % of rows by body neutral state (calibrated/provisional/none)
    neutral      the neutral in force at the FIRST row: kind, age_s (device
                 seconds from its capture to the take start; negative = the
                 neutral was captured during the take), spread_deg (largest
                 hand/forearm deviation in the hold, when known), status
    pos_source_pct % of rows whose position came from the headset (`vision`,
                 a fresh AR wrist pose), else from the arm model with the
                 inertial elbow active (`arm+inertial`), else `arm`
    latency_ms   bridge-internal pose-lane latency (tx - rx: S-line received
                 -> pose message handed to the socket) over the take: median,
                 p95, n. None when no client subscribed to the pose lane.
    timing       qage_ms per IMU (age of the orientation at frame start),
                 enc_ms (encoder sweep duration) and rx_jitter_ms (receive
                 time minus device time, relative to its minimum over the
                 take: the USB/serial delivery jitter), each median/p95
    grade        good / fair / poor (see `issues` for why):
                 poor  dropped_pct > 5, or hand/forearm live < 90 %, or no
                       neutral in > 50 % of rows
                 fair  dropped_pct > 1, max_gap_ms > 100, hand/forearm live
                       < 99 %, or the body neutral is not a real (device or
                       bridge) calibration for >= 50 % of rows
                 good  otherwise
    """

    def __init__(self, nominal_hz=None, clock="t_ms"):
        self.nominal_hz = nominal_hz
        self.clock = clock
        self.frames = 0
        self.dup = 0
        self.t_first = None
        self.t_last = None
        self.dt_hist = Hist(0.0, 1000.0, 0.1)          # ms: row-to-row intervals
        self._long = []                                # intervals >= 1 s, exact (rare)
        self._gaps = 0                                 # exact counts when nominal_hz is known
        self._dropped = 0
        self.max_gap_ms = 0.0
        self.imu_live = {k: 0 for k in IMU_KEYS}
        self.enc_live = [0] * 14
        self.cal = {0: 0, 1: 0, 2: 0}
        self.pos = {"arm": 0, "arm+inertial": 0, "vision": 0}
        self.qage = {k: Hist(0.0, 100.0, 0.05) for k in IMU_KEYS}   # ms
        self.enc_ms = Hist(0.0, 20.0, 0.01)                          # ms
        self.rx_off = Hist(-2000.0, 2000.0, 0.05)                    # ms, relative to the first
        self._rx0 = None
        self.latency = Hist(0.0, 500.0, 0.02)                        # ms
        self.neutral = None

    def set_neutral(self, info):
        if self.neutral is None:
            self.neutral = info

    def add(self, t_dev_us, imu_live=None, enc_ok=None, cal=0, pos_src="arm",
            qage_us=None, enc_us=None, rx_ms=None):
        if t_dev_us is None:
            return
        if self.t_last is not None and t_dev_us <= self.t_last:
            self.dup += 1
            return
        if self.t_last is not None:
            dt = (t_dev_us - self.t_last) / 1000.0
            if dt >= 1000.0:
                if len(self._long) < 100000:
                    self._long.append(dt)
            else:
                self.dt_hist.add(dt)
            if dt > self.max_gap_ms:
                self.max_gap_ms = dt
            if self.nominal_hz:
                per = 1000.0 / self.nominal_hz
                if dt > 1.5 * per:
                    self._gaps += 1
                    self._dropped += max(0, int(math.floor(dt / per + 0.5)) - 1)
        else:
            self.t_first = t_dev_us
        self.t_last = t_dev_us
        self.frames += 1
        for k in IMU_KEYS:
            if imu_live and imu_live.get(k):
                self.imu_live[k] += 1
        if enc_ok:
            for ch, ok in enumerate(enc_ok[:14]):
                if ok:
                    self.enc_live[ch] += 1
        self.cal[cal if cal in (0, 1, 2) else 0] += 1
        self.pos[pos_src if pos_src in self.pos else "arm"] += 1
        if qage_us:
            for k in IMU_KEYS:
                a = qage_us.get(k)
                if a:                       # 0 = no quaternion yet (not an age)
                    self.qage[k].add(a / 1000.0)
        if enc_us:
            self.enc_ms.add(enc_us / 1000.0)
        if rx_ms is not None:
            off = rx_ms - t_dev_us / 1000.0
            if self._rx0 is None:
                self._rx0 = off
            self.rx_off.add(off - self._rx0)

    def add_latency(self, ms):
        self.latency.add(ms)

    def _nominal(self):
        if self.nominal_hz:
            return float(self.nominal_hz)
        med = self.dt_hist.pct(50)
        return 1000.0 / med if med else None

    def finish(self):
        n = self.frames
        span = ((self.t_last - self.t_first) / 1e6) if (n > 1) else 0.0
        nom = self._nominal()
        dropped = gaps = 0
        if self.nominal_hz:
            dropped, gaps = self._dropped, self._gaps
        elif nom and n > 1:
            per = 1000.0 / nom
            # counted from the interval histogram (0.1 ms bins, bounded
            # memory) plus the exact list of intervals >= 1 s
            for i, c in enumerate(self.dt_hist.bins):
                if not c:
                    continue
                dt = self.dt_hist.lo + (i + 0.5) * self.dt_hist.width
                if dt > 1.5 * per:
                    gaps += c
                    dropped += c * max(0, int(math.floor(dt / per + 0.5)) - 1)
            for dt in self._long:
                if dt > 1.5 * per:
                    gaps += 1
                    dropped += max(0, int(math.floor(dt / per + 0.5)) - 1)
        if nom and n > 1 and span > 0:          # missing frames = expected - present
            dropped = max(0, int(round(span * nom)) + 1 - n)
        p99 = None
        tot = sum(self.dt_hist.bins) + len(self._long)
        if tot:
            want, acc = 0.99 * tot, 0
            for i, c in enumerate(self.dt_hist.bins):
                acc += c
                if acc >= want:
                    p99 = round(self.dt_hist.lo + (i + 1) * self.dt_hist.width, 2)
                    break
            if p99 is None and self._long:
                p99 = round(sorted(self._long)[max(0, int(0.99 * tot) - sum(self.dt_hist.bins))], 2)
        pct = lambda c: round(100.0 * c / n, 2) if n else 0.0
        enc_live = [ch for ch, c in enumerate(self.enc_live) if n and c >= 0.95 * n]
        enc_pct = {str(ch): pct(c) for ch, c in enumerate(self.enc_live) if c}
        imu_pct = {k: pct(self.imu_live[k]) for k in IMU_KEYS}
        cal_pct = {"calibrated": pct(self.cal[2]), "provisional": pct(self.cal[1]), "none": pct(self.cal[0])}
        pos_pct = {k: pct(v) for k, v in self.pos.items()}
        rx = None
        if self.rx_off.n:
            lo = self.rx_off.vmin
            rx = {"median": round(self.rx_off.pct(50) - lo, 2), "p95": round(self.rx_off.pct(95) - lo, 2),
                  "max": round(self.rx_off.vmax - lo, 2)}
        dropped_pct = round(100.0 * dropped / (n + dropped), 3) if (n + dropped) else 0.0
        q = {
            "version": QUALITY_VERSION,
            "frames": n,
            "duration_s": round(span, 3),
            "rate_hz": round((n - 1) / span, 2) if span > 0 else None,
            "nominal_hz": round(nom, 2) if nom else None,
            "clock": self.clock,
            "dropped": int(dropped),
            "dropped_pct": dropped_pct,
            "gaps": int(gaps),
            "max_gap_ms": round(self.max_gap_ms, 2),
            "interval_p99_ms": p99,
            "dup": self.dup,
            "imu_live_pct": imu_pct,
            "enc_live": enc_live,
            "enc_live_pct": enc_pct,
            "cal_pct": cal_pct,
            "neutral": self.neutral or {"kind": "none", "status": "none", "age_s": None, "spread_deg": None},
            "pos_source_pct": pos_pct,
            "latency_ms": self.latency.summary(nd=3),
            "timing": {
                "qage_ms": {k: self.qage[k].summary(nd=2) for k in IMU_KEYS},
                "enc_ms": self.enc_ms.summary(nd=3),
                "rx_jitter_ms": rx,
            },
        }
        issues = []
        main_live = min(imu_pct["hand"], imu_pct["forearm"])
        real_cal = cal_pct["calibrated"]
        if dropped_pct > 5:
            issues.append("%.1f %% of frames dropped" % dropped_pct)
        if main_live < 90:
            issues.append("hand/forearm IMU live only %.0f %%" % main_live)
        if cal_pct["none"] > 50:
            issues.append("no body neutral for %.0f %% of the take" % cal_pct["none"])
        grade = "poor" if issues else None
        if grade is None:
            if dropped_pct > 1:
                issues.append("%.1f %% of frames dropped" % dropped_pct)
            if self.max_gap_ms > 100:
                issues.append("a %.0f ms gap" % self.max_gap_ms)
            if main_live < 99:
                issues.append("hand/forearm IMU live %.1f %%" % main_live)
            if real_cal < 50:
                issues.append("body neutral provisional or missing")
            grade = "fair" if issues else "good"
        q["grade"] = grade
        q["issues"] = issues
        return q


def neutral_info(neutral, t_first_s, spread=None):
    """The quality.neutral block from a BodyModel.neutral dict (or None)."""
    if neutral is None:
        return {"kind": "none", "status": "none", "age_s": None, "spread_deg": None}
    sp = spread if spread is not None else neutral.get("spread")
    worst = None
    if isinstance(sp, dict):
        vals = [v for k, v in sp.items() if k in ("hand", "forearm") and v is not None]
        worst = round(max(vals), 2) if vals else None
    age = None
    if neutral.get("t") is not None and t_first_s is not None:
        age = round(t_first_s - float(neutral["t"]), 2)
    return {"kind": neutral.get("kind"), "status": "provisional" if neutral.get("provisional") else "calibrated",
            "age_s": age, "spread_deg": worst}


# ---------------------------------------------------------------------------
# the raw device stream sidecar
# ---------------------------------------------------------------------------
class RawWriter:
    """`<take>.raw.txt.gz`: every S/E line the bridge received while the take
    was recording, byte for byte, prefixed by its receive time:

        #takto-raw v1
        #meta {"take": ..., "provenance": {...}, "neutral": {...}, "state0": {...}, "preroll": N}
        <rx_ms>\\t<device line>
        <rx_ms>\\t#N,<a|b>,<t_dev_s>,<kind>,<provisional 0|1>,<hq w,x,y,z>,<fq 4>,<tq 4 or empty>

    rx_ms is the bridge's wall clock (ms since the Unix epoch, 0.1 ms). The
    first `preroll` data lines are the second BEFORE the take (warm-up for
    re-derivation: filters, stillness timers); they are not take rows. `#N`
    lines are bridge annotations, in stream order: the body neutral changed
    (any source: device, console, provisional), with the averaged raw
    quaternions it was solved from (phase: see neutral_line). `#end` closes
    a complete file; a file without it was cut off (bridge killed) and is
    still readable up to the damage."""

    def __init__(self, path, meta):
        self.path = path
        self.f = gzip.open(path, "wt", compresslevel=5, encoding="utf-8", newline="\n")
        self.lines = 0
        self.f.write("#" + RAW_FORMAT + "\n")
        self.f.write("#meta " + json.dumps(meta, separators=(",", ":")) + "\n")

    def write(self, rx_s, line):
        self.f.write("%.1f\t%s\n" % (rx_s * 1000.0, line))
        self.lines += 1

    def close(self, end=None):
        try:
            self.f.write("#end " + json.dumps(end or {}, separators=(",", ":")) + "\n")
            self.f.close()
        except Exception:
            pass
        try:
            return os.path.getsize(self.path)
        except OSError:
            return None


def is_raw_stream(first_line):
    s = (first_line or "").strip()
    return s.startswith("#" + RAW_FORMAT) or s.startswith("#takto-raw")


def open_text(path):
    """A take file as text lines: .gz transparently, a truncated gzip (bridge
    killed mid-take) yields every line up to the damage."""
    if path.endswith(".gz"):
        return _gz_lines(path)
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read().splitlines()


def _gz_lines(path):
    out = []
    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            for ln in f:
                out.append(ln.rstrip("\n"))
    except (EOFError, OSError, gzip.BadGzipFile):
        # incomplete stream: the last partial line may be cut, drop it
        if out and not out[-1]:
            out.pop()
    return out


def iter_lines(path):
    """A take file's lines, streamed (.gz transparently). A truncated gzip
    (bridge killed mid-take) yields every complete line up to the damage."""
    if not path.endswith(".gz"):
        with open(path, encoding="utf-8", errors="replace") as f:
            for ln in f:
                yield ln.rstrip("\n").rstrip("\r")
        return
    prev = None
    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            for ln in f:
                if prev is not None:
                    yield prev.rstrip("\n")
                prev = ln
    except (EOFError, OSError, gzip.BadGzipFile):
        # the last line read before the damage may be cut: keep it only if whole
        if prev is not None and prev.endswith("\n"):
            yield prev.rstrip("\n")
        return
    if prev is not None:
        yield prev.rstrip("\n")


class RawStream:
    """A raw sidecar read lazily: `meta` (the header), then `items()` yields
    (rx_ms, line) in order without holding the stream in memory; `complete`
    turns True when the #end line is reached."""

    def __init__(self, lines):
        self._it = iter(lines)
        self.meta = {}
        self.complete = False
        self._first = None
        for ln in self._it:
            if not ln:
                continue
            if ln.startswith("#meta "):
                try:
                    self.meta = json.loads(ln[6:])
                except ValueError:
                    self.meta = {}
                continue
            if ln.startswith("#") and not ln.startswith("#end"):
                continue
            self._first = ln
            break

    def _item(self, ln):
        if not ln:
            return None
        if ln.startswith("#end"):
            self.complete = True
            return None
        if ln.startswith("#"):
            return None
        rx, sep, line = ln.partition("\t")
        if not sep:
            return None
        try:
            return (float(rx), line)
        except ValueError:
            return None

    def items(self):
        if self._first is not None:
            it = self._item(self._first)
            self._first = None
            if it is not None:
                yield it
        for ln in self._it:
            it = self._item(ln)
            if it is not None:
                yield it


def read_raw(lines):
    """Parse a raw sidecar: {"meta": {...}, "items": [(rx_ms, line)], "complete": bool}."""
    meta, items, complete = {}, [], False
    for ln in lines:
        if not ln:
            continue
        if ln.startswith("#meta "):
            try:
                meta = json.loads(ln[6:])
            except ValueError:
                meta = {}
            continue
        if ln.startswith("#end"):
            complete = True
            continue
        if ln.startswith("#"):
            continue
        rx, sep, line = ln.partition("\t")
        if not sep:
            continue
        try:
            rxv = float(rx)
        except ValueError:
            continue
        items.append((rxv, line))
    return {"meta": meta, "items": items, "complete": complete}


def neutral_line(phase, t_dev_s, kind, provisional, q0):
    """The `#N` annotation for a body-neutral change (see RawWriter).
    phase "b": the change happened between frames (apply before the next
    S-line); "a": it happened inside the preceding S-line's model update
    (apply right after that frame's update, before its row)."""
    def q4(k):
        q = (q0 or {}).get(k)
        return ",".join("%.6f" % v for v in q) if q is not None else ",,,"
    return "#N,%s,%.6f,%s,%d,%s,%s,%s" % (phase, t_dev_s if t_dev_s is not None else 0.0,
                                          kind or "bridge", 1 if provisional else 0,
                                          q4("hand"), q4("forearm"), q4("thumb"))


def parse_neutral_line(line):
    p = line.split(",")
    if len(p) < 17 or p[0] != "#N" or p[1] not in ("a", "b"):
        return None
    try:
        t = float(p[2])
    except ValueError:
        return None

    def q(i):
        try:
            v = [float(x) for x in p[i:i + 4]]
        except ValueError:
            return None
        return v if len(v) == 4 else None
    return {"phase": p[1], "t": t, "kind": p[3], "provisional": p[4] == "1",
            "q0": {"hand": q(5), "forearm": q(9), "thumb": q(13)}}


# ---------------------------------------------------------------------------
# rows
# ---------------------------------------------------------------------------
# raw/timing columns appended to every take row (MOTION_PIPELINE.md s.8)
RAW_COLS = (["t_us", "h_qage_us", "f_qage_us", "t_qage_us", "enc_us", "rx_ms"]
            + ["enc_raw_%02d" % ch for ch in range(14)]
            + ["hq_raw_w", "hq_raw_x", "hq_raw_y", "hq_raw_z",
               "fq_raw_w", "fq_raw_x", "fq_raw_y", "fq_raw_z",
               "tq_raw_w", "tq_raw_x", "tq_raw_y", "tq_raw_z"])


def iter_take_rows(path):
    """(cols, row iterator, extra) of a take-data file without loading it whole
    when it was written one row per line (every file from this version on);
    older single-line files fall back to json.load."""
    f = open(path, encoding="utf-8")
    head = f.readline()
    if head.rstrip().endswith('"rows":['):
        hdr = json.loads(head.rstrip() + "]}")

        def gen():
            try:
                for ln in f:
                    s = ln.strip()
                    if not s:
                        continue
                    if s.startswith("]"):
                        break
                    if s.endswith(","):
                        s = s[:-1]
                    yield json.loads(s)
            finally:
                f.close()
        return hdr.get("cols") or [], gen(), hdr
    f.close()
    with open(path, encoding="utf-8") as g:
        d = json.load(g)
    return d.get("cols") or [], iter(d.get("rows") or []), d


D2R = math.pi / 180.0
_JOINT_NAMES = []
for _f in ("index", "middle", "ring", "pinky"):
    _JOINT_NAMES += [("%s_mcp" % _f, "%s_mcp_abd_rad" % _f, "%s MCP abduction (+ radial splay)" % _f),
                     ("%s_pip" % _f, "%s_mcp_flex_rad" % _f, "%s MCP flexion (+ flexion)" % _f),
                     ("%s_dip" % _f, "%s_pip_flex_rad" % _f, "%s PIP flexion (+ flexion)" % _f)]


def _spec():
    """(source column, output column, unit, scale, description). The output
    CSV has exactly these columns, in this order; `t_s`/`t_dev_s` are computed."""
    s = [("__t", "t_s", "s", None, "time since the first row of the take (device clock)"),
         ("__tdev", "t_dev_s", "s", None, "device time since boot, from t_us (unwrapped) or t_ms"),
         ("t_ms", "t_dev_ms", "ms", 1.0, "device millis() at the frame (as streamed; integer)")]
    for src, out, desc in _JOINT_NAMES:
        s.append((src, out, "rad", D2R, desc + "; encoder (or headset vision, see take.json joint_source)"))
    for pre, what in (("hq", "hand"), ("fq", "forearm")):
        for c in "wxyz":
            s.append(("%s_%s" % (pre, c), "legacy_%s_%s" % (pre, c), "1",
                      1.0, "legacy display quaternion of the %s (tared, twin frame)" % what))
    for c in "wxyz":
        s.append(("tq_%s" % c, "legacy_tq_%s" % c, "1", 1.0, "thumb-tip IMU in the hand frame (legacy display)"))
    s += [("blend", "blend", "1", 1.0, "assist/transparency blend 0..1 (UI or crown)"),
          ("act", "act", "1", 1.0, "EMG activation 0..1 (live only; 0 when re-derived offline)")]
    for c in "xyz":
        s.append(("p%s" % c, "vision_wrist_%s_m" % c, "m", 1.0, "headset-tracked wrist position (room frame), empty when not tracked"))
    for c in "wxyz":
        s.append(("pq_%s" % c, "vision_wrist_q%s" % c, "1", 1.0, "headset-tracked wrist orientation (room frame)"))
    for src, out in (("thumb_abd", "vision_thumb_abd_rad"), ("thumb_mcp", "vision_thumb_mcp_flex_rad"),
                     ("thumb_ip", "vision_thumb_ip_flex_rad")):
        s.append((src, out, "rad", D2R, "thumb angle from the headset's hand tracking"))
    for src, out, what in (("ihx", "inertial_hand_x_m", "hand"), ("ihy", "inertial_hand_y_m", "hand"),
                           ("ihz", "inertial_hand_z_m", "hand"), ("ifx", "inertial_forearm_x_m", "forearm"),
                           ("ify", "inertial_forearm_y_m", "forearm"), ("ifz", "inertial_forearm_z_m", "forearm")):
        s.append((src, out, "m", 0.001, "legacy strapdown displacement of the %s IMU (its own Z-up world; drifts)" % what))
    s.append(("i_conf", "inertial_conf", "1", 1.0, "confidence of the legacy strapdown displacement"))
    for src, out, what in (("b_ex", "elbow_x_m", "elbow"), ("b_ey", "elbow_y_m", "elbow"), ("b_ez", "elbow_z_m", "elbow"),
                           ("b_wx", "wrist_x_m", "wrist"), ("b_wy", "wrist_y_m", "wrist"), ("b_wz", "wrist_z_m", "wrist")):
        s.append((src, out, "m", 1.0, "%s position, body frame (+Y up, +Z forward, origin shoulder)" % what))
    for pre, what in (("b_fq", "forearm"), ("b_hq", "hand")):
        for c in "wxyz":
            s.append(("%s_%s" % (pre, c), "%s_q%s" % (what, c), "1", 1.0,
                      "%s segment orientation, body frame (Hamilton, body <- segment)" % what))
    s.append(("b_cal", "body_cal", "1", 1.0, "body neutral: 0 none, 1 provisional, 2 calibrated"))
    s += [("t_us", "t_us", "us", 1.0, "device micros() at frame start, as streamed (32-bit, wraps at 2^32)"),
          ("h_qage_us", "hand_qage_s", "s", 1e-6, "age of the hand orientation at frame start (sample time = frame time - age)"),
          ("f_qage_us", "forearm_qage_s", "s", 1e-6, "age of the forearm orientation at frame start"),
          ("t_qage_us", "thumb_qage_s", "s", 1e-6, "age of the thumb orientation at frame start"),
          ("enc_us", "enc_sweep_s", "s", 1e-6, "duration of the encoder sweep (channels sampled in order over [t, t + sweep])"),
          ("rx_ms", "rx_unix_s", "s", 0.001, "bridge receive time of the frame (Unix epoch; empty for SD takes)")]
    for ch in range(14):
        s.append(("enc_raw_%02d" % ch, "enc_raw_%02d_rad" % ch, "rad", D2R,
                  "encoder channel %d, unfiltered AS5600 angle (empty = absent)" % ch))
    for pre, what in (("hq", "hand"), ("fq", "forearm"), ("tq", "thumb")):
        for c in "wxyz":
            s.append(("%s_raw_%s" % (pre, c), "%s_raw_q%s" % (what, c), "1", 1.0,
                      "raw game rotation vector of the %s IMU (W_s <- S, Z up, per-boot heading)" % what))
    return s


RESEARCH_SPEC = _spec()
RESEARCH_COLUMNS = [{"name": o, "unit": u, "source": (None if src.startswith("__") else src),
                     "description": d} for src, o, u, _sc, d in RESEARCH_SPEC]


def _fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        if not math.isfinite(v):
            return ""
        r = "%.9g" % v
        return r
    return str(v)


def research_row_fn(cols):
    """A function row -> list of output cells, for take rows with columns `cols`."""
    ci = {c: i for i, c in enumerate(cols)}
    t_ms_i, t_us_i = ci.get("t_ms"), ci.get("t_us")
    plan = []
    for src, out, unit, sc, _d in RESEARCH_SPEC:
        if src.startswith("__"):
            plan.append((src, None, None))
        else:
            plan.append((src, ci.get(src), sc))
    state = {"t0": None}

    def fn(r):
        t_ms = r[t_ms_i] if t_ms_i is not None else None
        t_us = r[t_us_i] if (t_us_i is not None and t_us_i < len(r)) else None
        tdev = unwrap_us(t_ms, t_us)
        tdev_s = tdev / 1e6 if tdev is not None else None
        if state["t0"] is None and tdev_s is not None:
            state["t0"] = tdev_s
        out = []
        for src, i, sc in plan:
            if src == "__t":
                out.append(_fmt(round(tdev_s - state["t0"], 6)) if tdev_s is not None else "")
                continue
            if src == "__tdev":
                out.append(_fmt(round(tdev_s, 6)) if tdev_s is not None else "")
                continue
            v = r[i] if (i is not None and i < len(r)) else None
            if v is None:
                out.append("")
                continue
            if src.startswith("enc_raw_") and v < 0:
                out.append("")
                continue
            if src == "t_ms" or src == "t_us":
                out.append(str(int(v)))
                continue
            if sc is not None and sc != 1.0 and isinstance(v, (int, float)):
                v = float(v) * sc
            out.append(_fmt(v))
        return out
    return fn


def write_research_csv(cols, rows, out):
    """Rows (take-data layout `cols`) -> the research take.csv on the text
    stream `out`. Returns the number of rows written."""
    out.write(",".join(o for _s, o, _u, _sc, _d in RESEARCH_SPEC) + "\n")
    fn = research_row_fn(cols)
    n = 0
    for r in rows:
        out.write(",".join(fn(r)) + "\n")
        n += 1
    return n


def take_json(meta, provenance=None, quality=None, raw_name=None, csv_name="take.csv"):
    """The research package's take.json."""
    return {
        "format": "takto-research-take v1",
        "take": {k: v for k, v in (meta or {}).items() if k not in ("spark", "provenance")},
        "quality": quality if quality is not None else (meta or {}).get("quality"),
        "provenance": provenance if provenance is not None else (meta or {}).get("provenance"),
        "files": {"csv": csv_name, "raw": raw_name},
        "units": "SI: s, m, rad; quaternions [w,x,y,z] unitless, Hamilton",
        "frames": {
            "body": "+Y up, +Z forward (forearm heading at the neutral), +X left; origin shoulder (MOTION_PIPELINE.md s.2)",
            "sensor_world": "per IMU: Z up, heading arbitrary per device boot (game rotation vector)",
        },
        "columns": RESEARCH_COLUMNS,
        "raw_format": ("gzip text, one line per received device line: <rx_ms>\\t<line>; "
                       "#meta holds provenance, the neutral in force and the model state at the "
                       "first row; #N lines are neutral changes; re-derive with "
                       "software/bridge/rederive.py"),
    }
