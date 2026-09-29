"""Unit tests for motion.py against the synthetic ground truth in motion_synth.py.

Every scenario synthesizes RAW sensor data (game quaternions with arbitrary
per-sensor heading references and heading drift, perturbed mountings, gyro
with bias/noise, gravity-free acceleration with bias, noise AND the fusion's
gravity leak, firmware-style dv, stability classes) from a known arm, runs it
through a BodyModel exactly as the bridge does, and compares with the truth.

Run with -s to see the error numbers the thesis text can quote.
"""
import math
import random

import pytest

from motion import (BodyModel, C_WB, IDENTITY, X_AXIS, Y_AXIS, Z_AXIS, mounting_prior,
                    qmul, qconj, qnorm, qrot, qx, qy, qaxis_angle, qangle_between,
                    qaverage, qfrom_mat, wrist_angles, wrist_quat,
                    soft_limit_wrist, vlen, vsub, remap_matrix, solve_neutral, principal_axis)
from motion_synth import Arm, Sensors, perturb, elbow_only, shoulder_motion, still, Pose

# The bridge's bench-calibrated mounting config (IMU_CFG_DEFAULT in teensy_bridge.py)
BENCH_CFG = {
    "hand": {"remap": [[-1, "x"], [-1, "z"], [-1, "y"]], "offset": [1.0, 0.0, 0.0, 0.0]},
    "forearm": {"remap": [[1, "y"], [1, "z"], [1, "x"]], "offset": [1.0, 0.0, 0.0, 0.0]},
    "thumb": {"remap": [[1, "x"], [1, "y"], [1, "z"]], "offset": [1.0, 0.0, 0.0, 0.0]},
}
PRIORS = {k: mounting_prior(v) for k, v in BENCH_CFG.items()}
D = math.degrees


def close_q(a, b, deg=1e-6):
    return math.degrees(qangle_between(a, b)) <= deg


# --------------------------------------------------------------------------
# math foundations
# --------------------------------------------------------------------------
def test_c_is_zup_to_yup():
    # contract: (x, y, z)_W -> (x, z, -y)_B
    for v in ([1, 2, 3], [0, 0, 1], [0.3, -0.2, 0.9]):
        r = qrot(C_WB, v)
        assert r == pytest.approx([v[0], v[2], -v[1]], abs=1e-12)


def test_quaternion_kit_roundtrips():
    rng = random.Random(0)
    for _ in range(50):
        q = qnorm([rng.gauss(0, 1) for _ in range(4)])
        v = [rng.gauss(0, 1) for _ in range(3)]
        # q^-1 q = I, rotation preserves length, matrix round trip
        assert close_q(qmul(qconj(q), q), IDENTITY, 1e-9)
        assert vlen(qrot(q, v)) == pytest.approx(vlen(v), rel=1e-12)
        cols = [qrot(q, X_AXIS), qrot(q, Y_AXIS), qrot(q, Z_AXIS)]
        m = [[cols[j][i] for j in range(3)] for i in range(3)]
        assert close_q(qfrom_mat(m), q, 1e-7)
    # averaging tolerates the double cover
    base = qnorm([0.3, 0.5, -0.2, 0.7])
    qs = [qnorm(qmul(base, qaxis_angle([1, 2, 3], math.radians(d)))) for d in (-1, 0, 1)]
    qs[1] = [-c for c in qs[1]]
    assert close_q(qaverage(qs), base, 1e-6)


def test_wrist_decomposition_roundtrip_and_signs():
    rng = random.Random(1)
    for _ in range(200):
        f, d, t = (math.radians(rng.uniform(-80, 80)), math.radians(rng.uniform(-40, 40)),
                   math.radians(rng.uniform(-60, 60)))
        f2, d2, t2 = wrist_angles(wrist_quat(f, d, t))
        assert (f2, d2, t2) == pytest.approx((f, d, t), abs=1e-9)
    # + flexion sends the fingers palm-ward (-Y); + deviation toward the thumb (+X)
    assert qrot(wrist_quat(math.radians(30), 0, 0), Z_AXIS)[1] < 0
    assert qrot(wrist_quat(0, math.radians(15), 0), Z_AXIS)[0] > 0


