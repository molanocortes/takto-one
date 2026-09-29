"""Research-grade takes (MOTION_PIPELINE.md section 8): the device clock
(t_us across its 32-bit wrap), per-IMU sample times, take quality on synthetic
gaps, the raw sidecar and its offline re-derivation (rederive.py == live rows),
the research CSV, and the SD importer producing the same quality/provenance.

In-process like test_bridge.py (conftest isolates SENSORYHAND_STATE_DIR);
rederive.py runs as a real subprocess so it starts from clean globals."""
import gzip
import io
import json
import math
import os
import subprocess
import sys

import pytest

import motion
import motion_synth as ms
import research
import sdcard
import sim_device
import teensy_bridge as tb

HERE = os.path.dirname(os.path.abspath(__file__))
REDERIVE = os.path.join(os.path.dirname(HERE), "rederive.py")
WRAP_S = 2 ** 32 / 1e6            # 4294.967296 s


@pytest.fixture
def sim_bridge(monkeypatch):
    """The bridge in sim encoding (joint-space encoders), fresh body/device state."""
    saved = (dict(tb.ENC_DOF), dict(tb.ENC_FINGER), dict(tb.ENC_OPEN), dict(tb.ENC_CLOSED),
             tb.ENC_JOINT_SPACE_DIRECT)
    monkeypatch.setattr(tb, "SIM_MODE", True)
    tb.ENC_DOF.clear()
    tb.ENC_JOINT_SPACE_DIRECT = True
    tb.DEVICE.update(boot_id=None, flags=None, last_t_ms=None)
    tb._frame_rate.update(t_prev=None, hz=None, dt=None)
    tb.BODY = tb._make_body()
    tb.BODY_REQ.clear()
    tb.RAW_RING.clear()
    tb.NEUTRAL_UI.update(phase=None, t0=None, source=None, want_enc_open=False)
    for k in tb.IMU_KEYS:
        tb.TRACKERS[k].reset()
    yield
    if tb.state["recording"]:
        tb.record_stop()
    tb.ENC_DOF.clear(); tb.ENC_DOF.update(saved[0])
    tb.ENC_FINGER.clear(); tb.ENC_FINGER.update(saved[1])
    tb.ENC_OPEN.clear(); tb.ENC_OPEN.update(saved[2])
    tb.ENC_CLOSED.clear(); tb.ENC_CLOSED.update(saved[3])
    tb.ENC_JOINT_SPACE_DIRECT = saved[4]


def feed(dev, t0, t1, skip=()):
    """Frames of the sim device for (t0, t1] through handle_line; frames whose
    index is in `skip` are generated (the device's clock runs) but not sent."""
    t, i = t0, 0
    while t < t1 - 1e-9:
        t = round(t + 0.01, 6)
        fr = dev.frame_at(t, 0.01)
        line = dev._sline(int(t * 1000), fr, t)
        if i not in skip:
            tb.handle_line(line)
        i += 1


# --------------------------------------------------------------------------
# the device clock
# --------------------------------------------------------------------------
def test_unwrap_us_is_stateless_and_crosses_the_wrap():
    for t_s in (0.001, 1.0, WRAP_S - 0.004, WRAP_S + 0.006, 3 * WRAP_S + 12.345, 40 * WRAP_S + 0.5):
        us = int(round(t_s * 1e6))
        t_ms = int(t_s * 1000)
        assert research.unwrap_us(t_ms, us & 0xFFFFFFFF) == us
    assert research.unwrap_us(1234, None) == 1234000                 # pre-v17: t_ms only
    # frames across the wrap stay 10 ms apart
    seq = [research.unwrap_us(int(t * 1000), int(round(t * 1e6)) & 0xFFFFFFFF)
           for t in (WRAP_S - 0.02, WRAP_S - 0.01, WRAP_S, WRAP_S + 0.01)]
    assert [b - a for a, b in zip(seq, seq[1:])] == [10000, 10000, 10000]


