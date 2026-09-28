"""analysis on synthetic traces with known answers"""
import os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
from lab import analysis as A  # noqa: E402


def test_metrics_and_lag():
    fs = 30.0
    t = np.arange(0, 10, 1 / fs)
    # 1.5 Hz flex-extend between 5 and 65 deg, starting after 1.2 s of rest
    x = np.where(t < 1.2, 5.0, 35 + 30 * np.sin(2 * np.pi * 1.5 * (t - 1.2) - np.pi / 2))
    x += np.random.default_rng(1).normal(0, 0.6, len(t))
    xf = A._sg(x)
    m = A.block_metrics(t, xf)
    assert 55 < m["rom_deg"] < 66, m
    assert 11 <= m["cycles"] <= 14, m
    assert abs(m["cycle_hz"] - 1.5) < 0.1, m
    # peak speed of 30*sin(2pi*1.5 t): 30 * 2pi * 1.5 = 283 deg/s
    assert 240 < m["peak_speed_deg_s"] < 300, m
    on = A.onset_time(t, A.velocity(t, xf))
    assert on is not None and 1.1 < on < 1.5, on
    # a delayed copy lags by 120 ms
    y = np.interp(t - 0.12, t, x)
    lag = A.lag_ms(t, x, y)
    assert abs(lag - 120) <= 15, lag
    # settle: a step to 30 deg reached at 0.8 s and held
    z = np.where(t < 2.8, 0.0, 30.0)
    st = A.settle_time(t, z, 30.0, t_go=2.0)
    assert st is not None and abs(st - 0.8) < 0.05, st
    cmp = A.compare_speed({"fast": {"peak_speed_deg_s": 300, "rom_deg": 80, "cycle_hz": 2.0}},
                          {"fast": {"peak_speed_deg_s": 240, "rom_deg": 72, "cycle_hz": 1.6}})
    assert abs(cmp["fast_slower_pct"] - 20) < 1e-9 and abs(cmp["fast_rom_retained_pct"] - 90) < 1e-9
    print("analysis:", {k: round(v, 2) if isinstance(v, float) else v for k, v in m.items()}, "onset", round(on, 2), "lag", lag)


if __name__ == "__main__":
    test_metrics_and_lag(); print("ANALYSIS OK")