def test_soft_limit_is_display_only_and_monotonic():
    prev = -1e9
    for f in range(-120, 121, 5):
        f2, _, _, _ = soft_limit_wrist(float(f), 0.0, 0.0)
        assert f2 >= prev - 1e-9
        prev = f2
        assert -70.0 - 1e-6 <= f2 <= 80.0 + 1e-6
    f2, d2, _, lim = soft_limit_wrist(30.0, 5.0, 0.0)
    assert (f2, d2, lim) == (30.0, 5.0, False)
    # ulnar has more range than radial (anatomy): -30 survives, +30 does not
    assert soft_limit_wrist(0.0, -30.0, 0.0)[1] < -25.0
    assert soft_limit_wrist(0.0, 30.0, 0.0)[1] <= 20.0


# --------------------------------------------------------------------------
# mounting priors: M = R^-1 * offset reproduces the legacy pipeline
# --------------------------------------------------------------------------
def _legacy_display(q0, q, cfg):
    """The bridge's legacy stages, verbatim in meaning: remap (signed
    permutation of the vector part), right-multiply by offset, tare = inverse
    of the same at the tare pose, left-multiplied."""
    def remap(qq):
        v = {"x": qq[1], "y": qq[2], "z": qq[3]}
        return [qq[0]] + [s * v[a] for (s, a) in cfg["remap"]]
    off = cfg["offset"]
    tare = qconj(qmul(remap(q0), off))
    return qmul(tare, qmul(remap(q), off))


@pytest.mark.parametrize("key", ["hand", "forearm", "thumb"])
@pytest.mark.parametrize("offset", [[1, 0, 0, 0], [0, 0, 1, 0], [0.7071068, 0.7071068, 0, 0]])
def test_mounting_prior_matches_legacy_pipeline(key, offset):
    cfg = dict(BENCH_CFG[key], offset=offset)
    m = mounting_prior(cfg)
    rng = random.Random(2)
    for _ in range(40):
        q0 = qnorm([rng.gauss(0, 1) for _ in range(4)])
        q = qnorm([rng.gauss(0, 1) for _ in range(4)])
        legacy = _legacy_display(q0, q, cfg)
        model = qmul(qmul(qconj(m), qmul(qconj(q0), q)), m)       # M^-1 (q0^-1 q) M
        assert close_q(legacy, model, 1e-6)
    # remap really is conjugation by the permutation's rotation
    assert abs(sum(remap_matrix(cfg["remap"])[i][i] for i in range(3))) <= 3


def test_mounting_direction_convention_segment_frame():
    """Direction check with a physical meaning: if a sensor is truly mounted
    with M (S <- segment), the legacy display equals the segment's rotation
    since the tare EXPRESSED IN SEGMENT AXES, which is what the twin renders."""
    arm = Arm()
    heading = {"hand": 0.7, "forearm": -2.1, "thumb": 1.3}
    s = Sensors(arm, elbow_only, PRIORS, heading, noise=False)
    t0, t1 = 2.0, 7.3
    for key in ("hand", "forearm"):
        q0, q1 = s.raw_quat(key, t0), s.raw_quat(key, t1)
        seg0, seg1 = s.truth(t0)["q"][key], s.truth(t1)["q"][key]
        local = qmul(qconj(seg0), seg1)
        assert close_q(_legacy_display(q0, q1, BENCH_CFG[key]), local, 1e-5)
    # and the prior itself: the hand's distal axis is sensor -Y, the forearm's +X
    assert qrot(PRIORS["hand"], Z_AXIS) == pytest.approx([0, -1, 0], abs=1e-9)
    assert qrot(PRIORS["forearm"], Z_AXIS) == pytest.approx([1, 0, 0], abs=1e-9)


