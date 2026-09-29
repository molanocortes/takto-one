"""emg_engine.py - surface-EMG activation, research grade (firmware v19).

The device (firmware/takto_one/emg.h) samples the MyoWare 2.0 at 2 kHz on
two channels - ENV (analog envelope, pin 14) and, when wired, RAW (pin 15) -
band-passes RAW 20-450 Hz with 50/100 Hz notches, and sends per 10 ms frame:
RMS / MAV / waveform length / zero crossings of RAW, the ENV mean and SD,
the 50 Hz share of the band (Goertzel, before the notches), a clipping count,
and the mean / median frequency of a 256-point spectrum. This module turns
that into the activation contract every surface draws.

What makes it more than a threshold on an envelope:

* AMPLITUDE: RAW RMS when RAW is wired (the true band-limited EMG), else
  the ENV mean. Both in mV at the pin.
* NORMALIZATION to a measured MVC, per SENIAM: a guided calibration (rest
  3 s, then three maximal contractions of 3 s with 3 s rests) gives the rest
  level and noise (median, robust SD) and the MVC as the highest 500 ms
  moving mean. Until then, an automatic rest floor / peak tracker stands in
  and the output says `calibrated: false`.
* SMOOTHING: Sanger's (2007) Bayesian amplitude posterior on the normalized
  amplitude (the Fable estimator, fable_activation.BayesianAmplitude): smooth
  during a hold, agile on a transient - it Pareto-dominates fixed windows.
* ONSET: Page's CUSUM on the standardized log energy (the minimum-expected-
  delay detector for a given false-alarm rate), with an offset CUSUM for the
  release, so `active` has hysteresis in time, not just in level.
* FATIGUE: the median frequency falls as a sustained contraction fatigues
  (conduction velocity drops). During contraction the MDF is tracked against
  the MDF at the start of the contraction bout; a 25 % drop is full scale.
  RAW only - an envelope has no spectrum - and reported as unavailable, not 0.
* SIGNAL QUALITY: presence (pulled-down pins: an open input reads 0), mains
  pickup (a lifted electrode is an antenna: 50 Hz share of the band), clipping,
  a flat line, and after calibration the SNR (MVC over rest noise, dB). One
  0..1 index plus the reason.
"""
import math
import statistics

from fable_activation import BayesianAmplitude

FS = 100.0                           # frames per second (firmware v16+)
# Smallest span the AUTOMATIC scale may stretch to full range before any real
# contraction has been seen: rest noise must never read as effort. A MyoWare
# 2.0 envelope rests at ~20 mV and reaches 1-3 V on a strong squeeze; RAW RMS
# rests near its noise floor. (A guided calibration replaces both.)
AUTO_MIN_SPAN_MV = {"env": 80.0, "raw": 0.05}
MV_PER_COUNT10 = 3300.0 / 1023.0     # v3..v18 ENV fields are 10-bit counts


def _clip(x, lo=0.0, hi=1.0):
    return lo if x < lo else (hi if x > hi else x)


