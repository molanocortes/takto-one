"""The EMG activation module (MyoWare envelope on pin 14): the ported Fable
Bayesian amplitude filter and the auto rest/MVC normalization."""
import random

from fable_activation import FableActivation, BayesianAmplitude


def test_rest_contraction_release_at_100hz():
    rng = random.Random(3)
    fa = FableActivation(fs=100.0)
    out = []
    for i in range(1000):
        t = i / 100.0
        base = 90 if t < 2.0 else (90 + (t - 2.0) * 300 if t < 3.0 else (390 if t < 6.0 else 90))
        out.append(fa.update(base + rng.gauss(0, 6)))
    assert out[450]["level"] > 0.9                    # holding a contraction
    assert out[700]["level"] < 0.05                   # released
    fired = [i / 100.0 for i, r in enumerate(out) if r["onset"]]
    assert fired and 2.0 <= fired[0] <= 2.6           # onset on the ramp, not at rest
    assert out[700]["quality"] == "good"


def test_bayes_posterior_tracks_a_step():
    b = BayesianAmplitude(n_grid=150, diff=3e-3, diff_fast=0.08, eps=0.02)
    rng = random.Random(1)
    lo = [b.step(abs(rng.gauss(0, 0.1))) for _ in range(200)][-1]
    hi = [b.step(abs(rng.gauss(0, 1.0))) for _ in range(200)][-1]
    assert lo < 0.3 and 0.7 < hi < 1.4


def test_absent_is_honest():
    assert FableActivation().update(None)["present"] is False
