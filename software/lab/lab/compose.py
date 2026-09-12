"""compose.py - the two-panel portrait video, cut for a phone.

1080 x 1920, two panels of 1080 x 960 stacked: the top panel is always the
camera's truth, the bottom is what is being compared with it (the device's
twin, the same finger wearing the device, the robot copying it). Both panels
start at their own motion onset, so the two movements begin on the same
frame; the frame times come from frames.csv, never from the container, and
each output frame takes the nearest recorded frame to its instant.

Text is deliberately sparse: a mono-caps label per panel, one headline
number, and a small footer with the method, so the number is never a bare
claim. Fonts are the project's own (Inter, JetBrains Mono).
"""
from __future__ import annotations

import csv
import math
import os
import subprocess
from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .recorder import ffmpeg_exe

W, H = 1080, 1920
PANEL_H = H // 2
FONTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "fonts")

INK = (26, 26, 28)
INK2 = (110, 110, 116)
PAGE = (246, 245, 242)
GREEN = (32, 160, 96)


def _font(name: str, size: int) -> ImageFont.FreeTypeFont:
    p = os.path.join(FONTS, name)
    try:
        return ImageFont.truetype(p, size)
    except Exception:
        return ImageFont.load_default()


@dataclass
class Panel:
    """one video panel: a take's video with its frames.csv, or a directory of
    numbered PNG frames rendered by the twin page (with a times.csv beside it)"""
    label: str
    video: str | None = None
    frames_csv: str | None = None
    frames_dir: str | None = None          # twin renders: %06d.png
    crop: tuple | None = None              # (x, y, w, h) in source pixels, None = whole frame
    t_start_ns: int = 0                    # the instant this panel's clock is 0 (motion onset)
    _times: np.ndarray = field(default_factory=lambda: np.zeros(0))
    _cap: object = None
    _last_idx: int = -1
    _last_img: object = None

    def open(self):
        if self.frames_csv:
            with open(self.frames_csv, newline="") as f:
                r = csv.reader(f); next(r, None)
                self._times = np.array([int(row[1]) for row in r], dtype=np.int64)
        if self.video:
            self._cap = cv2.VideoCapture(self.video)
        return self

    def duration_s(self) -> float:
        if len(self._times) == 0:
            return 0.0
        return float((self._times[-1] - self.t_start_ns) / 1e9)

    def frame_at(self, t_s: float) -> np.ndarray | None:
        """nearest recorded frame to t_s seconds after this panel's start"""
        if len(self._times) == 0:
            return None
        want = self.t_start_ns + int(t_s * 1e9)
        idx = int(np.searchsorted(self._times, want))
        if idx > 0 and (idx >= len(self._times) or abs(self._times[idx - 1] - want) <= abs(self._times[idx] - want)):
            idx -= 1
        idx = max(0, min(len(self._times) - 1, idx))
        if idx == self._last_idx:
            return self._last_img
        img = None
        if self._cap is not None:
            if idx != self._last_idx + 1:
                self._cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, img = self._cap.read()
            if not ok:
                img = None
        elif self.frames_dir:
            p = os.path.join(self.frames_dir, "%06d.png" % idx)
            img = cv2.imread(p) if os.path.exists(p) else None
        self._last_idx, self._last_img = idx, img
        return img


def fit_panel(img: np.ndarray, crop: tuple | None) -> np.ndarray:
    """crop (or not), then cover-fit into W x PANEL_H"""
    if img is None:
        return np.full((PANEL_H, W, 3), PAGE[::-1], np.uint8)
    if crop:
        x, y, w, h = [int(v) for v in crop]
        x, y = max(0, x), max(0, y)
        img = img[y:y + max(1, h), x:x + max(1, w)]
    ih, iw = img.shape[:2]
    s = max(W / iw, PANEL_H / ih)
    nw, nh = max(1, int(round(iw * s))), max(1, int(round(ih * s)))
    img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    x0, y0 = (nw - W) // 2, (nh - PANEL_H) // 2
    return img[y0:y0 + PANEL_H, x0:x0 + W]


def overlay(frame: np.ndarray, top: Panel, bottom: Panel, headline: str, sub: str, footer: str, t_s: float) -> np.ndarray:
    im = Image.fromarray(frame[:, :, ::-1])
    d = ImageDraw.Draw(im, "RGBA")
    mono = _font("JetBrainsMono_500Medium.ttf", 30)
    small = _font("JetBrainsMono_400Regular.ttf", 24)
    big = _font("Inter_300Light.ttf", 150)
    med = _font("Inter_400Regular.ttf", 40)
    # panel labels, mono caps, top-left of each panel on a soft plate
    for y, p in ((0, top), (PANEL_H, bottom)):
        txt = p.label.upper()
        tw = d.textlength(txt, font=mono)
        d.rounded_rectangle((40, y + 40, 40 + tw + 44, y + 40 + 62), 10, fill=(255, 255, 255, 215))
        d.text((62, y + 40 + 13), txt, font=mono, fill=INK)
    # divider hairline
    d.line((0, PANEL_H, W, PANEL_H), fill=(255, 255, 255, 140), width=2)
    # headline number in the bottom panel's lower-left, on a plate
    if headline:
        hw = d.textlength(headline, font=big)
        sw = d.textlength(sub, font=med) if sub else 0
        pw = max(hw, sw) + 80
        y0 = H - 340
        d.rounded_rectangle((40, y0, 40 + pw, H - 120), 18, fill=(255, 255, 255, 225))
        d.text((80, y0 + 10), headline, font=big, fill=INK)
        if sub:
            d.text((82, y0 + 175), sub, font=med, fill=INK2)
    # footer and time stamp on their own plates, legible on any picture
    ts = f"{t_s:6.2f} s"
    tw = d.textlength(ts, font=small)
    d.rounded_rectangle((W - 40 - tw - 28, H - 88, W - 40 + 14, H - 40), 8, fill=(255, 255, 255, 215))
    d.text((W - 40 - tw - 14, H - 80), ts, font=small, fill=INK2)
    if footer:
        fw = d.textlength(footer.upper(), font=small)
        d.rounded_rectangle((40, H - 88, 40 + fw + 28, H - 40), 8, fill=(255, 255, 255, 215))
        d.text((54, H - 80), footer.upper(), font=small, fill=INK2)
    return np.asarray(im)[:, :, ::-1].copy()


def render(top: Panel, bottom: Panel, out_mp4: str, headline: str = "", sub: str = "", footer: str = "",
           fps: float = 30.0, slow: float = 1.0, duration_s: float | None = None, progress=None) -> dict:
    """slow > 1 plays both panels slower (2 = half speed) without inventing
    frames: nearest-frame sampling, like the recorded rate allows"""
    top.open(); bottom.open()
    dur = min(top.duration_s(), bottom.duration_s())
    if duration_s:
        dur = min(dur, duration_s)
    n = int(dur * fps * slow)
    os.makedirs(os.path.dirname(out_mp4), exist_ok=True)
    cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", out_mp4]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    for i in range(n):
        t = i / fps / slow
        a = fit_panel(top.frame_at(t), top.crop)
        b = fit_panel(bottom.frame_at(t), bottom.crop)
        frame = np.vstack([a, b])
        frame = overlay(frame, top, bottom, headline, sub, footer, t)
        proc.stdin.write(frame.tobytes())
        if progress and i % 15 == 0:
            progress(i / max(1, n))
    proc.stdin.close()
    proc.wait()
    err = proc.stderr.read().decode(errors="ignore")[-300:]
    return {"frames": n, "duration_s": n / fps, "path": out_mp4, "ffmpeg_error": err}
