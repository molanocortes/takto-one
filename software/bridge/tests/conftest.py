"""Shared test setup: the bridge directory on sys.path and an isolated state
directory, so no test can ever read or write the real bench calibration in ~."""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.dirname(HERE)
if BRIDGE not in sys.path:
    sys.path.insert(0, BRIDGE)

if not os.environ.get("SENSORYHAND_STATE_DIR"):
    os.environ["SENSORYHAND_STATE_DIR"] = tempfile.mkdtemp(prefix="takto_bridge_test_")
