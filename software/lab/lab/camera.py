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
    note: str = ""
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
        """Open the source and prove it delivers frames. A camera that macOS
        has not authorised for this process opens and then never delivers a
        frame; OpenCV only says so on stderr, so stderr is captured around the
        attempt and the reason is written where the page can show it."""
        self.stats.error = ""
        if self.source:
            cap = cv2.VideoCapture(self.source)
            ok, img = cap.read()
            if not ok or img is None:
                cap.release()
                self.stats.opened = False
                self.stats.error = f"cannot read {self.source}"
                return False
            self._adopt(cap, img)
            return True
        attempts = [("requested", True), ("driver defaults", False)]
        last_err = ""
        for label, with_props in attempts:
            cap, img, err = self._try_open(with_props)
            if cap is not None:
                self._adopt(cap, img)
                if not with_props:
                    self.stats.note = "camera refused the requested mode; running at the driver's defaults"
                return True
            last_err = err
        self.stats.opened = False
        self.stats.error = last_err or "no frame from the camera"
        return False

    def _try_open(self, with_props: bool):
        import io, os, sys, tempfile
        # capture OpenCV's stderr for the duration of the attempt
        fd = sys.stderr.fileno()
        saved = os.dup(fd)
        tmp = tempfile.TemporaryFile(mode="w+b")
        os.dup2(tmp.fileno(), fd)
        try:
            cap = cv2.VideoCapture(self.index, cv2.CAP_AVFOUNDATION)
            if with_props:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
                if self.fps:
                    cap.set(cv2.CAP_PROP_FPS, self.fps)
            img = None
            t0 = time.monotonic()
            while time.monotonic() - t0 < 3.0:       # warm-up: the first frames may take a moment
                ok, img = cap.read()
                if ok and img is not None:
                    break
                time.sleep(0.05)
        finally:
            os.dup2(saved, fd)
            os.close(saved)
        tmp.seek(0)
        log = tmp.read().decode(errors="ignore")
        tmp.close()
        if img is not None:
            return cap, img, ""
        cap.release()
        if "not authorized" in log:
            return None, None, ("macOS has not allowed this process to use the camera. Run the lab from Terminal.app "
                                "(it asks once), or allow the camera for the app that launched it in System Settings "
                                "> Privacy & Security > Camera.")
        if "can't be used to capture by index" in log or "failed to properly initialize" in log:
            return None, None, f"no camera at index {self.index} (or access denied); pick another camera below"
        return None, None, "no frame from the camera"

    def _adopt(self, cap, img):
        self._cap = cap
        self.stats.opened = True
        self.stats.width, self.stats.height = int(img.shape[1]), int(img.shape[0])
        self.stats.fps_reported = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)

    def reopen(self, index: int | None = None, width: int | None = None, height: int | None = None, fps: float | None = None) -> bool:
        """switch camera or mode at runtime; the reader thread keeps running"""
        if index is not None:
            self.index = index
        if width:
            self.width = width
        if height:
            self.height = height
        if fps is not None:
            self.fps = fps
        old = self._cap
        self._cap = None
        if old is not None:
            try:
                old.release()
            except Exception:
                pass
        ok = self.open()
        if ok and not self._run:
            self.start()
        return ok

    @staticmethod
    def list_cameras(max_index: int = 4) -> list:
        """which indices deliver a frame right now, with their default size;
        names come from the system, which lists them in the same order as
        AVFoundation enumerates them"""
        import subprocess, json
        names = []
        try:
            out = subprocess.run(["system_profiler", "SPCameraDataType", "-json"], capture_output=True, text=True, timeout=8).stdout
            names = [c.get("_name", "") for c in json.loads(out).get("SPCameraDataType", [])]
        except Exception:
            pass
        found = []
        for i in range(max_index + 1):
            cap = cv2.VideoCapture(i, cv2.CAP_AVFOUNDATION)
            ok, img = cap.read()
            if ok and img is not None:
                found.append({"index": i, "name": names[i] if i < len(names) else f"camera {i}", "width": int(img.shape[1]), "height": int(img.shape[0]),
                              "fps": float(cap.get(cv2.CAP_PROP_FPS) or 0)})
            cap.release()
            if not ok and i >= len(names) and i > 0:
                break
        return found

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
        file_fps = float(self._cap.get(cv2.CAP_PROP_FPS) or 30.0) if (self.source and self._cap is not None) else 0.0
        while self._run:
            cap = self._cap
            if cap is None:
                time.sleep(0.05)
                continue
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
