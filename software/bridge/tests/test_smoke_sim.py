"""End-to-end smoke test: launch `teensy_bridge.py --sim` as a real process on
a free, non-reserved port with an isolated state directory, talk to it over
WebSocket like a surface does, and check the contract end to end:

  * snapshots carry a sane `body` block: provisional before a neutral, the
    wrist actually moving, calibrated after {"cmd":"calibrate","what":"neutral"}
    (countdown -> hold -> done acks)
  * record start/stop: rows once per device frame (no duplicate t_ms), the b_*
    columns present, b_cal = 2 after the neutral
  * the SD library: sd_takes on connect / after list, the take just recorded is
    on the (simulated) card, an import round-trips into a normal take
  * a simulated power cycle drops the neutral (device_boot ack)

~40 s. Run: pytest tests/test_smoke_sim.py -s
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import time

import pytest

websockets = pytest.importorskip("websockets")

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(os.path.dirname(HERE), "teensy_bridge.py")
RESERVED = {8080, 8096, 8097, 8765}


def free_port(preferred=8799):
    for p in [preferred] + list(range(8800, 8900)):
        if p in RESERVED:
            continue
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free port")


@pytest.fixture
def bridge(tmp_path):
    port = free_port()
    env = dict(os.environ, SENSORYHAND_STATE_DIR=str(tmp_path), PYTHONUNBUFFERED="1")
    log = open(tmp_path / "bridge.log", "w")
    proc = subprocess.Popen([sys.executable, "-u", BRIDGE, "--sim", "--ws-host", "127.0.0.1",
                             "--ws-port", str(port)], stdout=log, stderr=subprocess.STDOUT, env=env)
    t0 = time.time()
    while time.time() - t0 < 20:          # ready when the server says so (no raw TCP probe)
        if "ecosystem host" in (tmp_path / "bridge.log").read_text() or proc.poll() is not None:
            break
        time.sleep(0.2)
    try:
        yield port, proc, tmp_path
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        print("\n---- bridge log ----\n" + (tmp_path / "bridge.log").read_text()[-3000:])


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.snap = None
        self.msgs = []

    async def next(self, pred, timeout=20.0, what=""):
        t0 = time.time()
        while time.time() - t0 < timeout:
            m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout))
            if m.get("kind") == "snap":
                self.snap = m
            else:
                self.msgs.append(m)
            if pred(m):
                return m
        raise AssertionError("timed out waiting for " + what)

    async def snaps(self, seconds):
        out = []
        t0 = time.time()
        while time.time() - t0 < seconds:
            m = await self.next(lambda m: m.get("kind") == "snap", what="snap")
            out.append(m)
        return out

    async def send(self, obj):
        await self.ws.send(json.dumps(obj))


async def scenario(port):
    async with websockets.connect("ws://127.0.0.1:%d/ws" % port, max_size=512 * 1024 * 1024) as ws:
        c = Client(ws)
        m = await c.next(lambda m: m.get("kind") == "sd_takes", what="sd_takes on connect")
        assert "items" in m and "busy" in m

        # 1. the body block before any neutral: provisional after the first still 1.5 s
        await c.next(lambda m: m.get("kind") == "snap" and m["body"]["provisional"], timeout=15,
                     what="provisional neutral")
        b = c.snap["body"]
        assert b["frame"] == "body_yup_v1" and b["calibrated"] is False and b["live"] is True
        assert c.snap["device"]["fw"] == 16 and c.snap["device"]["boot_id"]
        assert c.snap["rel"]["source"] == "body"

        # 2. the wrist moves (the sim choreography is running)
        snaps = await c.snaps(5.0)
        xs = [s["body"]["wrist_m"] for s in snaps]
        span = max(max(v[i] for v in xs) - min(v[i] for v in xs) for i in range(3))
        assert span > 0.02, "wrist_m did not move (%.3f m)" % span
        ts = [s["t_ms"] for s in snaps]
        assert ts[-1] > ts[0]

        # 3. neutral: countdown -> hold -> done, then calibrated
        await c.send({"cmd": "calibrate", "what": "neutral"})
        phases = []
        done = await c.next(lambda m: m.get("event") == "neutral" and
                            (phases.append(m.get("phase")) or m.get("phase") in ("done", "abort")),
                            timeout=25, what="neutral done")
        assert done["phase"] == "done", done
        assert "countdown" in phases and "hold" in phases
        await c.next(lambda m: m.get("kind") == "snap", what="snap")
        b = c.snap["body"]
        assert b["calibrated"] is True and b["provisional"] is False
        assert b["quality"]["neutral_kind"] == "device"

        # 4. record 3 s: one row per device frame, b_* columns, calibrated rows
        await c.send({"cmd": "record", "action": "start", "task": "smoke"})
        rs = await c.next(lambda m: m.get("event") == "rec_started", what="rec_started")
        await c.next(lambda m: m.get("event") == "sd_rec" and m.get("phase") == "start",
                     what="SD take opened")
        await c.snaps(3.0)
        await c.send({"cmd": "record", "action": "stop"})
        await c.next(lambda m: m.get("event") == "rec_stopped", what="rec_stopped")
        await c.send({"cmd": "take_data", "id": rs["id"]})
        td = await c.next(lambda m: m.get("kind") == "take_data", what="take_data")
        cols, rows = td["cols"], td["rows"]
        for col in ("b_ex", "b_ey", "b_ez", "b_wx", "b_wy", "b_wz", "b_fq_w", "b_hq_z", "b_cal"):
            assert col in cols
        t = [r[0] for r in rows]
        assert len(t) == len(set(t)), "duplicate t_ms rows"
        assert len(rows) > 200, "expected ~100 rows/s, got %d in 3 s" % len(rows)
        assert {r[cols.index("b_cal")] for r in rows} == {2}
        print("\n[smoke] recorded %d rows in ~3 s, t_ms unique" % len(rows))

        # 5. SD library: list, then import a standalone take
        await c.send({"cmd": "sd", "action": "list"})
        lst = await c.next(lambda m: m.get("kind") == "sd_takes" and m.get("listed") and not m["busy"],
                           timeout=15, what="sd list")
        names = [i["name"] for i in lst["items"]]
        assert "TAKES/TK00001.CSV" in names and "TAKES/TK00091.CSV" in names
        await c.send({"cmd": "sd", "action": "import", "name": "TAKES/TK00091.CSV"})
        imp = await c.next(lambda m: m.get("event") == "sd_imported" or
                           (m.get("event") == "sd_import" and m.get("ok") is False),
                           timeout=60, what="sd_imported")
        assert imp.get("event") == "sd_imported", imp
        pcts = [m["pct"] for m in c.msgs if m.get("event") == "sd_import" and m.get("pct") is not None]
        assert pcts and pcts[-1] == 100
        lst = await c.next(lambda m: m.get("kind") == "sd_takes" and not m["busy"], what="sd_takes after import")
        assert any(i["imported_take"] == imp["take"] for i in lst["items"])
        await c.send({"cmd": "take_data", "id": imp["take"]})
        td = await c.next(lambda m: m.get("kind") == "take_data", what="imported take_data")
        assert len(td["rows"]) == 1200 and td["cols"] == cols
        assert {r[cols.index("b_cal")] for r in td["rows"]} == {2}
        print("[smoke] imported TK00091 -> %s (%d rows)" % (imp["take"], len(td["rows"])))

        # 6. a power cycle of the device drops the neutral
        await c.send({"cmd": "sim", "action": "reboot"})
        ev = await c.next(lambda m: m.get("event") == "device_boot", timeout=10, what="device_boot")
        assert ev["neutral_dropped"] is True
        await c.next(lambda m: m.get("kind") == "snap" and m["device"]["boot_id"] == ev["boot_id"],
                     what="snap after reboot")
        assert c.snap["body"]["calibrated"] is False


def test_sim_bridge_end_to_end(bridge):
    port, proc, _ = bridge
    assert proc.poll() is None, "bridge exited early"
    asyncio.run(scenario(port))
    assert proc.poll() is None
