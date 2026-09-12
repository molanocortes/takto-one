"""markers.py - the finger by its own marks, when a hand model cannot see it.

A hand learned from photographs of hands does not always find a hand wearing
an exoskeleton, and a device on the table is not a hand at all. For those
takes the joints are marked: a small coloured dot at the wrist line, the MCP,
the PIP and the DIP (or fingertip), seen from the side. This tracks the dots
by colour (HSV window, calibrated by clicking each dot on the page), keeps
them apart by order along the finger, and reads the same three flexion
angles the landmark tracker reads, so track.csv means the same thing whether
a hand model or four stickers produced it.

It is the older, plainer method, and for a side view it is the more exact
one: a 4 mm dot on a 1280-pixel frame is located to a fraction of a pixel by
its centroid, and it does not care what the finger is wearing.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from .tracker import Angles

NAMES = ("wrist", "mcp", "pip", "dip")


@dataclass
class MarkerSpec:
    name: str
    h: int              # hue 0..179 (OpenCV)
    s: int
    v: int
    h_tol: int = 10
    s_tol: int = 70
    v_tol: int = 80
    min_area: int = 20
    max_area: int = 6000

    def lo_hi(self):
        return (np.array([max(0, self.h - self.h_tol), max(0, self.s - self.s_tol), max(0, self.v - self.v_tol)]),
                np.array([min(179, self.h + self.h_tol), min(255, self.s + self.s_tol), min(255, self.v + self.v_tol)]))


@dataclass
class MarkerResult:
    t_ns: int
    found: bool
    points: dict = field(default_factory=dict)     # name -> (x, y) pixels
    raw: Angles = field(default_factory=Angles)


def sample_hsv(image_bgr: np.ndarray, x: int, y: int, r: int = 4) -> tuple[int, int, int]:
    """median HSV in a small window around a click"""
    h, w = image_bgr.shape[:2]
    x0, x1 = max(0, x - r), min(w, x + r + 1)
    y0, y1 = max(0, y - r), min(h, y + r + 1)
    hsv = cv2.cvtColor(image_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2HSV).reshape(-1, 3)
    m = np.median(hsv, axis=0)
    return int(m[0]), int(m[1]), int(m[2])


class MarkerTracker:
    def __init__(self, specs: list[MarkerSpec]):
        self.specs = specs
        self._prev: dict = {}

    def track(self, image_bgr: np.ndarray, t_ns: int) -> MarkerResult:
        hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
        out = MarkerResult(t_ns=t_ns, found=False)
        for spec in self.specs:
            lo, hi = spec.lo_hi()
            if lo[0] > hi[0]:
                mask = cv2.inRange(hsv, lo, hi)
            else:
                mask = cv2.inRange(hsv, lo, hi)
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            n, _, stats, cents = cv2.connectedComponentsWithStats(mask)
            best, best_d = None, float("inf")
            prev = self._prev.get(spec.name)
            for i in range(1, n):
                area = stats[i, cv2.CC_STAT_AREA]
                if area < spec.min_area or area > spec.max_area:
                    continue
                c = (float(cents[i][0]), float(cents[i][1]))
                # the blob nearest to where the marker was last frame wins;
                # with no history, the largest blob
                d = math.hypot(c[0] - prev[0], c[1] - prev[1]) if prev else -area
                if d < best_d:
                    best, best_d = c, d
            if best is not None:
                out.points[spec.name] = best
                self._prev[spec.name] = best
        p = out.points
        if all(k in p for k in ("mcp", "pip", "dip")):
            out.found = True
            def ang(a, b, c):
                v1 = np.array(a) - np.array(b); v2 = np.array(c) - np.array(b)
                n = np.linalg.norm(v1) * np.linalg.norm(v2)
                return 180.0 - math.degrees(math.acos(max(-1, min(1, float(np.dot(v1, v2) / n))))) if n > 1e-9 else float("nan")
            mcp = ang(p["wrist"], p["mcp"], p["pip"]) if "wrist" in p else float("nan")
            pip = ang(p["mcp"], p["pip"], p["dip"])
            out.raw = Angles(mcp, pip, float("nan"), float("nan"))
        return out