# --------------------------------------------------------------------------
# a runner: synth -> BodyModel, neutral at t=2.5 s, error stats vs truth
# --------------------------------------------------------------------------
def run(fn, T=30.0, pert=2.0, seed=3, noise=True, cfg=None, wrist_axis=None,
        neutral_at=2.5, sensor_kw=None, true_mount=None, on_frame=None):
    rng = random.Random(seed)
    tm = true_mount or {k: perturb(PRIORS[k], pert, rng) for k in PRIORS}
    heading = {k: rng.uniform(-math.pi, math.pi) for k in PRIORS}
    s = Sensors(Arm(), fn, tm, heading, seed=seed, noise=noise, **(sensor_kw or {}))
    bm = BodyModel(PRIORS, cfg=cfg, wrist_axis=wrist_axis)
    bm.auto_neutral = False
    st = {"flex": 0.0, "dev": 0.0, "pro": 0.0, "qf": 0.0, "qh": 0.0, "wrist": 0.0,
          "wrist_sum": 0.0, "n": 0, "elbow": 0.0}
    t, dt = 0.0, 0.01
    while t < T - 1e-9:
        t = round(t + dt, 6)
        bm.update(s.frame(t, dt))
        if neutral_at is not None and abs(t - neutral_at) < 1e-9:
            res = bm.capture_neutral(t_end=t, kind="test")
            assert res["ok"], res
        if on_frame:
            on_frame(t, bm, s)
        if neutral_at is not None and t > neutral_at + 0.05:
            tr = s.truth(t)
            b = bm.body()
            p = tr["pose"]
            st["flex"] = max(st["flex"], abs(b["wrist_deg"]["flex"] - D(p.wflex)))
            st["dev"] = max(st["dev"], abs(b["wrist_deg"]["dev"] - D(p.wdev)))
            st["pro"] = max(st["pro"], abs(b["wrist_deg"]["pro"] - D(p.pro)))
            st["qf"] = max(st["qf"], D(qangle_between(b["forearm_quat"], tr["q"]["forearm"])))
            st["qh"] = max(st["qh"], D(qangle_between(b["hand_quat"], tr["q"]["hand"])))
            we = vlen(vsub(b["wrist_m"], tr["pts"]["wrist"]))
            st["wrist"] = max(st["wrist"], we)
            st["elbow"] = max(st["elbow"], vlen(vsub(b["elbow_m"], tr["pts"]["elbow"])))
            st["wrist_sum"] += we
            st["n"] += 1
    st["wrist_mean"] = st["wrist_sum"] / max(1, st["n"])
    return st, bm, s


def fmt(st):
    return ("flex %.2f dev %.2f pro %.2f deg | forearm %.2f hand %.2f deg | "
            "wrist max %.1f mean %.1f cm | elbow max %.1f cm"
            % (st["flex"], st["dev"], st["pro"], st["qf"], st["qh"],
               st["wrist"] * 100, st["wrist_mean"] * 100, st["elbow"] * 100))


# --------------------------------------------------------------------------
# accuracy
# --------------------------------------------------------------------------
@pytest.mark.parametrize("seed", [3, 11])
def test_elbow_only_motion_accuracy(seed):
    """Shoulder still: the jointed arm model is (near) exact, orientation errors
    come only from mounting perturbation, noise and heading drift."""
    for inertial in (False, True):
        st, bm, _ = run(elbow_only, seed=seed, cfg={"inertial": inertial})
        print("\n[elbow-only seed=%d %s] %s" % (seed, "arm+inertial" if inertial else "arm", fmt(st)))
        assert st["flex"] < 3.0 and st["dev"] < 3.0
        assert st["pro"] < 3.0
        assert st["qf"] < 3.0 and st["qh"] < 3.5
        assert st["wrist"] < 0.015                       # 1.5 cm worst case
        assert bm.body()["calibrated"] is True


def test_exact_without_noise():
    st, _, _ = run(elbow_only, pert=0.0, noise=False, cfg={"inertial": False})
    print("\n[elbow-only, no noise, exact mounting] " + fmt(st))
    assert st["flex"] < 0.05 and st["dev"] < 0.05 and st["qf"] < 0.05 and st["qh"] < 0.05
    assert st["wrist"] < 1e-3


