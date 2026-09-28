"""
motion_synth.py - synthetic ground truth for the motion pipeline.

A kinematic right arm (shoulder, elbow hinge, forearm pronation, 2-DOF wrist)
driven by a choreography, and the SENSOR-LEVEL data three BNO085s strapped to
it would report: raw game rotation vectors with an arbitrary per-sensor heading
reference (and slow heading drift), mounting rotations, calibrated gyro,
gravity-free linear acceleration (the second derivative of each IMU's true
position, rotated into the sensor frame), the firmware v16 preintegrated `dv`
(in each IMU's own Z-up world), and a stability class.

Used by the unit tests (as ground truth) and by the bridge's --sim device (so
the simulator exercises the same parse -> body-model path as the hardware).
Dependency-free; deterministic for a given seed.

Truth frame = the contract's body frame: +Y up, +Z forward, +X left, origin at
the shoulder, with the neutral pose (upper arm hanging, elbow at 90 deg,
forearm level and pointing +Z, palm down, wrist straight) giving identity
forearm and hand orientations.
"""
import math
import random

from motion import (IDENTITY, C_WB, qmul, qconj, qnorm, qrot, qx, qy, qz, qaxis_angle,
                    qrotvec, qfrom_rotvec, vadd, vsub, vscale, vlen, vnorm, Z_AXIS)


