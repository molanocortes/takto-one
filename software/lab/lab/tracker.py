"""tracker.py - the index finger, measured from the picture.

MediaPipe's hand landmarker gives 21 points per hand; this reads three joint
angles of the index finger from them and nothing else:

    MCP flexion   at landmark 5, between wrist->5 and 5->6
    PIP flexion   at landmark 6, between 5->6 and 6->7
    DIP flexion   at landmark 7, between 6->7 and 7->8

reported as flexion in degrees, 0 = the three points in a line, so the number
means the same thing the device's encoders mean after their neutral capture.
The world landmarks (metres, hand-centred) are used when present, because an
angle read in the image plane shrinks whenever the finger leans out of it;
the image landmarks are kept for drawing and as the fallback.

Two passes share this code: the live pass (feedback on the page, and the
targets for the follow protocols) runs on whatever frame is newest, and the
analysis pass re-runs on every frame of the saved video so the dataset is
complete and reproducible whatever the live load was. A One Euro filter
smooths the live reading for the eye and the follower; the analysis pass
filters offline with a zero-phase filter instead, so timing is not biased.
"""
from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass, field

import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "models", "hand_landmarker.task")

# landmark indices, MediaPipe hand topology
WRIST = 0
INDEX = (5, 6, 7, 8)     # mcp, pip, dip, tip
MIDDLE = (9, 10, 11, 12)


@dataclass
class Angles:
    mcp: float = float("nan")
    pip: float = float("nan")
    dip: float = float("nan")
    ab: float = float("nan")      # abduction of the index away from the middle finger, deg


@dataclass
class TrackResult:
    t_ns: int
    found: bool
    score: float = 0.0
    handed: str = ""
    lm: list = field(default_factory=list)      # 21 x (x, y, z) normalised image coords
    world: list = field(default_factory=list)   # 21 x (x, y, z) metres
    raw: Angles = field(default_factory=Angles)
    smooth: Angles = field(default_factory=Angles)
    infer_ms: float = 0.0


def _angle(a, b, c) -> float:
    """interior angle at b, degrees"""
    v1 = np.asarray(a, float) - np.asarray(b, float)
    v2 = np.asarray(c, float) - np.asarray(b, float)
    n = np.linalg.norm(v1) * np.linalg.norm(v2)
    if n < 1e-12:
        return float("nan")
    return math.degrees(math.acos(max(-1.0, min(1.0, float(np.dot(v1, v2) / n)))))


def angles_from_points(pts) -> Angles:
    """pts: 21 x 3 array-like. Flexion = 180 - interior angle, 0 = straight."""
    p = np.asarray(pts, float)
    mcp = 180.0 - _angle(p[WRIST], p[INDEX[0]], p[INDEX[1]])
    pip = 180.0 - _angle(p[INDEX[0]], p[INDEX[1]], p[INDEX[2]])
    dip = 180.0 - _angle(p[INDEX[1]], p[INDEX[2]], p[INDEX[3]])
    # abduction: angle between the index and middle proximal phalanx directions,
    # signed positive when the index swings away from the middle finger
    vi = p[INDEX[1]] - p[INDEX[0]]
    vm = p[MIDDLE[1]] - p[MIDDLE[0]]
    ab = _angle(p[INDEX[0]] + vi, p[INDEX[0]], p[INDEX[0]] + vm)
    return Angles(mcp, pip, dip, ab)


class OneEuro:
    """Casiez et al. 2012. Low lag at speed, low jitter at rest."""

    def __init__(self, min_cutoff=1.0, beta=0.02, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x_prev = self.dx_prev = None
        self.t_prev = None

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, x: float, t: float) -> float:
        if x != x:      # nan passes through, resets nothing
            return x
        if self.x_prev is None or self.t_prev is None:
            self.x_prev, self.dx_prev, self.t_prev = x, 0.0, t
            return x
        dt = max(1e-3, t - self.t_prev)
        self.t_prev = t
        dx = (x - self.x_prev) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        dx_hat = a_d * dx + (1 - a_d) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = self._alpha(cutoff, dt)
        x_hat = a * x + (1 - a) * self.x_prev
        self.x_prev, self.dx_prev = x_hat, dx_hat
        return x_hat


class HandTracker:
    def __init__(self, model_path: str = MODEL_PATH, min_conf: float = 0.5, smooth: bool = True):
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        self._mp = mp
        self._vision = vision
        opts = vision.HandLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=model_path),
            running_mode=vision.RunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=min_conf,
            min_hand_presence_confidence=min_conf,
            min_tracking_confidence=min_conf,
        )
        self._lm = vision.HandLandmarker.create_from_options(opts)
        self._last_ts_ms = -1
        self._filters = {k: OneEuro() for k in ("mcp", "pip", "dip", "ab")} if smooth else None

    def close(self):
        try:
            self._lm.close()
        except Exception:
            pass

    def reset_smoothing(self):
        if self._filters:
            for f in self._filters.values():
                f.x_prev = f.dx_prev = f.t_prev = None

    def track(self, image_bgr: np.ndarray, t_ns: int) -> TrackResult:
        """image_bgr: the frame. t_ns: its monotonic stamp; the landmarker
        needs a strictly increasing millisecond clock, which this provides."""
        t0 = time.perf_counter()
        ts_ms = int(t_ns // 1_000_000)
        if ts_ms <= self._last_ts_ms:
            ts_ms = self._last_ts_ms + 1
        self._last_ts_ms = ts_ms
        rgb = image_bgr[:, :, ::-1]
        mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        res = self._lm.detect_for_video(mp_img, ts_ms)
        out = TrackResult(t_ns=t_ns, found=False)
        if res.hand_landmarks:
            lm = res.hand_landmarks[0]
            out.found = True
            out.lm = [(p.x, p.y, p.z) for p in lm]
            if res.hand_world_landmarks:
                out.world = [(p.x, p.y, p.z) for p in res.hand_world_landmarks[0]]
            if res.handedness and res.handedness[0]:
                out.score = float(res.handedness[0][0].score)
                out.handed = res.handedness[0][0].category_name
            pts = out.world if out.world else out.lm
            out.raw = angles_from_points(pts)
            if self._filters:
                t = t_ns / 1e9
                out.smooth = Angles(
                    self._filters["mcp"](out.raw.mcp, t), self._filters["pip"](out.raw.pip, t),
                    self._filters["dip"](out.raw.dip, t), self._filters["ab"](out.raw.ab, t))
            else:
                out.smooth = out.raw
        out.infer_ms = (time.perf_counter() - t0) * 1000
        return out