@pytest.mark.parametrize("seed", [3, 7])
@pytest.mark.parametrize("dyn_tilt", [0.4, 0.8])
def test_shoulder_motion_inertial_beats_baseline(seed, dyn_tilt):
    kw = {"tilt_err_dyn_deg": dyn_tilt}
    base, _, _ = run(shoulder_motion, seed=seed, cfg={"inertial": False}, sensor_kw=kw)
    iner, bm, _ = run(shoulder_motion, seed=seed, cfg={"inertial": True}, sensor_kw=kw)
    print("\n[shoulder seed=%d tilt %.1f deg/(rad/s)] arm only:     %s" % (seed, dyn_tilt, fmt(base)))
    print("[shoulder seed=%d tilt %.1f deg/(rad/s)] arm+inertial: %s" % (seed, dyn_tilt, fmt(iner)))
    assert iner["wrist"] < 0.70 * base["wrist"]
    assert iner["wrist_mean"] < 0.80 * base["wrist_mean"]
    # orientation does not depend on the position path
    # (large shoulder excursions with a 2 deg unknown mount error: ~3.5 deg)
    assert iner["flex"] < 4.0 and iner["dev"] < 4.0 and iner["qf"] < 3.5


def test_clean_inertial_upper_bound():
    """With only white noise + a learned constant bias (no fusion tilt leak)
    and the deadbands off, the same algorithm tracks the shoulder to ~2 cm:
    the kinematics (w x r removal, sphere projection, ZUPT) are right, and the
    remaining error of the default is the price of the deadbands that keep a
    real BNO085's gravity leak from walking the arm."""
    kw = {"tilt_err_deg": 0.0, "tilt_err_dyn_deg": 0.0}
    loose = {"inertial": True, "acc_deadband": 0.0, "acc_deadband_per_rad_s": 0.0,
             "acc_deadband_v": 0.0, "vel_leak_per_s": 1.0}
    st, _, _ = run(shoulder_motion, cfg=loose, sensor_kw=kw)
    print("\n[shoulder, no tilt leak, deadbands off] " + fmt(st))
    assert st["wrist"] < 0.03


def test_still_60s_no_runaway():
    st, bm, _ = run(still, T=63.0, cfg={"inertial": True})
    print("\n[60 s still, bias + noise + drift] " + fmt(st))
    assert st["wrist"] < 0.01
    assert bm.body()["quality"]["elevation_deg"] < 2.0
    assert bm.body()["quality"]["still"] is True
    assert bm.body()["quality"]["inertial_conf"] == 1.0


def test_wrist_axis_calibration_recovers_a_bad_hand_mount():
    """A 12 deg error in the hand mounting that the neutral cannot see (a tilt
    of the flexion axis) mixes flexion into deviation; 5 s of flex/extend
    measures the real axis and removes it."""
    rng = random.Random(5)
    tm = {k: perturb(PRIORS[k], 1.0, rng) for k in PRIORS}
    tm["hand"] = qnorm(qmul(PRIORS["hand"], qy(math.radians(12.0))))   # yaw of the chip

    def flexing(t):
        p = Pose()
        a = 0.0 if t < 3.0 else 1.0
        p.wflex = a * math.radians(55) * math.sin(2.2 * (t - 3.0))
        return p

    # 1) capture the axis (forearm still on a table, from the flexing motion)
    captured = {}

    def grab(t, bm, s):
        if abs(t - 3.0) < 1e-9:
            bm.start_wrist_axis(5.0)
        for kind, res in bm.pop_events():
            if kind == "wrist_axis":
                captured.update(res)
    run(flexing, T=9.0, true_mount=tm, seed=5, on_frame=grab)
    assert captured.get("ok"), captured
    assert captured["planarity"] > 0.9
    axis = captured["axis_sensor"]
    true_axis = qrot(tm["hand"], X_AXIS)
    assert D(math.acos(max(-1, min(1, sum(axis[i] * true_axis[i] for i in range(3)))))) < 1.5

    # 2) the same bad mount, a real exercise, without and with the axis
    no_cal, _, _ = run(elbow_only, true_mount=tm, seed=5)
    cal, _, _ = run(elbow_only, true_mount=tm, seed=5, wrist_axis=axis)
    print("\n[12 deg hand mount error] no wrist-axis cal: " + fmt(no_cal))
    print("[12 deg hand mount error] wrist-axis cal:    " + fmt(cal))
    assert no_cal["dev"] > 6.0                         # the error is real without it
    assert cal["flex"] < 3.0 and cal["dev"] < 3.0 and cal["qh"] < 3.5


