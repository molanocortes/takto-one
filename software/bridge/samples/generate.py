#!/usr/bin/env python3
"""Author the three demonstration takes that ship with this repository.

These are CHOREOGRAPHED, SYNTHETIC recordings: no hand wore the device to make
them. They exist so the session-replay viewer has something beautiful to play
on a fresh clone, and so the take format has a readable, regenerable example.
Every value is produced by the motion functions below; run this script and you
get byte-identical files. The column layout matches the bridge's replay rows
(see COLS in software/web/src/views/replay.js) and the environment reference
points at the bundled Sim Lab mesh.

    python3 generate.py            # writes the three take JSONs next to itself
"""
import json, math, os

HZ = 50
COLS = (["t_ms"]
        + [f"{f}_{j}" for f in ("index", "middle", "ring", "pinky")
                      for j in ("mcp", "pip", "dip")]
        + ["hq_w", "hq_x", "hq_y", "hq_z", "fq_w", "fq_x", "fq_y", "fq_z",
           "tq_w", "tq_x", "tq_y", "tq_z", "blend", "act",
           "px", "py", "pz", "pq_w", "pq_x", "pq_y", "pq_z"])

def clamp(x, a, b): return max(a, min(b, x))
def smooth(x):
    x = clamp(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)
def bump(t, t0, width):
    """Raised-cosine bump centred on t0: 0 outside, 1 at the crest."""
    x = (t - t0) / width
    return 0.0 if abs(x) >= 1.0 else 0.5 * (1 + math.cos(math.pi * x))
def quat(yaw, pitch, roll):
    """Intrinsic y-x-z Euler (degrees) -> w,x,y,z."""
    cy, sy = math.cos(math.radians(yaw) / 2),  math.sin(math.radians(yaw) / 2)
    cp, sp = math.cos(math.radians(pitch) / 2), math.sin(math.radians(pitch) / 2)
    cr, sr = math.cos(math.radians(roll) / 2),  math.sin(math.radians(roll) / 2)
    return (cy * cp * cr + sy * sp * sr,
            cy * sp * cr + sy * cp * sr,
            sy * cp * cr - cy * sp * sr,
            cy * cp * sr - sy * sp * cr)
def organic(t, f1=0.9, f2=1.7):
    """Two incommensurate sines: the small breath that keeps motion alive."""
    return 0.5 * math.sin(2 * math.pi * f1 * t) + 0.5 * math.sin(2 * math.pi * f2 * t + 1.3)

def rows_for(duration, fn):
    out = []
    n = int(duration * HZ)
    for i in range(n):
        t = i / HZ
        j, act, pos, ori = fn(t)               # joints deg (4 fingers), act 0..1, pos m, (yaw,pitch,roll)
        q = quat(*ori)
        fq = quat(ori[0] * 0.4, 0, 0)          # forearm lags the hand's yaw
        row = [round(i * 1000 / HZ, 1)]
        for (mcp, pip) in j:
            row += [round(mcp, 2), round(pip, 2), round(pip * 0.62, 2)]
        row += [round(v, 4) for v in q]        # hq
        row += [round(v, 4) for v in fq]       # fq
        row += [1.0, 0.0, 0.0, 0.0]            # tq: thumb identity
        row += [0.35, round(clamp(act, 0, 1), 3)]
        row += [round(v, 4) for v in pos]
        row += [round(v, 4) for v in q]        # pq: pose = hand orientation
        out.append(row)
    return out

