"""analysis.py - from recorded rows to numbers a reader can check.

Inputs are the take's own files (track.csv from the second tracking pass,
device.csv, events.csv, follow.csv). Everything here is deterministic and
re-runnable; nothing is read from the live session.

Conventions
  angles       flexion in degrees, 0 = straight, after zeroing on the take's
               own rest phase (median of the last second of it), the same
               operation for the camera and for the encoders
  time         seconds from GO (the first countdown's end), on the shared
               monotonic clock
  filtering    zero-phase Savitzky-Golay (window 11 frames, order 3) for
               the presented angle traces; velocity is its derivative; peaks
               are read from the filtered trace so the numbers are not
               jitter, and the raw trace is kept beside it
  onset        the first sample where |velocity| exceeds 30 deg/s for three
               consecutive samples; used to align two takes so both videos
               start moving at the same instant
  lag          the shift that maximises the cross-correlation of two traces,
               reported in ms; positive means the second trails the first

What each protocol yields
  bare/worn    per block: range of motion (p95-p5), peak angular speed (p95 of
               |velocity|), cycles, mean cycle period; worn also gets the
               camera-vs-encoder RMSE and lag, and the twin reconstruction
               accuracy = 1 - RMSE / ROM
  bare vs worn "x % slower" = 1 - peak speed worn / peak speed bare, in the
               fast block; also the ROM retained
  follow       target-vs-actual RMSE, the follower's lag statistics, share of
               poses reached
  assisted     per target: time from GO to settle (within 4 deg for 300 ms)
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

try:
    from scipy.signal import savgol_filter, find_peaks
except Exception:   # pragma: no cover - scipy is in requirements
    savgol_filter = None
    find_peaks = None

SG_WINDOW = 11
SG_ORDER = 3
ONSET_DEG_S = 30.0
ONSET_RUN = 3
SETTLE_TOL_DEG = 4.0
SETTLE_HOLD_S = 0.3


def _sg(x: np.ndarray) -> np.ndarray:
    if savgol_filter is None or len(x) < SG_WINDOW:
        return x.copy()
    x = np.asarray(x, float)
    ok = np.isfinite(x)
    if ok.sum() < SG_WINDOW:
        return x.copy()
    y = x.copy()
    # interpolate over short gaps so the filter sees a continuous trace
    idx = np.arange(len(x))
    y[~ok] = np.interp(idx[~ok], idx[ok], x[ok])
    return savgol_filter(y, SG_WINDOW, SG_ORDER)


def velocity(t: np.ndarray, x: np.ndarray) -> np.ndarray:
    if len(t) < 2:
        return np.zeros_like(x)
    return np.gradient(x, t)


def onset_time(t: np.ndarray, v: np.ndarray, thresh=ONSET_DEG_S, run=ONSET_RUN) -> float | None:
    a = np.abs(v) > thresh
    for i in range(len(a) - run + 1):
        if a[i:i + run].all():
            return float(t[i])
    return None


REST_STILL_DEG = 5.0


def zero_on_rest(x: np.ndarray, t: np.ndarray, rest_t0: float, rest_t1: float) -> tuple[np.ndarray, float, str]:
    """Subtract "straight". Straight is the median over the last second of the
    rest window, provided the finger was actually still there (spread under
    REST_STILL_DEG); a rest that was not a rest is not trusted, and the
    2nd percentile of the whole take is used instead. Returns the zeroed
    trace, the offset and which rule produced it."""
    lo = max(rest_t0, rest_t1 - 1.0)
    m = (t >= lo) & (t <= rest_t1) & np.isfinite(x)
    if m.sum() >= 3 and float(np.nanpercentile(x[m], 90) - np.nanpercentile(x[m], 10)) <= REST_STILL_DEG:
        return x - float(np.median(x[m])), float(np.median(x[m])), "rest_median"
    ok = np.isfinite(x)
    if ok.sum() >= 10:
        off = float(np.nanpercentile(x[ok], 2))
        return x - off, off, "take_p2_rest_not_still"
    return x, 0.0, "none"


def cycles(t: np.ndarray, x: np.ndarray, min_amp_deg=15.0):
    """peaks of a flex-extend trace: count and mean period"""
    if find_peaks is None or len(x) < 5:
        return 0, float("nan")
    rng = np.nanpercentile(x, 95) - np.nanpercentile(x, 5)
    if not np.isfinite(rng) or rng < min_amp_deg:
        return 0, float("nan")
    fs = 1.0 / max(1e-3, float(np.median(np.diff(t))))
    pk, _ = find_peaks(np.nan_to_num(x, nan=np.nanmin(x)), prominence=rng * 0.35, distance=max(1, int(0.2 * fs)))
    if len(pk) < 2:
        return int(len(pk)), float("nan")
    return int(len(pk)), float(np.mean(np.diff(t[pk])))


def lag_ms(t: np.ndarray, a: np.ndarray, b: np.ndarray, max_lag_s=1.0) -> float:
    """resample both on a common grid, cross-correlate; positive = b trails a"""
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 20:
        return float("nan")
    dt = 0.01
    grid = np.arange(t[ok].min(), t[ok].max(), dt)
    if len(grid) < 50:
        return float("nan")
    ga = np.interp(grid, t[ok], a[ok]); gb = np.interp(grid, t[ok], b[ok])
    ga -= ga.mean(); gb -= gb.mean()
    if ga.std() < 1e-6 or gb.std() < 1e-6:
        return float("nan")
    n = int(max_lag_s / dt)
    best, best_k = -np.inf, 0
    for k in range(-n, n + 1):
        if k >= 0:
            c = np.dot(ga[:len(ga) - k], gb[k:]) if k < len(ga) else -np.inf
        else:
            c = np.dot(ga[-k:], gb[:len(gb) + k])
        if c > best:
            best, best_k = c, k
    return best_k * dt * 1000.0


def block_metrics(t: np.ndarray, x_filt: np.ndarray) -> dict:
    v = velocity(t, x_filt)
    ok = np.isfinite(x_filt)
    if ok.sum() < 5:
        return {"samples": int(ok.sum())}
    n_cyc, period = cycles(t[ok], x_filt[ok])
    return {
        "samples": int(ok.sum()),
        "rom_deg": float(np.nanpercentile(x_filt, 95) - np.nanpercentile(x_filt, 5)),
        "peak_speed_deg_s": float(np.nanpercentile(np.abs(v[ok]), 95)),
        "mean_speed_deg_s": float(np.nanmean(np.abs(v[ok]))),
        "cycles": n_cyc,
        "cycle_period_s": period,
        "cycle_hz": (1.0 / period) if period == period and period > 0 else float("nan"),
        "max_deg": float(np.nanmax(x_filt)), "min_deg": float(np.nanmin(x_filt)),
    }


def rmse(a: np.ndarray, b: np.ndarray) -> float:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 3:
        return float("nan")
    return float(np.sqrt(np.mean((a[ok] - b[ok]) ** 2)))


def settle_time(t: np.ndarray, x: np.ndarray, target: float, t_go: float, tol=SETTLE_TOL_DEG, hold=SETTLE_HOLD_S) -> float | None:
    """first time after t_go from which |x - target| stays within tol for hold seconds"""
    m = t >= t_go
    tt, xx = t[m], x[m]
    inside = np.abs(xx - target) <= tol
    start = None
    for i in range(len(tt)):
        if inside[i] and np.isfinite(xx[i]):
            if start is None:
                start = i
            if tt[i] - tt[start] >= hold:
                return float(tt[start] - t_go)
        else:
            start = None
    return None


def compare_speed(bare: dict, worn: dict) -> dict:
    """the one number for the video: how much slower the worn finger is"""
    out = {}
    for block in ("comfortable", "fast"):
        b, w = bare.get(block, {}), worn.get(block, {})
        pb, pw = b.get("peak_speed_deg_s"), w.get("peak_speed_deg_s")
        rb, rw = b.get("rom_deg"), w.get("rom_deg")
        if pb and pw and pb > 0:
            out[f"{block}_slower_pct"] = 100.0 * (1.0 - pw / pb)
        if rb and rw and rb > 0:
            out[f"{block}_rom_retained_pct"] = 100.0 * rw / rb
        hb, hw = b.get("cycle_hz"), w.get("cycle_hz")
        if hb and hw and hb == hb and hw == hw and hb > 0:
            out[f"{block}_cadence_ratio"] = hw / hb
    return out