def test_t_us_wrap_through_the_bridge(sim_bridge):
    """A device that has been up 71.6 min: micros() wraps mid-stream. The body
    model's clock, the frame rate and a take's rows never notice."""
    dev = sim_device.SimDevice(tb.body_priors(), seed=21, preload=False)
    t0 = WRAP_S - 3.0
    feed(dev, t0, t0 + 2.0)
    tb.record_start("wrap", "wrap", "")
    ts = []
    t = t0 + 2.0
    while t < t0 + 4.0 - 1e-9:                # crosses t_us = 2^32 at t0 + 3 s
        t = round(t + 0.01, 6)
        fr = dev.frame_at(t, 0.01)
        tb.handle_line(dev._sline(int(t * 1000), fr, t))
        ts.append(tb.BODY.t)
    take = tb.record_stop()
    steps = [b - a for a, b in zip(ts, ts[1:])]
    assert min(steps) > 0.0099 and max(steps) < 0.0101          # 10 ms, no 71-minute jump
    assert abs(tb._frame_rate["hz"] - 100.0) < 0.5
    q = take["quality"]
    assert q["clock"] == "t_us" and q["dropped"] == 0 and q["frames"] == 200
    assert q["rate_hz"] == pytest.approx(100.0, abs=0.01) and q["max_gap_ms"] < 10.5
    data = json.load(open(tb._take_data_path(take["id"])))
    ci = {c: i for i, c in enumerate(data["cols"])}
    raw_us = [r[ci["t_us"]] for r in data["rows"]]
    assert any(a > b for a, b in zip(raw_us, raw_us[1:]))        # the wire value did wrap...
    dev_us = [research.unwrap_us(r[0], r[ci["t_us"]]) for r in data["rows"]]
    assert all(abs(b - a - 10000) <= 2 for a, b in zip(dev_us, dev_us[1:]))   # ...the unwrapped one did not


def test_imu_sample_times():
    fr = {"t": 1000, "t_dev_us": 1_000_000,
          "timing": {"t_us": 1_000_000, "qage_us": {"hand": 4000, "forearm": 0, "thumb": 11000}, "enc_us": 2500}}
    ts = tb.imu_sample_times(fr)
    assert ts["hand"] == pytest.approx(0.996) and ts["forearm"] is None and ts["thumb"] == pytest.approx(0.989)
    assert tb.imu_sample_times({"t": 5, "t_dev_us": 5000, "timing": None}) == {}


def test_sample_times_repeat_report_integrates_nothing():
    """A frame that carries the same IMU report again (dv_n = 0) adds no
    velocity, and a frame after a two-period gap uses the 20 ms the dv spans."""
    rng_m = {k: ms.perturb(tb.body_priors()[k], 0.0, __import__("random").Random(1)) for k in ms.KEYS}
    s = ms.Sensors(ms.Arm(), ms.shoulder_motion, rng_m, {k: 0.0 for k in ms.KEYS}, seed=2, noise=False)
    ss = ms.SampledSensors(s, seed=5)
    bm = motion.BodyModel(tb.body_priors())
    bm.auto_neutral = False
    seen_zero = seen_double = False
    t = 0.0
    while t < 6.0:
        t = round(t + 0.01, 6)
        fr = ss.frame(t, 0.01)
        fr["dv"] = {k: (fr["dv"][k] if fr["dv_n"][k] else None) for k in fr["dv"]}
        bm.update(fr)
        if abs(t - 2.5) < 1e-9:
            assert bm.capture_neutral(t_end=t, kind="t")["ok"]
        d = bm.dt_s["forearm"]
        if d == 0.0:
            seen_zero = True
        if d is not None and d > 0.015:
            seen_double = True
    assert seen_zero and seen_double          # the two clocks beat: both cases occur


