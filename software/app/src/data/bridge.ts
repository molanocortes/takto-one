// bridge.ts - the WebSocket client for teensy_bridge.py.
//
// The bridge broadcasts one `snap` object per tick and this reads what a
// companion needs: the twelve joint channels, the EMG activation envelope, the
// assist blend, the arm (the v16 `body` block, or the legacy tared hand /
// forearm quaternions), the device's SD state and the shared recording. The
// other messages (the take library, take rows, the SD library, acks) are
// handed to the session untouched, and commands go back up the same socket.
//
// Honesty rule carried from the console: a channel the bridge marked ok:false
// is a ZERO FILL, not a joint resting at 0 degrees. It is carried as ok:false
// at the neutral pose, and every surface draws it as absent.
//
// The link is built for a phone on a lab Wi-Fi: it retries with a short
// backoff, it notices a socket that is open but silent (a bridge that died
// mid-stream, a phone that slept) and reconnects, and it reports its own
// rate so "connected" always comes with a number that proves it.
import { FINGERS } from '../ui/tokens';
import { emptyFrame, NEUTRAL_POSE, type Body, type DeviceInfo, type Frame, type RecInfo } from './types';
import { asQuat, asVec3, qmul } from './quat';
import { armBody, palmOf, wristAngles } from './arm';

type AnyObj = Record<string, any>;

export const DEFAULT_PORT = 8765;
export const DEFAULT_PATH = '/ws';

/**
 * What a person types is rarely the full address. "192.168.1.20" is enough:
 * the scheme, the port and the path the bridge always uses are filled in.
 * Anything that is not ONE address is refused with the reason, so a field
 * that was typed into the middle of a pre-filled URL (we once produced
 * "ws://localhost:8765:ws://localhost:8765/ws65293/ws") never gets dialled.
 */
