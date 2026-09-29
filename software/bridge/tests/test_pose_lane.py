"""The fast pose lane and the research export over a real WebSocket
(MOTION_PIPELINE.md section 8): launches `teensy_bridge.py --sim` on a free,
non-reserved port (never 8765/8096/8097) and checks

  * opt-in: a client that sent {"cmd":"stream","pose":true} gets ~100 Hz
    `pose` messages, one that did not gets none; opting out stops them
  * every pose carries a fresh seq, rx <= tx, and the contract fields
  * the snapshot reports link.latency_ms (median/p95 of tx - rx) and pose_hz
  * a recorded take: quality + provenance in the library, and take_file
    delivers the raw stream (gzip), take.json and the research take.csv as
    base64 chunks that reassemble byte-exact

~20 s. Prints the measured pose rate and the bridge-internal latency.
"""
import asyncio
import base64
import gzip
import json
import time

import pytest

websockets = pytest.importorskip("websockets")

from test_smoke_sim import Client, bridge, free_port  # noqa: F401  (fixture re-export)

import research


async def collect(c, seconds):
    poses, snaps = [], []
    t0 = time.time()
    while time.time() - t0 < seconds:
        m = json.loads(await asyncio.wait_for(c.ws.recv(), 5))
        k = m.get("kind")
        if k == "pose":
            m["_arr"] = time.time() * 1000.0
            poses.append(m)
        elif k == "snap":
            c.snap = m
            snaps.append(m)
        else:
            c.msgs.append(m)
    return poses, snaps


async def fetch_file(c, take_id, what, timeout=30):
    await c.send({"cmd": "take_file", "id": take_id, "what": what})
    parts, meta = [], None
    t0 = time.time()
    while time.time() - t0 < timeout:
        m = json.loads(await asyncio.wait_for(c.ws.recv(), timeout))
        if m.get("kind") == "take_file" and m.get("id") == take_id and m.get("what") == what:
            assert m["seq"] == len(parts)
            parts.append(base64.b64decode(m["data"]))
            meta = m
            if m["last"]:
                data = b"".join(parts)
                assert len(data) == m["bytes"]
                return data, meta
        elif m.get("event") == "error" and m.get("cmd") == "take_file":
            raise AssertionError(m)
    raise AssertionError("take_file %s timed out" % what)


