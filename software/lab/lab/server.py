"""server.py - the lab, as one process and one page.

FastAPI serves the page and its API; the camera, the live tracker, the
device link and the protocol runner are threads inside the same process,
all stamping on the same monotonic clock. The page never carries data it
would have to keep in sync: everything it shows comes from /api/state or the
state socket, twenty times a second.
"""
from __future__ import annotations

import asyncio
import csv
import json
import math
import os
import threading
import time
from dataclasses import asdict, dataclass, field

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import analysis as A
from . import store
from .camera import Camera, Frame
from .device import DEVICE_COLS, FOLLOW_COLS, DeviceLink
from .markers import MarkerSpec, MarkerTracker, sample_hsv
from .protocols import PROTOCOLS, Phase
from .recorder import Recorder
from .tracker import HandTracker, Angles

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
WEB = os.path.join(PKG, "web")
CONSOLE = os.path.normpath(os.path.join(PKG, "..", "console", "app"))
APP_MODEL = os.path.normpath(os.path.join(PKG, "..", "app", "assets", "model"))

TRACK_COLS = ["idx", "t_ns", "found", "score", "mcp", "pip", "dip", "ab", "mode"]
EVENT_COLS = ["t_ns", "event", "detail"]
LIVE_HZ = 30.0


@dataclass
class RunState:
    take_id: str = ""
    protocol: str = ""
    phase_idx: int = -1
    phase_key: str = ""
    title: str = ""
    instruction: str = ""
    countdown: float = 0.0     # seconds left in a countdown phase, else 0
    remaining: float = 0.0
    elapsed: float = 0.0
    total: float = 0.0
    recording: bool = False
    running: bool = False
    t_go_ns: int = 0
    block: str = ""
    target: dict | None = None
    message: str = ""