# --------------------------------------------------------------------------
# quality
# --------------------------------------------------------------------------
def test_quality_counts_synthetic_gaps():
    q = research.QualityAccumulator(nominal_hz=100)
    t = 0
    gaps_ms = {50: 25, 120: 30, 300: 1200, 301: 10}    # after frame i, the next interval
    for i in range(1000):
        q.add(t, imu_live={"hand": True, "forearm": i % 10 != 0, "thumb": False},
              enc_ok=[True] * 12 + [False, False], cal=2 if i > 100 else 1, pos_src="arm",
              qage_us={"hand": 5000, "forearm": 6000, "thumb": 0}, enc_us=2500, rx_ms=t / 1000 + 3.0)
        t += gaps_ms.get(i, 10) * 1000
    q.add(t - 10000 * 3)                                  # a duplicate / backwards device time
    r = q.finish()
    # 25 ms -> floor(2.5 + 0.5) - 1 = 2, 30 ms -> 2, 1200 ms -> 119 missing frames
    assert r["gaps"] == 3 and r["dropped"] == 2 + 2 + 119
    assert r["dup"] == 1 and r["frames"] == 1000
    assert r["max_gap_ms"] == pytest.approx(1200.0)
    assert r["dropped_pct"] == pytest.approx(100.0 * 123 / 1123, abs=1e-3)
    assert r["imu_live_pct"] == {"hand": 100.0, "forearm": 90.0, "thumb": 0.0}
    assert r["enc_live"] == list(range(12))
    assert r["cal_pct"]["calibrated"] == pytest.approx(89.9)
    assert r["timing"]["qage_ms"]["hand"]["median"] == pytest.approx(5.0, abs=0.05)
    assert r["timing"]["qage_ms"]["thumb"] is None                   # 0 = no quaternion, not an age
    assert r["timing"]["enc_ms"]["median"] == pytest.approx(2.5, abs=0.01)
    assert r["timing"]["rx_jitter_ms"]["p95"] == pytest.approx(0.0, abs=0.1)
    assert r["grade"] == "poor"                                      # 10.9 % dropped
    assert r["latency_ms"] is None


def test_quality_grades():
    def run(n, every=None, live=True, cal=2):
        q = research.QualityAccumulator(nominal_hz=100)
        t = 0
        for i in range(n):
            q.add(t, imu_live={"hand": live, "forearm": True}, cal=cal)
            t += (20000 if (every and i % every == 0) else 10000)
        return q.finish()
    assert run(500)["grade"] == "good"
    assert run(500, every=50)["grade"] == "fair"                     # 2 % dropped
    assert run(500, cal=1)["grade"] == "fair"                        # provisional neutral only
    assert run(500, live=False)["grade"] == "poor"


def test_live_take_quality_sees_dropped_frames(sim_bridge):
    dev = sim_device.SimDevice(tb.body_priors(), seed=22, preload=False)
    feed(dev, 0.0, 2.0)
    tb.record_start("q", "gaps", "")
    feed(dev, 2.0, 5.0, skip={40, 41, 42, 150})             # 3 + 1 frames lost on the wire
    take = tb.record_stop()
    q = take["quality"]
    assert q["frames"] == 296 and q["dropped"] == 4 and q["gaps"] == 2
    assert q["max_gap_ms"] == pytest.approx(40.0, abs=0.6)
    assert q["imu_live_pct"]["hand"] == 100.0 and q["enc_live"] == list(range(12))
    assert q["neutral"]["status"] == "provisional" and q["neutral"]["kind"] == "auto"
    assert q["timing"]["qage_ms"]["forearm"]["p95"] < 12.5
    assert 1.8 < q["timing"]["enc_ms"]["median"] < 3.2
    meta = json.load(open(tb._meta_path(take["id"])))
    assert meta["quality"]["dropped"] == 4
    prov = meta["provenance"]
    assert prov["bridge_version"] == tb.BRIDGE_VERSION and prov["sim"] is True
    assert prov["boot_id"] == dev.boot_id and prov["fw"] >= 16
    assert set(prov["imu_mounting"]["priors"]) == {"hand", "forearm", "thumb"}
    assert {c["name"] for c in meta["columns"]} >= {"t_s", "elbow_x_m", "index_mcp_flex_rad", "enc_raw_00_rad"}