class EmgEngine:
    CAL_REST_S = 3.0
    CAL_SQUEEZE_S = 3.0
    CAL_RELAX_S = 3.0
    CAL_REPS = 3

    def __init__(self, cal=None):
        self.bayes = BayesianAmplitude(n_grid=150, diff=3e-3, diff_fast=0.08, eps=0.02)
        self.cal = dict(cal) if isinstance(cal, dict) and cal.get("mvc_mv") else None
        self.reset_auto()
        self._calrun = None
        self._src = "env"
        self.events = []

    def reset_auto(self):
        self.auto_rest = None
        self.auto_peak = None
        self.n = 0
        self._log_hist = []                  # rest log-energy samples (onset stats)
        self._mu0 = None
        self._sd0 = None
        self._S_on = 0.0
        self._S_off = 0.0
        self.active = False
        self._onset_hold = 0
        self._mdf0 = None
        self._mdf_ema = None
        self._bout_frames = 0
        self._flat_frames = 0
        self._amp_prev = None
        self.level = 0.0

    # ---------------- guided MVC calibration ----------------
    def start_calibration(self):
        self._calrun = {"phase": "rest", "t": 0.0, "rep": 0, "rest": [], "mvc": [], "win": []}
        self.events.append(("emg_cal", self._cal_status()))
        return self._cal_status()

    def cancel_calibration(self):
        self._calrun = None

    def _cal_status(self):
        c = self._calrun
        if c is None:
            return {"phase": "idle"}
        dur = {"rest": self.CAL_REST_S, "squeeze": self.CAL_SQUEEZE_S, "relax": self.CAL_RELAX_S}[c["phase"]]
        return {"phase": c["phase"], "rep": c["rep"] + (1 if c["phase"] != "rest" else 0),
                "reps": self.CAL_REPS, "remaining_s": round(max(0.0, dur - c["t"]), 1)}

    def _cal_step(self, amp, dt):
        c = self._calrun
        c["t"] += dt
        if c["phase"] == "rest":
            if c["t"] > 0.5:                           # settle
                c["rest"].append(amp)
            if c["t"] >= self.CAL_REST_S:
                c.update(phase="squeeze", t=0.0, win=[])
                self.events.append(("emg_cal", self._cal_status()))
        elif c["phase"] == "squeeze":
            c["win"].append(amp)
            if c["t"] >= self.CAL_SQUEEZE_S:
                # the highest 500 ms moving mean of this contraction (SENIAM MVC)
                w = int(0.5 * FS)
                a = c["win"]
                best = max((sum(a[i:i + w]) / w for i in range(0, max(1, len(a) - w + 1))), default=0.0)
                c["mvc"].append(best)
                c["rep"] += 1
                if c["rep"] >= self.CAL_REPS:
                    self._cal_finish()
                    return
                c.update(phase="relax", t=0.0)
                self.events.append(("emg_cal", self._cal_status()))
        elif c["phase"] == "relax":
            if c["t"] >= self.CAL_RELAX_S:
                c.update(phase="squeeze", t=0.0, win=[])
                self.events.append(("emg_cal", self._cal_status()))

    def _cal_finish(self):
        c = self._calrun
        self._calrun = None
        rest = c["rest"]
        if len(rest) < 10 or not c["mvc"]:
            self.events.append(("emg_cal", {"phase": "failed", "reason": "no signal during the calibration"}))
            return
        med = statistics.median(rest)
        mad = statistics.median(abs(x - med) for x in rest) * 1.4826 or 1e-4
        mvc = max(c["mvc"])
        snr_db = 20.0 * math.log10(max(1e-6, (mvc - med)) / mad)
        if mvc - med < 6.0 * mad:
            self.events.append(("emg_cal", {"phase": "failed", "snr_db": round(snr_db, 1),
                                            "reason": "the contractions were not above the rest noise "
                                                      "(check the electrodes and squeeze harder)"}))
            return
        spread = (max(c["mvc"]) - min(c["mvc"])) / mvc if mvc > 0 else 1.0
        self.cal = {"rest_mv": round(med, 5), "noise_mv": round(mad, 5), "mvc_mv": round(mvc, 5),
                    "snr_db": round(snr_db, 1), "reps_mv": [round(x, 5) for x in c["mvc"]],
                    "rep_spread": round(spread, 3), "source": self._src}
        self.reset_auto()
        self.events.append(("emg_cal", dict({"phase": "done"}, **self.cal)))

    # ---------------- per frame ----------------
    def update(self, e):
        """e: {"present", "raw_present", "env_mv", "env_sd_mv", "raw_rms_mv",
        "mnf_hz", "mdf_hz", "line50_pct", "sat", "n"} (v19), or the legacy
        {"present", "env_mv"} from a v3..v18 firmware."""
        dt = 1.0 / FS
        if not e or not e.get("present"):
            self._amp_prev = None
            return {"present": False, "level": 0.0, "direction": 0, "fatigue": 0.0,
                    "onset": False, "quality": "none", "sqi": 0.0}
        raw = bool(e.get("raw_present")) and e.get("raw_rms_mv") is not None
        self._src = "raw" if raw else "env"
        amp = float(e["raw_rms_mv"] if raw else e["env_mv"])
        if self.cal and self.cal.get("source") and self.cal["source"] != self._src:
            self.cal = None                  # the wiring changed: that MVC no longer applies
        self.n += 1
        if self._calrun is not None:
            self._cal_step(amp, dt)

        # ---- rest / MVC: calibrated, else automatic trackers ----
        if self.auto_rest is None:
            self.auto_rest, self.auto_peak = amp, amp
        # rest floor: follows new lows at once, creeps up slowly (drift)
        self.auto_rest = amp if amp < self.auto_rest else self.auto_rest + (amp - self.auto_rest) * 0.0005
        self.auto_peak = amp if amp > self.auto_peak else self.auto_peak - (self.auto_peak - self.auto_rest) * 0.0003
        min_span = max(AUTO_MIN_SPAN_MV[self._src], 3.0 * self.auto_rest if self._src == "raw" else 0.0)
        seen_contraction = self.auto_peak - self.auto_rest >= min_span
        if self.cal:
            rest, mvc, noise = self.cal["rest_mv"], self.cal["mvc_mv"], self.cal["noise_mv"]
        else:
            rest, mvc = self.auto_rest, max(self.auto_peak, self.auto_rest + min_span)
            noise = None
        span = max(1e-6, mvc - rest)
        # a noise deadband so rest reads 0: 3 robust SDs when calibrated, else 4 % of the span
        dead = 3.0 * noise if noise else 0.04 * span
        u = _clip((amp - rest - dead) / max(1e-6, span - dead), 0.0, 1.5)

        # ---- Sanger Bayesian smoothing (the posterior lives on 0..6) ----
        lvl = self.bayes.step(u)
        lvl = _clip((lvl - 0.05) / 0.95, 0.0, 1.5)
        self.level = lvl

        # ---- onset / offset: CUSUM on the standardized log energy ----
        le = math.log(max(amp, 1e-5) ** 2)
        if not self.active and u < 0.05:
            self._log_hist.append(le)
            if len(self._log_hist) > int(3 * FS):
                self._log_hist.pop(0)
            if len(self._log_hist) >= 30:
                self._mu0 = statistics.fmean(self._log_hist)
                self._sd0 = max(0.05, statistics.pstdev(self._log_hist))
        onset = False
        if self._mu0 is not None:
            z = (le - self._mu0) / self._sd0
            if not self.active:
                self._S_on = max(0.0, self._S_on + z - 1.2)
                if self._S_on > 10.0 and u > 0.03:
                    self.active, onset = True, True
                    self._S_on, self._S_off = 0.0, 0.0
                    self._onset_hold = int(0.15 * FS)
            else:
                self._S_off = max(0.0, self._S_off + (1.5 - z))
                if self._S_off > 10.0 or u < 0.01:
                    self.active = False
                    self._S_off = 0.0
        if self._onset_hold > 0:
            self._onset_hold -= 1

        # ---- fatigue: median-frequency drop within a contraction bout ----
        fatigue, fat_ok = 0.0, False
        mdf = e.get("mdf_hz")
        if raw and mdf and self.active and u > 0.15:
            self._bout_frames += 1
            self._mdf_ema = mdf if self._mdf_ema is None else self._mdf_ema + (mdf - self._mdf_ema) * 0.05
            if self._bout_frames == int(1.0 * FS):
                self._mdf0 = self._mdf_ema          # the fresh-muscle reference, 1 s into the bout
            if self._mdf0:
                fatigue = _clip((self._mdf0 - self._mdf_ema) / self._mdf0 / 0.25)
                fat_ok = True
        elif not self.active:
            self._bout_frames = 0
            self._mdf_ema = None
            self._mdf0 = None

        # ---- signal quality ----
        reasons = []
        sqi = 1.0
        line = e.get("line50_pct")
        if raw and line is not None:
            if line > 50:
                sqi *= 0.3; reasons.append("poor contact (mains %.0f %%)" % line)
            elif line > 20:
                sqi *= 0.7; reasons.append("mains pickup %.0f %%" % line)
        if (e.get("sat") or 0) > 0:
            sqi *= 0.6; reasons.append("clipping")
        sd = e.get("raw_rms_mv") if raw else e.get("env_sd_mv")
        if self._amp_prev is not None and abs(amp - self._amp_prev) < 1e-6 and (sd is not None and sd < 1e-4):
            self._flat_frames += 1
        else:
            self._flat_frames = 0
        self._amp_prev = amp
        if self._flat_frames > FS:
            sqi *= 0.2; reasons.append("flat signal")
        snr_db = self.cal["snr_db"] if self.cal else None
        if snr_db is not None and snr_db < 20:
            sqi *= 0.7; reasons.append("low SNR %.0f dB" % snr_db)
        warmed = self.n > FS
        if not warmed:
            quality = "warming"
        elif reasons:
            quality = reasons[0]
        elif not self.cal and not seen_contraction:
            quality = "no contraction yet"    # scale not established: squeeze once, or calibrate
        else:
            quality = "good"
        r = lambda v, d=4: None if v is None else round(float(v), d)
        return {"present": True, "level": round(_clip(lvl), 4), "pct_mvc": round(lvl * 100.0, 1),
                "direction": 0, "fatigue": round(fatigue, 3), "fatigue_available": fat_ok,
                "onset": self._onset_hold > 0, "active": self.active,
                "quality": quality, "sqi": round(sqi, 2), "source": self._src,
                "calibrated": bool(self.cal), "amp_mv": r(amp), "rest_mv": r(rest), "mvc_mv": r(mvc),
                "snr_db": snr_db, "mdf_hz": r(mdf, 1), "mnf_hz": r(e.get("mnf_hz"), 1),
                "line50_pct": r(line, 1), "cal": self._cal_status(),
                # legacy keys (v18 surfaces)
                "env": r(e.get("env_mv"), 2), "rest": r(rest), "mvc": r(mvc)}

    def pop_events(self):
        ev, self.events = self.events, []
        return ev
