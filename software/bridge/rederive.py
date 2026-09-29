#!/usr/bin/env python3
"""
rederive.py - re-run the TAKTO ONE pipeline on a recorded take, offline.

    python3 rederive.py <take>.raw.txt.gz [-o OUTDIR] [--csv]
    python3 rederive.py TK00012.CSV       [-o OUTDIR] [--csv] [--sim]

Input
  * a live take's raw device stream (`<take>.raw.txt.gz`, what the bridge
    keeps next to every take and what the web's research export downloads):
    every S/E line with its receive time, the provenance (encoder map and
    marks, IMU mounting, wrist axis, arm lengths, encoder filter), the neutral
    in force and the model state at the first row. The provenance is applied
    before deriving, so the result does not depend on this machine's
    calibration files.
  * an SD card take (`TK000nn.CSV`, or the `.sd.csv.gz` the bridge keeps):
    derived with the calibration in SENSORYHAND_STATE_DIR (default: your home
    directory, read-only here), exactly like the bridge's SD import. `--sim`
    for takes recorded by the simulated device (joint-space encoders).

Output (OUTDIR, default: next to the input)
  <stem>.rows.json   take data: {"id", "cols", "rows"} (the bridge's ROW_COLS)
  <stem>.json        take.json: metadata, quality, provenance, column dictionary
  <stem>.csv         with --csv: the research CSV (SI units, header documented
                     in <stem>.json "columns")

The same code path as the bridge (teensy_bridge.OfflineDeriver): the SD
import, this tool and the live recorder share one definition of every column
and of the quality block (research.QualityAccumulator).
"""
import argparse
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _stem(path):
    b = os.path.basename(path)
    if b.startswith(".sensoryhand_takedata_"):          # the bridge's own state files
        b = b[len(".sensoryhand_takedata_"):]
    for ext in (".raw.txt.gz", ".sd.csv.gz", ".csv.gz", ".CSV", ".csv", ".gz", ".txt"):
        if b.endswith(ext):
            return b[: -len(ext)]
    return os.path.splitext(b)[0]


def rederive(path, outdir=None, take_id=None, csv=False, sim=False, quiet=False):
    """Re-derive one take file. Returns {"rows", "meta", "csv", "take", "quality"}."""
    import research
    raw_state = None
    first = next((ln for ln in research.iter_lines(path) if ln.strip()), "")
    is_raw = research.is_raw_stream(first)
    if is_raw and not os.environ.get("SENSORYHAND_STATE_DIR"):
        # a raw take carries its own calibration: never read (or touch) the bench's
        raw_state = tempfile.mkdtemp(prefix="takto_rederive_")
        os.environ["SENSORYHAND_STATE_DIR"] = raw_state
    import teensy_bridge as tb
    outdir = outdir or os.path.dirname(os.path.abspath(path))
    os.makedirs(outdir, exist_ok=True)
    stem = _stem(path)
    tid = take_id or stem
    rows_path = os.path.join(outdir, stem + ".rows.json")
    if is_raw:
        rs_meta = research.RawStream(research.iter_lines(path)).meta
        tid = take_id or rs_meta.get("take") or stem
        tb.apply_provenance(rs_meta.get("provenance") or {})
        # streamed: a 2 h raw stream (~1 GB of text) is never held in memory
        take, prov = tb.derive_raw_take(research.iter_lines(path), tid, rows_path)
        take["rederived_from"]["file"] = os.path.basename(path)
    else:
        lines = research.open_text(path)
        if sim and not tb.SIM_MODE:
            tb.SIM_MODE = True
            tb.enable_sim_pipeline()
        take, prov = tb.import_sd_take(lines, os.path.basename(path), tid, out_path=rows_path,
                                       raw_keep=False, want_prov=True)
        take["source"] = "sd-rederived"
    prov = dict(prov or {})
    prov["rederived_by"] = {"bridge_version": tb.BRIDGE_VERSION, "git": tb.GIT_REV,
                            "tool": "rederive.py", "input": os.path.basename(path)}
    meta = research.take_json(take, prov, take.get("quality"), raw_name=os.path.basename(path),
                              csv_name=(stem + ".csv") if csv else None)
    meta_path = os.path.join(outdir, stem + ".json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=1)
    csv_path = None
    if csv:
        csv_path = os.path.join(outdir, stem + ".csv")
        cols, rows, _ = research.iter_take_rows(rows_path)
        with open(csv_path, "w", newline="") as f:
            research.write_research_csv(cols, rows, f)
    q = take.get("quality") or {}
    if not quiet:
        print("[rederive] %s -> %d rows, %.1f s, %s Hz, dropped %s, grade %s"
              % (os.path.basename(path), take.get("rows") or 0, take.get("duration_s") or 0.0,
                 q.get("rate_hz"), q.get("dropped"), q.get("grade")))
        for p in (rows_path, meta_path, csv_path):
            if p:
                print("           " + p)
    return {"rows": rows_path, "meta": meta_path, "csv": csv_path, "take": take, "quality": q}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Re-derive a TAKTO ONE take (raw stream or SD CSV) offline.")
    ap.add_argument("file", help="<take>.raw.txt.gz, an SD take CSV (.CSV / .csv.gz)")
    ap.add_argument("-o", "--outdir", default=None, help="output directory (default: next to the input)")
    ap.add_argument("--id", default=None, help="take id written into the rows file (default: file stem)")
    ap.add_argument("--csv", action="store_true", help="also write the research CSV (SI units)")
    ap.add_argument("--sim", action="store_true", help="SD CSV from the simulated device (joint-space encoders)")
    a = ap.parse_args(argv)
    rederive(a.file, a.outdir, a.id, csv=a.csv, sim=a.sim)


if __name__ == "__main__":
    main()