# --------------------------------------------------------------------------
# raw sidecar -> rederive.py == live rows
# --------------------------------------------------------------------------
def test_raw_sidecar_rederive_equals_live_rows(sim_bridge, tmp_path):
    dev = sim_device.SimDevice(tb.body_priors(), seed=11, preload=False)
    feed(dev, 0.0, 3.0)                          # provisional neutral happens here
    take_id, _ = tb.record_start("rt", "roundtrip", "")
    feed(dev, 3.0, 4.0)
    # the device's own neutral mid-take (E line + #N annotation in the stream)
    q = {k: motion.qaverage([dev.sensors.raw_quat(k, 3.5 + 0.01 * i) for i in range(50)]) for k in ms.KEYS}
    tb.handle_line("E,neutral,done,4000,%s" % ",".join("%.5f" % v for k in ms.KEYS for v in q[k]))
    feed(dev, 4.0, 10.0)
    take = tb.record_stop()
    raw = tb._raw_path(take_id)
    assert take["raw"]["file"] == take_id + ".raw.txt.gz" and os.path.getsize(raw) == take["raw"]["bytes"]
    lines = research.open_text(raw)
    assert lines[0] == "#takto-raw v1" and lines[-1].startswith("#end")
    rs = research.read_raw(lines)
    assert rs["complete"] and rs["meta"]["take"] == take_id and rs["meta"]["preroll"] >= 90
    assert sum(1 for _rx, ln in rs["items"] if ln.startswith("#N,b")) == 1
    assert sum(1 for _rx, ln in rs["items"] if ln.startswith("S,")) == rs["meta"]["preroll"] + take["rows"]
    out = tmp_path / "out"
    env = {k: v for k, v in os.environ.items() if k != "SENSORYHAND_STATE_DIR"}
    r = subprocess.run([sys.executable, REDERIVE, raw, "-o", str(out), "--csv"], capture_output=True,
                       text=True, env=env, timeout=120)
    assert r.returncode == 0, r.stderr
    live = json.load(open(tb._take_data_path(take_id)))
    off = json.load(open(out / (take_id + ".rows.json")))
    assert off["cols"] == live["cols"] and len(off["rows"]) == len(live["rows"]) == take["rows"]
    worst = {}
    for a, b in zip(live["rows"], off["rows"]):
        assert a[0] == b[0]
        for i, c in enumerate(live["cols"]):
            if c in ("blend", "act"):
                continue                      # UI/EMG state, not derived from the stream
            x, y = a[i], b[i]
            assert (x is None) == (y is None), c
            if x is not None:
                worst[c] = max(worst.get(c, 0.0), abs(x - y))
    print("\n[rederive] worst |live - offline| per column group: joints %.4f deg, body %.5f, "
          "legacy quats %.5f, strapdown %.2f mm"
          % (max(worst[c] for c in live["cols"][1:13]), max(worst[c] for c in motion.B_COLS),
             max(worst[c] for c in ("hq_w", "hq_x", "fq_w", "fq_x")),
             max(worst[c] for c in ("ihx", "ihy", "ihz", "ifx", "ify", "ifz"))))
    assert max(worst[c] for c in live["cols"][1:13]) < 0.02                   # deg
    assert max(worst[c] for c in motion.B_COLS) < 2e-4                        # m / quat components
    assert max(worst[c] for c in research.RAW_COLS if c in worst) < 1e-9       # raw is raw
    assert max(worst[c] for c in ("ihx", "ihy", "ihz", "ifx", "ify", "ifz")) < 0.5   # mm
    meta = json.load(open(out / (take_id + ".json")))
    lq, oq = take["quality"], meta["quality"]
    for k in ("frames", "dropped", "gaps", "rate_hz", "imu_live_pct", "enc_live", "cal_pct"):
        assert lq[k] == oq[k], k
    assert oq["neutral"]["kind"] == lq["neutral"]["kind"]
    assert meta["provenance"]["rederived_by"]["tool"] == "rederive.py"
    # the research CSV: SI header, one line per row, radians
    with open(out / (take_id + ".csv")) as f:
        head = f.readline().rstrip("\n").split(",")
        first = f.readline().rstrip("\n").split(",")
        n = 2 + sum(1 for _ in f)
    assert head == [c["name"] for c in research.RESEARCH_COLUMNS] and n == take["rows"] + 1
    hi = {c: i for i, c in enumerate(head)}
    assert float(first[hi["t_s"]]) == 0.0
    li = {c: i for i, c in enumerate(live["cols"])}
    assert float(first[hi["index_mcp_flex_rad"]]) == pytest.approx(math.radians(live["rows"][0][li["index_pip"]]), abs=1e-6)
    assert float(first[hi["elbow_y_m"]]) == pytest.approx(live["rows"][0][li["b_ey"]], abs=1e-4)


