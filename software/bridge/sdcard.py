"""
sdcard.py - the device's SD take library over USB (MOTION_PIPELINE.md s.5-6).

  * SdClient   the host side of the F protocol (F,list / F,get / F,auto). The
               serial reader thread feeds it every `F,` line; the caller blocks
               (in a worker thread) on list()/get() until the device answers.
  * parse_take_csv   a v1 take file -> meta, header neutral, columns, rows, events.
  * column names and a writer (used by the simulator's fake card, so the import
    path is exercised byte-for-byte like the firmware's files).

Dependency-free. Thread-safe: one transfer at a time, guarded by a Condition.
"""
import threading
import time
import zlib

N_CH = 14
IMU_NAMES = ("hand", "forearm", "thumb")


EMG19_COLS = ["emg_n", "env_mv", "env_sd_mv", "raw_present", "raw_rms_mv", "raw_mav_mv",
              "raw_wl_mv", "raw_zc", "mnf_hz", "mdf_hz", "line50_pct", "emg_sat", "emg_ovr"]


def sd_columns():
    """The firmware v17 take header (recStartTake), generated the same way.
    (A v16 file simply lacks the five timing columns: consumers index by name.)"""
    cols = ["t_ms"] + ["enc%02d" % ch for ch in range(N_CH)]
    cols += ["h_qw", "h_qx", "h_qy", "h_qz", "f_qw", "f_qx", "f_qy", "f_qz", "emg_env", "emg_rms",
             "crown", "t_qw", "t_qx", "t_qy", "t_qz", "thumb_live",
             "mflags", "m0_pos", "m0_vel", "m0_ma", "m1_pos", "m1_vel", "m1_ma", "crown_live"]
    for n in IMU_NAMES:
        cols += ["%s_lax" % n, "%s_lay" % n, "%s_laz" % n]
        cols += ["%s_ax" % n, "%s_ay" % n, "%s_az" % n]
        cols += ["%s_gx" % n, "%s_gy" % n, "%s_gz" % n]
        cols += ["%s_mx" % n, "%s_my" % n, "%s_mz" % n]
        cols += ["%s_grx" % n, "%s_gry" % n, "%s_grz" % n]
        cols += ["%s_gqw" % n, "%s_gqx" % n, "%s_gqy" % n, "%s_gqz" % n]
        cols += ["%s_cal_a" % n, "%s_cal_g" % n, "%s_cal_m" % n, "%s_rotacc" % n]
    cols += ["h_live", "f_live", "t_live", "emg_present",
             "h_dvx", "h_dvy", "h_dvz", "f_dvx", "f_dvy", "f_dvz", "t_dvx", "t_dvy", "t_dvz",
             "h_stab", "f_stab", "t_stab"]
    # v17: device timing (MOTION_PIPELINE.md s.8)
    cols += ["t_us", "h_qage_us", "f_qage_us", "t_qage_us", "enc_us"]
    # v19: sEMG features per frame (firmware emg.h; MOTION_PIPELINE.md s.9)
    cols += EMG19_COLS
    return cols


SD_COLUMNS = sd_columns()


class SdError(Exception):
    pass