# --------------------------------------------------------------------------
# neutral lifecycle
# --------------------------------------------------------------------------
def test_provisional_then_device_neutral():
    rng = random.Random(9)
    tm = {k: perturb(PRIORS[k], 2.0, rng) for k in PRIORS}
    s = Sensors(Arm(), elbow_only, tm, {k: rng.uniform(-3, 3) for k in PRIORS}, seed=9)
    bm = BodyModel(PRIORS)
    t = 0.0
    seen_prov = None
    for _ in range(250):
        t = round(t + 0.01, 6)
        bm.update(s.frame(t, 0.01))
        b = bm.body()
        if b["provisional"] and seen_prov is None:
            seen_prov = t
    assert seen_prov is not None and 1.5 <= seen_prov <= 1.8        # 1.5 s still
    b = bm.body()
    assert b["provisional"] is True and b["calibrated"] is False
    assert b["pos_source"] == "arm"                 # drift-free arm model by default
    # the device's own averages (E,neutral,done) make it a real neutral
    q_avg = {k: s.raw_quat(k, t) for k in ("hand", "forearm", "thumb")}
    res = bm.request_device_neutral(t, q_avg=q_avg)
    assert res["ok"] and bm.body()["calibrated"] is True and bm.body()["provisional"] is False
    assert bm.body()["quality"]["neutral_kind"] == "device"


def test_reboot_discards_neutral_and_tare_cannot_come_back():
    s = Sensors(Arm(), still, PRIORS, {"hand": 1.0, "forearm": -0.5, "thumb": 0.2}, noise=False)
    bm = BodyModel(PRIORS)
    bm.set_boot(4711)
    t = 0.0
    for _ in range(60):
        t = round(t + 0.01, 6)
        bm.update(s.frame(t, 0.01))
    assert bm.capture_neutral(t_end=t)["ok"]
    rec = bm.export_neutral()
    assert rec["boot_id"] == 4711
    # same boot (a bridge restart): accepted
    bm2 = BodyModel(PRIORS)
    bm2.set_boot(4711)
    assert bm2.import_neutral(rec) is True and bm2.body()["calibrated"]
    # a reboot of the device: the old heading reference is meaningless
    assert bm2.set_boot(9) is True
    assert bm2.body()["calibrated"] is False and bm2.neutral is None
    bm3 = BodyModel(PRIORS)
    bm3.set_boot(9)
    assert bm3.import_neutral(rec) is False
    bm4 = BodyModel(PRIORS)                     # boot unknown (pre-v16 firmware)
    assert bm4.import_neutral(rec) is False
    # provisional neutrals are never exported
    for i in range(10):
        bm3.update(s.frame(0.01 * (i + 1), 0.01))
    assert bm3.capture_neutral(t_end=0.1, provisional=True)["ok"]
    assert bm3.export_neutral() is None


def test_neutral_refused_when_moving_or_vertical():
    s = Sensors(Arm(), elbow_only, PRIORS, {"hand": 0.3, "forearm": 2.0, "thumb": 0.0}, noise=False)
    bm = BodyModel(PRIORS)
    bm.auto_neutral = False
    t = 0.0
    while t < 6.0:
        t = round(t + 0.01, 6)
        bm.update(s.frame(t, 0.01))
    res = bm.capture_neutral(t_end=6.0)               # mid-exercise
    assert res["ok"] is False and "moved" in res["reason"]
    # forearm pointing straight down: no "forward" to define
    q = {"forearm": qmul(qconj(C_WB), qmul(qx(-math.pi / 2), qconj(PRIORS["forearm"]))),
         "hand": [1, 0, 0, 0], "thumb": None}
    with pytest.raises(ValueError):
        solve_neutral(q, PRIORS)


