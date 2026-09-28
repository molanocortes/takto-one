"""Bridge-level tests: v16 parsing, the per-boot legacy tare, E-events, rows per
device frame, stale-state clearing, the F protocol client and the offline SD
import (checked against synthetic ground truth).

These import teensy_bridge in-process (conftest points SENSORYHAND_STATE_DIR at
a temporary directory) and drive it through handle_line(), the same entry
point the serial thread and the simulated device use."""
import json
import math
import os
import random
import threading
import time
import zlib

import pytest

import motion
import motion_synth as ms
import sdcard
import sim_device
import teensy_bridge as tb

PRIORS = tb.body_priors()


def make_dev(seed=1):
    dev = sim_device.SimDevice(PRIORS, seed=seed, emit=lambda line: None, preload=False)
    return dev


def sline(dev, t_s, dt=0.01):
    fr = dev.sensors.frame(t_s, dt)
    return dev._sline(int(round(t_s * 1000)), fr, t_s), fr


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------
def test_parse_v16_v15_v6_lines():
    dev = make_dev()
    dev.streaming = True
    line, fr = sline(dev, 1.0)
    p = line.split(",")
    assert len(p) == 140                                   # 0..139 per the contract
    v16 = tb.parse_s_line(line)
    assert v16["t"] == 1000
    assert v16["v16"]["boot_id"] == dev.boot_id
    assert v16["v16"]["flags"] & 2                         # SD present
    assert v16["v16"]["dv"]["forearm"] == pytest.approx(fr["dv"]["forearm"], abs=1e-4)
    assert v16["v16"]["stab"]["hand"] in (2, 4)
    assert v16["v16"]["dv_n"]["hand"] == 4
    assert v16["imu_full"]["hand"]["game"] == pytest.approx(fr["q"]["hand"], abs=1e-3)
    assert v16["crown"] is None and v16["crown_live"] is False   # crown_live -1: no crown
    v15 = tb.parse_s_line(",".join(p[:121]))
    assert v15["v16"] is None and v15["imu_full"] is not None
    v6 = tb.parse_s_line(",".join(p[:43]))
    assert v6["imu_full"] is None and v6["motors_fw"] is not None
    old = tb.parse_s_line(",".join(p[:30]))                # v3: crown without crown_live
    assert old["crown"] == 0.0 and old["crown_live"] is None
    assert tb.parse_s_line("S,1,2,3") is None
    assert tb.parse_s_line("S," + ",".join(["x"] * 40)) is None


def test_crown_live_is_honored():
    dev = make_dev()
    line, _ = sline(dev, 1.0)
    p = line.split(",")
    p[29] = "700"
    p[tb.CROWN_LIVE_IDX] = "1"
    assert tb.parse_s_line(",".join(p))["crown"] == pytest.approx(0.7)
    p[tb.CROWN_LIVE_IDX] = "-1"
    assert tb.parse_s_line(",".join(p))["crown"] is None


def test_mounting_prior_matches_the_bridges_own_legacy_stages():
    rng = random.Random(0)
    for key in tb.IMU_KEYS:
        cfg = tb.IMU_CFG_DEFAULT[key]
        m = motion.mounting_prior(cfg)
        for _ in range(20):
            q0 = motion.qnorm([rng.gauss(0, 1) for _ in range(4)])
            q = motion.qnorm([rng.gauss(0, 1) for _ in range(4)])
            tare = tb.quat_conj(tb._norm_quat(tb.remap_quat(q0, cfg["remap"])))
            legacy = tb.quat_mul(tare, tb.remap_quat(q, cfg["remap"]))
            model = motion.qmul(motion.qmul(motion.qconj(m), motion.qmul(motion.qconj(q0), q)), m)
            assert math.degrees(motion.qangle_between(legacy, model)) < 1e-5


