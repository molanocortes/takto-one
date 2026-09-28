#!/usr/bin/env python3
"""TAKTO Lab - the bench camera experiment station.

    ./.venv/bin/python lab.py                       # camera 0, bridge on localhost
    ./.venv/bin/python lab.py --camera 1 --fps 60    # another camera, ask for 60 fps
    ./.venv/bin/python lab.py --source take.mp4      # a video file stands in for the camera
    ./.venv/bin/python lab.py --bridge ws://192.168.1.20:8765/ws --tracker markers

Then open http://localhost:8790 (or http://takto-lab.localhost:8080 behind the
router). macOS asks once for camera access for the terminal that runs this.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser(description="TAKTO Lab")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=float, default=None, help="request a frame rate; default: the camera's own. The page shows what it really delivers")
    ap.add_argument("--check", action="store_true", help="probe the cameras, print what delivers frames, and exit")
    ap.add_argument("--source", default=None, help="a video file instead of the camera")
    ap.add_argument("--bridge", default="ws://localhost:8765/ws", help="teensy_bridge.py address, '' for none")
    ap.add_argument("--tracker", default="hand", choices=["hand", "markers"])
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()

    import uvicorn
    from lab.camera import Camera
    if a.check:
        for c in Camera.list_cameras():
            print(f"[lab] camera {c['index']}: {c['name']} {c['width']}x{c['height']} reports {c['fps']:.0f} fps")
        cam = Camera(a.camera, a.width, a.height, a.fps)
        print("[lab] open:", "ok" if cam.open() else cam.stats.error)
        return
    from lab.device import DeviceLink
    from lab.server import Lab, build_app

    cam = Camera(a.camera, a.width, a.height, a.fps, source=a.source)
    cam.start()
    if not cam.stats.opened:
        print("[lab] camera:", cam.stats.error)
        print("[lab] the page stays usable; pick a camera or re-open it from the Acquisition table")
    else:
        print(f"[lab] camera {cam.stats.width}x{cam.stats.height}, reports {cam.stats.fps_reported:.0f} fps")
    dev = DeviceLink(a.bridge or None)
    lab = Lab(cam, dev, tracker_mode=a.tracker)
    app = build_app(lab)
    print(f"[lab] http://{a.host}:{a.port}")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