def _num(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v


def parse_row(line, ncols):
    """One data line -> list of floats/None (a short line is padded with None)."""
    vals = line.split(",")
    out = [_num(v) for v in vals[:ncols]]
    if len(out) < ncols:
        out += [None] * (ncols - len(out))
    return out


def parse_take_csv(src):
    """Parse one take file (text, or an iterable of lines without newlines).
    Lines starting with '#' are metadata/events and the first other line is the
    header; columns are indexed BY NAME. Data rows are kept as their raw text
    and parsed on demand (parse_row), so a long take is held once, not three
    times as text + floats.

    Returns {"meta": {...}, "neutral": {"t_ms", "q": {hand, forearm, thumb}} | None,
             "cols": [...], "idx": {name: i}, "rows": [raw line], "events": [...],
             "end": {"rows", "ms"} | None, "warnings": [...]}"""
    lines = src.splitlines() if isinstance(src, str) else src
    meta, events, rows, warnings = {}, [], [], []
    cols, neutral, end = None, None, None
    for ln, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#E,"):
            parts = line[3:].split(",")
            t = _num(parts[0]) if parts else None
            if t is None or len(parts) < 2:
                warnings.append("line %d: malformed event" % (ln + 1))
                continue
            ev = {"t_ms": t, "kind": parts[1], "args": parts[2:]}
            if len(parts) >= 3 and parts[1] == "neutral" and parts[2] == "done" and len(parts) >= 15:
                q = [_num(x) for x in parts[3:15]]
                if all(v is not None for v in q):
                    ev["q"] = {"hand": q[0:4], "forearm": q[4:8], "thumb": q[8:12]}
            events.append(ev)
            continue
        if line.startswith("#"):
            body = line[1:].strip()
            if body.startswith("neutral="):
                vals = [_num(x) for x in body[len("neutral="):].split(",")]
                if len(vals) >= 13 and all(v is not None for v in vals[:13]):
                    neutral = {"t_ms": vals[0], "q": {"hand": vals[1:5], "forearm": vals[5:9],
                                                      "thumb": vals[9:13]}}
                else:
                    warnings.append("malformed neutral header")
            elif body.startswith("end"):
                end = {}
                for tok in body.split()[1:]:
                    if "=" in tok:
                        k, v = tok.split("=", 1)
                        end[k] = _num(v)
            elif "=" in body:
                for tok in body.split():
                    if "=" in tok:
                        k, v = tok.split("=", 1)
                        meta[k] = v
            elif body.startswith("takto take"):
                meta["format"] = body
            continue
        if cols is None:
            cols = [c.strip() for c in line.split(",")]
            continue
        n = line.count(",") + 1
        if n != len(cols):
            warnings.append("line %d: %d fields, header has %d" % (ln + 1, n, len(cols)))
            if n < len(cols):
                continue
        rows.append(line)
    if cols is None:
        raise SdError("no column header in the file")
    idx = {c: i for i, c in enumerate(cols)}
    if "t_ms" not in idx:
        raise SdError("the file has no t_ms column")
    return {"meta": meta, "neutral": neutral, "cols": cols, "idx": idx, "rows": rows,
            "events": events, "end": end, "warnings": warnings}


class SdClient:
    """Host side of the F protocol. `write(bytes)` sends a line to the device."""

    LIST_TIMEOUT_S = 4.0
    CHUNK_BYTES = 32768           # firmware v18: verifiable chunks (see get())
    CHUNK_RETRIES = 5
    BEGIN_TIMEOUT_S = 4.0
    IDLE_TIMEOUT_S = 3.0          # silence inside a transfer -> abort

    def __init__(self, write):
        self._write = write
        self._cv = threading.Condition()
        self._op = None           # {"kind": "list"|"get"|"auto", ...}
        self.last_list = None     # [(name, bytes)] from the latest successful list
        self.auto = None          # device's standalone auto-record setting, once known
        self.last_get = None      # {"name", "bytes", "crc"} of the last verified download
        # Firmware v18+ serves F,get,<path>,<offset>,<max> chunks and F,crc. The
        # bridge sets this from the version banner; older firmware keeps the
        # single-burst transfer.
        self.chunked = False

    # ---- state for the snapshot ---------------------------------------------
    @property
    def busy(self):
        with self._cv:
            return self._op is not None

    def transfer(self):
        """{"name", "got", "total"} while a get() runs, else None."""
        with self._cv:
            op = self._op
            if op is None or op["kind"] != "get":
                return None
            return {"name": op["name"], "got": op["got"], "total": op.get("total")}

    # ---- fed by the serial reader --------------------------------------------
    def feed(self, line):
        """Consume one device line starting with 'F,'. Returns True if used."""
        if not line.startswith("F,"):
            return False
        with self._cv:
            op = self._op
            now = time.time()
            if line.startswith("F,auto,"):
                try:
                    self.auto = line.split(",")[2].strip() == "1"
                except IndexError:
                    pass
                if op is not None and op["kind"] == "auto":
                    op["done"] = True
                self._cv.notify_all()
                return True
            if op is None:
                return True               # a stray reply (e.g. after a timeout): drop it
            op["t_last"] = now
            if line.startswith("F,err,"):
                op["error"] = line[6:].strip() or "error"
                self._cv.notify_all()
                return True
            if op["kind"] == "list":
                if line.startswith("F,item,"):
                    rest = line[7:]
                    name, _, size = rest.rpartition(",")
                    try:
                        op["items"].append((name, int(size)))
                    except ValueError:
                        op["items"].append((rest, None))
                elif line.startswith("F,end"):
                    op["done"] = True
                    self._cv.notify_all()
                return True
            if op["kind"] == "crc":
                if line.startswith("F,crc,"):
                    parts = line[6:].rsplit(",", 2)
                    if len(parts) == 3:
                        op["size"], op["crc"] = parts[1], parts[2].strip()
                    op["done"] = True
                    self._cv.notify_all()
                return True
            if op["kind"] == "chunk":
                if line.startswith("F,begin,"):
                    op["began"] = True
                    try:
                        op["total"] = int(line[8:].rpartition(",")[2])
                    except ValueError:
                        op["total"] = None
                elif line.startswith("F,d,"):
                    if op.get("began"):
                        op["lines"].append(line[4:])
                elif line.startswith("F,chunk,"):
                    parts = line[8:].rsplit(",", 3)
                    if len(parts) == 4:
                        op["c_start"], op["c_end"], op["c_crc"] = parts[1], parts[2], parts[3].strip()
                    op["done"] = True
                    self._cv.notify_all()
                return True
            if op["kind"] == "get":
                if line.startswith("F,begin,"):
                    name, _, size = line[8:].rpartition(",")
                    op["began"] = True
                    try:
                        op["total"] = int(size)
                    except ValueError:
                        op["total"] = None
                elif line.startswith("F,d,"):
                    if op.get("began"):
                        op["lines"].append(line[4:])
                        op["got"] += len(line) - 4 + 1
                elif line.startswith("F,done,"):
                    parts = line[7:].rsplit(",", 2)
                    if len(parts) == 3:
                        op["done_name"], op["done_bytes"], op["done_crc"] = parts
                    op["done"] = True
                    self._cv.notify_all()
                return True
            return True

    # ---- blocking calls (run them in a worker thread) --------------------------
    def _start(self, op, line):
        with self._cv:
            if self._op is not None:
                raise SdError("busy: another SD transfer is running")
            op.update({"t_start": time.time(), "t_last": time.time(), "error": None, "done": False})
            self._op = op
        try:
            self._write(line.encode())
        except Exception as e:
            with self._cv:
                self._op = None
            raise SdError("could not write to the device: %s" % e)

    def _finish(self):
        with self._cv:
            self._op = None

    def list(self):
        op = {"kind": "list", "items": []}
        self._start(op, "F,list\n")
        try:
            with self._cv:
                ok = self._cv.wait_for(lambda: op["done"] or op["error"], self.LIST_TIMEOUT_S)
                if op["error"]:
                    raise SdError(op["error"])
                if not ok:
                    raise SdError("timeout: the device did not answer F,list")
                self.last_list = list(op["items"])
                return list(op["items"])
        finally:
            self._finish()

    def set_auto(self, on):
        op = {"kind": "auto"}
        self._start(op, "F,auto,%d\n" % (1 if on else 0))
        try:
            with self._cv:
                if not self._cv.wait_for(lambda: op["done"] or op["error"], self.LIST_TIMEOUT_S):
                    raise SdError("timeout: the device did not answer F,auto")
                if op["error"]:
                    raise SdError(op["error"])
                return self.auto
        finally:
            self._finish()

    def _wait(self, op, limit):
        with self._cv:
            ok = self._cv.wait_for(lambda: op["done"] or op["error"], limit)
            if op["error"]:
                raise SdError(op["error"])
            if not ok:
                raise SdError("timeout: the device did not answer")

    def _get_chunked(self, name, progress=None):
        """[BENCH 2026-09-29] One 32 KB chunk at a time, each verified by its own
        CRC-32 and re-requested if damaged, then the whole file against F,crc.
        The single-burst transfer lost 36-75 % of a 6 MB file on macOS (the USB
        serial driver drops bytes when the reader falls behind; nothing tells
        the device). Chunks keep every burst small enough to be read in time,
        and a damaged one costs one retry instead of the whole import."""
        lines, offset, total, crc_all, retries = [], 0, None, 0, 0
        attempt = 0                                     # tries of THIS chunk
        while total is None or offset < total:
            op = {"kind": "chunk", "name": name, "lines": [], "began": False, "total": None}
            self._start(op, "F,get,%s,%d,%d\n" % (name, offset, self.CHUNK_BYTES))
            try:
                self._wait(op, self.IDLE_TIMEOUT_S + self.BEGIN_TIMEOUT_S)
            except SdError as e:
                if "timeout" not in str(e) or attempt >= self.CHUNK_RETRIES:
                    raise
                retries += 1; attempt += 1
                continue
            finally:
                self._finish()
            try:
                start, end, want = int(op["c_start"]), int(op["c_end"]), int(op["c_crc"], 16)
            except (KeyError, TypeError, ValueError):
                start, end, want = -1, -1, -1
            total = op["total"] if op["total"] is not None else total
            got = [ln.encode("latin-1", "replace") for ln in op["lines"]]
            ok = False
            if start == offset and end >= start:
                # the device sends every line with '\n'; the file's very last
                # line may have had none, so try both for the final chunk only
                for tail in ((True,) if total is None or end < total else (True, False)):
                    data = b"".join(g + b"\n" for g in got)
                    if not tail and data.endswith(b"\n"):
                        data = data[:-1]
                    if len(data) == end - start and (zlib.crc32(data) & 0xFFFFFFFF) == want:
                        ok = True
                        crc_all = zlib.crc32(data, crc_all)
                        break
            if not ok:
                retries += 1; attempt += 1
                if attempt > self.CHUNK_RETRIES:
                    raise SdError("chunk at %d failed its CRC %d times" % (offset, attempt))
                continue
            attempt = 0
            lines.extend(op["lines"])
            offset = end
            if progress:
                progress(offset, total)
            if end == start:                           # an empty file / nothing more
                break
        op = {"kind": "crc", "name": name}
        self._start(op, "F,crc,%s\n" % name)
        try:
            self._wait(op, self.IDLE_TIMEOUT_S + 10.0)   # the device reads the whole file
        finally:
            self._finish()
        if int(op.get("size", -1)) != offset or int(op.get("crc", "0"), 16) != (crc_all & 0xFFFFFFFF):
            raise SdError("whole-file CRC mismatch after chunked transfer")
        self.last_get = {"name": name, "bytes": offset, "crc": op["crc"], "chunk_retries": retries}
        return lines

    def get(self, name, progress=None):
        """Download one file; verifies the byte count and the CRC-32. Returns
        the file's lines (no newlines). `progress(got, total)` is called ~5x/s."""
        if self.chunked:
            return self._get_chunked(name, progress)
        op = {"kind": "get", "name": name, "lines": [], "got": 0, "total": None, "began": False}
        self._start(op, "F,get,%s\n" % name)
        try:
            last_prog = 0.0
            with self._cv:
                while True:
                    if op["error"]:
                        raise SdError(op["error"])
                    if op["done"]:
                        break
                    now = time.time()
                    limit = self.IDLE_TIMEOUT_S if op["began"] else self.BEGIN_TIMEOUT_S
                    if now - op["t_last"] > limit:
                        raise SdError("timeout: %s" % ("the transfer stalled" if op["began"]
                                                       else "the device did not start the transfer"))
                    self._cv.wait(0.2)
                    if progress and now - last_prog > 0.2:
                        last_prog = now
                        got, total = op["got"], op["total"]
                        self._cv.release()
                        try:
                            progress(got, total)
                        finally:
                            self._cv.acquire()
                lines = list(op["lines"])
                done_bytes, done_crc = op.get("done_bytes"), op.get("done_crc")
            out = verify_transfer(lines, done_bytes, done_crc)
            self.last_get = {"name": name, "bytes": int(done_bytes), "crc": done_crc}
            return out
        finally:
            self._finish()


def verify_transfer(lines, done_bytes, done_crc):
    """Check the F,d lines against F,done without joining them into one string.

    The firmware strips '\\r' and sends each line without its '\\n' (and a final
    line without a newline the same way), so the exact bytes are ambiguous in
    two places; the byte count and the CRC-32 decide. Returns the list of lines
    (the file content, one entry per line)."""
    try:
        want_len = int(done_bytes)
        want_crc = int(done_crc, 16)
    except (TypeError, ValueError):
        raise SdError("the device sent no valid F,done (bytes/crc missing)")
    # the lines are ASCII (latin-1 for safety: one byte per character)
    body_len = sum(len(ln) for ln in lines)
    n = len(lines)
    for eol in (b"\n", b"\r\n"):
        for tail in (True, False):
            n_eol = n if tail else max(0, n - 1)
            if body_len + n_eol * len(eol) != want_len:
                continue
            crc = 0
            for i, ln in enumerate(lines):
                crc = zlib.crc32(ln.encode("latin-1", "replace"), crc)
                if tail or i < n - 1:
                    crc = zlib.crc32(eol, crc)
            if (crc & 0xFFFFFFFF) == want_crc:
                return lines
    crc = 0
    for ln in lines:
        crc = zlib.crc32(ln.encode("latin-1", "replace") + b"\n", crc)
    raise SdError("CRC/length mismatch: got %d bytes crc %08x, device says %d bytes crc %08x"
                  % (body_len + n, crc & 0xFFFFFFFF, want_len, want_crc))


def crc32_hex(data):
    return "%08x" % (zlib.crc32(data) & 0xFFFFFFFF)