# --------------------------------------------------------------------------
# the legacy tare can no longer come back from another boot
# --------------------------------------------------------------------------
def test_legacy_tare_is_per_boot(tmp_path):
    tb.DEVICE["boot_id"] = 100
    tb.IMU_TARE_HAND = motion.qnorm([0.9, 0.1, 0.2, 0.3])
    tb.IMU_TARE_FOREARM = motion.qnorm([0.8, -0.1, 0.4, 0.1])
    tb._save_tare({"hand": True, "forearm": True, "thumb": False})
    saved = json.load(open(tb._TARE_FILE))
    assert saved["boot_id"] == 100
    # a later bridge start, device on ANOTHER boot: the home must not come back
    tb._load_tare()
    assert tb._imu_tare_pending is True
    tb.DEVICE["boot_id"] = None
    tb._on_device_boot(200, "test")
    assert tb._imu_tare_pending is True and tb.IMU_TARE_HAND == [1.0, 0.0, 0.0, 0.0]
    # the SAME boot (bridge restart while the device stayed powered): adopted
    tb.DEVICE["boot_id"] = 100
    tb.IMU_TARE_HAND = motion.qnorm([0.9, 0.1, 0.2, 0.3])
    tb._save_tare({"hand": True, "forearm": True, "thumb": False})
    tb._load_tare()
    tb.DEVICE["boot_id"] = None
    tb._on_device_boot(100, "test")
    assert tb._imu_tare_pending is False
    assert tb.IMU_TARE_HAND == pytest.approx(motion.qnorm([0.9, 0.1, 0.2, 0.3]))
    # a file without a boot id (every pre-v16 bridge wrote those) never loads
    d = json.load(open(tb._TARE_FILE))
    d.pop("boot_id")
    json.dump(d, open(tb._TARE_FILE, "w"))
    tb._load_tare()
    assert tb._TARE_CANDIDATE is None and tb._imu_tare_pending is True


# --------------------------------------------------------------------------
# frames -> body, E-events, recording, reboot, stale state
# --------------------------------------------------------------------------
@pytest.fixture
def fresh_bridge():
    tb.DEVICE["boot_id"] = None
    tb.DEVICE["flags"] = None
    tb.DEVICE["last_t_ms"] = None
    tb._frame_rate.update(t_prev=None, hz=None, dt=None)
    tb.BODY = tb._make_body()
    tb.BODY_REQ.clear()
    tb.NEUTRAL_UI.update(phase=None, t0=None, source=None, want_enc_open=False)
    yield
    if tb.state["recording"]:
        tb.record_stop()


def feed(dev, t0, t1, dup_every=0):
    """Feed the sim device's frames for [t0, t1) through handle_line."""
    n, t = 0, t0
    frames = {}
    while t < t1 - 1e-9:
        t = round(t + 0.01, 6)
        line, fr = sline(dev, t)
        tb.handle_line(line)
        frames[int(round(t * 1000))] = fr
        if dup_every and n % dup_every == 0:
            tb.handle_line(line)                       # the same frame again
        n += 1
    return frames


def test_neutral_event_then_reboot(fresh_bridge):
    dev = make_dev(seed=4)
    feed(dev, 0.0, 2.0)
    b = tb.state["derived"]["body"]
    assert b["provisional"] is True and b["calibrated"] is False    # still arm: auto neutral
    assert tb._tare_state == "provisional"
    # the device's neutral: countdown, then done with the averaged raw game quats
    tb.handle_line("E,neutral,start")
    assert tb.NEUTRAL_UI["phase"] == "countdown"
    q = {k: motion.qaverage([dev.sensors.raw_quat(k, 1.0 + 0.01 * i) for i in range(100)])
         for k in ms.KEYS}
    vals = ",".join("%.5f" % v for k in ms.KEYS for v in q[k])
    tb.handle_line("E,neutral,done,2000,%s" % vals)
    feed(dev, 2.0, 2.2)
    b = tb.state["derived"]["body"]
    assert b["calibrated"] is True and b["provisional"] is False
    assert b["quality"]["neutral_kind"] == "device"
    assert tb.NEUTRAL_UI["phase"] == "done"
    assert tb._tare_state == "calibrated"
    saved = json.load(open(tb._BODY_FILE))
    assert saved["neutral"]["boot_id"] == dev.boot_id
    # neutral pose => the body model reads a straight wrist and a hanging arm
    assert abs(b["wrist_deg"]["flex"]) < 3 and abs(b["wrist_deg"]["dev"]) < 3
    assert b["elbow_m"] == pytest.approx([0, -0.3, 0], abs=0.01)
    # power cycle: new boot id -> the neutral and the legacy home are gone
    dev.reboot()
    feed(dev, 0.0, 0.5)
    b = tb.state["derived"]["body"]
    assert b["calibrated"] is False
    assert tb.DEVICE["boot_id"] == dev.boot_id
    assert tb._tare_state in ("none", "provisional")


def test_rows_once_per_device_frame(fresh_bridge):
    dev = make_dev(seed=5)
    feed(dev, 0.0, 2.0)
    take_id, started = tb.record_start("test", "rows", "")
    assert started
    frames = feed(dev, 2.0, 5.0, dup_every=3)                 # every 3rd frame arrives twice
    take = tb.record_stop()
    data = json.load(open(tb._take_data_path(take_id)))
    ts = [r[0] for r in data["rows"]]
    assert len(ts) == len(set(ts)) == len(frames)             # one row per device frame
    assert data["cols"][-15:] == motion.B_COLS
    assert len(data["cols"]) == len(data["rows"][0]) == 59
    assert take["rows"] == len(frames) and take["body"] is True
    assert not os.path.exists(tb._spool_path(take_id))
    cal = data["cols"].index("b_cal")
    assert {r[cal] for r in data["rows"]} <= {1, 2}


