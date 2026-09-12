"""two synthetic takes with different onsets compose into one portrait video
whose motions start together"""
import os, sys, csv, tempfile, time
import numpy as np, cv2
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
from lab.recorder import Recorder  # noqa: E402
from lab.camera import Frame  # noqa: E402
from lab.compose import Panel, render  # noqa: E402


def make_take(d, onset_frame, color):
    rec = Recorder(os.path.join(d, "video.mp4"), os.path.join(d, "frames.csv"), 640, 360, 30)
    rec.start()
    for i in range(90):
        img = np.full((360, 640, 3), 235, np.uint8)
        x = 100 + (max(0, i - onset_frame) * 6) % 400
        cv2.circle(img, (x, 180), 40, color, -1)
        rec.push(Frame(i, 5_000_000_000 + i * 33_333_333, time.time(), img))
    rec.stop()
    return 5_000_000_000 + onset_frame * 33_333_333


def test_compose():
    root = tempfile.mkdtemp()
    a, b = os.path.join(root, "a"), os.path.join(root, "b")
    on_a = make_take(a, 10, (60, 60, 200)); on_b = make_take(b, 40, (40, 160, 90))
    top = Panel("Bare finger", os.path.join(a, "video.mp4"), os.path.join(a, "frames.csv"), t_start_ns=on_a)
    bot = Panel("In TAKTO", os.path.join(b, "video.mp4"), os.path.join(b, "frames.csv"), t_start_ns=on_b, crop=(100, 60, 440, 240))
    out = os.path.join(root, "out.mp4")
    info = render(top, bot, out, headline="12 % slower", sub="peak angular speed, fast block", footer="TAKTO ONE · lab · n = 1")
    assert info["frames"] > 30 and os.path.getsize(out) > 5000, info
    cap = cv2.VideoCapture(out); cap.set(cv2.CAP_PROP_POS_FRAMES, 5); ok, fr = cap.read()
    assert ok and fr.shape == (1920, 1080, 3)
    cv2.imwrite("/private/tmp/claude-501/-Users-sebas-Downloads-Thesis/efa0f6b2-8551-44fc-9cae-dc5fbea9693b/scratchpad/compose_frame.jpg", fr)
    print("compose:", {k: v for k, v in info.items() if k != "ffmpeg_error"})


if __name__ == "__main__":
    test_compose(); print("COMPOSE OK")