# ---------------------------------------------------------------- the three
def cascade(t):
    """Three rolling waves, index to pinky, each pass fuller than the last."""
    D = 14.0
    px = 0.30 + 0.26 * math.sin(2 * math.pi * t / D)
    pz = -0.55 + 0.16 * math.sin(4 * math.pi * t / D + 0.8)
    py = 1.12 + 0.05 * math.sin(2 * math.pi * t / 7 + 1.0) + 0.004 * organic(t)
    yaw = 18 * math.sin(2 * math.pi * t / D + 0.3)
    roll = 10 * math.sin(2 * math.pi * t / 7)
    joints, act = [], 0.06
    for fi in range(4):
        c = 0.0
        for p, (t0, amp) in enumerate(((2.2, 0.55), (6.6, 0.8), (11.0, 1.0))):
            c = max(c, amp * bump(t, t0 + fi * 0.18, 0.95))
            act = max(act, amp * bump(t + 0.15, t0, 1.1))    # effort leads motion
        joints.append((8 + c * 62, 6 + c * 92))
    return joints, act + 0.01 * organic(t, 2.3, 3.1), (px, py, pz), (yaw, -6, roll)

def grasp(t):
    """Approach, pre-shape, close, carry, release, retreat."""
    a = smooth(t / 3.0)                          # approach 0..3 s
    lift = smooth((t - 5.2) / 1.6) - smooth((t - 8.0) / 1.5)
    px = -0.35 + 0.75 * a - 0.55 * smooth((t - 9.5) / 2.5)
    py = 1.02 + 0.13 * lift + 0.004 * organic(t)
    pz = -0.72 + 0.22 * a
    pre = 0.22 * smooth((t - 3.0) / 1.0)
    close = smooth((t - 8.0) / 1.2)              # release ramp
    joints = []
    for fi in range(4):
        g = pre + (1 - pre) * smooth((t - 4.0 - fi * 0.06) / 1.2) \
                - (pre + (1 - pre)) * smooth((t - 8.0 - (3 - fi) * 0.06) / 1.2) * 0  # keep grip until release below
        g = clamp(g - close * g, 0, 1)
        tremor = 0.015 * organic(t, 6.1, 7.3) if 5.2 < t < 8.0 else 0
        g = clamp(g + tremor, 0, 1)
        joints.append((4 + g * 58, 6 + g * 82))
    act = 0.05 + 0.45 * smooth((t - 2.85) / 1.1) + 0.28 * lift
    act -= 0.7 * act * smooth((t - 8.2) / 1.3)
    yaw = 24 * lift
    return joints, act, (px, py, pz), (yaw, -4 + 6 * lift, 8 * lift)

def signature(t):
    """A figure-eight with rolling supination; the hand breathes, then rests open."""
    D, w = 16.0, 2 * math.pi / 13.0
    fade = 1 - smooth((t - 13.5) / 1.6)          # glide to centre for the final hold
    px = 0.30 + fade * 0.34 * math.sin(2 * w * t)
    pz = -0.55 + fade * 0.20 * math.sin(w * t) * math.cos(w * t) * 2
    py = 1.10 + fade * 0.09 * math.sin(w * t) + 0.004 * organic(t)
    roll = fade * 32 * math.sin(2 * w * t + 0.6)
    yaw = fade * 22 * math.sin(w * t)
    breathe = 0.32 + 0.24 * math.sin(2 * math.pi * 0.4 * t)
    joints = []
    for fi in range(4):
        b = clamp(breathe + 0.05 * math.sin(2 * math.pi * 0.4 * t - fi * 0.7), 0, 1) * fade
        joints.append((6 + b * 55, 5 + b * 80))
    act = clamp((0.12 + 0.4 * (breathe - 0.1)) * fade + 0.04, 0, 1)
    return joints, act, (px, py, pz), (yaw, -5 * fade, roll)

TAKES = (("take_demo_cascade", 14.0, cascade),
         ("take_demo_grasp", 12.0, grasp),
         ("take_demo_signature", 16.0, signature))

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for tid, dur, fn in TAKES:
        payload = {"id": tid, "env": "env_0001", "cols": COLS, "rows": rows_for(dur, fn)}
        path = os.path.join(here, tid + ".json")
        with open(path, "w") as f:
            json.dump(payload, f, separators=(",", ":"))
        print(f"{tid}: {dur}s, {len(payload['rows'])} rows, {os.path.getsize(path)//1024} KB")
