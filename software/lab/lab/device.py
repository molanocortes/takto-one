"""device.py - the device, on the same clock as the camera.

A WebSocket client for teensy_bridge.py that stamps every `snap` with
time.monotonic_ns() on arrival, keeps the index finger's channels handy
({f}_mcp = abduction, {f}_pip = MCP flexion, {f}_dip = PIP flexion, the
wire contract every twin reads), records rows while a take is running, and
sends the bridge's own commands: the camera-follow gateway (neutral, arm,
target, stop) and take recording. Nothing here talks to a motor directly;
the bridge and the firmware keep every safety rule they already have.

FollowQueue is the follower the "robot copies my finger" protocol asks for.
The finger will be faster than the device, so instead of chasing the newest
pose (and skipping the ones in between) it keeps every sampled pose in order
and moves to the next only when the device has reached the current one, or
has had its fair chance. The device then plays the motion back late but
whole, and the queue reports how late: that lag is the measurement.
"""
from __future__ import annotations

import asyncio
import json
import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field

INDEX_CH = ("index_mcp", "index_pip", "index_dip")


@dataclass
class DeviceSample:
    t_ns: int                 # arrival, monotonic
    t_ms: float               # the bridge/device clock
    ab: float = float("nan")  # index abduction (deg)
    mcp: float = float("nan")  # index MCP flexion (deg)
    pip: float = float("nan")  # index PIP flexion (deg)
    ok: tuple = (False, False, False)
    follow_target: tuple = (float("nan"), float("nan"))
    follow_actual: tuple = (float("nan"), float("nan"))
    follow_armed: bool = False
    motors: list = field(default_factory=list)   # [(id, pos_deg, ma)]
    device_up: bool = False
    state: str = ""


@dataclass
class FollowStats:
    mode: str = "queue"
    queued: int = 0
    sent: int = 0
    reached: int = 0
    timed_out: int = 0
    lag_s: float = 0.0        # age of the pose being executed
    max_lag_s: float = 0.0
    current: tuple = (float("nan"), float("nan"))
    error_deg: float = float("nan")


class FollowQueue:
    """Targets in, in order; each is held until reached (within tol_deg) or
    until dwell_s has passed; the bridge wants a fresh target every 250 ms,
    so the current one is re-sent every period_s regardless."""

    def __init__(self, tol_deg: float = 4.0, dwell_s: float = 1.5, period_s: float = 0.1, mode: str = "queue"):
        self.tol, self.dwell, self.period = tol_deg, dwell_s, period_s
        self.stats = FollowStats(mode=mode)
        self._q: deque = deque()
        self._cur = None          # (t_sample_ns, mcp, pip, t_issued)
        self._log: list = []      # rows for follow.csv
        self.lock = threading.Lock()

    @property
    def mode(self):
        return self.stats.mode

    def set_mode(self, mode: str):
        self.stats.mode = "latest" if mode == "latest" else "queue"

    def push(self, t_ns: int, mcp: float, pip: float):
        if not (math.isfinite(mcp) and math.isfinite(pip)):
            return
        with self.lock:
            if self.stats.mode == "latest":
                self._q.clear()
            self._q.append((t_ns, mcp, pip))
            self.stats.queued = len(self._q)

    def clear(self):
        with self.lock:
            self._q.clear(); self._cur = None
            self.stats.queued = 0

    def rows(self):
        with self.lock:
            return list(self._log)

    def tick(self, now_ns: int, actual: tuple) -> tuple | None:
        """Called every period_s. Returns the (mcp, pip) target to send now,
        or None when there is nothing to do."""
        with self.lock:
            if self._cur is not None:
                t_s, mcp, pip, t_issued = self._cur
                err = float("nan")
                if all(math.isfinite(a) for a in actual):
                    err = max(abs(actual[0] - mcp), abs(actual[1] - pip))
                self.stats.error_deg = err
                reached = math.isfinite(err) and err <= self.tol
                expired = (now_ns - t_issued) / 1e9 >= self.dwell
                if reached or expired:
                    self.stats.reached += int(reached)
                    self.stats.timed_out += int(not reached)
                    self._log.append([t_s, t_issued, now_ns, mcp, pip, actual[0], actual[1], int(reached)])
                    self._cur = None
            if self._cur is None and self._q:
                t_s, mcp, pip = self._q.popleft()
                self.stats.queued = len(self._q)
                self._cur = (t_s, mcp, pip, now_ns)
                self.stats.sent += 1
            if self._cur is None:
                self.stats.lag_s = 0.0
                return None
            t_s, mcp, pip, _ = self._cur
            self.stats.lag_s = (now_ns - t_s) / 1e9
            self.stats.max_lag_s = max(self.stats.max_lag_s, self.stats.lag_s)
            self.stats.current = (mcp, pip)
            return (mcp, pip)