async def scenario(port):
    url = "ws://127.0.0.1:%d/ws" % port
    async with websockets.connect(url, max_size=64 * 1024 * 1024) as wa, \
            websockets.connect(url, max_size=64 * 1024 * 1024) as wb:
        a, b = Client(wa), Client(wb)
        await a.next(lambda m: m.get("kind") == "snap" and m["link"]["device"], timeout=15, what="live")
        await a.send({"cmd": "stream", "pose": True})
        ack = await a.next(lambda m: m.get("event") == "stream", what="stream ack")
        assert ack["pose"] is True and ack["hz"] == 100.0
        await asyncio.sleep(0.5)
        (pa, sa), (pb, sb) = await asyncio.gather(collect(a, 4.0), collect(b, 4.0))
        assert not pb, "a client that did not opt in got pose messages"
        assert len(sb) > 150 and len(sa) > 150                   # snapshots keep flowing (60 Hz)
        span = (pa[-1]["_arr"] - pa[0]["_arr"]) / 1000.0
        rate = (len(pa) - 1) / span
        seqs = [p["seq"] for p in pa]
        gaps = sum(1 for x, y in zip(seqs, seqs[1:]) if y != x + 1)
        dev_rate = (len(pa) - 1) / ((pa[-1]["us"] - pa[0]["us"]) / 1e6)
        lat = sorted(p["tx"] - p["rx"] for p in pa)
        e2e = sorted(p["_arr"] - p["rx"] for p in pa)
        pct = lambda v, q: v[min(len(v) - 1, int(q * len(v)))]
        print("\n[pose lane] %d poses in %.2f s = %.1f Hz (device clock %.1f Hz), seq gaps %d"
              % (len(pa), span, rate, dev_rate, gaps))
        print("[pose lane] bridge tx-rx ms: p50 %.2f p95 %.2f max %.2f | to this client p50 %.2f p95 %.2f"
              % (pct(lat, .5), pct(lat, .95), lat[-1], pct(e2e, .5), pct(e2e, .95)))
        # the device-clock rate is the lane's rate; arrival-based `rate` is
        # skewed by this (Python, two-client) test reader catching up
        # [2026-09-29] the count is NOT asserted at 350: the simulated device is
        # Python inside the bridge process and falls behind real time on a
        # loaded machine (seen: load average 23-31, 2.3 s of device time in a 4 s
        # window, every message in sequence at exactly 100 Hz device clock). The
        # lane's properties are the device-clock rate, continuity and latency.
        assert 95.0 <= dev_rate <= 105.0 and len(pa) >= 150, (dev_rate, len(pa), rate)
        assert gaps <= 5
        assert all(p["tx"] >= p["rx"] for p in pa)
        assert all(y > x for x, y in zip(seqs, seqs[1:]))
        assert pct(lat, .95) < 20.0
        p = pa[-1]
        for k in ("t", "us", "seq", "rx", "tx", "cal", "live", "e", "w", "h", "fq", "hq", "wd", "j", "tq"):
            assert k in p, k
        assert len(p["j"]) == 12 and len(p["fq"]) == 4 and len(p["e"]) == 3
        link = a.snap["link"]
        print("[pose lane] snapshot link: latency_ms %s, pose_hz %s, frame_hz %s, serial_jitter_ms %s"
              % (link["latency_ms"], link["pose_hz"], link["frame_hz"], link["serial_jitter_ms"]))
        assert link["pose_clients"] == 1 and 90 <= link["pose_hz"] <= 110
        assert link["latency_ms"]["n"] > 100 and link["latency_ms"]["p95"] < 20.0
        assert 95 <= link["frame_hz"] <= 105

        # opt out: the lane stops for this client
        await a.send({"cmd": "stream", "pose": False})
        await a.next(lambda m: m.get("event") == "stream" and m["pose"] is False, what="stream off")
        await asyncio.sleep(0.2)
        pa2, _ = await collect(a, 1.0)
        assert not pa2

        # a research take: record 2 s, then the three files
        await a.send({"cmd": "stream", "pose": True})
        await a.send({"cmd": "record", "action": "start", "task": "pose-lane"})
        rs = await a.next(lambda m: m.get("event") == "rec_started", what="rec_started")
        await collect(a, 2.0)
        await a.send({"cmd": "record", "action": "stop"})
        await a.next(lambda m: m.get("event") == "rec_stopped", what="rec_stopped")
        await a.send({"cmd": "stream", "pose": False})
        takes = await a.next(lambda m: m.get("kind") == "takes" and m["takes"] and m["takes"][0]["id"] == rs["id"],
                             what="takes push")
        tk = takes["takes"][0]
        q = tk["quality"]
        assert isinstance(q, dict) and q["grade"] in ("good", "fair", "poor")
        assert q["frames"] > 150 and q["clock"] == "t_us" and q["latency_ms"]["n"] > 100
        assert tk["raw"]["file"] == rs["id"] + ".raw.txt.gz" and tk["research"] is True
        print("[take] %s: %d frames %.1f Hz dropped %d, latency p50 %.2f p95 %.2f ms, grade %s"
              % (tk["id"], q["frames"], q["rate_hz"], q["dropped"], q["latency_ms"]["median"],
                 q["latency_ms"]["p95"], q["grade"]))
        raw, m = await fetch_file(a, rs["id"], "raw")
        assert m["name"] == rs["id"] + ".raw.txt.gz" and m["mime"] == "application/gzip"
        text = gzip.decompress(raw).decode()
        assert text.startswith("#takto-raw v1\n#meta ") and "\tS," in text
        assert len(raw) == tk["raw"]["bytes"]
        meta, _ = await fetch_file(a, rs["id"], "meta")
        meta = json.loads(meta)
        assert meta["format"] == "takto-research-take v1"
        assert meta["quality"]["frames"] == q["frames"] and meta["provenance"]["bridge_version"]
        assert meta["columns"] == research.RESEARCH_COLUMNS
        csv, m = await fetch_file(a, rs["id"], "csv")
        lines = csv.decode().splitlines()
        assert lines[0].split(",") == [c["name"] for c in research.RESEARCH_COLUMNS]
        assert len(lines) == tk["rows"] + 1
        bad = json.loads(json.dumps({"cmd": "take_file", "id": "../etc", "what": "raw"}))
        await a.send(bad)
        err = await a.next(lambda m: m.get("event") == "error" and m.get("cmd") == "take_file", what="refusal")
        assert "bad take id" in err["error"]


def test_pose_lane_and_take_files(bridge):
    port, proc, _ = bridge
    assert proc.poll() is None, "bridge exited early"
    asyncio.run(scenario(port))
    assert proc.poll() is None
