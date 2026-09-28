"""kinematics.py - the shared mechanical model, in Python.

A line-for-line port of software/app/src/data/kinematics.js (KIN_VERSION 3),
the ONE model every twin renders from. It exists here so the lab can turn a
finger pose the camera measured into the spool (motor) angles the device must
reach: the inverse kinematics of a tendon-driven joint is the spool law
itself, theta_spool = (h_arm / r_spool) * theta_joint, and the telescopic
slides are what the mechanism must do to permit that angle.

tests/test_kinematics.py proves parity against the JavaScript by running the
same inputs through node; change the constants in the .js and here together,
or nowhere.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

KIN_VERSION = 3

H_RAIL_MM = 8.0
KAPPA = 0.5
SEG_MM = {
    "index": (40.0, 24.0, 18.0),
    "middle": (45.0, 28.0, 22.0),
    "ring": (42.0, 27.0, 20.0),
    "pinky": (33.0, 20.0, 17.0),
}
H_ARM_MM = 5.0
R_SPOOL_MM = 5.0
SPOOL_PER_JOINT = H_ARM_MM / R_SPOOL_MM

AB_MIN, AB_MAX = -16.0, 16.0
MCP_MIN, MCP_MAX = -10.0, 90.0
PIP_MIN, PIP_MAX = -10.0, 110.0

FINGERS = ("index", "middle", "ring", "pinky")

SPOOL_STATIONS = {
    "spool_a0": ("index", "mcp"), "spool_a1": ("middle", "mcp"),
    "spool_a2": ("ring", "mcp"), "spool_a3": ("pinky", "mcp"), "spool_a4": None,
    "spool_b0": ("index", "pip"), "spool_b1": ("middle", "pip"),
    "spool_b2": ("ring", "pip"), "spool_b3": ("pinky", "pip"), "spool_b4": None,
}


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def slide_exact(theta_rad: float, a_mm: float, b_mm: float, h_mm: float = H_RAIL_MM) -> float:
    c, s = math.cos(theta_rad), math.sin(theta_rad)
    dx = a_mm + b_mm * c + h_mm * s
    dy = h_mm * (1 - c) + b_mm * s
    return math.hypot(dx, dy) - (a_mm + b_mm)


def slide_link(theta_rad: float, span_mm: float, h_mm: float = H_RAIL_MM) -> float:
    c, s = math.cos(theta_rad), math.sin(theta_rad)
    d = math.sqrt(span_mm * span_mm + 2 * h_mm * h_mm * (1 - c) + 2 * span_mm * h_mm * s)
    return d - span_mm


def slide_knuckle(theta_rad: float, h_mm: float = H_RAIL_MM) -> float:
    return h_mm * math.tan(theta_rad / 2)


@dataclass(frozen=True)
class FingerPose:
    ab: float
    mcp: float
    pip: float
    slide_knuckle_mm: float
    slide_mcp_mm: float
    slide_mcp_mid_mm: float
    slide_pip_mm: float
    spool_mcp_deg: float
    spool_pip_deg: float

    def as_dict(self) -> dict:
        return {
            "ab": self.ab, "mcp": self.mcp, "pip": self.pip,
            "slideKnuckleMm": self.slide_knuckle_mm, "slideMcpMm": self.slide_mcp_mm,
            "slideMcpMidMm": self.slide_mcp_mid_mm, "slidePipMm": self.slide_pip_mm,
            "spoolMcpDeg": self.spool_mcp_deg, "spoolPipDeg": self.spool_pip_deg,
        }


def finger_pose(finger: str, ab_deg: float | None, mcp_deg: float | None, pip_deg: float | None) -> FingerPose:
    """Every rigid-body coordinate of one finger's mechanism for the three
    wire-contract channels (deg): {f}_mcp = abduction, {f}_pip = MCP flexion,
    {f}_dip = PIP flexion."""
    seg = SEG_MM.get(finger, SEG_MM["middle"])
    ab = clamp(0.0 if ab_deg is None else ab_deg, AB_MIN, AB_MAX)
    mcp = clamp(8.0 if mcp_deg is None else mcp_deg, MCP_MIN, MCP_MAX)
    pip = clamp(8.0 if pip_deg is None else pip_deg, PIP_MIN, PIP_MAX)
    d2r = math.pi / 180
    sk = slide_knuckle(max(0.0, mcp) * d2r)
    sm = slide_link(max(0.0, mcp) * d2r, seg[0])
    sp = slide_link(max(0.0, pip) * d2r, seg[1])
    return FingerPose(ab, mcp, pip, sk, sm, sm / 2, sp,
                      SPOOL_PER_JOINT * max(0.0, mcp), SPOOL_PER_JOINT * max(0.0, pip))


def spool_angle_deg(station: str, poses: dict[str, FingerPose], motors_deg: dict[str, float] | None = None) -> float:
    st = SPOOL_STATIONS.get(station)
    if not st:
        return 0.0
    finger, joint = st
    m = (motors_deg or {}).get(f"{finger}_drive")
    if joint == "mcp" and isinstance(m, (int, float)) and math.isfinite(m):
        return SPOOL_PER_JOINT * max(0.0, float(m))
    p = poses.get(finger)
    if p is None:
        return 0.0
    return p.spool_mcp_deg if joint == "mcp" else p.spool_pip_deg


def inverse_kinematics(finger: str, mcp_deg: float, pip_deg: float, ab_deg: float = 0.0) -> dict:
    """Joint angles the camera measured -> what the device must do to be there:
    the spool rotations for the two driven joints (the motor goal, in spool
    degrees; the drive shares the spool axis) and the three slides. This is
    the whole inverse problem for a tendon-and-rail finger: one law per joint,
    no iteration, no ambiguity."""
    p = finger_pose(finger, ab_deg, mcp_deg, pip_deg)
    return {
        "finger": finger,
        "target_deg": {"mcp": p.mcp, "pip": p.pip, "ab": p.ab},
        "spool_deg": {"mcp": p.spool_mcp_deg, "pip": p.spool_pip_deg},
        "tendon_mm": {"mcp": p.spool_mcp_deg * math.pi / 180 * R_SPOOL_MM,
                      "pip": p.spool_pip_deg * math.pi / 180 * R_SPOOL_MM},
        "slides_mm": {"knuckle": p.slide_knuckle_mm, "mcp": p.slide_mcp_mm,
                      "mcp_mid": p.slide_mcp_mid_mm, "pip": p.slide_pip_mm},
    }