def test_truncated_raw_stream_is_still_readable(tmp_path):
    p = str(tmp_path / "x.raw.txt.gz")
    w = research.RawWriter(p, {"take": "take_0001"})
    for i in range(500):
        w.write(1.0 + i * 0.01, "S,%d,1,2,3" % i)
    w.f.flush()
    data = open(p, "rb").read()
    open(p, "wb").write(data[: len(data) // 2])          # the bridge died mid-take
    rs = research.read_raw(research.open_text(p))
    assert rs["meta"]["take"] == "take_0001" and not rs["complete"]
    st = research.RawStream(research.iter_lines(p))            # the streamed reader rederive uses
    items = list(st.items())
    assert st.meta["take"] == "take_0001" and not st.complete
    assert 0 < len(items) < 500 and all(ln.startswith("S,") for _rx, ln in items)
    assert items == rs["items"][:len(items)]


# --------------------------------------------------------------------------
# SD import: same quality/provenance, and the card file kept as the raw stream
# --------------------------------------------------------------------------
def test_sd_import_quality_provenance_and_rederive(sim_bridge, tmp_path):
    dev = sim_device.SimDevice(tb.body_priors(), seed=9, preload=False)
    dev._synth_take("TAKES/TK00077.CSV", 77, ms.shoulder_motion, dur=8.0, device_neutral=True)
    lines = dev.files["TAKES/TK00077.CSV"]
    # drop two rows as a damaged card would
    lines = lines[:300] + lines[302:]
    header = next(ln for ln in lines if ln.startswith("t_ms,"))
    assert header.endswith(",t_us,h_qage_us,f_qage_us,t_qage_us,enc_us")
    take = tb.import_sd_take(lines, "TAKES/TK00077.CSV", "take_7701")
    q = take["quality"]
    assert q["frames"] == 798 and q["dropped"] == 2 and q["clock"] == "t_us"
    assert q["neutral"]["kind"] == "sd-event" and q["cal_pct"]["calibrated"] > 60
    assert q["timing"]["qage_ms"]["hand"]["n"] == 798 and q["latency_ms"] is None
    assert take["raw"]["file"] == "take_7701.sd.csv.gz"
    with gzip.open(tb._raw_path("take_7701", ".sd.csv.gz"), "rt") as f:
        assert f.read().splitlines() == lines
    meta = json.load(open(tb._meta_path("take_7701")))
    assert meta["provenance"]["source"] == "sd" and meta["provenance"]["sd"]["name"] == "TAKES/TK00077.CSV"
    # the same file through rederive.py (the SD code path, sim encoding)
    csv = tmp_path / "TK00077.CSV"
    csv.write_text("\n".join(lines) + "\n")
    env = dict(os.environ)
    r = subprocess.run([sys.executable, REDERIVE, str(csv), "-o", str(tmp_path / "o"), "--sim"],
                       capture_output=True, text=True, env=env, timeout=120)
    assert r.returncode == 0, r.stderr
    live = json.load(open(tb._take_data_path("take_7701")))
    off = json.load(open(tmp_path / "o" / "TK00077.rows.json"))
    assert len(off["rows"]) == len(live["rows"])
    bi = live["cols"].index("b_wx")
    assert max(abs(a[bi] - b[bi]) for a, b in zip(live["rows"], off["rows"])) < 1e-9
    oq = json.load(open(tmp_path / "o" / "TK00077.json"))["quality"]
    assert oq["dropped"] == 2 and oq["frames"] == 798


# --------------------------------------------------------------------------
# the pose-lane message
# --------------------------------------------------------------------------
def test_pose_message_shape(sim_bridge):
    dev = sim_device.SimDevice(tb.body_priors(), seed=23, preload=False)
    feed(dev, 0.0, 2.0)
    fr = dev.frame_at(2.01, 0.01)
    line = dev._sline(2010, fr, 2.01)
    pf = tb.parse_s_line(line)
    d = tb.ingest_frame(pf, 1234.5678, line)
    m = tb.pose_message(pf, d, 1234.5678, 7)
    assert m["kind"] == "pose" and m["t"] == 2010 and m["us"] == 2010000 and m["seq"] == 7
    assert m["rx"] == 1234567.8 and m["cal"] == 1 and m["live"] is True
    assert len(m["e"]) == len(m["w"]) == len(m["h"]) == 3 and len(m["fq"]) == len(m["hq"]) == 4
    assert len(m["j"]) == 12 and all(isinstance(v, float) for v in m["j"])
    assert len(m["wd"]) == 3 and len(m["tq"]) == 4
    assert all(round(v, 4) == v for v in m["e"] + m["fq"])
    text = tb.wire_json(m)[:-1] + ',"tx":%.1f}' % 1234568.0
    assert json.loads(text)["tx"] == 1234568.0
