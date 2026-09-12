"""recorder.py - every frame to disk, with its time.

The video goes to ffmpeg over a pipe (Apple's hardware H.264 encoder, high
bitrate, so the tracker's second pass sees what the camera saw), and the
frame times go to frames.csv beside it: one row per encoded frame, index,
monotonic nanoseconds, wall clock. The video's own timeline is nominal (a
constant rate); the CSV is the truth, and every later step reads times from
it, never from the container.
"""
from __future__ import annotations

import csv
import os
import queue
import subprocess
import threading
import time

from .camera import Frame


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


class Recorder:
    def __init__(self, path_mp4: str, path_csv: str, width: int, height: int, fps: float, bitrate: str = "24M"):
        self.path_mp4, self.path_csv = path_mp4, path_csv
        self.width, self.height, self.fps = width, height, max(1.0, round(fps))
        self.q: queue.Queue = queue.Queue(maxsize=600)
        self.frames = 0
        self.dropped = 0
        self.first_ns = 0
        self.last_ns = 0
        self._proc = None
        self._thread = None
        self._run = False
        self._bitrate = bitrate

    def start(self):
        os.makedirs(os.path.dirname(self.path_mp4), exist_ok=True)
        cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{self.width}x{self.height}",
               "-r", str(self.fps), "-i", "-",
               "-c:v", "h264_videotoolbox", "-b:v", self._bitrate, "-pix_fmt", "yuv420p",
               "-movflags", "+faststart", self.path_mp4]
        self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        self._csv = open(self.path_csv, "w", newline="")
        self._w = csv.writer(self._csv)
        self._w.writerow(["idx", "t_ns", "t_wall", "cam_idx"])
        self._run = True
        self._thread = threading.Thread(target=self._loop, name="recorder", daemon=True)
        self._thread.start()

    def push(self, fr: Frame):
        if not self._run:
            return
        try:
            self.q.put_nowait(fr)
        except queue.Full:
            self.dropped += 1

    def _loop(self):
        while self._run or not self.q.empty():
            try:
                fr = self.q.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                self._proc.stdin.write(fr.image.tobytes())
            except Exception:
                self._run = False
                break
            if not self.first_ns:
                self.first_ns = fr.t_ns
            self.last_ns = fr.t_ns
            self._w.writerow([self.frames, fr.t_ns, f"{fr.t_wall:.6f}", fr.idx])
            self.frames += 1

    def stop(self) -> dict:
        self._run = False
        if self._thread:
            self._thread.join(timeout=10)
        try:
            self._proc.stdin.close()
            self._proc.wait(timeout=30)
        except Exception:
            pass
        err = b""
        try:
            err = self._proc.stderr.read()
        except Exception:
            pass
        self._csv.close()
        dur = (self.last_ns - self.first_ns) / 1e9 if self.frames > 1 else 0.0
        return {"frames": self.frames, "dropped": self.dropped, "duration_s": dur,
                "fps_effective": (self.frames - 1) / dur if dur > 0 else 0.0,
                "ffmpeg_error": err.decode(errors="ignore")[-400:]}