class DeviceLink:
    """Runs its own asyncio loop on a thread. `latest` is always the newest
    sample; `recording` collects rows between start/stop."""

    def __init__(self, url: str | None):
        self.url = url
        self.latest: DeviceSample | None = None
        self.snap: dict | None = None
        self.connected = False
        self.detail = "no bridge address" if not url else "connecting"
        self.hz = 0.0
        self.acks: deque = deque(maxlen=50)
        self.follow = FollowQueue()
        self.follow_enabled = False
        self.follow_limit = {"mcp_deg": 35.0, "pip_deg": 45.0}
        self._rows: list | None = None
        self._loop = asyncio.new_event_loop()
        self._ws = None
        self._thread = threading.Thread(target=self._run, name="device", daemon=True)
        self._frames = 0
        self._rate_t = time.monotonic()
        if url:
            self._thread.start()

    # ---- recording -------------------------------------------------------
    def start_recording(self):
        self._rows = []
        self.follow._log.clear()

    def stop_recording(self) -> list:
        rows, self._rows = (self._rows or []), None
        return rows

    # ---- commands --------------------------------------------------------
    def send(self, obj: dict):
        if self._ws is None:
            return False
        asyncio.run_coroutine_threadsafe(self._send(obj), self._loop)
        return True

    async def _send(self, obj):
        try:
            await self._ws.send(json.dumps(obj))
        except Exception:
            pass

    def follow_cmd(self, action: str, **extra):
        return self.send({"cmd": "camera_follow", "action": action, **extra})

    def record_cmd(self, action: str, task: str = "", notes: str = ""):
        return self.send({"cmd": "record", "action": action, "task": task, "notes": notes, "profile": {"name": "lab"}})

    # ---- the loop --------------------------------------------------------
    def _run(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._main())

    async def _main(self):
        import websockets
        backoff = 0.5
        while True:
            try:
                async with websockets.connect(self.url, max_size=None, open_timeout=3) as ws:
                    self._ws = ws
                    self.connected = True
                    self.detail = "linked"
                    backoff = 0.5
                    follow_task = asyncio.create_task(self._follow_loop())
                    try:
                        async for raw in ws:
                            self._on_message(raw)
                    finally:
                        follow_task.cancel()
            except Exception as e:
                self.detail = f"no bridge ({type(e).__name__})"
            self.connected = False
            self._ws = None
            await asyncio.sleep(backoff)
            backoff = min(3.0, backoff * 2)

    async def _follow_loop(self):
        while True:
            await asyncio.sleep(self.follow.period)
            if not self.follow_enabled:
                continue
            s = self.latest
            actual = s.follow_actual if s else (float("nan"), float("nan"))
            tgt = self.follow.tick(time.monotonic_ns(), actual)
            if tgt is None:
                continue
            lim = self.follow_limit
            await self._send({"cmd": "camera_follow", "action": "target",
                              "target": {"mcp_deg": max(0.0, min(lim["mcp_deg"], tgt[0])),
                                         "pip_deg": max(0.0, min(lim["pip_deg"], tgt[1]))}})

    def _on_message(self, raw: str):
        try:
            m = json.loads(raw)
        except Exception:
            return
        if not isinstance(m, dict):
            return
        kind = m.get("kind") or m.get("type")
        if kind != "snap":
            if m.get("event"):
                self.acks.append((time.monotonic_ns(), m))
            return
        now = time.monotonic_ns()
        self.snap = m
        s = DeviceSample(t_ns=now, t_ms=float(m.get("t_ms") or 0))
        by = {j.get("id"): j for j in (m.get("joints") or []) if isinstance(j, dict)}
        vals, oks = [], []
        for ch in INDEX_CH:
            j = by.get(ch)
            ok = bool(j and j.get("ok"))
            vals.append(float(j["deg"]) if ok and j.get("deg") is not None else float("nan"))
            oks.append(ok)
        s.ab, s.mcp, s.pip = vals
        s.ok = tuple(oks)
        cf = m.get("camera_follow") or {}
        t, a = cf.get("target") or {}, cf.get("actual") or {}
        s.follow_target = (float(t.get("mcp_deg", float("nan"))), float(t.get("pip_deg", float("nan"))))
        s.follow_actual = (float(a.get("mcp_deg", float("nan"))), float(a.get("pip_deg", float("nan"))))
        s.follow_armed = bool(cf.get("armed"))
        if isinstance(cf.get("limit"), dict):
            self.follow_limit = {"mcp_deg": float(cf["limit"].get("mcp_deg", 35)), "pip_deg": float(cf["limit"].get("pip_deg", 45))}
        s.motors = [(mo.get("id"), float(mo.get("pos", float("nan"))), float(mo.get("ma", float("nan"))))
                    for mo in (m.get("motors") or []) if isinstance(mo, dict)]
        s.device_up = bool((m.get("link") or {}).get("device"))
        s.state = str(m.get("state") or "")
        self.latest = s
        self._frames += 1
        tn = time.monotonic()
        if tn - self._rate_t >= 1.0:
            self.hz = self._frames / (tn - self._rate_t)
            self._frames = 0
            self._rate_t = tn
            self.detail = f"linked · {self.hz:.0f} Hz"
        if self._rows is not None:
            self._rows.append([now, s.t_ms, s.ab, s.mcp, s.pip, int(s.ok[0]), int(s.ok[1]), int(s.ok[2]),
                               s.follow_target[0], s.follow_target[1], s.follow_actual[0], s.follow_actual[1],
                               int(s.follow_armed), int(s.device_up), s.state,
                               json.dumps(s.motors) if s.motors else ""])


DEVICE_COLS = ["t_ns", "t_ms", "index_mcp", "index_pip", "index_dip", "ok_mcp", "ok_pip", "ok_dip",
               "follow_target_mcp", "follow_target_pip", "follow_actual_mcp", "follow_actual_pip",
               "follow_armed", "device_up", "state", "motors"]
FOLLOW_COLS = ["t_sample_ns", "t_issued_ns", "t_done_ns", "target_mcp", "target_pip", "actual_mcp", "actual_pip", "reached"]
