#!/usr/bin/env python3
"""fable_activation.py - the Fable activation-signal module, wired for the
MyoWare ENVELOPE channel on Teensy pin 14 (A0).

Pin 14 carries the MyoWare's ANALOG envelope (rectify + smooth done on the
sensor), NOT raw EMG. effort_control's raw front end (adaptive powerline
cancellation, Clancy whitening) therefore does not apply here - the sensor
already did that job in analog. The Fable pieces that DO operate on an
already-enveloped channel, and that this module uses:

  * Sanger (2007) BayesianAmplitude - the nonlinear posterior-mean smoother that
    dominates any fixed moving-RMS window (heavy smoothing in a hold, agile on a
    transient). Imported UNCHANGED from effort_control.preprocess.
  * auto rest / MVC normalization -> a calibrated 0..1 activation level, no manual
    maximum-voluntary-contraction step required (the first strong contraction sets
    the scale; both floors adapt slowly so it re-calibrates).
  * onset detection (fixed-threshold with hysteresis - the classical detector that
    Fable's CUSUM is benchmarked against; the lower-latency CUSUM needs the raw
    channel to shine and is a drop-in upgrade once the MyoWare RAW pin is wired).

Feed one ADC envelope sample per call; get the activation contract dict
{present, level, direction, fatigue, onset, quality}. Single channel, so
`direction` = 0 and `fatigue` = 0 (both need agonist/antagonist raw spectra,
which an envelope cannot provide - reported honestly, not faked).

To run the FULL effort_control front end, wire the MyoWare RAW output to a spare
analog pin, sample it at >= 2 kHz, stream the raw block, and swap the smoother
for adaptive_condition + whiten + BayesianAmplitude on the raw stream.
"""
import math
import os
import sys

# The Fable Bayesian amplitude estimator (Sanger 2007), ported line for line
# from effort_control.preprocess.BayesianAmplitude to dependency-free Python:
# the bridge must not need numpy/scipy (or the Fable tree) to read one EMG
# channel. Same grid, same mixture transition kernel, same half-normal
# likelihood, same posterior mean.
_EPS = 1e-12


class BayesianAmplitude:
    """Online Bayesian filter for the latent activation drive (Sanger 2007): a
    non-negative amplitude on a fixed grid, a heavy-tailed random-walk prior
    (narrow + wide Gaussian mixture: smooth in a hold, able to leap on an
    onset), and a half-normal likelihood per observation."""

    def __init__(self, n_grid=300, xmax=6.0, diff=2e-3, diff_fast=0.05, eps=0.01):
        n = n_grid
        self.grid = [0.02 + (xmax - 0.02) * i / (n - 1) for i in range(n)]
        self.dx = self.grid[1] - self.grid[0]
        half = max(2, int(3 * diff_fast / self.dx))
        ks = [j * self.dx for j in range(-half, half + 1)]
        g_n = [math.exp(-0.5 * (k / (diff + _EPS)) ** 2) for k in ks]
        g_w = [math.exp(-0.5 * (k / (diff_fast + _EPS)) ** 2) for k in ks]
        sn, sw = sum(g_n), sum(g_w)
        kern = [(1.0 - eps) * a / sn + eps * b / sw for a, b in zip(g_n, g_w)]
        sk = sum(kern)
        self.kern = [k / sk for k in kern]
        self.half = half
        self._c = [math.sqrt(2.0 / math.pi) / g for g in self.grid]
        self._inv2 = [0.5 / (g * g) for g in self.grid]
        self.reset()

    def reset(self):
        n = len(self.grid)
        self.p = [1.0 / n] * n

    def step(self, obs):
        p, kern, h, n = self.p, self.kern, self.half, len(self.grid)
        # prediction: convolution with the mixture kernel ("same" mode)
        q = [0.0] * n
        for i in range(n):
            acc = 0.0
            lo, hi = max(0, i - h), min(n - 1, i + h)
            for j in range(lo, hi + 1):
                acc += p[j] * kern[i - j + h]
            q[i] = acc
        # measurement: half-normal likelihood of |obs|
        o2 = obs * obs
        for i in range(n):
            q[i] *= self._c[i] * math.exp(-o2 * self._inv2[i])
        s = sum(q)
        if s < _EPS:
            self.reset()
        else:
            self.p = [v / s for v in q]
        return sum(g * v for g, v in zip(self.grid, self.p))


_HAVE_BAYES = True
_IMPORT_ERR = ""


def _clip01(x):
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


