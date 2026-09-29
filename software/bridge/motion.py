"""
motion.py - the TAKTO ONE body model (software/MOTION_PIPELINE.md, sections 2-4, 7).

Pure Python, no numpy, no globals: every BodyModel is an independent instance,
so the live bridge, an offline SD-take import and the tests can each run their
own without touching one another.

What it does, per device frame (100 Hz on firmware v16):

  raw game quaternions (W_s <- S)          one per IMU, arbitrary per-boot heading
      |  Q_seg = H_s * C * q_s * M_s        (contract section 2)
      v
  segment orientations in the body frame   +Y up, +Z forward (the forearm's heading
      |                                     at the neutral), +X left, shoulder origin
      |  arm model (section 4)
      v
  elbow / wrist / palm positions           metres, from segment lengths, plus the
                                           forearm IMU's acceleration for shoulder
                                           motion (bounded to the upper-arm sphere)

Honesty rules this module keeps:
  * Body quaternions are the measurement: never clamped (only NaN-guarded). The
    anatomical wrist envelope is applied only to the DISPLAY copy (`display_rel`).
  * A neutral is valid for exactly one device boot (`boot_id`), because the game
    rotation vector's heading reference is re-chosen at every power-up.
  * Position is an estimate. `pos_source` and `quality.inertial_conf` say how much
    of it is the (drift-free) jointed-arm model and how much is integration.

Conventions: quaternions [w, x, y, z], Hamilton, active; q * v * q^-1 rotates v.
A quaternion named A_from_B (or "A <- B") maps vectors expressed in B into A.
"""
import math
from collections import deque

# ----------------------------------------------------------------------------
# small vector / quaternion kit
# ----------------------------------------------------------------------------
IDENTITY = (1.0, 0.0, 0.0, 0.0)
X_AXIS = (1.0, 0.0, 0.0)
Y_AXIS = (0.0, 1.0, 0.0)
Z_AXIS = (0.0, 0.0, 1.0)
DOWN = (0.0, -1.0, 0.0)

# Contract C: W (Z up) -> B (Y up), a -90 deg rotation about X: (x,y,z)_W -> (x,z,-y)_B
C_WB = (math.sqrt(0.5), -math.sqrt(0.5), 0.0, 0.0)


def vadd(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def vsub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def vscale(a, s):
    return [a[0] * s, a[1] * s, a[2] * s]


def vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def vcross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def vlen(a):
    return math.sqrt(vdot(a, a))


def vnorm(a, fallback=None):
    n = vlen(a)
    if n < 1e-12:
        return list(fallback) if fallback is not None else None
    return [a[0] / n, a[1] / n, a[2] / n]


def vangle(a, b):
    """Angle between two vectors, radians (0..pi)."""
    na, nb = vlen(a), vlen(b)
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    c = vdot(a, b) / (na * nb)
    return math.acos(max(-1.0, min(1.0, c)))


def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return [aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw]


def qconj(q):
    return [q[0], -q[1], -q[2], -q[3]]


def qnorm(q):
    n = math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    if n < 1e-12:
        return list(IDENTITY)
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]


def qcanon(q):
    """The w >= 0 representative (q and -q are the same rotation)."""
    return list(q) if q[0] >= 0.0 else [-q[0], -q[1], -q[2], -q[3]]


def qrot(q, v):
    """Rotate vector v by unit quaternion q."""
    w, x, y, z = q
    tx = 2.0 * (y * v[2] - z * v[1])
    ty = 2.0 * (z * v[0] - x * v[2])
    tz = 2.0 * (x * v[1] - y * v[0])
    return [v[0] + w * tx + y * tz - z * ty,
            v[1] + w * ty + z * tx - x * tz,
            v[2] + w * tz + x * ty - y * tx]


def qaxis_angle(axis, angle):
    a = vnorm(axis, X_AXIS)
    s = math.sin(angle * 0.5)
    return [math.cos(angle * 0.5), a[0] * s, a[1] * s, a[2] * s]


def qx(a):
    return [math.cos(a * 0.5), math.sin(a * 0.5), 0.0, 0.0]


def qy(a):
    return [math.cos(a * 0.5), 0.0, math.sin(a * 0.5), 0.0]


def qz(a):
    return [math.cos(a * 0.5), 0.0, 0.0, math.sin(a * 0.5)]