def test_device_lines_are_surfaced(fresh_bridge):
    tb.handle_line("# SD WRITE FAILED after 12 rows - recording stopped")
    assert "SD WRITE FAILED" in tb.DEVICE["last_error"]["text"]
    tb.handle_line("E,rec,fail,nosd")
    assert tb.DEVICE["last_error"]["code"] == "sd_nosd"
    tb.handle_line(">>> RECORDING to TAKES/TK00003.CSV")
    assert tb.DEVICE["messages"][-1]["text"].startswith(">>> RECORDING")
    tb.handle_line("E,standby,1")
    assert tb.DEVICE["standby"] is True
    tb.handle_line("E,standby,0")


def test_sd_take_is_bound_to_the_bridge_take(fresh_bridge):
    dev = make_dev(seed=6)
    feed(dev, 0.0, 0.3)
    take_id, _ = tb.record_start("test", "bind", "")
    tb.handle_line("E,rec,start,12,host")
    feed(dev, 0.3, 0.6)
    take = tb.record_stop()
    assert take["sd_take"] == 12


def test_stale_state_is_cleared(fresh_bridge):
    dev = make_dev(seed=7)
    feed(dev, 0.0, 0.5)
    assert tb.state["imu_live"] == [1, 1]
    tb.clear_stale_device_state("test")
    assert tb.state["imu_live"] == [0, 0]
    assert tb.state["motors_fw"] is None and tb.state["imu_full"] is None
    assert all(e < 0 for e in tb.state["enc"])
    assert tb.state["derived"]["body"]["live"] is False
    assert not any(j["ok"] for j in tb.state["derived"]["joints"])


def test_bridge_timed_neutral_for_old_firmware(fresh_bridge):
    """Firmware without N: the bridge counts down itself and averages its own
    frames of the hold."""
    dev = make_dev(seed=8)
    tb.DEVICE["flags"] = None
    lines = []
    for i in range(300):                                   # a v15 stream (no v16 tail)
        t = round(0.01 * (i + 1), 6)
        line, _ = sline(dev, t)
        lines.append(",".join(line.split(",")[:121]))
    for ln in lines[:100]:
        tb.handle_line(ln)
    res = tb.start_neutral_capture(enc_open=False)
    assert res == {"ok": True, "via": "bridge"}
    tb.NEUTRAL_UI["t0"] -= 5.1                            # fast-forward the host countdown + hold
    tb._neutral_ui_tick(time.time())
    for ln in lines[100:]:
        tb.handle_line(ln)
    b = tb.state["derived"]["body"]
    assert b["calibrated"] is True and b["quality"]["neutral_kind"] == "bridge"
    assert tb.DEVICE["boot_id"] is None


# --------------------------------------------------------------------------
# the F protocol client
# --------------------------------------------------------------------------
class FakeWire:
    """A device on the other end of SdClient: answers F commands from a thread."""

    def __init__(self, files, corrupt=False, silent=False, err=None):
        self.files = files
        self.corrupt, self.silent, self.err = corrupt, silent, err
        self.client = None

    def write(self, data):
        cmd = data.decode().strip()
        threading.Thread(target=self._answer, args=(cmd,), daemon=True).start()

    def _answer(self, cmd):
        time.sleep(0.01)
        feed = self.client.feed
        if self.silent:
            return
        if self.err:
            feed("F,err,%s" % self.err)
            return
        if cmd == "F,list":
            for name, data in self.files.items():
                feed("F,item,%s,%d" % (name, len(data)))
            feed("F,end,%d" % len(self.files))
        elif cmd.startswith("F,get,"):
            name = cmd[6:]
            data = self.files[name]
            feed("F,begin,%s,%d" % (name, len(data)))
            lines = data.decode().split("\n")[:-1]
            for i, ln in enumerate(lines):
                if self.corrupt and i == 3:
                    ln = ln.replace("1", "7")
                feed("F,d," + ln)
            feed("F,done,%s,%d,%08x" % (name, len(data), zlib.crc32(data) & 0xFFFFFFFF))


def _client(wire):
    c = sdcard.SdClient(wire.write)
    c.IDLE_TIMEOUT_S = c.BEGIN_TIMEOUT_S = c.LIST_TIMEOUT_S = 0.5
    wire.client = c
    return c


