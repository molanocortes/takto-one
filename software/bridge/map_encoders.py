#!/usr/bin/env python3
"""map_encoders.py - learn which encoder channel measures which finger joint.

The glove has up to 12 AS5600 encoders (4 fingers x MCP abduction, MCP flexion,
PIP flexion) on 14 mux channels, and the wiring decides which channel is which.
Instead of trusting a wiring table, this asks the wearer to move one joint at a
time and watches every channel:

  1. HOLD STILL (1.5 s): a channel that moves while the hand is still has no
     magnet (an AS5600 without one reads noise) and is excluded.
  2. MOVE the named joint through its range (4 s): the channel with the largest
     smooth travel is that joint.
  3. HOLD it bent / spread toward the thumb (1.5 s): the direction of the change
     gives the channel's sign.

It talks to the running bridge (nothing to stop), prints what it found, and
stores the map with {"cmd":"enc_map","action":"set"} (the bridge keeps it in
.takto_enc_map.json). Afterwards run the hand calibration (open / closed) in
the console so each flexion channel gets its travel.

    python3 software/bridge/map_encoders.py                 # all 12 joints
    python3 software/bridge/map_encoders.py --only index    # one finger
    python3 software/bridge/map_encoders.py --show          # print the current map
    python3 software/bridge/map_encoders.py --set 10=index:abduct 8=index:mcpflex:-1
"""
import argparse
import asyncio
import json
import math
import sys
import time

try:
    import websockets
except ImportError:
    sys.exit("pip install websockets (see software/bridge/requirements.txt)")

FINGERS = ["index", "middle", "ring", "pinky"]
DOFS = [("abduct", "side to side (spread / close the finger)", "spread it TOWARD THE THUMB"),
        ("mcpflex", "at the KNUCKLE, up and down", "hold the knuckle BENT"),
        ("pipflex", "at the MIDDLE JOINT, up and down", "hold the middle joint BENT")]
STILL_S, MOVE_S, HOLD_S = 1.5, 4.0, 1.5
NOISE_DEG = 3.0          # travel while "still" above this = no magnet / loose
MIN_TRAVEL_DEG = 12.0    # a joint moved through its range travels far more


def wrap180(d):
    return (d + 180.0) % 360.0 - 180.0


