"""Smoke test of the tracker and the recorder without a camera: the landmarker
runs on blank frames (no hand, and it must say so quickly), and the recorder
writes a short real MP4 through ffmpeg with a frames.csv beside it."""
import os, sys, tempfile, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
from lab.tracker import HandTracker, angles_from_points  # noqa: E402
from lab.recorder import Recorder  # noqa: E402
from lab.camera import Frame  # noqa: E402


def test_angles_geometry():
    pts = np.zeros((21, 3))
    # a straight index finger along +x: wrist(0,0) mcp(1,0) pip(2,0) dip(3,0) tip(4,0); middle parallel
    for i, k in enumerate((5, 6, 7, 8)): pts[k] = (1 + i, 0, 0)
    for i, k in enumerate((9, 10, 11, 12)): pts[k] = (1 + i, 0.3, 0)
    a = angles_from_points(pts)
    assert abs(a.mcp) < 1e-9 and abs(a.pip) < 1e-9 and abs(a.dip) < 1e-9 and abs(a.ab) < 1e-9
    # bend the PIP by 90 degrees
    pts[7] = (2, 1, 0); pts[8] = (2, 2, 0)
    a = angles_from_points(pts)
    assert abs(a.pip - 90) < 1e-9 and abs(a.dip) < 1e-9 and abs(a.mcp) < 1e-9


def test_tracker_runs():
    tr = HandTracker()
    img = np.full((720, 1280, 3), 200, np.uint8)
    t0 = time.perf_counter()
    for i in range(10):
        r = tr.track(img, int((i + 1) * 33e6))
        assert r.found is False
    ms = (time.perf_counter() - t0) * 100
    tr.close()
    print(f"landmarker on a blank 720p frame: {ms:.1f} ms/frame")


def test_recorder_writes():
    d = tempfile.mkdtemp()
    rec = Recorder(os.path.join(d, "v.mp4"), os.path.join(d, "frames.csv"), 320, 240, 30)
    rec.start()
    for i in range(45):
        img = np.zeros((240, 320, 3), np.uint8); img[:, :, 1] = (i * 5) % 255
        rec.push(Frame(i, 1_000_000_000 + i * 33_333_333, time.time(), img))
    info = rec.stop()
    assert info["frames"] == 45, info
    assert os.path.getsize(os.path.join(d, "v.mp4")) > 1000, info
    rows = open(os.path.join(d, "frames.csv")).read().strip().splitlines()
    assert len(rows) == 46
    print("recorder:", {k: v for k, v in info.items() if k != "ffmpeg_error"})


if __name__ == "__main__":
    test_angles_geometry(); test_tracker_runs(); test_recorder_writes(); print("CAPTURE STACK OK")