class Lab:
    def __init__(self, camera: Camera, device: DeviceLink, tracker_mode: str = "hand"):
        self.camera = camera
        self.device = device
        self.tracker_mode = tracker_mode      # "hand" | "markers"
        self.hand = None
        self.markers: list[MarkerSpec] = self._load_markers()
        self.marker_tracker = MarkerTracker(self.markers)
        self.live: dict = {"found": False, "angles": Angles(), "lm": [], "points": {}, "infer_ms": 0.0, "hz": 0.0, "t_ns": 0}
        self.run = RunState()
        self.jobs: dict = {}                  # background jobs: analyze, compose
        self._rec: Recorder | None = None
        self._events: list = []
        self._live_rows: list = []
        self._lock = threading.Lock()
        self._stop = False
        self._track_thread = threading.Thread(target=self._track_loop, name="tracker", daemon=True)
        self._track_thread.start()
        self._run_thread: threading.Thread | None = None
        self._last_follow_push_ns = 0
        self._last_target_send_ns = 0
        self.console: list = []              # (t_wall, text), the page's console
        self.log("lab started")
        cs = camera.stats
        self.log(f"camera {cs.width}x{cs.height}, reports {cs.fps_reported:.0f} fps" if cs.opened else f"camera: {cs.error}")
        self.log(f"device: {device.url or 'none'}")

    def log(self, text: str):
        self.console.append((time.time(), text))
        del self.console[:-200]
        print("[lab]", text)

    # ---- markers -----------------------------------------------------------
    def _markers_path(self):
        return os.path.join(store.ROOT, "markers.json")

    def _load_markers(self) -> list[MarkerSpec]:
        try:
            with open(self._markers_path()) as f:
                return [MarkerSpec(**m) for m in json.load(f)]
        except Exception:
            return []

    def save_markers(self):
        os.makedirs(store.ROOT, exist_ok=True)
        with open(self._markers_path(), "w") as f:
            json.dump([asdict(m) for m in self.markers], f, indent=2)
        self.marker_tracker = MarkerTracker(self.markers)

    def sample_marker(self, name: str, nx: float, ny: float) -> MarkerSpec | None:
        fr = self.camera.latest()
        if fr is None:
            return None
        h, w = fr.image.shape[:2]
        hh, ss, vv = sample_hsv(fr.image, int(nx * w), int(ny * h))
        spec = MarkerSpec(name=name, h=hh, s=ss, v=vv)
        self.markers = [m for m in self.markers if m.name != name] + [spec]
        self.markers.sort(key=lambda m: ("wrist", "mcp", "pip", "dip").index(m.name) if m.name in ("wrist", "mcp", "pip", "dip") else 9)
        self.save_markers()
        return spec

    # ---- live tracking -------------------------------------------------------
    def _track_loop(self):
        last_idx = -1
        n, t_rate = 0, time.monotonic()
        while not self._stop:
            fr = self.camera.latest()
            if fr is None or fr.idx == last_idx:
                time.sleep(0.003)
                continue
            last_idx = fr.idx
            try:
                if self.tracker_mode == "hand":
                    if self.hand is None:
                        self.hand = HandTracker()
                    r = self.hand.track(fr.image, fr.t_ns)
                    self.live.update(found=r.found, angles=r.smooth if r.found else Angles(), lm=r.lm, points={},
                                     infer_ms=r.infer_ms, t_ns=fr.t_ns, score=r.score)
                    raw = r.smooth
                else:
                    r = self.marker_tracker.track(fr.image, fr.t_ns)
                    h, w = fr.image.shape[:2]
                    self.live.update(found=r.found, angles=r.raw if r.found else Angles(), lm=[],
                                     points={k: (v[0] / w, v[1] / h) for k, v in r.points.items()}, t_ns=fr.t_ns, score=1.0 if r.found else 0.0)
                    raw = r.raw
            except Exception as e:
                self.live.update(found=False, error=str(e))
                time.sleep(0.05)
                continue
            n += 1
            tn = time.monotonic()
            if tn - t_rate >= 1.0:
                self.live["hz"] = n / (tn - t_rate); n, t_rate = 0, tn
            st = self.run
            if st.recording:
                self._live_rows.append([fr.idx, fr.t_ns, int(self.live["found"]), self.live.get("score", 0.0),
                                        raw.mcp, raw.pip, raw.dip, raw.ab, self.tracker_mode])
            # the follow protocol: the finger's pose, sampled at 10 Hz, into the queue
            if st.running and st.block == "follow" and self.live["found"] and fr.t_ns - self._last_follow_push_ns >= 100_000_000:
                self._last_follow_push_ns = fr.t_ns
                self.device.follow.push(fr.t_ns, raw.mcp, raw.pip)

    # ---- protocol runner -----------------------------------------------------
    def start_protocol(self, key: str) -> str:
        if self.run.running:
            raise RuntimeError("a protocol is already running")
        if key not in PROTOCOLS:
            raise RuntimeError("unknown protocol")
        if not self.camera.stats.opened:
            raise RuntimeError("camera is not open")
        take_id = store.new_take_id(key)
        self._run_thread = threading.Thread(target=self._run_protocol, args=(key, take_id), name="protocol", daemon=True)
        self._run_thread.start()
        return take_id

    def abort(self):
        self.run.message = "aborted"
        self.run.running = False

    def _event(self, name: str, detail: str = ""):
        self._events.append([time.monotonic_ns(), name, detail])

    def _run_protocol(self, key: str, take_id: str):
        proto = PROTOCOLS[key]
        st = self.run = RunState(take_id=take_id, protocol=key, running=True, total=proto.duration_s)
        self._events, self._live_rows = [], []
        cs = self.camera.stats
        rec = Recorder(os.path.join(store.take_dir(take_id), "video.mp4"), os.path.join(store.take_dir(take_id), "frames.csv"),
                       cs.width, cs.height, cs.fps_measured or cs.fps_reported or 30.0)
        os.makedirs(store.take_dir(take_id), exist_ok=True)
        store.write_meta(take_id, {
            "protocol": key, "protocol_name": proto.name, "started_wall": time.time(), "started_iso": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "tracker_mode": self.tracker_mode, "camera": {"width": cs.width, "height": cs.height, "fps_measured": cs.fps_measured, "fps_reported": cs.fps_reported},
            "device": {"url": self.device.url, "connected": self.device.connected},
            "phases": [{"key": p.key, "seconds": p.seconds, "block": p.block, "neutral": p.neutral, "countdown": p.countdown, "target": p.target} for p in proto.phases],
            "markers": [asdict(m) for m in self.markers] if self.tracker_mode == "markers" else [],
            "status": "recording",
        })
        rec.start()
        self.camera.subscribe(rec.q)
        self._rec = rec
        self.device.start_recording()
        st.recording = True
        self._event("take_start", take_id)
        self.log(f"take {take_id}: recording {proto.name}")
        if proto.follow:
            self.device.follow.clear()
            self.device.follow_enabled = True
        t0 = time.monotonic_ns()
        elapsed_before = 0.0
        try:
            for i, ph in enumerate(proto.phases):
                if not st.running:
                    break
                st.phase_idx, st.phase_key, st.title, st.instruction = i, ph.key, ph.title, ph.instruction
                st.block, st.target = ph.block, ph.target
                self._event("phase", json.dumps({"key": ph.key, "block": ph.block, "neutral": ph.neutral, "target": ph.target}))
                self.log(f"phase {ph.key} ({ph.seconds:.0f} s): {ph.title}")
                if ph.neutral and self.hand is not None:
                    self.hand.reset_smoothing()
                ph_start = time.monotonic_ns()
                while st.running:
                    now = time.monotonic_ns()
                    e = (now - ph_start) / 1e9
                    if e >= ph.seconds:
                        break
                    st.elapsed = elapsed_before + e
                    st.remaining = ph.seconds - e
                    st.countdown = (ph.seconds - e) if ph.countdown else 0.0
                    if proto.targets and ph.target and now - self._last_target_send_ns >= 100_000_000:
                        # the assisted protocol: the device is asked for the pose every 100 ms
                        self._last_target_send_ns = now
                        self.device.follow_cmd("target", target=ph.target)
                    time.sleep(0.01)
                elapsed_before += ph.seconds
                if ph.countdown and st.running:
                    st.t_go_ns = time.monotonic_ns()
                    self._event("go", ph.key)
                    self.log(f"GO at t = {st.t_go_ns} ns (monotonic)")
        finally:
            st.recording = False
            st.running = False
            if proto.follow:
                self.device.follow_enabled = False
            self.camera.unsubscribe(rec.q)
            info = rec.stop()
            rows = self.device.stop_recording()
            store.write_csv(take_id, "device.csv", DEVICE_COLS, rows)
            store.write_csv(take_id, "events.csv", EVENT_COLS, self._events)
            store.write_csv(take_id, "live_track.csv", TRACK_COLS, self._live_rows)
            if proto.follow:
                store.write_csv(take_id, "follow.csv", FOLLOW_COLS, self.device.follow.rows())
            store.update_meta(take_id, status="recorded", video=info, device_rows=len(rows), t_go_ns=st.t_go_ns,
                              live_found_pct=(100.0 * sum(r[2] for r in self._live_rows) / len(self._live_rows)) if self._live_rows else 0.0)
            st.message = f"take {take_id} saved ({info['frames']} frames)"
            self.log(f"take {take_id}: saved {info['frames']} frames at {info['fps_effective']:.1f} fps, {len(rows)} device rows, {info['dropped']} dropped; analysing")
            self._rec = None
            threading.Thread(target=self.analyze, args=(take_id,), daemon=True).start()

    # ---- analysis pass -------------------------------------------------------
    def analyze(self, take_id: str) -> dict:
        job = self.jobs[f"analyze:{take_id}"] = {"progress": 0.0, "done": False, "error": ""}
        try:
            meta = store.read_meta(take_id) or {}
            mode = meta.get("tracker_mode", "hand")
            d = store.take_dir(take_id)
            cols, frows = store.read_csv(take_id, "frames.csv")
            t_ns = np.array([int(r[1]) for r in frows], dtype=np.int64)
            cap = cv2.VideoCapture(os.path.join(d, "video.mp4"))
            tracker = HandTracker(smooth=False) if mode == "hand" else MarkerTracker([MarkerSpec(**m) for m in meta.get("markers", [])] or self.markers)
            rows = []
            n = len(t_ns)
            i = 0
            while i < n:
                ok, img = cap.read()
                if not ok:
                    break
                r = tracker.track(img, int(t_ns[i]))
                a = r.raw
                rows.append([i, int(t_ns[i]), int(r.found), getattr(r, "score", 1.0 if r.found else 0.0), a.mcp, a.pip, a.dip, a.ab, mode])
                i += 1
                if i % 30 == 0:
                    job["progress"] = i / max(1, n)
            cap.release()
            if hasattr(tracker, "close"):
                tracker.close()
            store.write_csv(take_id, "track.csv", TRACK_COLS, rows)
            result = _clean(self._metrics(take_id, meta, rows))
            store.update_meta(take_id, status="analyzed", analysis=result)
            self.log(f"take {take_id}: analysed, finger found in {result.get('found_pct', 0):.0f} % of frames")
            job["done"] = True
            job["progress"] = 1.0
            return result
        except Exception as e:
            job["error"] = str(e)
            job["done"] = True
            store.update_meta(take_id, status="analysis_failed", analysis_error=str(e))
            raise

    def _metrics(self, take_id: str, meta: dict, rows: list) -> dict:
        proto = PROTOCOLS.get(meta.get("protocol", ""), None)
        ev_cols, ev = store.read_csv(take_id, "events.csv")
        phases = []      # (key, block, neutral, t_start_ns, t_end_ns, target)
        for k, row in enumerate(ev):
            if row[1] == "phase":
                info = json.loads(row[2]); t_s = int(row[0])
                t_e = int(ev[k + 1][0]) if k + 1 < len(ev) else t_s
                # the next phase event ends this phase; a "go" between them does not
                for row2 in ev[k + 1:]:
                    if row2[1] == "phase":
                        t_e = int(row2[0]); break
                else:
                    t_e = max(int(r[1]) for r in rows) if rows else t_s
                phases.append((info["key"], info.get("block", ""), info.get("neutral", False), t_s, t_e, info.get("target")))
        t_go = int(meta.get("t_go_ns") or 0)
        go_events = [int(r[0]) for r in ev if r[1] == "go"]
        t_go = go_events[0] if go_events else t_go
        base = t_go or (int(rows[0][1]) if rows else 0)
        t = np.array([(int(r[1]) - base) / 1e9 for r in rows])
        found = np.array([int(r[2]) for r in rows], bool)
        cam = {k: np.array([float(r[j]) for r in rows]) for k, j in (("mcp", 4), ("pip", 5), ("dip", 6), ("ab", 7))}
        for k in cam:
            cam[k][~found] = np.nan
        rest = next((p for p in phases if p[2]), None)
        result: dict = {"frames": len(rows), "found_pct": float(100 * found.mean()) if len(rows) else 0.0, "t_go_ns": t_go,
                        "blocks": {}, "camera_offsets_deg": {}}
        if rest:
            r0, r1 = (rest[3] - base) / 1e9, (rest[4] - base) / 1e9
            result["zero_method"] = {}
            for k in ("mcp", "pip", "dip"):
                cam[k], off, how = A.zero_on_rest(cam[k], t, r0, r1)
                result["camera_offsets_deg"][k] = off
                result["zero_method"]["camera_" + k] = how
        filt = {k: A._sg(cam[k]) for k in ("mcp", "pip", "dip")}
        v = A.velocity(t, filt["mcp"]) if len(t) > 1 else np.zeros(0)
        on = A.onset_time(t, v) if len(t) > 1 else None
        result["onset_s"] = on
        result["onset_ns"] = int(base + on * 1e9) if on is not None else None
        # device rows
        dcols, drows = store.read_csv(take_id, "device.csv")
        dev = None
        if drows:
            dt = np.array([(int(r[0]) - base) / 1e9 for r in drows])
            dm = np.array([float(r[3]) if r[6] == "1" else np.nan for r in drows])
            dp = np.array([float(r[4]) if r[7] == "1" else np.nan for r in drows])
            if rest:
                dm, offm, howm = A.zero_on_rest(dm, dt, r0, r1); dp, offp, howp = A.zero_on_rest(dp, dt, r0, r1)
                result["device_offsets_deg"] = {"mcp": offm, "pip": offp}
                result.setdefault("zero_method", {}).update({"device_mcp": howm, "device_pip": howp})
            dev = {"t": dt, "mcp": dm, "pip": dp,
                   "fa_mcp": np.array([float(r[10]) for r in drows]), "fa_pip": np.array([float(r[11]) for r in drows]),
                   "ft_mcp": np.array([float(r[8]) for r in drows]), "ft_pip": np.array([float(r[9]) for r in drows])}
            result["device_rows"] = len(drows)
            result["device_hz"] = float(len(drows) / max(1e-6, dt[-1] - dt[0])) if len(drows) > 1 else 0.0
        for key, block, neutral, ts, te, target in phases:
            if not block:
                continue
            m = (t >= (ts - base) / 1e9) & (t <= (te - base) / 1e9)
            b: dict = {"phase": key, "t0_s": (ts - base) / 1e9, "t1_s": (te - base) / 1e9,
                       "camera": {j: A.block_metrics(t[m], filt[j][m]) for j in ("mcp", "pip")}}
            if dev is not None:
                md = (dev["t"] >= b["t0_s"]) & (dev["t"] <= b["t1_s"])
                b["device"] = {"mcp": A.block_metrics(dev["t"][md], A._sg(dev["mcp"][md])), "pip": A.block_metrics(dev["t"][md], A._sg(dev["pip"][md]))}
                # camera vs encoder on the camera's grid
                if md.sum() > 10 and m.sum() > 10:
                    agree = {}
                    for j in ("mcp", "pip"):
                        okd = np.isfinite(dev[j])
                        if okd.sum() > 10:
                            di = np.interp(t[m], dev["t"][okd], dev[j][okd])
                            e = A.rmse(filt[j][m], di)
                            rom = b["camera"][j].get("rom_deg", float("nan"))
                            agree[j] = {"rmse_deg": e, "lag_ms": A.lag_ms(t[m], filt[j][m], di),
                                        "accuracy_pct": float(100 * (1 - e / rom)) if rom and rom > 0 and e == e else float("nan")}
                    b["agreement"] = agree
                if block in ("follow", "drain"):
                    okf = np.isfinite(dev["fa_mcp"]) & np.isfinite(dev["ft_mcp"]) & md
                    if okf.sum() > 10:
                        b["follow"] = {"rmse_mcp_deg": A.rmse(dev["ft_mcp"][okf], dev["fa_mcp"][okf]),
                                       "rmse_pip_deg": A.rmse(dev["ft_pip"][okf], dev["fa_pip"][okf]),
                                       "lag_ms": A.lag_ms(dev["t"][okf], dev["ft_mcp"][okf], dev["fa_mcp"][okf], max_lag_s=5.0)}
                if block == "target" and target:
                    b["settle"] = {j: A.settle_time(dev["t"], dev[j], float(target[f"{j}_deg"]), b["t0_s"]) for j in ("mcp", "pip")}
                    b["target"] = target
            result["blocks"][key] = b
        fcols, frs = store.read_csv(take_id, "follow.csv")
        if frs:
            lag = np.array([(int(r[2]) - int(r[0])) / 1e9 for r in frs])
            reached = np.array([int(r[7]) for r in frs])
            result["follow_queue"] = {"poses": len(frs), "reached_pct": float(100 * reached.mean()), "lag_mean_s": float(lag.mean()),
                                      "lag_max_s": float(lag.max()), "lag_final_s": float(lag[-1])}
        # a comparison against the reference take, if this is a worn take and a bare one exists
        if proto and proto.comparison:
            ref = next((tk for tk in store.list_takes() if tk.get("protocol") == proto.comparison and tk.get("analysis")), None)
            if ref:
                bare = {ph["phase"] if False else k: ph["camera"]["mcp"] for k, ph in ref["analysis"]["blocks"].items()}
                worn = {k: ph["camera"]["mcp"] for k, ph in result["blocks"].items()}
                result["comparison"] = {"reference": ref["id"], **A.compare_speed(bare, worn)}
        return result

    # ---- state for the page -----------------------------------------------
    def state(self) -> dict:
        cs = self.camera.stats
        d = self.device
        s = d.latest
        a = self.live["angles"]
        fs = d.follow.stats
        cf = (d.snap or {}).get("camera_follow") or {}
        return {
            "camera": {"opened": cs.opened, "width": cs.width, "height": cs.height, "fps": round(cs.fps_measured, 1),
                       "fps_reported": cs.fps_reported, "frames": cs.frames, "period_p50_ms": round(cs.period_ms_p50, 2),
                       "period_p95_ms": round(cs.period_ms_p95, 2), "error": cs.error, "note": cs.note, "index": self.camera.index,
                       "source": self.camera.source or f"camera {self.camera.index}", "dropped_reads": cs.dropped_reads},
            "console": [[round(t, 3), x] for t, x in self.console[-14:]],
            "tracker": {"mode": self.tracker_mode, "found": bool(self.live["found"]), "hz": round(self.live["hz"], 1),
                        "infer_ms": round(self.live.get("infer_ms", 0.0), 1),
                        "mcp": _r(a.mcp), "pip": _r(a.pip), "dip": _r(a.dip), "ab": _r(a.ab),
                        "lm": [[round(x, 4), round(y, 4)] for x, y, _ in self.live["lm"]] if self.live["lm"] else [],
                        "points": {k: [round(v[0], 4), round(v[1], 4)] for k, v in self.live["points"].items()},
                        "markers": [asdict(m) for m in self.markers], "error": self.live.get("error", "")},
            "device": {"url": d.url, "connected": d.connected, "detail": d.detail, "hz": round(d.hz, 1),
                       "mcp": _r(s.mcp) if s else None, "pip": _r(s.pip) if s else None, "ab": _r(s.ab) if s else None,
                       "ok": list(s.ok) if s else [False] * 3, "device_up": bool(s.device_up) if s else False, "state": s.state if s else "",
                       "follow": {"armed": bool(cf.get("armed")), "zeroed": bool(cf.get("zeroed")), "directions": bool(cf.get("directions")),
                                  "reason": cf.get("reason", ""), "limit": cf.get("limit") or d.follow_limit,
                                  "target": cf.get("target"), "actual": cf.get("actual"),
                                  "enabled": d.follow_enabled, "mode": fs.mode, "queued": fs.queued, "sent": fs.sent, "reached": fs.reached,
                                  "timed_out": fs.timed_out, "lag_s": round(fs.lag_s, 2), "max_lag_s": round(fs.max_lag_s, 2)},
                       "acks": [m for _, m in list(d.acks)[-3:]]},
            "run": asdict(self.run),
            "recorder": {"frames": self._rec.frames, "dropped": self._rec.dropped} if self._rec else None,
            "jobs": self.jobs,
            "protocols": {k: {"name": p.name, "summary": p.summary, "setup": p.setup, "duration_s": p.duration_s,
                              "follow": p.follow, "targets": p.targets, "comparison": p.comparison,
                              "phases": [{"key": ph.key, "seconds": ph.seconds, "title": ph.title} for ph in p.phases]} for k, p in PROTOCOLS.items()},
            "t_ns": time.monotonic_ns(),
        }