export function checkBridgeAddress(input: string): { url: string | null; error: string | null } {
  let s = (input ?? '').trim();
  if (!s) return { url: null, error: null };
  if (/\s/.test(s)) return { url: null, error: 'no spaces in an address' };
  if ((s.match(/:\/\//g) ?? []).length > 1) return { url: null, error: 'two addresses run together: clear the field and type one' };
  s = s.replace(/^https?:\/\//i, (m) => (m.toLowerCase().startsWith('https') ? 'wss://' : 'ws://'));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^wss?:\/\//i.test(s)) return { url: null, error: 'use ws:// or wss:// (or just the IP)' };
  if (!/^wss?:\/\//i.test(s)) s = 'ws://' + s;
  const m = /^(wss?:\/\/)(\[[0-9a-f:.]+\]|[^/:?#[\]]+)(?::(\d{1,5}))?(\/[^?#]*)?([?#].*)?$/i.exec(s);
  if (!m) return { url: null, error: 'not an address: expected e.g. 192.168.1.20 or 192.168.1.20:8765' };
  const [, scheme, host, port, path, rest] = m;
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split('.');
    if (parts.length !== 4 || parts.some((x) => x === '' || Number(x) > 255)) return { url: null, error: 'an IP address has four numbers 0-255, e.g. 192.168.1.20' };
  } else if (!host.startsWith('[') && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i.test(host)) {
    return { url: null, error: 'the host has characters an address cannot have' };
  }
  const p = port ? Number(port) : DEFAULT_PORT;
  if (!Number.isFinite(p) || p <= 0 || p > 65535) return { url: null, error: 'the port must be 1-65535' };
  const finalPath = path && path !== '/' ? path : DEFAULT_PATH;
  return { url: `${scheme.toLowerCase()}${host.toLowerCase()}:${p}${finalPath}${rest ?? ''}`, error: null };
}

/** the full ws:// URL, or null when nothing usable was typed */
export function normalizeBridgeUrl(input: string): string | null {
  return checkBridgeAddress(input).url;
}

/** the shortest thing a person would type for this URL: "192.168.1.20" for the defaults */
export function shortAddress(url: string): string {
  const m = /^(wss?):\/\/([^/]+?)(?::(\d+))?(\/[^?#]*)?$/i.exec(url ?? '');
  if (!m) return url ?? '';
  const [, scheme, host, port, path] = m;
  if (scheme.toLowerCase() !== 'ws' || (path && path !== DEFAULT_PATH)) return url;
  return port && Number(port) !== DEFAULT_PORT ? `${host}:${port}` : host;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The v16 `body` block. Null when absent or unusable. */
export function parseBody(b: AnyObj | undefined | null): Body | null {
  if (!b || typeof b !== 'object') return null;
  const fq = asQuat(b.forearm_quat), hq = asQuat(b.hand_quat);
  if (!fq || !hq) return null;
  const cal: Body['cal'] = b.provisional ? 'provisional' : b.calibrated ? 'calibrated' : 'none';
  const q = b.quality ?? {};
  const elbow = asVec3(b.elbow_m), wrist = asVec3(b.wrist_m);
  const base = armBody(fq, hq, {
    origin: 'body', cal, live: b.live !== false,
    posSource: typeof b.pos_source === 'string' ? b.pos_source : 'arm',
    sinceNeutralS: numOrNull(q.since_neutral_s), still: typeof q.still === 'boolean' ? q.still : null,
  });
  if (elbow && wrist) {
    base.shoulder = asVec3(b.shoulder_m) ?? [0, 0, 0];
    base.elbow = elbow;
    base.wrist = wrist;
    base.hand = asVec3(b.hand_m) ?? palmOf(wrist, hq);
  }
  const wd = b.wrist_deg;
  if (wd && typeof wd === 'object') base.wristDeg = { flex: num(wd.flex), dev: num(wd.dev), pro: num(wd.pro) };
  base.inertialConf = numOrNull(q.inertial_conf);
  return base;
}

/**
 * A bridge older than the v16 body model still sends the tared hand and
 * forearm quaternions at the TOP level of the snapshot (snap.hand.quat,
 * snap.forearm.quat; very old builds nested them under snap.imu). The tare
 * makes both identity at the neutral pose, which is also the body frame's
 * neutral, so they drive the twin as an approximation under a fixed hanging
 * upper arm; rel.quat, when present, is the mounting-corrected wrist.
 */
function legacyBody(s: AnyObj): Body | null {
  const hs = s.hand ?? s.imu?.hand, fs = s.forearm ?? s.imu?.forearm;
  const hq = asQuat(hs?.quat), fq = asQuat(fs?.quat);
  if (!hq || !fq) return null;
  const rel = asQuat(s.rel?.quat);
  const hand = rel ? qmul(fq, rel) : hq;
  const live = (hs?.live ?? true) !== false && (fs?.live ?? true) !== false;
  return armBody(fq, hand, { origin: 'legacy', cal: 'none', live });
}

function parseDevice(d: AnyObj | undefined): DeviceInfo | undefined {
  if (!d || typeof d !== 'object') return undefined;
  return {
    fw: numOrNull(d.fw), bootId: numOrNull(d.boot_id),
    sdPresent: !!d.sd_present, sdRecording: !!d.sd_recording,
    sdTake: num(d.sd_take), sdRows: num(d.sd_rows),
    standby: !!d.standby,
    autoRecord: typeof d.standalone_auto_record === 'boolean' ? d.standalone_auto_record : null,
    neutralRunning: !!d.neutral_running,
    rateHz: numOrNull(d.rate_hz),
  };
}

function parseRec(r: AnyObj | undefined): RecInfo | undefined {
  if (!r || typeof r !== 'object') return undefined;
  return {
    recording: !!r.recording, id: r.id ?? null, task: r.task ?? null, profile: r.profile ?? null,
    elapsedMs: num(r.elapsed_ms), samples: num(r.samples),
  };
}

export function snapToFrame(s: AnyObj, t0: number): Frame {
  const f = emptyFrame();
  f.t = (num(s.t_ms) - t0) / 1000;
  const by = new Map<string, AnyObj>((Array.isArray(s.joints) ? s.joints : []).map((j: AnyObj) => [j.id, j]));
  for (const finger of FINGERS) {
    const g = (seg: string) => by.get(`${finger}_${seg}`);
    // wire names: _mcp = abduction, _pip = MCP flexion, _dip = PIP flexion
    const ab = g('mcp'), mcp = g('pip'), pip = g('dip');
    const okAb = !!ab?.ok && Number.isFinite(ab?.deg);
    const okMcp = !!mcp?.ok && Number.isFinite(mcp?.deg);
    const okPip = !!pip?.ok && Number.isFinite(pip?.deg);
    f.joints[finger] = {
      ab: okAb ? ab!.deg : NEUTRAL_POSE.ab,
      mcp: okMcp ? mcp!.deg : NEUTRAL_POSE.mcp,
      pip: okPip ? pip!.deg : NEUTRAL_POSE.pip,
    };
    f.ok[finger] = { ab: okAb, mcp: okMcp, pip: okPip };
  }
  f.emg = s.activation?.present ? num(s.activation.level) : -1;
  f.blend = s.blend?.present ? num(s.blend.assist) : 0;
  const hq = asQuat((s.hand ?? s.imu?.hand)?.quat), fq = asQuat((s.forearm ?? s.imu?.forearm)?.quat);
  if (hq) f.hand = hq;
  if (fq) f.forearm = fq;
  f.body = parseBody(s.body) ?? legacyBody(s);
  if (f.body && !f.body.wristDeg) f.body.wristDeg = wristAngles(f.body.forearmQuat, f.body.handQuat);
  const lv = (o: AnyObj | undefined | null) => (o && typeof o === 'object' && typeof o.live === 'boolean' ? o.live : null);
  f.imu = { hand: lv(s.hand ?? s.imu?.hand), forearm: lv(s.forearm ?? s.imu?.forearm), thumb: lv(s.thumb ?? s.imu?.thumb) };
  f.device = parseDevice(s.device);
  f.rec = parseRec(s.session);
  return f;
}

/**
 * The fast pose lane (MOTION_PIPELINE.md section 8): one compact {kind:"pose"}
 * per device frame, 100 Hz. It carries only what the twin draws, so it is laid
 * over the newest snapshot frame (`base`), which still owns the recording,
 * the device block and the rest. Null when the message is unusable.
 */
export function poseToFrame(m: AnyObj, base: Frame | null, t: number): Frame | null {
  const fq = asQuat(m.fq), hq = asQuat(m.hq);
  const j = Array.isArray(m.j) ? m.j : null;
  if (!fq && !j) return null;
  const f: Frame = base ? { ...base, joints: { ...base.joints }, ok: { ...base.ok } } : emptyFrame();
  f.t = t;
  if (j && j.length >= 12) {
    FINGERS.forEach((finger, k) => {
      // wire order per finger: _mcp (abduction), _pip (MCP flexion), _dip (PIP flexion)
      const v = [j[k * 3], j[k * 3 + 1], j[k * 3 + 2]].map((x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null));
      f.joints[finger] = { ab: v[0] ?? NEUTRAL_POSE.ab, mcp: v[1] ?? NEUTRAL_POSE.mcp, pip: v[2] ?? NEUTRAL_POSE.pip };
      f.ok[finger] = { ab: v[0] !== null, mcp: v[1] !== null, pip: v[2] !== null };
    });
  }
  if (fq && hq) {
    const cal: Body['cal'] = m.cal === 2 ? 'calibrated' : m.cal === 1 ? 'provisional' : 'none';
    const prev = base?.body && base.body.origin === 'body' ? base.body : null;
    const b = armBody(fq, hq, {
      origin: 'body', cal, live: m.live !== false,
      posSource: prev?.posSource ?? 'arm', sinceNeutralS: prev?.sinceNeutralS ?? null, still: prev?.still ?? null,
    });
    const e = asVec3(m.e), w = asVec3(m.w), h = asVec3(m.h);
    if (e && w) { b.elbow = e; b.wrist = w; b.hand = h ?? palmOf(w, hq); }
    if (Array.isArray(m.wd) && m.wd.length >= 3) b.wristDeg = { flex: num(m.wd[0]), dev: num(m.wd[1]), pro: num(m.wd[2]) };
    b.inertialConf = prev?.inertialConf ?? null;
    f.body = b;
    f.forearm = base?.forearm ?? f.forearm;
    f.hand = base?.hand ?? f.hand;
  }
  return f;
}

/** what the snapshot says about the bridge itself */
export type BridgeMeta = {
  /** the bridge runs --sim: synthetic joints and IMUs, NOT a person */
  synthetic: boolean;
  /** the bridge's own LAN address and port, when it reports them */
  lan: string | null;
  port: number | null;
  /** the bridge's own median ingest-to-send time for the pose lane, ms */
  latencyMs: number | null;
};

function snapMeta(s: AnyObj): BridgeMeta {
  const link = Array.isArray(s.health) ? s.health.find((h: AnyObj) => h?.stream === 'link') : null;
  return {
    synthetic: link?.detail === 'sim',
    lan: typeof s.link?.lan === 'string' ? s.link.lan : null,
    port: numOrNull(s.link?.port),
    latencyMs: numOrNull(s.link?.latency_ms),
  };
}

export type ConnState = 'connecting' | 'open' | 'stalled' | 'offline';

/** What the client measures about the pose lane, once a second. */
export type PoseStats = {
  /** 'asked': subscribed, nothing yet; 'on': pose messages arriving;
   *  'unsupported': the bridge refused the command (older bridge) */
  lane: 'off' | 'asked' | 'on' | 'unsupported';
  hz: number;
  /** median bridge-side ingest-to-send (tx - rx), bridge clock only: always valid */
  procMs: number | null;
  /** median now - tx: network + this app. Mixes two clocks, so it is only
   *  shown when it is plausible (0..1000 ms); null otherwise */
  ageMs: number | null;
  /** p95 - p50 of the arrival interval, ms: how even the stream is (the
   *  pose lane's when it flows, otherwise the snapshot's) */
  jitterMs: number | null;
  /** frames the bridge's seq says were skipped in the last second */
  gaps: number;
};

const med = (a: number[]) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const pct = (a: number[], p: number) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };

export type BridgeHandlers = {
  onFrame: (f: Frame, meta: BridgeMeta) => void;
  /** one {kind:"pose"} message, raw; the session lays it over the newest frame */
  onPose?: (m: AnyObj) => void;
  onPoseStats?: (s: PoseStats) => void;
  /** every non-snapshot message: takes, take_data, sd_takes, ack, ... */
  onMessage: (m: AnyObj) => void;
  onState: (state: ConnState, detail: string, hz: number) => void;
};

/** seconds without a frame on an open socket before it is declared dead */
const STALL_S = 3;
/** reconnect backoff, seconds: quick first, never slower than the last */
const BACKOFF_S = [0.5, 1, 2, 3, 5];

export type BridgeLink = {
  stop: () => void;
  /** false when the socket is not open (the command is dropped, not queued) */
  send: (cmd: AnyObj) => boolean;
};

/**
 * One socket, one reconnect timer, no library.
 * `url` is the same one the console uses, e.g. ws://192.168.1.20:8765/ws
 */
export function connectBridge(url: string, h: BridgeHandlers): BridgeLink {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let t0 = 0;
  let attempt = 0;
  let lastFrameAt = 0;
  let frames = 0;
  let rateAt = 0;
  let hz = 0;
  let isOpen = false;
  // the pose lane
  let lane: PoseStats['lane'] = 'off';
  let poses = 0, lastSeq = -1, gaps = 0, lastPoseAt = 0;
  let proc: number[] = [], age: number[] = [], gapsMs: number[] = [], snapGaps: number[] = [];
  const resetPose = () => { lane = 'off'; poses = 0; lastSeq = -1; gaps = 0; lastPoseAt = 0; proc = []; age = []; gapsMs = []; snapGaps = []; };

  const clearTimers = () => {
    if (retry) clearTimeout(retry);
    if (watchdog) clearInterval(watchdog);
    retry = watchdog = null;
  };

  const open = () => {
    if (stopped) return;
    h.onState('connecting', attempt ? `retrying (${attempt})` : 'opening socket', 0);
    try {
      ws = new WebSocket(url);
    } catch {
      return schedule('bad address');
    }
    const sock = ws;
    ws.onopen = () => {
      if (sock !== ws) return;
      t0 = 0; attempt = 0; frames = 0; hz = 0; isOpen = true;
      lastFrameAt = rateAt = Date.now();
      h.onState('open', 'socket open, waiting for data', 0);
      // ask for the fast pose lane; an older bridge answers unknown_cmd and
      // the twin simply keeps drawing from the 60 Hz snapshot
      resetPose();
      if (h.onPose) {
        try { sock.send(JSON.stringify({ cmd: 'stream', pose: true })); lane = 'asked'; } catch { /* the snapshot still works */ }
      }
      // the watchdog: an open socket that stops delivering is worse than a
      // closed one, because nothing else would ever notice
      watchdog = setInterval(() => {
        const now = Date.now();
        if (now - lastFrameAt > STALL_S * 1000) {
          h.onState('stalled', `no data for ${STALL_S} s`, 0);
          try { sock.close(); } catch { /* already gone */ }
          return;
        }
        if (now - rateAt >= 1000) {
          const span = now - rateAt;
          hz = Math.round((frames * 1000) / span);
          const phz = Math.round((poses * 1000) / span);
          frames = 0; rateAt = now;
          if (lane === 'on' && now - lastPoseAt > 2000) lane = 'asked';
          h.onPoseStats?.({
            lane, hz: phz, procMs: med(proc), ageMs: (() => { const a = med(age); return a !== null && a >= 0 && a < 1000 ? a : null; })(),
            jitterMs: (() => { const g = lane === 'on' ? gapsMs : snapGaps; const a = pct(g, 0.95), b = med(g); return a !== null && b !== null ? a - b : null; })(), gaps,
          });
          poses = 0; gaps = 0; proc = []; age = []; gapsMs = []; snapGaps = [];
          h.onState('open', `${hz} Hz`, hz);
        }
      }, 500);
    };
    ws.onmessage = (ev) => {
      if (sock !== ws) return;
      let s: AnyObj;
      try { s = JSON.parse(String(ev.data)); } catch { return; }
      if (!s || typeof s !== 'object') return;
      const kind = s.type ?? s.kind;
      if (kind === 'pose') {
        const now = Date.now();
        lastFrameAt = now;
        if (lane !== 'on') lane = 'on';
        poses++;
        if (lastPoseAt) gapsMs.push(now - lastPoseAt);
        lastPoseAt = now;
        if (typeof s.seq === 'number') { if (lastSeq >= 0 && s.seq > lastSeq + 1) gaps += s.seq - lastSeq - 1; lastSeq = s.seq; }
        if (typeof s.tx === 'number' && typeof s.rx === 'number') proc.push(s.tx - s.rx);
        if (typeof s.tx === 'number') age.push(now - s.tx);
        h.onPose?.(s);
        return;
      }
      if (kind === 'ack' && s.event === 'error' && s.error === 'unknown_cmd' && s.cmd === 'stream') { lane = 'unsupported'; return; }
      if (kind !== 'snap') { h.onMessage(s); return; }
      if (!t0) t0 = num(s.t_ms);
      const at = Date.now();
      if (frames > 0 || snapGaps.length) snapGaps.push(at - lastFrameAt);
      lastFrameAt = at;
      frames++;
      h.onFrame(snapToFrame(s, t0), snapMeta(s));
    };
    ws.onerror = () => { /* onclose always follows; report there */ };
    ws.onclose = () => { if (sock === ws) schedule(isOpen ? 'connection lost' : 'no bridge at this address'); };
  };

  const schedule = (why: string) => {
    ws = null; isOpen = false;
    clearTimers();
    if (stopped) return;
    h.onState('offline', why, 0);
    const wait = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)];
    attempt++;
    retry = setTimeout(open, wait * 1000);
  };

  open();
  return {
    stop: () => {
      stopped = true;
      clearTimers();
      const sock = ws; ws = null; isOpen = false;
      try { sock?.close(); } catch { /* already gone */ }
    },
    send: (cmd) => {
      if (!ws || !isOpen || ws.readyState !== 1) return false;
      try { ws.send(JSON.stringify(cmd)); return true; } catch { return false; }
    },
  };
}