def qangle(q):
    """Rotation angle of q, radians, 0..pi (atan2 form: no acos blow-up of
    rounding noise near identity)."""
    s = math.sqrt(q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    return 2.0 * math.atan2(s, abs(q[0]))


def qangle_between(a, b):
    return qangle(qmul(qconj(a), b))


def qrotvec(q):
    """Rotation vector (axis * angle, radians) of q, short way."""
    q = qcanon(q)
    s = math.sqrt(q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    if s < 1e-12:
        return [2.0 * q[1], 2.0 * q[2], 2.0 * q[3]]
    ang = 2.0 * math.atan2(s, q[0])
    return [q[1] / s * ang, q[2] / s * ang, q[3] / s * ang]


def qfrom_rotvec(r):
    ang = vlen(r)
    if ang < 1e-12:
        return qnorm([1.0, r[0] * 0.5, r[1] * 0.5, r[2] * 0.5])
    return qaxis_angle(r, ang)


def qslerp(a, b, t):
    a = list(a)
    b = list(b)
    d = sum(a[i] * b[i] for i in range(4))
    if d < 0.0:
        b = [-x for x in b]
        d = -d
    if d > 0.9995:
        return qnorm([a[i] + (b[i] - a[i]) * t for i in range(4)])
    th = math.acos(max(-1.0, min(1.0, d)))
    s = math.sin(th)
    ka, kb = math.sin((1 - t) * th) / s, math.sin(t * th) / s
    return qnorm([a[i] * ka + b[i] * kb for i in range(4)])


def qfrom_mat(m):
    """3x3 rotation matrix (rows) -> quaternion."""
    tr = m[0][0] + m[1][1] + m[2][2]
    if tr > 0.0:
        s = math.sqrt(tr + 1.0) * 2.0
        q = [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]
    else:
        i = max(range(3), key=lambda k: m[k][k])
        j, k = (i + 1) % 3, (i + 2) % 3
        s = math.sqrt(max(1e-12, 1.0 + m[i][i] - m[j][j] - m[k][k])) * 2.0
        q = [0.0, 0.0, 0.0, 0.0]
        q[0] = (m[k][j] - m[j][k]) / s
        q[1 + i] = 0.25 * s
        q[1 + j] = (m[j][i] + m[i][j]) / s
        q[1 + k] = (m[k][i] + m[i][k]) / s
    return qcanon(qnorm(q))


def qfrom_axes(xa, ya, za):
    """Quaternion whose rotation maps the unit axes onto the given (orthonormal)
    columns: q*X = xa, q*Y = ya, q*Z = za."""
    m = [[xa[0], ya[0], za[0]], [xa[1], ya[1], za[1]], [xa[2], ya[2], za[2]]]
    return qfrom_mat(m)


def qfrom_two(a, b):
    """Shortest-arc rotation taking direction a onto direction b."""
    a = vnorm(a, Z_AXIS)
    b = vnorm(b, Z_AXIS)
    d = vdot(a, b)
    if d < -0.999999:
        ax = vcross(X_AXIS, a)
        if vlen(ax) < 1e-6:
            ax = vcross(Y_AXIS, a)
        return qaxis_angle(ax, math.pi)
    c = vcross(a, b)
    return qnorm([1.0 + d, c[0], c[1], c[2]])


def qaverage(quats):
    """Sign-aligned mean of rotations, renormalized (accurate for the small
    spreads of a held pose; the firmware uses the same estimator)."""
    acc = [0.0, 0.0, 0.0, 0.0]
    ref = None
    for q in quats:
        if q is None:
            continue
        if ref is None:
            ref = q
        s = 1.0 if sum(q[i] * ref[i] for i in range(4)) >= 0.0 else -1.0
        for i in range(4):
            acc[i] += s * q[i]
    if ref is None:
        return None
    return qnorm(acc)


def swing_twist_angle(q, axis):
    """Twist angle (radians, -pi..pi) of q about `axis` (swing-twist split)."""
    p = vdot(q[1:], axis)
    return 2.0 * math.atan2(p, q[0]) if (abs(p) > 1e-12 or abs(q[0]) > 1e-12) else 0.0


def wrap_pi(a):
    return (a + math.pi) % (2.0 * math.pi) - math.pi


def heading(v):
    """Heading of a body-frame direction: angle of its horizontal projection,
    measured from +Z toward +X (a rotation about +Y by this angle takes +Z
    there). Returns (angle_rad, horizontal_norm)."""
    h = math.hypot(v[0], v[2])
    return math.atan2(v[0], v[2]), h


def valid_quat(q):
    """None, or the normalized quaternion if q is a finite near-unit 4-vector."""
    if q is None:
        return None
    try:
        v = [float(x) for x in q]
    except (TypeError, ValueError):
        return None
    if len(v) != 4 or not all(math.isfinite(x) for x in v):
        return None
    n2 = sum(x * x for x in v)
    if n2 < 0.25 or n2 > 2.25:
        return None
    n = math.sqrt(n2)
    return [x / n for x in v]


def valid_vec(v):
    if v is None:
        return None
    try:
        out = [float(x) for x in v]
    except (TypeError, ValueError):
        return None
    if len(out) != 3 or not all(math.isfinite(x) for x in out):
        return None
    return out


# ----------------------------------------------------------------------------
# mounting priors from the legacy IMU_CFG (remap / align / offset)
# ----------------------------------------------------------------------------
_AX = {"x": 0, "y": 1, "z": 2}


def remap_matrix(remap):
    """The signed permutation the legacy remap applies to a quaternion's vector
    part: new[i] = s_i * old[axis_i], i.e. new = P * old."""
    m = [[0.0, 0.0, 0.0] for _ in range(3)]
    for i, (s, a) in enumerate(remap):
        m[i][_AX[a]] = float(s)
    return m


def mounting_prior(cfg):
    """Legacy IMU_CFG entry -> the contract's mounting M_s (S <- Segment).

    The legacy pipeline displayed   tare * R q R^-1 * offset   with the tare the
    inverse of the same expression at the tare pose, i.e. it showed
        X^-1 (q0^-1 q) X      with   X = R^-1 * offset,
    the sensor's rotation since the tare expressed in the frame X. The twin
    rendered that as the segment's rotation in segment axes, and the bench tuned
    `remap`/`offset` until it looked right: X is the segment frame seen from the
    sensor, S <- Segment, which is exactly M_s. (R is the rotation whose matrix is
    the remap permutation, or the solved `align` quaternion when present.)
    tests/test_motion.py::test_mounting_prior_matches_legacy_pipeline checks this
    identity numerically against a re-implementation of the legacy stages."""
    if cfg.get("align"):
        r = qnorm(cfg["align"])
    else:
        r = qfrom_mat(remap_matrix(cfg["remap"]))
    off = cfg.get("offset") or IDENTITY
    return qnorm(qmul(qconj(r), off))


# ----------------------------------------------------------------------------
# wrist angles and the display-only anatomical envelope
# ----------------------------------------------------------------------------
# Anatomical wrist envelope (display only): flexion +80 / extension -70,
# radial +20 / ulnar -35, axial +-90 (the radiocarpal joint has almost none).
WRIST_LIMITS_DEG = {"flex": (-70.0, 80.0), "dev": (-35.0, 20.0), "twist": (-90.0, 90.0)}


def wrist_angles(rel):
    """Hand-in-forearm rotation -> (flex, dev, twist) radians.

    Decomposition rel = Rx(flex) * Ry(dev) * Rz(twist) (intrinsic X then Y then
    Z): flex and dev are read off where the hand's distal axis points in the
    forearm frame, which is how a clinician reads a wrist. +flex = palm-ward
    (a +X rotation sends +Z toward -Y), +dev = radial (toward +X, the thumb),
    twist = residual axial rotation (should be ~0 at a real wrist)."""
    d = qrot(rel, Z_AXIS)
    dev = math.asin(max(-1.0, min(1.0, d[0])))
    flex = math.atan2(-d[1], d[2])
    rem = qmul(qconj(qmul(qx(flex), qy(dev))), rel)
    twist = wrap_pi(2.0 * math.atan2(rem[3], rem[0]))
    return flex, dev, twist


def wrist_quat(flex, dev, twist):
    return qmul(qmul(qx(flex), qy(dev)), qz(twist))


def _soft(r, knee=0.8):
    """Monotonic soft saturation to 1: identity below `knee`, tanh above."""
    if r <= knee:
        return r
    return knee + (1.0 - knee) * math.tanh((r - knee) / (1.0 - knee))


def soft_limit_wrist(flex_deg, dev_deg, twist_deg):
    """Display-only envelope. Flex/dev share an asymmetric ellipse (a corner of
    +80 flexion with +20 radial is not a real wrist), softened near the edge so
    a twin never snaps. Returns (flex, dev, twist, limited)."""
    lf = WRIST_LIMITS_DEG["flex"][1] if flex_deg >= 0 else -WRIST_LIMITS_DEG["flex"][0]
    ld = WRIST_LIMITS_DEG["dev"][1] if dev_deg >= 0 else -WRIST_LIMITS_DEG["dev"][0]
    r = math.hypot(flex_deg / lf, dev_deg / ld)
    f2, d2 = flex_deg, dev_deg
    if r > 0.8:
        k = _soft(r) / r
        f2, d2 = flex_deg * k, dev_deg * k
    lt = WRIST_LIMITS_DEG["twist"][1]
    t2 = math.copysign(_soft(abs(twist_deg) / lt) * lt, twist_deg)
    limited = abs(f2 - flex_deg) > 0.05 or abs(d2 - dev_deg) > 0.05 or abs(t2 - twist_deg) > 0.05
    return f2, d2, t2, limited


# ----------------------------------------------------------------------------
# configuration
# ----------------------------------------------------------------------------
DEFAULT_CFG = {
    "L_ua": 0.30,                      # shoulder -> elbow, m
    "L_fa": 0.26,                      # elbow -> wrist pivot, m
    "f_imu_to_wrist": [0.0, 0.008, 0.095],   # forearm IMU -> wrist pivot, forearm frame (REL_F2W_MM)
    "hand_offset": [0.0, 0.010, 0.055],      # wrist pivot -> palm centre, hand frame (contract)
    # stillness: an IMU is "still" below this angular rate
    "still_rad_s": 0.05,
    "provisional_still_s": 1.5,        # contract: provisional neutral after 1.5 s still
    "provisional_min_horiz": 0.35,     # forearm must not point (near) vertically for a heading
    "neutral_window_s": 2.0,
    "neutral_max_spread_deg": 8.0,     # a "hold" that moved more than this is refused
    "level_forearm": True,             # the neutral pose DEFINES the forearm as level + palm down
    "heading_bleed_tau_s": 30.0,       # axial-twist bleed time constant (contract)
    "heading_bleed_clamp_deg": 20.0,   # twist beyond this is a pose, not drift: cap the gradient
    # inertial elbow estimate
    "zupt_acc": 0.08,                  # m/s^2 (bench: resting |lin| p99 0.054, max 0.066)
    "zupt_gyr": 0.06,                  # rad/s
    "zupt_hold_s": 0.08,               # contract: 80 ms
    "bias_rate": 0.01,                 # per frame, during ZUPT
    # Tuned on motion_synth with bias, white noise AND the fusion's gravity leak
    # (0.12 deg static + 0.4..0.8 deg/(rad/s) dynamic tilt error): see
    # tests/test_motion.py for the resulting numbers. Lower thresholds track
    # a clean simulator better and a real BNO085 worse.
    "vel_leak_per_s": 0.85,            # elbow velocity kept per second of motion (weak high-pass)
    "acc_deadband": 0.15,              # m/s^2, horizontal: below this is bias/tilt leak, not a reach
    "acc_deadband_per_rad_s": 0.30,    # + this per rad/s of forearm rotation (dynamic tilt leak)
    "acc_deadband_v": 0.02,            # vertical component: immune to tilt leak to first order
    "acc_smooth_s": 0.04,              # smoothing of the unexplained accel before the deadband
    "relax_after_s": 4.0,              # still this long -> upper arm relaxes to hanging
    "relax_tau_s": 8.0,
    "max_elev_deg": 170.0,             # anatomical cone around hanging
    "inertial": True,
    "gap_s": 0.25,                     # a frame gap larger than this resets integration
    "history_s": 8.0,
}


def _now_or(t, default):
    return default if t is None else t


# ----------------------------------------------------------------------------
# the neutral solve (pure function; the model calls it)
# ----------------------------------------------------------------------------
def _heading_rot(psi):
    return qy(psi)


def _frame_align_heading(g, target):
    """psi maximizing the alignment of qy(psi)*g with target (closed form):
    maximize trace(Ry(psi) N), N = mat(g) mat(target)^T."""
    # columns of the two frames
    gx, gy, gz = qrot(g, X_AXIS), qrot(g, Y_AXIS), qrot(g, Z_AXIS)
    tx, ty, tz = qrot(target, X_AXIS), qrot(target, Y_AXIS), qrot(target, Z_AXIS)
    # N = sum_k g_k t_k^T
    n = [[gx[i] * tx[j] + gy[i] * ty[j] + gz[i] * tz[j] for j in range(3)] for i in range(3)]
    # Ry = [[c,0,s],[0,1,0],[-s,0,c]]; trace(Ry N) = c(N00+N22) + s(N20-N02) + N11
    return math.atan2(n[2][0] - n[0][2], n[0][0] + n[2][2])


def solve_neutral(q0, prior, wrist_axis=None, level_forearm=True, fold=True, min_horiz=0.35):
    """Solve the per-boot alignment from averaged raw quaternions at a neutral.

    q0:     {"hand","forearm","thumb"} raw game quats W_s <- S (thumb may be None)
    prior:  {"hand","forearm","thumb"} mounting priors M_s (S <- Segment)
    wrist_axis: optional hand-sensor-frame flexion axis (segment +X), unit
    fold:   True for a real (user) neutral - the pose is DEFINED as forearm level,
            palm down, wrist straight, so residual tilts are folded into the
            mountings; False for a provisional neutral (heading only).

    Returns {"psi": {k: rad}, "M": {k: quat}, "report": {...}} or raises ValueError.
    """
    qf0, qh0, qt0 = q0.get("forearm"), q0.get("hand"), q0.get("thumb")
    if qf0 is None or qh0 is None:
        raise ValueError("the hand and the forearm IMU must both be live")
    rep = {}
    # 1. forearm heading from its distal axis
    gf = qmul(qmul(C_WB, qf0), prior["forearm"])
    df = qrot(gf, Z_AXIS)
    psi_df, hf = heading(df)
    if hf < min_horiz:
        raise ValueError("the forearm points too steeply up/down (%.0f deg from level) "
                         "to define 'forward'" % math.degrees(math.acos(min(1.0, hf))))
    psi_f = -psi_df
    qf_neutral = qmul(_heading_rot(psi_f), gf)
    rep["forearm_tilt_deg"] = round(math.degrees(qangle(qf_neutral)), 2)
    if fold and level_forearm:
        m_f = qnorm(qmul(prior["forearm"], qconj(qf_neutral)))
        qf_neutral = list(IDENTITY)
    else:
        m_f = list(prior["forearm"])
    # 2. hand heading: from the functional flexion axis when calibrated, else
    #    from the prior's distal axis; frame alignment when that is degenerate.
    gh = qmul(qmul(C_WB, qh0), prior["hand"])
    psi_h = None
    if wrist_axis is not None and fold:
        v = qrot(qf_neutral, X_AXIS)                     # where +X must end up
        w = qrot(qmul(C_WB, qh0), wrist_axis)            # measured flexion axis, pre-heading
        pv, hv = heading(v)
        pw, hw = heading(w)
        if hv > 0.5 and hw > 0.5:
            psi_h = wrap_pi(pv - pw)
            rep["hand_heading_from"] = "wrist_axis"
    if psi_h is None:
        dh = qrot(gh, Z_AXIS)
        pdh, hh = heading(dh)
        pft, _ = heading(qrot(qf_neutral, Z_AXIS))
        if hh >= 0.5:
            psi_h = wrap_pi(pft - pdh)
            rep["hand_heading_from"] = "distal_axis"
        else:
            psi_h = _frame_align_heading(gh, qf_neutral)
            rep["hand_heading_from"] = "frame"
    qh_neutral = qmul(_heading_rot(psi_h), gh)
    rep["hand_residual_deg"] = round(math.degrees(qangle_between(qf_neutral, qh_neutral)), 2)
    if fold:
        # M_h = (H_h C q_h0)^-1 Q_f0 : hand frame == forearm frame at neutral
        m_h = qnorm(qmul(qconj(qmul(qmul(_heading_rot(psi_h), C_WB), qh0)), qf_neutral))
        if wrist_axis is not None:
            rep["wrist_axis_residual_deg"] = round(
                math.degrees(vangle(qrot(m_h, X_AXIS), wrist_axis)), 2)
    else:
        m_h = list(prior["hand"])
    # 3. thumb: aligned to the hand (legacy semantics: thumb == hand at the home pose)
    psi_t, m_t = None, list(prior["thumb"])
    if qt0 is not None:
        gt = qmul(qmul(C_WB, qt0), prior["thumb"])
        target = qf_neutral if fold else qh_neutral
        psi_t = _frame_align_heading(gt, target)
        if fold:
            m_t = qnorm(qmul(qconj(qmul(qmul(_heading_rot(psi_t), C_WB), qt0)), target))
    return {"psi": {"forearm": psi_f, "hand": psi_h, "thumb": psi_t},
            "M": {"forearm": m_f, "hand": m_h, "thumb": m_t},
            "report": rep}


# ----------------------------------------------------------------------------
# wrist-axis functional calibration
# ----------------------------------------------------------------------------
def principal_axis(samples, seed=None, iters=60):
    """Dominant eigenvector of sum(w w^T) over angular-velocity samples.
    Returns (unit_axis, planarity = lambda1 / trace)."""
    s = [[0.0] * 3 for _ in range(3)]
    for w in samples:
        for i in range(3):
            for j in range(3):
                s[i][j] += w[i] * w[j]
    tr = s[0][0] + s[1][1] + s[2][2]
    if tr <= 1e-12:
        return None, 0.0
    v = list(seed) if seed is not None else [1.0, 1.0, 1.0]
    v = vnorm(v, X_AXIS)
    for _ in range(iters):
        nv = [s[i][0] * v[0] + s[i][1] * v[1] + s[i][2] * v[2] for i in range(3)]
        nv = vnorm(nv)
        if nv is None:
            return None, 0.0
        v = nv
    lam = sum(v[i] * sum(s[i][j] * v[j] for j in range(3)) for i in range(3))
    return v, lam / tr


# ----------------------------------------------------------------------------
# the model
# ----------------------------------------------------------------------------
KEYS = ("hand", "forearm", "thumb")


class BodyModel:
    """One arm, one device boot. Feed `update(frame)` once per device frame.

    frame = {
      "t": device seconds,
      "q":   {k: raw game quat W_s<-S, or None when that IMU is not live},
      "gyr": {k: rad/s sensor frame | None},           (optional)
      "lin": {k: m/s^2 sensor frame, gravity removed | None},   (optional)
      "dv":  {k: m/s in W_s since the previous frame | None},   (optional, v16)
      "dv_n": {k: int},  "stab": {k: 0..4 | 255 | None},        (optional, v16)
      "ts":  {k: device seconds the IMU sampled this orientation | None}  (optional, v17:
             frame time - qage). When present, rates and the inertial path use
             the interval between successive SAMPLES of that IMU instead of the
             frame interval (a frame that re-reports an old sample adds no
             motion; a frame after a late report covers two).
    }
    """

    def __init__(self, priors, cfg=None, wrist_axis=None):
        self.cfg = dict(DEFAULT_CFG)
        if cfg:
            self.cfg.update(cfg)
        self.prior = {k: qnorm(priors[k]) for k in KEYS}
        self.wrist_axis = vnorm(wrist_axis) if wrist_axis is not None else None
        self.auto_neutral = True
        self.boot_id = None
        self.reset_boot(None)

    # ---------------- lifecycle ----------------
    def reset_boot(self, boot_id):
        """Everything that is only valid for one power-up of the device."""
        self.boot_id = boot_id
        self.neutral = None          # {"kind","t","q0","psi","M","report","provisional"}
        self.hist = deque(maxlen=int(self.cfg["history_s"] * 200))   # (t, {k: raw quat or None})
        self.raw = {k: None for k in KEYS}
        self.live = {k: False for k in KEYS}
        self.t = None
        self.bleed_psi = 0.0         # accumulated hand heading correction (rad)
        self.still_since = {k: None for k in KEYS}
        self._prev_q = {k: None for k in KEYS}
        self._ts_prev = {k: None for k in KEYS}
        self.dt_s = {k: None for k in KEYS}   # interval between this IMU's last two samples
        self._rate = {k: 0.0 for k in KEYS}
        self._reset_arm()
        self._pending = None         # a device neutral waiting for its frames
        self._auto_retry_t = -1e9
        self._wa = None              # wrist-axis capture in progress
        self._pro_prev = 0.0
        self._ua_x_prev = list(X_AXIS)
        self._out = None
        self.events = []             # (kind, payload) for the owner to broadcast

    def _reset_arm(self):
        """Arm state. The accelerometer bias is NOT reset: it belongs to the
        sensor, not to a neutral or a boot, and takes a second of rest to learn."""
        self.u = list(DOWN)
        self.v_e = [0.0, 0.0, 0.0]          # elbow velocity estimate, body frame
        self._a_un = [0.0, 0.0, 0.0]        # smoothed unexplained acceleration
        self._v_rot_prev = None
        if not hasattr(self, "bias_s"):
            self.bias_s = [0.0, 0.0, 0.0]
        self._quiet_since = None
        self.zupt = False
        self.last_zupt = None
        self.inertial_active = False
        self._fq_prev_body = None

    def set_boot(self, boot_id):
        """Tell the model which device boot the frames come from. Returns True
        when that invalidated the current neutral (a reboot)."""
        if boot_id == self.boot_id:
            return False
        had = self.neutral is not None
        bias = list(self.bias_s)
        self.reset_boot(boot_id)
        self.bias_s = bias               # accelerometer bias belongs to the sensor
        return had

    # ---------------- orientation pipeline ----------------
    def _H(self, k):
        n = self.neutral
        if n is None or n["psi"].get(k) is None:
            return list(IDENTITY)
        psi = n["psi"][k]
        if k == "hand":
            psi += self.bleed_psi
        return qy(psi)

    def _M(self, k):
        n = self.neutral
        if n is None:
            return self.prior[k]
        return n["M"][k]

    def seg_quat(self, k, q_raw=None):
        """Q_seg = H_s * C * q_s * M_s (body <- segment)."""
        q = q_raw if q_raw is not None else self.raw[k]
        if q is None:
            return None
        return qnorm(qmul(qmul(qmul(self._H(k), C_WB), q), self._M(k)))

    def sensor_to_body(self, k, q_raw=None):
        """body <- sensor rotation (H_s * C * q_s)."""
        q = q_raw if q_raw is not None else self.raw[k]
        if q is None:
            return None
        return qmul(qmul(self._H(k), C_WB), q)

    # ---------------- neutral ----------------
    def has_heading(self):
        return self.neutral is not None

    def status(self):
        if self.neutral is None:
            return "none"
        return "provisional" if self.neutral["provisional"] else "calibrated"

    def _window(self, t_end, span):
        out = {k: [] for k in KEYS}
        for (t, qs) in self.hist:
            if t_end - span - 1e-6 <= t <= t_end + 1e-6:
                for k in KEYS:
                    if qs.get(k) is not None:
                        out[k].append(qs[k])
        return out

    def _spread_deg(self, quats, mean):
        if not quats:
            return 0.0
        return max(math.degrees(qangle_between(mean, q)) for q in quats)

    def capture_neutral(self, t_end=None, window_s=None, kind="bridge", q_avg=None,
                        provisional=False):
        """Solve a neutral. Either from explicitly averaged raw quats (`q_avg`,
        e.g. the device's own E,neutral,done averages) or from the frame history
        over [t_end - window, t_end]. Returns a result dict (ok, reason, ...)."""
        window_s = window_s or self.cfg["neutral_window_s"]
        t_end = _now_or(t_end, self.t)
        spread = {}
        if q_avg is None:
            if t_end is None:
                return {"ok": False, "reason": "no frames yet"}
            win = self._window(t_end, window_s)
            if len(win["hand"]) < 3 or len(win["forearm"]) < 3:
                return {"ok": False, "reason": "the hand and forearm IMUs were not live during the hold"}
            q_avg = {}
            for k in KEYS:
                q_avg[k] = qaverage(win[k]) if len(win[k]) >= 3 else None
                if q_avg[k] is not None:
                    spread[k] = round(self._spread_deg(win[k], q_avg[k]), 2)
            worst = max(spread.get("hand", 0.0), spread.get("forearm", 0.0))
            if worst > self.cfg["neutral_max_spread_deg"] and not provisional:
                return {"ok": False, "reason": "moved during the hold (%.0f deg)" % worst,
                        "spread_deg": spread}
        else:
            q_avg = {k: valid_quat(q_avg.get(k)) for k in KEYS}
            # cross-check against our own frames when we have them
            if t_end is not None:
                win = self._window(t_end, window_s)
                for k in ("hand", "forearm"):
                    if len(win[k]) >= 3 and q_avg[k] is not None:
                        spread[k] = round(math.degrees(qangle_between(qaverage(win[k]), q_avg[k])), 2)
        try:
            sol = solve_neutral(q_avg, self.prior, self.wrist_axis,
                                level_forearm=self.cfg["level_forearm"], fold=not provisional,
                                min_horiz=self.cfg["provisional_min_horiz"])
        except ValueError as e:
            return {"ok": False, "reason": str(e)}
        self.neutral = {"kind": kind, "t": t_end, "q0": q_avg, "psi": sol["psi"],
                        "M": sol["M"], "report": sol["report"], "provisional": provisional,
                        "boot_id": self.boot_id, "spread": spread}
        self.bleed_psi = 0.0
        self._reset_arm()
        self._pro_prev = 0.0
        self._out = None
        return {"ok": True, "kind": kind, "provisional": provisional, "t": t_end,
                "report": sol["report"], "spread_deg": spread}

    def request_device_neutral(self, t_end, q_avg=None):
        """E,neutral,done arrived: solve now if the frames up to t_end are in,
        otherwise on the first frame at/after t_end (the event and the S-line of
        the same instant can arrive in either order)."""
        if q_avg is not None or (self.t is not None and self.t >= t_end - 0.005):
            return self.capture_neutral(t_end=t_end, kind="device", q_avg=q_avg)
        self._pending = {"t": t_end, "q_avg": q_avg, "deadline": None}
        return {"ok": None, "pending": True}

    def export_neutral(self):
        """Persistable record of a REAL neutral (provisional ones are never kept)."""
        n = self.neutral
        if n is None or n["provisional"]:
            return None
        return {"boot_id": n["boot_id"], "kind": n["kind"], "t": n["t"],
                "q0": {k: (list(v) if v is not None else None) for k, v in n["q0"].items()}}

    def import_neutral(self, rec):
        """Adopt a persisted neutral - only for the SAME device boot. It is
        re-solved from its raw averages with the current priors/wrist axis."""
        if not rec or self.boot_id is None or rec.get("boot_id") != self.boot_id:
            return False
        res = self.capture_neutral(t_end=rec.get("t"), kind=rec.get("kind", "restored"),
                                   q_avg=rec.get("q0") or {})
        return bool(res.get("ok"))

    # ---------------- wrist axis ----------------
    def start_wrist_axis(self, duration_s=5.0):
        self._wa = {"t0": None, "dur": float(duration_s), "samples": [], "sum": 0.0,
                    "prev": None, "f_motion": 0.0, "fprev": None, "frame_known": self.has_heading()}
        return {"ok": True, "duration_s": duration_s}

    def _wa_step(self):
        wa = self._wa
        qh, qf = self.raw["hand"], self.raw["forearm"]
        if qh is None or qf is None or not (self.live["hand"] and self.live["forearm"]):
            return
        if wa["t0"] is None:
            wa["t0"] = self.t
        if self.has_heading():
            # S_f <- S_h = (H_f C q_f)^-1 (H_h C q_h): immune to forearm motion
            p = qmul(qconj(self.sensor_to_body("forearm")), self.sensor_to_body("hand"))
        else:
            p = qh              # no heading link yet: valid while the forearm is still
            if wa["fprev"] is not None:
                wa["f_motion"] += qangle_between(wa["fprev"], qf)
            wa["fprev"] = qf
        if wa["prev"] is not None:
            inc = qmul(qconj(wa["prev"]), p)          # increment in the hand sensor frame
            r = qrotvec(inc)
            wa["samples"].append(r)
            wa["sum"] += vlen(r)
        wa["prev"] = p
        if self.t - wa["t0"] >= wa["dur"]:
            self._wa = None
            self.events.append(("wrist_axis", self._wa_solve(wa)))

    def _wa_solve(self, wa):
        total = math.degrees(wa["sum"])
        if total < 120.0:
            return {"ok": False, "reason": "not enough wrist motion (%.0f deg total; "
                    "flex and extend the wrist fully a few times)" % total}
        if not wa["frame_known"] and math.degrees(wa["f_motion"]) > 20.0:
            return {"ok": False, "reason": "the forearm moved; rest it on a table "
                    "(or capture a neutral first)"}
        seed = qrot(self._M("hand"), X_AXIS)
        axis, planarity = principal_axis(wa["samples"], seed=seed)
        if axis is None or planarity < 0.7:
            return {"ok": False, "reason": "the motion was not a clean flex/extend "
                    "(planarity %.2f < 0.70)" % planarity, "planarity": round(planarity, 3)}
        if vdot(axis, seed) < 0.0:
            axis = vscale(axis, -1.0)
        prior_x = qrot(self.prior["hand"], X_AXIS)
        self.wrist_axis = axis
        res = {"ok": True, "axis_sensor": [round(v, 5) for v in axis],
               "planarity": round(planarity, 3), "motion_deg": round(total, 1),
               "from_prior_deg": round(math.degrees(vangle(axis, prior_x)), 2)}
        n = self.neutral
        if n is not None and not n["provisional"]:
            again = self.capture_neutral(t_end=n["t"], kind=n["kind"], q_avg=n["q0"])
            res["neutral_resolved"] = bool(again.get("ok"))
        return res

    # ---------------- per-frame update ----------------
    def update(self, fr):
        t = float(fr["t"])
        cfg = self.cfg
        gap = self.t is None or t - self.t <= 0.0 or t - self.t > cfg["gap_s"]
        dt = 0.0 if gap else t - self.t
        self.t = t
        qin = fr.get("q") or {}
        gyr = fr.get("gyr") or {}
        ts = fr.get("ts") or {}
        for k in KEYS:
            q = valid_quat(qin.get(k))
            self.live[k] = q is not None
            if q is not None:
                self.raw[k] = q
            # per-IMU sample interval (v17 timing); None = unknown -> frame dt
            tk = ts.get(k) if q is not None else None
            if tk is None or gap:
                self.dt_s[k] = None if tk is None else 0.0
            else:
                p = self._ts_prev[k]
                d = (tk - p) if p is not None else None
                self.dt_s[k] = d if (d is not None and -1e-6 <= d <= cfg["gap_s"]) else None
                if self.dt_s[k] is not None and self.dt_s[k] < 0.0:
                    self.dt_s[k] = 0.0
            self._ts_prev[k] = tk if q is not None else None
        self.hist.append((t, {k: (self.raw[k] if self.live[k] else None) for k in KEYS}))
        while self.hist and t - self.hist[0][0] > cfg["history_s"]:
            self.hist.popleft()

        # stillness per IMU (gyro when streamed, else the quaternion's own rate)
        for k in KEYS:
            rate = None
            if self.live[k]:
                g = valid_vec(gyr.get(k))
                dk = self.dt_s[k] if self.dt_s[k] is not None else dt
                if g is not None:
                    rate = vlen(g)
                elif self._prev_q[k] is not None and dk > 0.0:
                    rate = qangle_between(self._prev_q[k], self.raw[k]) / dk
                elif self._prev_q[k] is not None and self.dt_s[k] == 0.0:
                    rate = self._rate[k]          # the same sample again: no new evidence
                if self.dt_s[k] != 0.0:
                    self._prev_q[k] = self.raw[k]
            else:
                self._prev_q[k] = None
            if rate is None:
                if not self.live[k]:
                    self.still_since[k] = None
                continue
            self._rate[k] = rate
            if rate < cfg["still_rad_s"]:
                if self.still_since[k] is None:
                    self.still_since[k] = t
            else:
                self.still_since[k] = None

        # a device neutral waiting for the frame it ended on
        if self._pending is not None and t >= self._pending["t"] - 0.005:
            p = self._pending
            self._pending = None
            self.events.append(("neutral", self.capture_neutral(t_end=p["t"], kind="device",
                                                                 q_avg=p["q_avg"])))

        # provisional neutral: first 1.5 s still window of this boot (a failed
        # attempt - e.g. the forearm hanging vertically - retries after 1 s)
        if self.neutral is None and self.auto_neutral and t >= self._auto_retry_t:
            hs, fs = self.still_since["hand"], self.still_since["forearm"]
            if hs is not None and fs is not None and t - max(hs, fs) >= cfg["provisional_still_s"]:
                res = self.capture_neutral(t_end=t, window_s=cfg["provisional_still_s"],
                                           kind="auto", provisional=True)
                if res.get("ok"):
                    self.events.append(("neutral_auto", res))
                else:
                    self._auto_retry_t = t + 1.0

        # heading-drift bleed (hand vs forearm axial twist -> hand heading)
        both = self.live["hand"] and self.live["forearm"]
        if self.neutral is not None and both and dt > 0.0:
            qf = self.seg_quat("forearm")
            qh = self.seg_quat("hand")
            rel = qmul(qconj(qf), qh)
            # the axial twist of the wrist model (flex about X, then dev about
            # the carried Y: a Hooke joint), NOT a swing-twist split - a pure
            # flex+dev has a nonzero swing-twist "twist" that is not drift
            tw = wrist_angles(rel)[2]
            lim = math.radians(cfg["heading_bleed_clamp_deg"])
            tw = max(-lim, min(lim, tw))
            u = qrot(qconj(qf), Y_AXIS)                  # body up, in forearm coords
            # d(twist)/d(psi_h) ~= u_z: gradient descent on twist^2 with tau.
            # Unobservable (u_z ~ 0) when the forearm is level: then nothing moves.
            self.bleed_psi -= tw * u[2] * dt / cfg["heading_bleed_tau_s"]

        if self._wa is not None:
            self._wa_step()

        self._arm_update(fr, dt)
        self._out = None

    # ---------------- arm model + inertial elbow ----------------
    def _arm_update(self, fr, dt):
        cfg = self.cfg
        k = "forearm"
        t = self.t
        both_still = (self.still_since["hand"] is not None and self.still_since["forearm"] is not None)
        prev_active, prev_zupt = self.inertial_active, self.zupt
        self.inertial_active = False
        self.zupt = False
        if not cfg["inertial"] or not self.live[k] or dt <= 0.0:
            self.v_e = [0.0, 0.0, 0.0]
            self._a_un = [0.0, 0.0, 0.0]
            self._v_rot_prev = None
            self._quiet_since = None
            self._fq_prev_body = None
            self._relax(both_still, dt)
            return
        q_raw = self.raw[k]
        dv = valid_vec((fr.get("dv") or {}).get(k))
        dv_n = (fr.get("dv_n") or {}).get(k)
        lin = valid_vec((fr.get("lin") or {}).get(k))
        # dt_a: the time the forearm's inertial data of this frame spans. With
        # v17 timing it is the interval between the IMU's successive samples
        # (frame time - qage), which is what the preintegrated dv covers when
        # the linear acceleration and the game vector share one report
        # interval; a frame that carries no new sample integrates nothing.
        dt_a = self.dt_s[k] if self.dt_s[k] is not None else dt
        if dt_a <= 0.0:
            # no new forearm sample in this frame: keep the elbow velocity and
            # the ZUPT verdict, advance the position on the frame clock, learn
            # nothing
            self.inertial_active, self.zupt = prev_active, prev_zupt
            if self.neutral is not None and prev_active and not prev_zupt:
                elbow = vadd(vscale(self.u, cfg["L_ua"]), vscale(self.v_e, dt))
                self.u = self._cone(vnorm(elbow, self.u))
            self._relax(both_still, dt)
            return
        # acceleration in the SENSOR frame (needs no heading, so the bias can be
        # learned from the first still second of the boot, before any neutral)
        if dv is not None and (dv_n is None or dv_n > 0):
            a_s_raw = vscale(qrot(qconj(q_raw), dv), 1.0 / dt_a)  # W_s -> S, mean over the span
        elif lin is not None:
            a_s_raw = lin
        else:
            self._relax(both_still, dt)
            return
        g_s = valid_vec((fr.get("gyr") or {}).get(k))
        g_mag = vlen(g_s) if g_s is not None else self._rate[k]
        stab = (fr.get("stab") or {}).get(k)
        quiet = vlen(a_s_raw) < cfg["zupt_acc"] and g_mag < cfg["zupt_gyr"]
        if quiet:
            if self._quiet_since is None:
                self._quiet_since = t
        else:
            self._quiet_since = None
        zupt = (stab in (1, 2, 3)) or (self._quiet_since is not None
                                       and t - self._quiet_since >= cfg["zupt_hold_s"])
        if zupt and g_mag < 0.02:
            # a genuine standstill (not a slow turn about the elbow, whose
            # centripetal/tangential terms are not bias): learn the bias
            r = cfg["bias_rate"]
            self.bias_s = [self.bias_s[i] + (a_s_raw[i] - self.bias_s[i]) * r for i in range(3)]
        if self.neutral is None:
            self._relax(both_still, dt)
            return                          # no body frame yet: nothing to integrate into
        self.inertial_active = True
        self.zupt = zupt
        rsb = self.sensor_to_body(k)                      # body <- forearm sensor
        a_body = qrot(rsb, vsub(a_s_raw, self.bias_s))
        qf = self.seg_quat(k)
        if g_s is not None:
            w_body = qrot(rsb, g_s)
        elif self._fq_prev_body is not None:
            w_body = vscale(qrotvec(qmul(qf, qconj(self._fq_prev_body))), 1.0 / dt_a)
        else:
            w_body = [0.0, 0.0, 0.0]
        self._fq_prev_body = qf
        r_imu = qrot(qf, vsub([0.0, 0.0, cfg["L_fa"]], cfg["f_imu_to_wrist"]))
        v_rot = vcross(w_body, r_imu)
        if zupt:
            # Zero-velocity update on the ELBOW: whatever the forearm IMU is doing
            # is explained by the forearm turning about a stationary elbow (and at
            # a true standstill that is ~0 anyway). Setting the IMU velocity to 0
            # instead would inject -w x r the moment a slow motion released it.
            self.v_e = [0.0, 0.0, 0.0]
            self._a_un = [0.0, 0.0, 0.0]
            self._v_rot_prev = v_rot
            self.last_zupt = t
            self._relax(both_still, dt)
            return
        # The elbow's own acceleration is what the forearm IMU feels minus what
        # the forearm turning about the elbow explains (d/dt of w x r). A small
        # constant remainder is residual accelerometer bias, not motion: it is
        # soft-thresholded away (a deadband at the sensor's noise floor), so a
        # long elbow/wrist exercise does not slowly walk the upper arm, while a
        # real reach (0.3..1 m/s^2) passes almost untouched.
        a_rot = vscale(vsub(v_rot, self._v_rot_prev), 1.0 / dt_a) if self._v_rot_prev is not None else [0.0, 0.0, 0.0]
        self._v_rot_prev = v_rot
        a_un = vsub(a_body, a_rot)
        al = min(1.0, dt / cfg["acc_smooth_s"])
        self._a_un = vadd(self._a_un, vscale(vsub(a_un, self._a_un), al))
        # Deadband, split by direction. The BNO085's linear acceleration is its
        # accelerometer minus ITS OWN gravity estimate, so a fusion tilt error e
        # (a rotation about a horizontal axis) leaks g * e into it - and e x g is
        # HORIZONTAL. The vertical component is immune to first order, so it
        # keeps a low threshold; the horizontal one gets a threshold that grows
        # with the rotation rate, because that is when the fusion's tilt error
        # is largest. The gate is decided on the smoothed signal (evidence) but
        # applied to the raw increment, so it adds neither lag nor a noise bias.
        thr_v = cfg["acc_deadband_v"]
        thr_h = cfg["acc_deadband"] + cfg["acc_deadband_per_rad_s"] * vlen(w_body)
        mh = math.hypot(self._a_un[0], self._a_un[2])
        mv = abs(self._a_un[1])
        gh = max(0.0, 1.0 - thr_h / mh) if mh > 1e-9 else 0.0
        gv = max(0.0, 1.0 - thr_v / mv) if mv > 1e-9 else 0.0
        a_eff = [a_un[0] * gh, a_un[1] * gv, a_un[2] * gh]
        v_e = vadd(self.v_e, vscale(a_eff, dt_a))                # = the (de-biased) dv itself
        v_e = vsub(v_e, vscale(self.u, vdot(v_e, self.u)))      # tangent to the sphere
        v_e = vscale(v_e, cfg["vel_leak_per_s"] ** dt)
        self.v_e = v_e
        elbow = vadd(vscale(self.u, cfg["L_ua"]), vscale(v_e, dt))
        self.u = self._cone(vnorm(elbow, self.u))
        self._relax(both_still, dt)

    def _cone(self, u):
        lim = math.radians(self.cfg["max_elev_deg"])
        ang = vangle(u, DOWN)
        if ang <= lim:
            return u
        q = qfrom_two(DOWN, u)
        ax = vnorm(q[1:], X_AXIS)
        return qrot(qaxis_angle(ax, lim), DOWN)

    def _relax(self, both_still, dt):
        if dt <= 0.0 or not both_still:
            return
        since = max(self.still_since["hand"], self.still_since["forearm"])
        if self.t - since < self.cfg["relax_after_s"]:
            return
        a = min(1.0, dt / self.cfg["relax_tau_s"])
        q = qfrom_two(self.u, DOWN)
        self.u = vnorm(qrot(qslerp(IDENTITY, q, a), self.u), DOWN)

    # ---------------- outputs ----------------
    def positions(self):
        cfg = self.cfg
        qf = self.seg_quat("forearm") or list(IDENTITY)
        qh = self.seg_quat("hand") or qf
        elbow = vscale(self.u, cfg["L_ua"])
        wrist = vadd(elbow, qrot(qf, [0.0, 0.0, cfg["L_fa"]]))
        hand = vadd(wrist, qrot(qh, cfg["hand_offset"]))
        return elbow, wrist, hand

    def upperarm_quat(self, qf):
        """+Z along the upper arm; +X on the elbow hinge axis (f x u), which keeps
        the flexion plane readable; continuity when the elbow is straight."""
        z = self.u
        f = qrot(qf, Z_AXIS)
        x = vcross(f, z)
        if vlen(x) < 0.2:
            x = self._ua_x_prev
        x = vnorm(vsub(x, vscale(z, vdot(x, z))), X_AXIS)
        self._ua_x_prev = x
        y = vcross(z, x)
        return qfrom_axes(x, y, z)

    def pronation(self, qf):
        """Forearm pronation, radians, + = pronation: roll of the forearm's +X
        (thumb side) away from the elbow hinge axis n = f x u, about the forearm
        axis. 0 at the neutral (palm down, upper arm hanging, elbow bent). A
        rotation about +Z lifts the thumb (supination), hence the sign."""
        f = qrot(qf, Z_AXIS)
        n = vcross(f, self.u)
        if vlen(n) < 0.25:                 # elbow (almost) straight: hinge undefined
            return self._pro_prev
        n = vnorm(n)
        xf = qrot(qf, X_AXIS)
        ang = math.atan2(vdot(vcross(n, xf), f), vdot(n, xf))
        self._pro_prev = -ang
        return -ang

    def body(self):
        """The contract's snapshot `body` block (section 7)."""
        if self._out is not None:
            return self._out
        qf = self.seg_quat("forearm") or list(IDENTITY)
        qh = self.seg_quat("hand") or list(qf)
        qt = self.seg_quat("thumb") if (self.raw["thumb"] is not None and self.live["thumb"]
                                        and self.neutral is not None
                                        and self.neutral["psi"].get("thumb") is not None) else None
        elbow, wrist, hand = self.positions()
        rel = qmul(qconj(qf), qh)
        fl, dv, tw = wrist_angles(rel)
        pro = self.pronation(qf)
        n = self.neutral
        since = None if (n is None or self.t is None or n["t"] is None) else max(0.0, self.t - n["t"])
        conf = 0.0
        if self.inertial_active or self.zupt:
            if self.zupt:
                conf = 1.0
            elif self.last_zupt is not None:
                conf = max(0.0, 1.0 - (self.t - self.last_zupt) / 3.0)
        still = (self.still_since["hand"] is not None and self.still_since["forearm"] is not None)
        r4 = lambda q: [round(float(v), 5) for v in qcanon(q)]
        r3 = lambda v: [round(float(x), 4) for x in v]
        self._out = {
            "frame": "body_yup_v1",
            "calibrated": bool(n is not None and not n["provisional"]),
            "provisional": bool(n is not None and n["provisional"]),
            "live": bool(self.live["hand"] and self.live["forearm"]),
            "shoulder_m": [0.0, 0.0, 0.0],
            "elbow_m": r3(elbow),
            "wrist_m": r3(wrist),
            "hand_m": r3(hand),
            "upperarm_quat": r4(self.upperarm_quat(qf)),
            "forearm_quat": r4(qf),
            "hand_quat": r4(qh),
            "thumb_quat": r4(qt) if qt is not None else None,
            "wrist_deg": {"flex": round(math.degrees(fl), 2), "dev": round(math.degrees(dv), 2),
                          "pro": round(math.degrees(pro), 2)},
            "pos_source": "arm+inertial" if self.inertial_active else "arm",
            "quality": {
                "since_neutral_s": None if since is None else round(since, 1),
                "inertial_conf": round(conf, 2),
                "still": bool(still),
                # additive diagnostics (not in the minimal contract)
                "neutral": self.status(),
                "neutral_kind": n["kind"] if n else None,
                "boot_id": self.boot_id,
                "wrist_axis": self.wrist_axis is not None,
                "twist_deg": round(math.degrees(tw), 2),
                "heading_bleed_deg": round(math.degrees(self.bleed_psi), 2),
                "elevation_deg": round(math.degrees(vangle(self.u, DOWN)), 1),
            },
        }
        return self._out

    def display_rel(self):
        """rel.quat for legacy views: hand-in-forearm, soft-limited to the
        anatomical envelope (display only). Returns (quat, [flex,dev,twist] deg,
        limited, raw_quat)."""
        qf = self.seg_quat("forearm") or list(IDENTITY)
        qh = self.seg_quat("hand") or list(qf)
        rel = qcanon(qnorm(qmul(qconj(qf), qh)))
        fl, dv, tw = (math.degrees(a) for a in wrist_angles(rel))
        f2, d2, t2, lim = soft_limit_wrist(fl, dv, tw)
        q = wrist_quat(math.radians(f2), math.radians(d2), math.radians(t2))
        return qcanon(q), [round(f2, 2), round(d2, 2), round(t2, 2)], lim, rel

    def take_cols(self):
        """The contract's b_* row columns (elbow, wrist, forearm quat, hand quat, cal)."""
        b = self.body()
        cal = 2 if b["calibrated"] else (1 if b["provisional"] else 0)
        return (list(b["elbow_m"]) + list(b["wrist_m"]) + list(b["forearm_quat"])
                + list(b["hand_quat"]) + [cal])

    def pop_events(self):
        ev, self.events = self.events, []
        return ev

    # ---------------- state snapshot (research re-derivation) ----------------
    def export_state(self):
        """The slowly-evolving model state a re-derivation cannot rebuild from
        a short pre-roll: heading bleed, upper-arm direction, elbow velocity,
        accelerometer bias. Stored in a take's raw sidecar (#meta state0)."""
        return {"bleed_psi": self.bleed_psi, "u": list(self.u), "v_e": list(self.v_e),
                "bias_s": list(self.bias_s)}

    def import_state(self, st):
        if not isinstance(st, dict):
            return
        try:
            if st.get("bleed_psi") is not None:
                self.bleed_psi = float(st["bleed_psi"])
            for key in ("u", "v_e", "bias_s"):
                v = st.get(key)
                if isinstance(v, list) and len(v) == 3:
                    setattr(self, key, [float(x) for x in v])
        except (TypeError, ValueError):
            pass
        self._out = None


B_COLS = ["b_ex", "b_ey", "b_ez", "b_wx", "b_wy", "b_wz",
          "b_fq_w", "b_fq_x", "b_fq_y", "b_fq_z",
          "b_hq_w", "b_hq_x", "b_hq_y", "b_hq_z", "b_cal"]