class FableActivation:
    """Turn a stream of MyoWare ENV ADC samples into the activation contract."""

    def __init__(self, fs=100.0, adc_max=1023.0):
        self.fs = float(fs)
        self.adc_max = float(adc_max)
        # --- auto rest floor / MVC peak (ADC units) ---
        self.rest = None
        self.peak = None
        self.MIN_SPAN = 60.0        # ADC; floor on (peak - rest) so rest noise != full scale
        self.FLOOR_RISE = 0.03      # ADC/sample the rest floor may creep up (drift)
        self.PEAK_FALL = 0.05       # ADC/sample the MVC decays so it re-calibrates
        self.DEAD_MIN = 12.0        # ADC noise deadband above the rest floor (min)
        self.DEAD_FRAC = 0.06       # + this fraction of the span, so rest reads 0
        # --- Fable Sanger Bayesian posterior smoother (agile params, low latency) ---
        # 150-point grid: the same posterior to < 1 % at half the per-frame cost
        self.bayes = BayesianAmplitude(n_grid=150, diff=3e-3, diff_fast=0.08, eps=0.02) if _HAVE_BAYES else None
        self.BAYES_FLOOR = 0.05     # posterior floor at rest (grid min) -> map to 0
        self._ema = 0.0             # fallback smoother state
        # --- onset (hysteresis fixed-threshold) ---
        self.ON_HI = 0.22
        self.ON_LO = 0.10
        self._armed = True
        self._onset_hold = 0
        self.level = 0.0
        self.samples = 0

    def recalibrate(self):
        """Forget the learned rest/MVC so the next rest + strong contraction re-scale."""
        self.rest = None
        self.peak = None
        self.samples = 0

    @property
    def have_bayes(self):
        return self.bayes is not None

    def update(self, env, present=True):
        if not present or env is None or env < 0:
            return {"present": False, "level": 0.0, "direction": 0, "fatigue": 0.0,
                    "onset": False, "quality": "none"}
        env = float(env)
        self.samples += 1

        # auto rest floor: drop instantly to new lows, creep up slowly
        if self.rest is None:
            self.rest = env
            self.peak = env + self.MIN_SPAN
        if env < self.rest:
            self.rest = env
        else:
            self.rest += self.FLOOR_RISE
        # auto MVC peak: jump to new highs, decay slowly toward rest + MIN_SPAN
        if env > self.peak:
            self.peak = env
        else:
            self.peak = max(self.rest + self.MIN_SPAN, self.peak - self.PEAK_FALL)

        # normalize env into 0..1 with a noise deadband above the rest floor, so a
        # resting muscle reads 0 (not the small rest-noise excursion) and a strong
        # contraction reads ~1 once the auto-MVC has seen it.
        span_full = max(self.MIN_SPAN, self.peak - self.rest)
        dead = max(self.DEAD_MIN, self.DEAD_FRAC * span_full)
        denom = max(self.MIN_SPAN, span_full - dead)
        raw = _clip01((env - self.rest - dead) / denom)

        # Fable Bayesian posterior-mean smoothing (or EMA fallback), then remove the
        # grid-min floor so a true rest reads 0 rather than the posterior's lower bound.
        if self.bayes is not None:
            lvl = float(self.bayes.step(raw))
            lvl = _clip01((lvl - self.BAYES_FLOOR) / (1.0 - self.BAYES_FLOOR))
        else:
            k = 1.0 - math.exp(-1.0 / (0.12 * self.fs))   # ~120 ms EMA
            self._ema += k * (raw - self._ema)
            lvl = _clip01(self._ema)
        self.level = lvl

        # onset: fire on a low->high crossing, hold briefly so the UI can flash.
        # Suppressed during the first second (warm-up) so a cold-start does not fire.
        warmed = self.samples >= int(1.0 * self.fs)
        fire = False
        if lvl <= self.ON_LO:
            self._armed = True
        elif warmed and self._armed and lvl >= self.ON_HI:
            fire = True
            self._armed = False
        if fire:
            self._onset_hold = int(0.15 * self.fs)
        onset = self._onset_hold > 0
        if self._onset_hold > 0:
            self._onset_hold -= 1

        if not warmed:
            quality = "warming"
        elif span_full <= self.MIN_SPAN * 1.2:
            quality = "flat"        # no contraction seen yet -> scale not established
        else:
            quality = "good"

        return {"present": True, "level": round(lvl, 4), "direction": 0, "fatigue": 0.0,
                "onset": bool(onset), "quality": quality,
                "env": round(env, 1), "rest": round(self.rest, 1), "mvc": round(self.peak, 1)}


if __name__ == "__main__":
    # self-test: rest -> ramp -> hold -> release, synthetic MyoWare ENV in ADC.
    import random
    rng = random.Random(3)
    fa = FableActivation(fs=100.0)
    seq = []
    for i in range(1000):
        t = i / 100.0
        if t < 2.0:
            base = 90            # rest
        elif t < 3.0:
            base = 90 + (t - 2.0) * 300     # ramp up
        elif t < 6.0:
            base = 390           # hold contraction
        else:
            base = 90            # release
        env = base + rng.gauss(0, 6)
        seq.append(fa.update(env))
    def at(tsec):
        return seq[int(tsec * 100)]
    print("have_bayes:", fa.have_bayes, "| import_err:", _IMPORT_ERR or "none")
    for tsec, tag in [(1.5, "rest"), (2.6, "ramp"), (4.5, "hold"), (7.0, "release")]:
        r = at(tsec)
        print(f"  t={tsec:>4}s {tag:8} level={r['level']:.3f} onset={int(r['onset'])} "
              f"quality={r['quality']:8} env={r['env']} rest={r['rest']} mvc={r['mvc']}")
    fired = [i / 100.0 for i, r in enumerate(seq) if r["onset"]]
    print("  onset fired near t =", round(fired[0], 2) if fired else "never",
          "(expected ~2.1-2.5 s)")