def _r(x):
    return None if x is None or x != x else round(float(x), 1)


def _num(x):
    """a CSV cell to a float, None when it is empty or not a number"""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if v != v or abs(v) == float("inf") else v


def _clean(o):
    """NaN and infinities become null, recursively: JSON has no NaN, and a
    number the method could not produce is honestly absent"""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
        return None
    if isinstance(o, (np.floating, np.integer)):
        v = o.item()
        return None if isinstance(v, float) and (v != v or abs(v) == float("inf")) else v
    return o


# ---------------------------------------------------------------------------
def build_app(lab: Lab) -> FastAPI:
    app = FastAPI(title="TAKTO Lab")
    app.mount("/static", StaticFiles(directory=WEB), name="static")
    app.mount("/assets", StaticFiles(directory=os.path.join(PKG, "assets")), name="assets")
    if os.path.isdir(CONSOLE):
        app.mount("/console", StaticFiles(directory=CONSOLE), name="console")
    if os.path.isdir(APP_MODEL):
        app.mount("/model", StaticFiles(directory=APP_MODEL), name="model")
    os.makedirs(store.ROOT, exist_ok=True)
    app.mount("/takes", StaticFiles(directory=store.ROOT), name="takes")

    @app.get("/", response_class=HTMLResponse)
    def index():
        return open(os.path.join(WEB, "index.html")).read()

    @app.get("/twin", response_class=HTMLResponse)
    def twin_page():
        return open(os.path.join(WEB, "twin.html")).read()

    @app.get("/api/state")
    def state():
        return lab.state()

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        try:
            while True:
                await sock.send_text(json.dumps(lab.state()))
                await asyncio.sleep(1 / 20)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    @app.get("/video.mjpg")
    async def mjpeg(request: Request):
        async def gen():
            last = -1
            while not await request.is_disconnected():
                fr = lab.camera.latest()
                if fr is None or fr.idx == last:
                    await asyncio.sleep(0.005)
                    continue
                last = fr.idx
                img = fr.image
                if img.shape[1] > 960:
                    img = cv2.resize(img, (960, int(img.shape[0] * 960 / img.shape[1])), interpolation=cv2.INTER_AREA)
                ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if not ok:
                    continue
                yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg.tobytes() + b"\r\n"
                await asyncio.sleep(1 / LIVE_HZ)
        return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/api/cameras")
    def cameras():
        return {"current": lab.camera.index, "cameras": Camera.list_cameras()}

    @app.post("/api/camera")
    async def camera_select(req: Request):
        body = await req.json()
        idx = body.get("index")
        ok = lab.camera.reopen(index=int(idx) if idx is not None else None, width=body.get("width"), height=body.get("height"), fps=body.get("fps"))
        cs = lab.camera.stats
        lab.log(f"camera {lab.camera.index}: {'opened ' + str(cs.width) + 'x' + str(cs.height) if ok else cs.error}")
        return {"ok": ok, "error": cs.error, "note": cs.note, "width": cs.width, "height": cs.height}

    @app.get("/frame.jpg")
    def frame_jpg():
        fr = lab.camera.latest()
        if fr is None:
            raise HTTPException(503, "no frame")
        ok, jpg = cv2.imencode(".jpg", fr.image, [cv2.IMWRITE_JPEG_QUALITY, 90])
        return StreamingResponse(iter([jpg.tobytes()]), media_type="image/jpeg")

    @app.post("/api/protocol/start")
    async def start(req: Request):
        body = await req.json()
        try:
            return {"take_id": lab.start_protocol(body.get("key", ""))}
        except RuntimeError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/protocol/abort")
    def abort():
        lab.abort()
        return {"ok": True}

    @app.post("/api/tracker")
    async def tracker(req: Request):
        body = await req.json()
        mode = body.get("mode")
        if mode in ("hand", "markers"):
            lab.tracker_mode = mode
        return {"mode": lab.tracker_mode}

    @app.post("/api/markers/sample")
    async def markers_sample(req: Request):
        body = await req.json()
        spec = lab.sample_marker(body["name"], float(body["x"]), float(body["y"]))
        if spec is None:
            raise HTTPException(503, "no frame")
        return asdict(spec)

    @app.post("/api/markers/set")
    async def markers_set(req: Request):
        """a marker window typed or tuned by hand (h 0..179, s/v 0..255)"""
        body = await req.json()
        spec = MarkerSpec(**{k: v for k, v in body.items() if k in MarkerSpec.__dataclass_fields__})
        lab.markers = [m for m in lab.markers if m.name != spec.name] + [spec]
        lab.markers.sort(key=lambda m: ("wrist", "mcp", "pip", "dip").index(m.name) if m.name in ("wrist", "mcp", "pip", "dip") else 9)
        lab.save_markers()
        return asdict(spec)

    @app.post("/api/markers/clear")
    def markers_clear():
        lab.markers = []
        lab.save_markers()
        return {"ok": True}

    @app.post("/api/follow")
    async def follow(req: Request):
        body = await req.json()
        action = body.get("action")
        if action == "mode":
            lab.device.follow.set_mode(body.get("mode", "queue"))
            return {"mode": lab.device.follow.mode}
        if action == "neutral":
            ok = lab.device.follow_cmd("neutral")
        elif action == "directions":
            ok = lab.device.follow_cmd("directions", directions={"mcp": int(body.get("mcp", 1)), "pip": int(body.get("pip", 1))}, confirmed=True)
        elif action in ("arm", "stop"):
            ok = lab.device.follow_cmd(action)
            if action == "stop":
                lab.device.follow_enabled = False
                lab.device.follow.clear()
        elif action == "identify":
            ok = lab.device.follow_cmd("identify", axis=body.get("axis", "mcp"))
        else:
            raise HTTPException(400, "unknown action")
        if not ok:
            raise HTTPException(503, "bridge not connected")
        return {"ok": True}

    @app.get("/api/takes")
    def takes():
        return store.list_takes()

    @app.get("/api/takes/{take_id}")
    def take(take_id: str):
        m = store.read_meta(take_id)
        if not m:
            raise HTTPException(404)
        m["id"] = take_id
        return m

    @app.post("/api/takes/{take_id}/analyze")
    def analyze(take_id: str):
        if not store.read_meta(take_id):
            raise HTTPException(404)
        threading.Thread(target=lab.analyze, args=(take_id,), daemon=True).start()
        return {"job": f"analyze:{take_id}"}

    @app.post("/api/takes/{take_id}/notes")
    async def notes(take_id: str, req: Request):
        body = await req.json()
        return store.update_meta(take_id, notes=str(body.get("notes", "")), title=str(body.get("title", "")))

    @app.get("/api/takes/{take_id}/series")
    def series(take_id: str):
        """the traces the page plots: camera angles (analysis pass) and device angles, seconds from GO"""
        m = store.read_meta(take_id) or {}
        base = int((m.get("analysis") or {}).get("t_go_ns") or m.get("t_go_ns") or 0)
        cols, rows = store.read_csv(take_id, "track.csv")
        if not rows:
            cols, rows = store.read_csv(take_id, "live_track.csv")
        if rows and not base:
            base = int(rows[0][1])
        f = _num
        cam = [[round((int(r[1]) - base) / 1e9, 4), f(r[4]) if r[2] == "1" else None, f(r[5]) if r[2] == "1" else None, f(r[6]) if r[2] == "1" else None] for r in rows]
        dcols, drows = store.read_csv(take_id, "device.csv")
        dev = [[round((int(r[0]) - base) / 1e9, 4), f(r[3]) if r[6] == "1" else None, f(r[4]) if r[7] == "1" else None,
                f(r[10]), f(r[11]), f(r[8]), f(r[9])] for r in drows]
        return _clean({"camera": cam[::max(1, len(cam) // 4000)], "device": dev[::max(1, len(dev) // 4000)], "offsets": (m.get("analysis") or {}).get("camera_offsets_deg", {}),
                       "device_offsets": (m.get("analysis") or {}).get("device_offsets_deg", {})})

    @app.get("/api/takes/{take_id}/twin_plan")
    def twin_plan(take_id: str, fps: float = 30.0, source: str = "device"):
        """what the twin page must render: one pose per output frame, on the take's clock"""
        m = store.read_meta(take_id) or {}
        base = int((m.get("analysis") or {}).get("onset_ns") or (m.get("analysis") or {}).get("t_go_ns") or m.get("t_go_ns") or 0)
        cols, frows = store.read_csv(take_id, "frames.csv")
        if not frows:
            raise HTTPException(404, "no frames")
        t_end = int(frows[-1][1])
        if source == "device":
            dcols, drows = store.read_csv(take_id, "device.csv")
            if not drows:
                raise HTTPException(404, "no device rows in this take")
            dt = np.array([int(r[0]) for r in drows], dtype=np.int64)
            offs = (m.get("analysis") or {}).get("device_offsets_deg", {})
            chans = {"mcp": np.array([float(r[3]) if r[6] == "1" else np.nan for r in drows]) - float(offs.get("mcp", 0.0)),
                     "pip": np.array([float(r[4]) if r[7] == "1" else np.nan for r in drows]) - float(offs.get("pip", 0.0)),
                     "ab": np.array([float(r[2]) if r[5] == "1" else np.nan for r in drows])}
        else:
            tcols, trows = store.read_csv(take_id, "track.csv")
            if not trows:
                raise HTTPException(404, "analyze the take first")
            dt = np.array([int(r[1]) for r in trows], dtype=np.int64)
            f = np.array([r[2] == "1" for r in trows])
            chans = {"mcp": np.where(f, [float(r[4]) for r in trows], np.nan), "pip": np.where(f, [float(r[5]) for r in trows], np.nan), "ab": np.zeros(len(trows))}
            offs = (m.get("analysis") or {}).get("camera_offsets_deg", {})
            chans["mcp"] = chans["mcp"] - float(offs.get("mcp", 0.0)); chans["pip"] = chans["pip"] - float(offs.get("pip", 0.0))
        if not base:
            base = int(dt[0])
        n = int(max(0.0, (t_end - base) / 1e9) * fps)
        frames = []
        for i in range(n):
            want = base + int(i / fps * 1e9)
            k = int(np.searchsorted(dt, want)); k = min(len(dt) - 1, max(0, k))
            def val(ch):
                v = chans[ch][k]
                if v != v:      # nearest finite neighbour
                    ok = np.isfinite(chans[ch])
                    if not ok.any():
                        return 0.0
                    v = float(np.interp(want, dt[ok], chans[ch][ok]))
                return float(v)
            frames.append({"idx": i, "t_ns": want, "index_mcp": val("ab"), "index_pip": val("mcp"), "index_dip": val("pip")})
        return _clean({"fps": fps, "base_ns": base, "frames": frames})

    @app.post("/api/takes/{take_id}/twin/{idx}")
    async def twin_frame(take_id: str, idx: int, req: Request):
        d = os.path.join(store.take_dir(take_id), "twin")
        os.makedirs(d, exist_ok=True)
        data = await req.body()
        with open(os.path.join(d, "%06d.png" % idx), "wb") as f:
            f.write(data)
        t_ns = req.headers.get("x-t-ns")
        with open(os.path.join(d, "frames.csv"), "a" if idx else "w", newline="") as f:
            w = csv.writer(f)
            if idx == 0:
                w.writerow(["idx", "t_ns"])
            w.writerow([idx, t_ns or 0])
        return {"ok": True}

    @app.post("/api/compose")
    async def compose(req: Request):
        from .compose import Panel, render
        body = await req.json()

        def panel(spec: dict) -> Panel:
            tid = spec["take"]
            d = store.take_dir(tid)
            m = store.read_meta(tid) or {}
            an = m.get("analysis") or {}
            start = int(spec.get("t_start_ns") or an.get("onset_ns") or an.get("t_go_ns") or m.get("t_go_ns") or 0)
            if spec.get("source") == "twin":
                return Panel(spec.get("label", "Digital twin"), frames_csv=os.path.join(d, "twin", "frames.csv"), frames_dir=os.path.join(d, "twin"),
                             t_start_ns=start, crop=None)
            return Panel(spec.get("label", m.get("protocol_name", tid)), video=os.path.join(d, "video.mp4"), frames_csv=os.path.join(d, "frames.csv"),
                         t_start_ns=start, crop=tuple(spec["crop"]) if spec.get("crop") else None)

        top, bottom = panel(body["top"]), panel(body["bottom"])
        name = body.get("name") or time.strftime("export-%Y%m%d-%H%M%S")
        out = os.path.join(store.take_dir(body["top"]["take"]), "exports", f"{name}.mp4")
        job = lab.jobs[f"compose:{name}"] = {"progress": 0.0, "done": False, "error": "", "path": f"/takes/{body['top']['take']}/exports/{name}.mp4"}

        def work():
            try:
                render(top, bottom, out, headline=body.get("headline", ""), sub=body.get("sub", ""), footer=body.get("footer", ""),
                       slow=float(body.get("slow", 1.0)), duration_s=body.get("duration_s"), progress=lambda p: job.update(progress=p))
                job["done"] = True; job["progress"] = 1.0
            except Exception as e:
                job["error"] = str(e); job["done"] = True
        threading.Thread(target=work, daemon=True).start()
        return {"job": f"compose:{name}", "path": job["path"]}

    return app
