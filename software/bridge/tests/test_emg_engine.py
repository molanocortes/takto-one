"""The sEMG engine (firmware v19 features -> activation contract) against
synthetic signals with a known truth."""
import math
import random

import pytest

from emg_engine import EmgEngine, FS


def frame(rng, amp, raw=True, mdf=95.0, line=3.0, sat=0):
    """One v19 frame of features: RAW RMS = amp (mV) with 6 % frame noise."""
    a = max(0.0, amp * (1.0 + rng.gauss(0, 0.06)))
    return {"present": True, "raw_present": raw, "raw_rms_mv": a if raw else None,
            "env_mv": 20.0 + 150.0 * amp + rng.gauss(0, 0.3), "env_sd_mv": 0.4,
            "mnf_hz": mdf + 16, "mdf_hz": mdf, "line50_pct": line, "sat": sat, "n": 20}


REST, MVC = 0.012, 0.60          # mV RAW RMS: a quiet forearm and a hard squeeze


def run_calibration(eng, rng, peak=MVC):
    eng.start_calibration()
    out = []
    for i in range(int(22 * FS)):
        c = eng._cal_status()
        amp = peak if c.get("phase") == "squeeze" and c.get("remaining_s", 0) < 2.6 else REST
        out.append(eng.update(frame(rng, amp)))
        if eng._calrun is None:
            break
    return out


def test_guided_mvc_calibration():
    rng = random.Random(1)
    eng = EmgEngine()
    run_calibration(eng, rng)
    ev = [r for k, r in eng.pop_events() if k == "emg_cal"]
    assert [e["phase"] for e in ev][0] == "rest" and ev[-1]["phase"] == "done", ev
    assert eng.cal["mvc_mv"] == pytest.approx(MVC, rel=0.05)
    assert eng.cal["rest_mv"] == pytest.approx(REST, rel=0.1)
    assert eng.cal["snr_db"] > 30


def test_level_is_percent_of_mvc_and_rest_reads_zero():
    rng = random.Random(2)
    eng = EmgEngine()
    run_calibration(eng, rng)
    for _ in range(int(3 * FS)):
        r = eng.update(frame(rng, REST))
    assert r["level"] < 0.02 and r["calibrated"] and r["quality"] == "good"
    for _ in range(int(2 * FS)):
        r = eng.update(frame(rng, 0.5 * MVC))
    assert r["pct_mvc"] == pytest.approx(50, abs=8)


def test_onset_fast_and_no_false_alarm_at_rest():
    rng = random.Random(3)
    eng = EmgEngine()
    run_calibration(eng, rng)
    onsets = 0
    for _ in range(int(20 * FS)):                   # 20 s of rest
        onsets += eng.update(frame(rng, REST))["onset"]
    assert onsets == 0
    first = None
    for i in range(int(2 * FS)):                    # a 20 % MVC contraction
        r = eng.update(frame(rng, 0.2 * MVC))
        if r["onset"] and first is None:
            first = i / FS
    assert first is not None and first < 0.06       # detected within 60 ms
    for _ in range(int(1 * FS)):
        r = eng.update(frame(rng, REST))
    assert r["active"] is False                     # and released


def test_fatigue_from_median_frequency_drop():
    rng = random.Random(4)
    eng = EmgEngine()
    run_calibration(eng, rng)
    for _ in range(int(2 * FS)):
        eng.update(frame(rng, REST))
    for i in range(int(30 * FS)):                   # 30 s at 60 % MVC, MDF 100 -> 78 Hz
        r = eng.update(frame(rng, 0.6 * MVC, mdf=100.0 - 22.0 * i / (30 * FS)))
        if i == int(3 * FS):
            early = r["fatigue"]
    assert r["fatigue_available"] and early < 0.15 and r["fatigue"] > 0.7


def test_quality_flags():
    rng = random.Random(5)
    eng = EmgEngine()
    for _ in range(int(2 * FS)):
        r = eng.update(frame(rng, REST, line=70.0))
    assert "poor contact" in r["quality"] and r["sqi"] < 0.5
    for _ in range(10):
        r = eng.update(frame(rng, MVC, sat=3))
    assert r["sqi"] < 1.0
    eng2 = EmgEngine()
    flat = {"present": True, "raw_present": False, "env_mv": 20.0, "env_sd_mv": 0.0}
    for _ in range(int(3 * FS)):
        r = eng2.update(flat)
    assert r["quality"] == "flat signal"
    assert EmgEngine().update({"present": False})["present"] is False


def test_envelope_only_path():
    """ENV wired, RAW not: amplitude from the envelope, fatigue honestly unavailable."""
    rng = random.Random(6)
    eng = EmgEngine()
    for i in range(int(8 * FS)):
        amp = MVC if 3 * FS < i < 5 * FS else REST
        r = eng.update(frame(rng, amp, raw=False))
        if i == int(4.5 * FS):
            held = r
    assert held["source"] == "env" and held["level"] > 0.6 and held["fatigue_available"] is False
    assert r["level"] < 0.1


def test_uncalibrated_rest_reads_zero_not_noise():
    """[BENCH 2026-09-30] ENV resting at 20.6 mV +- 0.3: the automatic scale
    stretched that noise to 57 %. Before any contraction it must read 0."""
    rng = random.Random(7)
    eng = EmgEngine()
    for _ in range(int(10 * FS)):
        r = eng.update({"present": True, "raw_present": False, "env_mv": 20.6 + rng.gauss(0, 0.3),
                        "env_sd_mv": 0.3, "sat": 0})
    assert r["level"] < 0.02 and r["quality"] == "no contraction yet"
