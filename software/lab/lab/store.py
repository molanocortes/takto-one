"""store.py - takes on disk, one folder each, nothing hidden in a database.

    takes/<id>/
        meta.json      protocol, camera, device, timing, results of analysis
        video.mp4      the camera, every frame the recorder received
        frames.csv     idx, t_ns, t_wall, cam_idx     (the video's real clock)
        device.csv     one row per bridge snapshot, stamped on arrival
        events.csv     t_ns, event, detail             (GO, phase changes, targets)
        follow.csv     what the follower sent and what the device reached
        track.csv      the analysis pass: per frame, landmarks and joint angles
        exports/       composed videos

The id is the wall-clock start (YYYYMMDD-HHMMSS) plus the protocol, so a
folder listing reads as a lab notebook.
"""
from __future__ import annotations

import csv
import json
import os
import time

ROOT = os.environ.get("TAKTO_LAB_TAKES") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "takes")


def take_dir(take_id: str) -> str:
    return os.path.join(ROOT, take_id)


def new_take_id(protocol: str) -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + protocol


def write_meta(take_id: str, meta: dict):
    os.makedirs(take_dir(take_id), exist_ok=True)
    p = os.path.join(take_dir(take_id), "meta.json")
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(meta, f, indent=2, sort_keys=True)
    os.replace(tmp, p)


def read_meta(take_id: str) -> dict | None:
    p = os.path.join(take_dir(take_id), "meta.json")
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def update_meta(take_id: str, **patch):
    m = read_meta(take_id) or {}
    m.update(patch)
    write_meta(take_id, m)
    return m


def write_csv(take_id: str, name: str, cols: list, rows: list):
    os.makedirs(take_dir(take_id), exist_ok=True)
    with open(os.path.join(take_dir(take_id), name), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)


def read_csv(take_id: str, name: str) -> tuple[list, list]:
    p = os.path.join(take_dir(take_id), name)
    if not os.path.exists(p):
        return [], []
    with open(p, newline="") as f:
        r = csv.reader(f)
        cols = next(r, [])
        return cols, [row for row in r]


def list_takes() -> list[dict]:
    out = []
    if not os.path.isdir(ROOT):
        return out
    for d in sorted(os.listdir(ROOT), reverse=True):
        m = read_meta(d)
        if m:
            m = dict(m)
            m["id"] = d
            m["has_video"] = os.path.exists(os.path.join(take_dir(d), "video.mp4"))
            m["has_track"] = os.path.exists(os.path.join(take_dir(d), "track.csv"))
            ex = os.path.join(take_dir(d), "exports")
            m["exports"] = sorted(os.listdir(ex)) if os.path.isdir(ex) else []
            out.append(m)
    return out