def vcross_(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def smooth01(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


def bump(t, t0, t1, ramp=0.6):
    """0 before t0, eases to 1 over `ramp` s, holds, eases back to 0 at t1."""
    if t <= t0 or t >= t1:
        return 0.0
    return smooth01((t - t0) / ramp) * smooth01((t1 - t) / ramp)


class Pose:
    """Anatomical angles, radians: shoulder forward flexion (elevation in the
    sagittal plane), shoulder abduction, humeral internal rotation, elbow
    flexion (0 = straight), pronation (0 = palm down at the neutral), wrist
    flexion (+ palm-ward), wrist deviation (+ radial)."""
    __slots__ = ("sh_flex", "sh_abd", "sh_rot", "elbow", "pro", "wflex", "wdev")

    def __init__(self, sh_flex=0.0, sh_abd=0.0, sh_rot=0.0, elbow=math.pi / 2, pro=0.0,
                 wflex=0.0, wdev=0.0):
        self.sh_flex, self.sh_abd, self.sh_rot = sh_flex, sh_abd, sh_rot
        self.elbow, self.pro, self.wflex, self.wdev = elbow, pro, wflex, wdev


class Arm:
    def __init__(self, L_ua=0.30, L_fa=0.26, f_imu_to_wrist=(0.0, 0.008, 0.095),
                 hand_imu=(0.0, 0.010, 0.055), thumb_imu=(0.035, -0.010, 0.10)):
        self.L_ua, self.L_fa = L_ua, L_fa
        self.f_imu_to_wrist = list(f_imu_to_wrist)
        self.hand_imu = list(hand_imu)
        self.thumb_imu = list(thumb_imu)

    def segments(self, p):
        """Body <- segment quaternions for upper arm, forearm, hand, thumb."""
        # shoulder: abduction (right arm: toward -X is about -Z), forward
        # flexion (about -X), humeral rotation about the arm's own axis
        q_sh = qmul(qmul(qz(-p.sh_abd), qx(-p.sh_flex)), IDENTITY)
        q_ua = qmul(qmul(q_sh, qx(math.pi / 2)), qz(p.sh_rot))
        q_f = qmul(qmul(q_ua, qx(-p.elbow)), qz(-p.pro))
        q_h = qmul(qmul(q_f, qx(p.wflex)), qy(p.wdev))
        # thumb: rests abducted/opposed a little relative to the hand
        q_t = qmul(q_h, qmul(qy(0.35), qz(-0.5)))
        return q_ua, q_f, q_h, q_t

    def points(self, p):
        q_ua, q_f, q_h, q_t = self.segments(p)
        elbow = qrot(q_ua, [0.0, 0.0, self.L_ua])
        wrist = vadd(elbow, qrot(q_f, [0.0, 0.0, self.L_fa]))
        f_imu = vsub(wrist, qrot(q_f, self.f_imu_to_wrist))
        h_imu = vadd(wrist, qrot(q_h, self.hand_imu))
        t_imu = vadd(wrist, qrot(q_h, self.thumb_imu))
        palm = vadd(wrist, qrot(q_h, [0.0, 0.010, 0.055]))
        return {"elbow": elbow, "wrist": wrist, "palm": palm,
                "forearm": f_imu, "hand": h_imu, "thumb": t_imu}


# ----------------------------------------------------------------------------
# choreographies (functions t -> Pose). Every one starts with >= 3 s in the
# neutral pose so a neutral can be captured from it.
# ----------------------------------------------------------------------------
D = math.radians


def neutral_pose(t):
    return Pose()


def elbow_only(t):
    """Shoulder fixed and hanging; elbow, pronation and wrist move, with pauses."""
    p = Pose()
    a = bump(t, 3.0, 13.0)
    b = bump(t, 15.0, 27.0)
    p.elbow = D(90) + a * D(35) * math.sin(0.9 * (t - 3.0)) - b * D(30) * (1 - math.cos(0.7 * (t - 15.0))) * 0.5
    p.pro = a * D(45) * math.sin(0.6 * (t - 3.0)) + b * D(-55) * smooth01((t - 15.0) / 3.0)
    p.wflex = a * D(50) * math.sin(1.3 * (t - 3.0)) + b * D(-45) * math.sin(1.1 * (t - 15.0))
    p.wdev = a * D(12) * math.sin(0.8 * (t - 3.0) + 1.0) + b * D(-25) * smooth01((t - 16.0) / 2.0)
    return p


def shoulder_motion(t):
    """Arm moves through space: shoulder flexion/abduction swings with pauses,
    the forearm and wrist also moving."""
    p = Pose()
    a = bump(t, 3.0, 9.0, ramp=1.2)
    b = bump(t, 11.0, 17.0, ramp=1.0)
    c = bump(t, 19.0, 26.0, ramp=1.5)
    p.sh_flex = a * D(40) + c * D(25) * (1 - math.cos(1.2 * (t - 19.0))) * 0.5
    p.sh_abd = b * D(35) + c * D(15)
    p.sh_rot = b * D(-15)
    p.elbow = D(90) + a * D(-25) + c * D(20) * math.sin(0.9 * (t - 19.0))
    p.pro = b * D(30) + c * D(-20)
    p.wflex = a * D(20) * math.sin(1.0 * (t - 3.0)) + c * D(25) * math.sin(1.4 * (t - 19.0))
    p.wdev = b * D(-15)
    return p


def still(t):
    return Pose()


def demo_loop(t):
    """The --sim choreography: a 36 s loop through everything (elbow, wrist,
    pronation, reach with the shoulder), always returning to rest."""
    tl = t % 36.0
    p = Pose()
    a = bump(tl, 3.0, 12.0)
    b = bump(tl, 14.0, 22.0, ramp=1.2)
    c = bump(tl, 24.0, 33.0, ramp=1.0)
    p.elbow = D(90) + a * D(30) * math.sin(0.8 * (tl - 3.0)) + b * D(-35) + c * D(15) * math.sin(0.9 * (tl - 24.0))
    p.pro = a * D(40) * math.sin(0.5 * (tl - 3.0)) + c * D(-30) * smooth01((tl - 24.0) / 2.0)
    p.wflex = a * D(45) * math.sin(1.2 * (tl - 3.0)) + c * D(35) * math.sin(1.5 * (tl - 24.0))
    p.wdev = a * D(10) * math.sin(0.7 * (tl - 3.0)) + c * D(-20) * smooth01((tl - 25.0) / 2.0)
    p.sh_flex = b * D(45)
    p.sh_abd = b * D(10) + c * D(20)
    return p


# ----------------------------------------------------------------------------
# the sensors
# ----------------------------------------------------------------------------
KEYS = ("hand", "forearm", "thumb")


class Sensors:
    """Synthesizes BNO085 reports for an Arm moving along a choreography.

    mounting:  {k: M_s (S <- Segment)} - the TRUE mounting of each chip
    heading:   {k: radians} - each chip's arbitrary game-vector heading
               reference: Q_seg = H_s * C * q_s * M_s with H_s = qy(heading)
    """

    def __init__(self, arm, pose_fn, mounting, heading, seed=1, noise=True,
                 heading_drift_deg_min=None, acc_bias=None, gyr_bias=None,
                 acc_noise=0.02, gyr_noise=0.003, quat_noise_deg=0.08,
                 lin_rate_hz=400.0, thumb=True, tilt_err_deg=0.12, tilt_err_dyn_deg=0.4):
        self.arm = arm
        self.pose_fn = pose_fn
        self.M = {k: qnorm(mounting[k]) for k in KEYS}
        self.heading0 = dict(heading)
        self.rng = random.Random(seed)
        self.noise = noise
        rng = self.rng
        self.drift = heading_drift_deg_min or {k: rng.uniform(-0.8, 0.8) for k in KEYS}
        self.acc_bias = acc_bias or {k: [rng.gauss(0, 0.02) for _ in range(3)] for k in KEYS}
        self.gyr_bias = gyr_bias or {k: [rng.gauss(0, 0.0015) for _ in range(3)] for k in KEYS}
        if not noise:
            self.drift = {k: 0.0 for k in KEYS}
            self.acc_bias = {k: [0.0, 0.0, 0.0] for k in KEYS}
            self.gyr_bias = {k: [0.0, 0.0, 0.0] for k in KEYS}
        self.acc_noise = acc_noise if noise else 0.0
        self.gyr_noise = gyr_noise if noise else 0.0
        self.quat_noise = math.radians(quat_noise_deg) if noise else 0.0
        self.lin_rate = lin_rate_hz
        # The BNO085's linear acceleration is accel minus its OWN gravity
        # estimate, so any tilt error in its fusion leaks g * tilt into it:
        # 0.1 deg is 0.017 m/s^2, 0.5 deg during brisk motion is 0.085 m/s^2.
        # Modelled as a static part plus a part that grows with angular rate,
        # about a slowly wandering horizontal axis.
        self.tilt_err = math.radians(tilt_err_deg) if noise else 0.0
        self.tilt_dyn = math.radians(tilt_err_dyn_deg) if noise else 0.0
        self._tilt_phase = {k: self.rng.uniform(0, 2 * math.pi) for k in KEYS}
        self.thumb = thumb
        self._still_for = {k: 0.0 for k in KEYS}
        self._t_prev = None

    # --- truth helpers ---------------------------------------------------
    def truth(self, t):
        p = self.pose_fn(t)
        q_ua, q_f, q_h, q_t = self.arm.segments(p)
        pts = self.arm.points(p)
        return {"pose": p, "q": {"upperarm": q_ua, "forearm": q_f, "hand": q_h, "thumb": q_t},
                "pts": pts}

    def H(self, k, t):
        return qy(self.heading0[k] + math.radians(self.drift[k]) * t / 60.0)

    def _seg(self, t):
        q_ua, q_f, q_h, q_t = self.arm.segments(self.pose_fn(t))
        return {"forearm": q_f, "hand": q_h, "thumb": q_t}

    def _imu_pos(self, t):
        return self.arm.points(self.pose_fn(t))

    def sensor_in_body(self, k, t, seg=None):
        seg = seg or self._seg(t)
        return qmul(seg[k], qconj(self.M[k]))            # body <- sensor

    def raw_quat(self, k, t, seg=None):
        """q_s = C^-1 H_s^-1 (Q_seg M_s^-1)  (W_s <- S)."""
        return qnorm(qmul(qmul(qconj(C_WB), qconj(self.H(k, t))), self.sensor_in_body(k, t, seg)))

    def _gauss3(self, s):
        return [self.rng.gauss(0.0, s) for _ in range(3)] if s > 0 else [0.0, 0.0, 0.0]

    # --- one device frame -------------------------------------------------
    def frame(self, t, dt):
        """Everything the v16 firmware would report for the frame at time t
        (covering (t - dt, t]). Quaternions etc. keyed by IMU name."""
        h = 1e-3
        seg0 = self._seg(t)
        segm, segp = self._seg(t - h), self._seg(t + h)
        p0, pm, pp = self._imu_pos(t), self._imu_pos(t - h), self._imu_pos(t + h)
        pprev_m, pprev_p = self._imu_pos(t - dt - h), self._imu_pos(t - dt + h)
        out = {"t": t, "q": {}, "gyr": {}, "lin": {}, "dv": {}, "dv_n": {}, "stab": {}}
        n_rep = max(1, int(round(self.lin_rate * dt)))
        for k in KEYS:
            if k == "thumb" and not self.thumb:
                out["q"][k] = None
                continue
            rsb = self.sensor_in_body(k, t, seg0)
            # orientation (+ tiny jitter)
            q = self.raw_quat(k, t, seg0)
            if self.quat_noise > 0:
                q = qnorm(qmul(q, qfrom_rotvec(self._gauss3(self.quat_noise))))
            out["q"][k] = q
            # angular velocity of the segment, body frame, then sensor frame
            w_body = vscale(qrotvec(qmul(segp[k], qconj(segm[k]))), 1.0 / (2 * h))
            w_s = qrot(qconj(rsb), w_body)
            w_s = vadd(vadd(w_s, self.gyr_bias[k]), self._gauss3(self.gyr_noise))
            out["gyr"][k] = w_s
            # linear acceleration of the IMU point: 2nd difference of position
            a_body = vscale(vadd(vsub(pp[k], vscale(p0[k], 2.0)), pm[k]), 1.0 / (h * h))
            leak = [0.0, 0.0, 0.0]
            if self.tilt_err > 0 or self.tilt_dyn > 0:
                mag = self.tilt_err + self.tilt_dyn * min(1.0, vlen(w_body))
                ph = self._tilt_phase[k] + 0.13 * t
                axis = [math.cos(ph), 0.0, math.sin(ph)]            # horizontal
                leak = vscale(vcross_(axis, [0.0, 9.81, 0.0]), mag)  # ~ e x (g up)
            a_s = qrot(qconj(rsb), vadd(a_body, leak))
            a_s = vadd(vadd(a_s, self.acc_bias[k]), self._gauss3(self.acc_noise))
            out["lin"][k] = a_s
            # dv: velocity change over the frame, in W_s (Z up), plus the bias and
            # the per-report noise the firmware would have summed
            v1 = vscale(vsub(pp[k], pm[k]), 1.0 / (2 * h))
            v0 = vscale(vsub(pprev_p[k], pprev_m[k]), 1.0 / (2 * h))
            dv_body = vadd(vsub(v1, v0), vscale(leak, dt))
            w_from_b = qmul(qconj(C_WB), qconj(self.H(k, t)))       # W_s <- body
            dv_w = qrot(w_from_b, dv_body)
            q_ws = qmul(w_from_b, rsb)                               # W_s <- S
            dv_w = vadd(dv_w, vscale(qrot(q_ws, self.acc_bias[k]), dt))
            if self.acc_noise > 0:
                dv_w = vadd(dv_w, self._gauss3(self.acc_noise * dt / math.sqrt(n_rep)))
            out["dv"][k] = dv_w
            out["dv_n"][k] = n_rep
            # stability class: stationary after 0.3 s of true rest, else motion
            quiet = vlen(w_body) < 0.02 and vlen(a_body) < 0.03
            self._still_for[k] = self._still_for[k] + dt if quiet else 0.0
            out["stab"][k] = 2 if self._still_for[k] >= 0.3 else 4
        return out


# ----------------------------------------------------------------------------
# a realistic default setup: the bridge's bench mounting priors, perturbed
# ----------------------------------------------------------------------------
def perturb(q, deg, rng):
    """q * (a random rotation of exactly `deg` degrees)."""
    ax = vnorm([rng.gauss(0, 1) for _ in range(3)], Z_AXIS)
    return qnorm(qmul(q, qaxis_angle(ax, math.radians(deg))))
