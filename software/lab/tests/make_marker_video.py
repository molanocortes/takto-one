"""a synthetic take for rehearsals without a hand: four coloured dots on a
light table, moving like an index finger seen from the side (a 1.2 Hz
flex-extend after 2.5 s of rest), 30 fps, 20 s"""
import math, sys
import cv2, numpy as np
out = sys.argv[1] if len(sys.argv) > 1 else "markers_test.mp4"
W, H, FPS, DUR = 1280, 720, 30, 20
vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
COL = {"wrist": (200, 120, 40), "mcp": (60, 180, 60), "pip": (40, 40, 220), "dip": (200, 40, 200)}   # BGR
L = (110, 100, 70)   # px: proximal, middle, distal
for i in range(FPS * DUR):
    t = i / FPS
    img = np.full((H, W, 3), (238, 236, 232), np.uint8)
    cv2.rectangle(img, (0, 560), (W, H), (225, 222, 216), -1)
    curl = 0.0 if t < 2.5 else 0.5 - 0.5 * math.cos(2 * math.pi * 1.2 * (t - 2.5))
    mcp, pip, dip = 70 * curl, 90 * (0.8 * curl + 0.2 * curl * curl), 40 * curl
    pts = {"wrist": (380.0, 400.0)}
    ang = 0.0
    x, y = 380.0 + 120, 400.0
    pts["mcp"] = (x, y)
    for name, seg, a in (("pip", L[0], mcp), ("dip", L[1], pip), ("tip", L[2], dip)):
        ang += a
        x += seg * math.cos(math.radians(ang)); y += seg * math.sin(math.radians(ang))
        pts[name] = (x, y)
    # a grey "finger" under the dots, so the segmentation has something to reject
    for a, b in (("mcp", "pip"), ("pip", "dip"), ("dip", "tip")):
        cv2.line(img, tuple(map(int, pts[a])), tuple(map(int, pts[b])), (190, 188, 184), 26)
    cv2.line(img, tuple(map(int, pts["wrist"])), tuple(map(int, pts["mcp"])), (190, 188, 184), 40)
    for k, c in COL.items():
        cv2.circle(img, tuple(map(int, pts[k])), 9, c, -1)
    vw.write(img)
vw.release()
print("wrote", out)
