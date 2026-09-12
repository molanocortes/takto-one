"""camera.py - the capture thread, and the one clock everything is stamped on.

Every sample the lab records, camera frame or device snapshot, carries a
time from time.monotonic_ns() taken on this machine the moment it arrived.
That is the alignment: one clock, no offsets to guess. The camera frame's
stamp is taken immediately after the driver hands it over, which on macOS
(AVFoundation) trails the sensor exposure by a small, steady latency; it is
reported once per session as the camera's own measured period so the reader
knows what a frame time means.

The FaceTime camera in this Mac delivers 30 frames per second at 1280x720 and
no more, whatever is requested; the thread measures the real rate and the
page shows it, so a claim of "high speed" is never made by the software, only
by the camera that is actually attached.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Frame:
    idx: int
    t_ns: int          # monotonic, this machine
    t_wall: float      # time.time() at the same instant, for the record only
    image: np.ndarray  # BGR


@dataclass
class CameraStats:
    width: int = 0
    height: int = 0
    fps_requested: float = 0.0
    fps_reported: float = 0.0
    fps_measured: float = 0.0
    frames: int = 0
    dropped_reads: int = 0
    opened: bool = False
    error: str = ""
    period_ms_p50: float = 0.0
    period_ms_p95: float = 0.0
    _periods: list = field(default_factory=list)


class Camera:
    """Reads frames as fast as the device allows on its own thread. Consumers
    take the latest frame (preview, live tracker) or subscribe to every frame
    (the recorder), never blocking the reader."""

    def __init__(self, index: int = 0, width: int = 1280, height: int = 720, fps: float = 60.0, source: str | None = None):
        self.index = index
        self.width, self.height, self.fps = width, height, fps
        self.source = source        # a video file stands in for the camera (tests, replays)
        self.stats = CameraStats(fps_requested=fps)
        self._cap: cv2.VideoCapture | None = None
        self._latest: Frame | None = None
        self._lock = threading.Lock()
        self._subs: list = []       # queues receiving every frame
        self._run = False
        self._thread: threading.Thread | None = None

    def open(self) -> bool:
        if self.source:
            cap = cv2.VideoCapture(self.source)
        else:
            cap = cv2.VideoCapture(self.index, cv2.CAP_AVFOUNDATION)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
            cap.set(cv2.CAP_PROP_FPS, self.fps)
        ok, img = cap.read()
        if not ok or img is None:
            self.stats.opened = False
            self.stats.error = "no frame from the camera (is camera access allowed for this terminal?)"
            cap.release()
            return False
        self._cap = cap
        self.stats.opened = True
        self.stats.error = ""
        self.stats.width, self.stats.height = int(img.shape[1]), int(img.shape[0])
        self.stats.fps_reported = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        return True

    def start(self):
        if self._run:
            return
        if self._cap is None and not self.open():
            return
        self._run = True
        self._thread = threading.Thread(target=self._loop, name="camera", daemon=True)
        self._thread.start()

    def stop(self):
        self._run = False
        if self._thread:
            self._thread.join(timeout=2)
        if self._cap is not None:
            self._cap.release()
            self._cap = None
        self.stats.opened = False

    def subscribe(self, q):
        with self._lock:
            self._subs.append(q)

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def latest(self) -> Frame | None:
        return self._latest

    def _loop(self):
        idx = 0
        last_ns = 0
        ema = 0.0
        periods: list[float] = []
        cap = self._cap
        file_fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0) if self.source else 0.0
        while self._run and cap is not None:
            ok, img = cap.read()
            t_ns = time.monotonic_ns()
            if not ok or img is None:
                if self.source:
                    # a file loops, so a bench rehearsal never runs out of picture
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                self.stats.dropped_reads += 1
                time.sleep(0.002)
                continue
            if self.source and file_fps > 0:
                time.sleep(max(0.0, 1.0 / file_fps - 0.001))
            fr = Frame(idx, t_ns, time.time(), img)
            idx += 1
            if last_ns:
                p = (t_ns - last_ns) / 1e6
                ema = p if ema == 0 else ema * 0.9 + p * 0.1
                periods.append(p)
                if len(periods) > 300:
                    periods.pop(0)
                self.stats.fps_measured = 1000.0 / ema if ema > 0 else 0.0
                if len(periods) >= 30 and idx % 30 == 0:
                    arr = np.array(periods)
                    self.stats.period_ms_p50 = float(np.percentile(arr, 50))
                    self.stats.period_ms_p95 = float(np.percentile(arr, 95))
            last_ns = t_ns
            self.stats.frames = idx
            self._latest = fr
            with self._lock:
                subs = list(self._subs)
            for q in subs:
                try:
                    q.put_nowait(fr)
                except Exception:
                    pass