def test_sd_client_list_get_crc():
    body = "# takto take v1\n# fw=16 boot=7 take=1 source=device rate_hz=100 start_ms=0\nt_ms,a\n1,2\n2,3\n"
    files = {"TAKES/TK00001.CSV": body.encode(), "REC00003.CSV": b"t_ms\n1\n"}
    c = _client(FakeWire(files))
    assert c.list() == [("TAKES/TK00001.CSV", len(body)), ("REC00003.CSV", 7)]
    assert "\n".join(c.get("TAKES/TK00001.CSV")) + "\n" == body
    assert not c.busy
    with pytest.raises(sdcard.SdError, match="CRC"):
        _client(FakeWire(files, corrupt=True)).get("TAKES/TK00001.CSV")
    with pytest.raises(sdcard.SdError, match="busy"):
        _client(FakeWire(files, err="busy")).get("TAKES/TK00001.CSV")
    with pytest.raises(sdcard.SdError, match="timeout"):
        _client(FakeWire(files, silent=True)).get("TAKES/TK00001.CSV")


def test_verify_transfer_last_line_without_newline():
    data = b"a,b\n1,2"
    lines = ["a,b", "1,2"]
    assert sdcard.verify_transfer(lines, str(len(data)), "%08x" % zlib.crc32(data)) == lines
    crlf = b"a,b\r\n1,2\r\n"
    assert sdcard.verify_transfer(lines, str(len(crlf)), "%08x" % zlib.crc32(crlf)) == lines


# --------------------------------------------------------------------------
# offline import == the live pipeline, checked against the truth
# --------------------------------------------------------------------------
@pytest.mark.parametrize("device_neutral", [True, False])
def test_sd_import_offline_matches_truth(monkeypatch, device_neutral):
    monkeypatch.setattr(tb, "SIM_MODE", True)
    dev = make_dev(seed=9)
    sens = dev._synth_take("TAKES/TK00077.CSV", 77, ms.shoulder_motion, dur=10.0,
                           device_neutral=device_neutral)
    text = "\n".join(dev.files["TAKES/TK00077.CSV"]) + "\n"
    parsed = sdcard.parse_take_csv(text)
    assert parsed["cols"] == sdcard.SD_COLUMNS and len(parsed["rows"]) == 1000
    assert len(sdcard.parse_row(parsed["rows"][0], len(parsed["cols"]))) == 124
    assert (parsed["neutral"] is None) == device_neutral
    body_before = dict(tb.state.get("derived") or {})
    take = tb.import_sd_take(text, "TAKES/TK00077.CSV", "take_7777")
    assert (tb.state.get("derived") or {}) == body_before       # live state untouched
    assert take["source"] == "sd" and take["neutral"] == "device" and take["rows"] == 1000
    data = json.load(open(tb._take_data_path("take_7777")))
    cols = data["cols"]
    ci = {c: i for i, c in enumerate(cols)}
    worst = 0.0
    for r in data["rows"][300:]:
        t = (r[0] - 5000) / 1000.0
        tr = sens.truth(t)
        qf = [r[ci["b_fq_w"]], r[ci["b_fq_x"]], r[ci["b_fq_y"]], r[ci["b_fq_z"]]]
        qh = [r[ci["b_hq_w"]], r[ci["b_hq_x"]], r[ci["b_hq_y"]], r[ci["b_hq_z"]]]
        worst = max(worst, math.degrees(motion.qangle_between(qf, tr["q"]["forearm"])),
                    math.degrees(motion.qangle_between(qh, tr["q"]["hand"])))
        assert r[ci["b_cal"]] == 2
    print("\n[sd import, %s neutral] worst segment error %.2f deg"
          % ("inline #E" if device_neutral else "header", worst))
    assert worst < 4.0
    ts = [r[0] for r in data["rows"]]
    assert len(ts) == len(set(ts))


def test_body_neutral_survives_a_bridge_restart_only_on_the_same_boot(fresh_bridge):
    dev = make_dev(seed=10)
    feed(dev, 0.0, 1.0)
    q = {k: motion.qaverage([dev.sensors.raw_quat(k, 0.5 + 0.01 * i) for i in range(50)])
         for k in ms.KEYS}
    tb.handle_line("E,neutral,done,1000,%s" % ",".join("%.5f" % v for k in ms.KEYS for v in q[k]))
    rec = json.load(open(tb._BODY_FILE))["neutral"]
    assert rec["boot_id"] == dev.boot_id
    # "restart": a fresh model and the persisted record as the pending candidate
    for boot, expect in ((dev.boot_id, True), (dev.boot_id + 1, False)):
        tb.BODY = tb._make_body()
        tb._body_load()
        assert tb._BODY_NEUTRAL_CANDIDATE is not None
        tb.DEVICE["boot_id"] = None
        tb._on_device_boot(boot, "first")
        assert tb.BODY.status() == ("calibrated" if expect else "none")