def test_heading_drift_bleeds_when_observable():
    """The hand's game vector drifts 6 deg in heading after the neutral. With
    the forearm upright the drift shows as axial twist, which a wrist cannot
    have, and the bleed removes it with the 30 s time constant; with the
    forearm level it is unobservable and nothing moves (honest)."""
    def upright(t):
        return Pose(sh_flex=math.radians(90) if t > 3.0 else 0.0,
                    elbow=math.radians(90))
    rng = random.Random(4)
    tm = {k: perturb(PRIORS[k], 0.5, rng) for k in PRIORS}
    heading = {"hand": 0.4, "forearm": -1.0, "thumb": 0.0}

    def twist_after(fn, T):
        s = Sensors(Arm(), fn, tm, heading, seed=4, noise=False)
        bm = BodyModel(PRIORS, cfg={"inertial": False, "heading_bleed": True})
        bm.auto_neutral = False
        t = 0.0
        while t < T - 1e-9:
            t = round(t + 0.01, 6)
            if abs(t - 2.6) < 1e-9:
                s.heading0["hand"] += math.radians(6.0)      # the drift, after the neutral
            bm.update(s.frame(t, 0.01))
            if abs(t - 2.5) < 1e-9:
                assert bm.capture_neutral(t_end=t)["ok"]
        return abs(bm.body()["quality"]["twist_deg"]), bm
    tw_up, bm = twist_after(upright, 100.0)
    print("\n[heading drift 6 deg, forearm upright, 97 s] residual twist %.2f deg, bleed %.2f deg"
          % (tw_up, bm.body()["quality"]["heading_bleed_deg"]))
    assert tw_up < 0.3
    assert abs(abs(bm.body()["quality"]["heading_bleed_deg"]) - 6.0) < 0.6


def test_nan_and_zero_quats_are_not_live():
    bm = BodyModel(PRIORS)
    bm.update({"t": 0.01, "q": {"hand": [0, 0, 0, 0], "forearm": [float("nan"), 0, 0, 1],
                                "thumb": None}})
    b = bm.body()
    assert b["live"] is False
    assert all(math.isfinite(v) for v in b["wrist_m"] + b["hand_quat"])


def test_body_block_shape():
    s = Sensors(Arm(), still, PRIORS, {"hand": 1.0, "forearm": -0.5, "thumb": 0.2}, noise=False)
    bm = BodyModel(PRIORS)
    for i in range(200):
        bm.update(s.frame((i + 1) * 0.01, 0.01))
    b = bm.body()
    for key in ("frame", "calibrated", "provisional", "live", "shoulder_m", "elbow_m", "wrist_m",
                "hand_m", "upperarm_quat", "forearm_quat", "hand_quat", "thumb_quat",
                "wrist_deg", "pos_source", "quality"):
        assert key in b
    assert b["frame"] == "body_yup_v1"
    assert set(b["wrist_deg"]) == {"flex", "dev", "pro"}
    for key in ("since_neutral_s", "inertial_conf", "still"):
        assert key in b["quality"]
    assert b["pos_source"] in ("arm", "arm+inertial")
    # neutral pose: elbow below the shoulder, wrist forward of the elbow
    assert b["elbow_m"] == pytest.approx([0, -0.30, 0], abs=0.01)
    assert b["wrist_m"] == pytest.approx([0, -0.30, 0.26], abs=0.01)


def test_principal_axis():
    rng = random.Random(0)
    ax = [0.6, 0.0, 0.8]
    samples = []
    for _ in range(500):
        g = rng.gauss(0, 1)
        samples.append([a * g + rng.gauss(0, 0.02) for a in ax])
    v, planarity = principal_axis(samples, seed=[1, 0, 0])
    assert abs(sum(v[i] * ax[i] for i in range(3))) > 0.999
    assert planarity > 0.98