class Channels:
    """Unwrapped per-channel angle traces from the bridge's snapshots."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.tr = {}                            # ch -> list of continuous degrees

    def add(self, encoders):
        for e in encoders:
            if not e.get("ok"):
                continue
            ch, d = int(e["ch"]), float(e["deg"])
            t = self.tr.setdefault(ch, [])
            t.append(d if not t else t[-1] + wrap180(d - (t[-1] % 360.0)))

    def travel(self):
        return {ch: (max(t) - min(t)) for ch, t in self.tr.items() if len(t) > 3}

    def mean(self):
        return {ch: sum(t) / len(t) for ch, t in self.tr.items() if t}


async def collect(ws, secs, chans):
    chans.reset()
    t0 = time.time()
    while time.time() - t0 < secs:
        try:
            m = json.loads(await asyncio.wait_for(ws.recv(), 2.0))
        except asyncio.TimeoutError:
            sys.exit("no data from the bridge: is it running and connected to the device?")
        if m.get("kind") == "snap":
            chans.add(m.get("encoders") or [])


def prompt(msg, timed):
    if timed:
        for k in (3, 2, 1):
            print(f"\r  {msg}  starting in {k} ", end="", flush=True)
            time.sleep(1.0)
        print(f"\r  {msg}  NOW".ljust(80))
    else:
        input(f"  {msg}  [Enter] ")


async def learn(ws, targets, timed):
    chans = Channels()
    found, taken = {}, set()
    for finger, (dof, how, hold) in targets:
        print(f"\n{finger.upper()} - {dof}")
        prompt("Relax the hand and HOLD STILL", timed)
        await collect(ws, STILL_S, chans)
        noisy = {ch for ch, tv in chans.travel().items() if tv > NOISE_DEG}
        still_mean = chans.mean()
        prompt(f"Move the {finger} finger {how}, through its whole range, until told to stop", timed)
        await collect(ws, MOVE_S, chans)
        tv = {ch: v for ch, v in chans.travel().items() if ch not in noisy and ch not in taken}
        ranked = sorted(tv.items(), key=lambda kv: -kv[1])
        if not ranked or ranked[0][1] < MIN_TRAVEL_DEG:
            best = f"{ranked[0][1]:.0f} deg on ch{ranked[0][0]}" if ranked else "nothing"
            print(f"  -> no channel moved enough (best: {best}). Magnet missing or joint not wired; skipped.")
            continue
        ch, travel = ranked[0]
        if len(ranked) > 1 and ranked[1][1] > 0.6 * travel:
            print(f"  (note: ch{ranked[1][0]} also moved {ranked[1][1]:.0f} deg - coupled joint or loose mount?)")
        prompt(f"Now {hold} and keep it there", timed)
        await collect(ws, HOLD_S, chans)
        held = chans.mean().get(ch)
        sign = 1.0
        if held is not None and ch in still_mean:
            sign = 1.0 if (held - still_mean[ch]) >= 0 else -1.0
        found[str(ch)] = {"finger": finger, "dof": dof, "sign": sign}
        taken.add(ch)
        print(f"  -> ch{ch:02d}: travel {travel:.0f} deg, sign {'+' if sign > 0 else '-'}"
              + (f"   (excluded as no-magnet/noisy: {sorted(noisy)})" if noisy else ""))
    return found


async def request(ws, msg):
    await ws.send(json.dumps(msg))
    t0 = time.time()
    while time.time() - t0 < 5:
        m = json.loads(await ws.recv())
        if m.get("kind") == "ack" and m.get("event") == "enc_map":
            return m
    sys.exit("the bridge did not answer enc_map (older bridge?)")


def show(m):
    mp = m.get("map") or {}
    if not mp:
        print("no channels mapped")
    for ch, v in sorted(mp.items(), key=lambda kv: int(kv[0])):
        print(f"  ch{int(ch):02d} -> {v['finger']:6s} {v['dof']:8s} sign {'+' if v['sign'] > 0 else '-'}")


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--ws", default="ws://127.0.0.1:8765/ws", help="bridge WebSocket")
    ap.add_argument("--only", help="comma-separated fingers to map (default: all four)")
    ap.add_argument("--timed", action="store_true", help="3-2-1 countdowns instead of Enter")
    ap.add_argument("--replace", action="store_true", help="drop channels not re-learned now")
    ap.add_argument("--show", action="store_true", help="print the current map and exit")
    ap.add_argument("--set", nargs="+", metavar="CH=FINGER:DOF[:SIGN]", help="set channels by hand")
    a = ap.parse_args()
    async with websockets.connect(a.ws, max_size=None) as ws:
        cur = await request(ws, {"cmd": "enc_map", "action": "get"})
        if a.show:
            show(cur)
            return
        new = {} if a.replace else dict(cur.get("map") or {})
        if a.set:
            for item in a.set:
                ch, rest = item.split("=")
                parts = rest.split(":")
                new[str(int(ch))] = {"finger": parts[0], "dof": parts[1],
                                     "sign": float(parts[2]) if len(parts) > 2 else 1.0}
        else:
            fingers = [f.strip() for f in a.only.split(",")] if a.only else FINGERS
            bad = [f for f in fingers if f not in FINGERS]
            if bad:
                sys.exit(f"unknown finger(s): {bad}")
            targets = [(f, d) for f in fingers for d in DOFS]
            print(f"Mapping {len(targets)} joints. Wear the device, forearm resting.")
            found = await learn(ws, targets, a.timed)
            for ch, v in found.items():             # a re-learned joint moves off its old channel
                for k in [k for k, w in new.items() if (w["finger"], w["dof"]) == (v["finger"], v["dof"])]:
                    del new[k]
            new.update(found)
        res = await request(ws, {"cmd": "enc_map", "action": "set", "map": new})
        if not res.get("ok"):
            sys.exit(f"bridge refused the map: {res.get('error')}")
        print("\nStored channel map:")
        show(res)
        print("\nNext: in the console, run the hand calibration (open, then closed) so each"
              "\nflexion channel gets its travel.")


if __name__ == "__main__":
    asyncio.run(main())
