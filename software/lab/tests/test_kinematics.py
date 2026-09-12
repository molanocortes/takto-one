"""Parity of lab/kinematics.py against software/app/src/data/kinematics.js.
Runs the JavaScript through node on 200 random poses; every number must agree
to 1e-9. Run: python3 -m pytest software/lab/tests  or  python3 tests/test_kinematics.py"""
import json, math, os, random, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from lab.kinematics import finger_pose, spool_angle_deg, FINGERS, SPOOL_STATIONS  # noqa: E402

JS = os.path.join(HERE, "..", "..", "app", "src", "data", "kinematics.js")


def run_js(cases):
    script = f"""
import {{ fingerPose, spoolAngleDeg, SPOOL_STATIONS }} from {json.dumps(os.path.abspath(JS))};
const cases = {json.dumps(cases)};
const out = cases.map((c) => {{
  const poses = {{}};
  for (const f of ["index","middle","ring","pinky"]) poses[f] = fingerPose(f, c[f][0], c[f][1], c[f][2]);
  const spools = {{}};
  for (const s of Object.keys(SPOOL_STATIONS)) spools[s] = spoolAngleDeg(s, poses, c.motors);
  return {{ poses, spools }};
}});
process.stdout.write(JSON.stringify(out));
"""
    return json.loads(subprocess.run(["node", "--input-type=module", "-e", script], check=True, capture_output=True, text=True).stdout)


def test_parity():
    rnd = random.Random(7)
    cases = []
    for _ in range(200):
        c = {f: [rnd.uniform(-25, 25), rnd.uniform(-20, 100), rnd.uniform(-20, 120)] for f in FINGERS}
        c["motors"] = {"index_drive": rnd.uniform(-5, 95)} if rnd.random() < 0.5 else None
        cases.append(c)
    js = run_js(cases)
    worst = 0.0
    for c, ref in zip(cases, js):
        poses = {f: finger_pose(f, *c[f]) for f in FINGERS}
        for f in FINGERS:
            for k, v in poses[f].as_dict().items():
                worst = max(worst, abs(v - ref["poses"][f][k]))
        for s in SPOOL_STATIONS:
            worst = max(worst, abs(spool_angle_deg(s, poses, c["motors"]) - ref["spools"][s]))
    assert worst < 1e-9, worst
    return worst


if __name__ == "__main__":
    print("max |py - js| =", test_parity(), "over 200 random poses: PARITY OK")
