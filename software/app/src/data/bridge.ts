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
 * Returns null when nothing usable was typed.
 */
export function normalizeBridgeUrl(input: string): string | null {
  let s = (input ?? '').trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, (m) => (m.toLowerCase().startsWith('https') ? 'wss://' : 'ws://'));
  if (!/^wss?:\/\//i.test(s)) s = 'ws://' + s;
  const m = /^(wss?:\/\/)([^/:?#]+)(?::(\d+))?([^?#]*)(.*)$/i.exec(s);
  if (!m) return null;
  const [, scheme, host, port, path, rest] = m;
  if (!host) return null;
  const p = port ? Number(port) : DEFAULT_PORT;
  if (!Number.isFinite(p) || p <= 0 || p > 65535) return null;
  const finalPath = path && path !== '/' ? path : DEFAULT_PATH;
  return `${scheme.toLowerCase()}${host}:${p}${finalPath}${rest ?? ''}`;
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
  f.device = parseDevice(s.device);
  f.rec = parseRec(s.session);
  return f;
}

/** what the snapshot says about the bridge itself */
export type BridgeMeta = {
  /** the bridge runs --sim: synthetic joints and IMUs, NOT a person */
  synthetic: boolean;
  /** the bridge's own LAN address and port, when it reports them */
  lan: string | null;
  port: number | null;
};

function snapMeta(s: AnyObj): BridgeMeta {
  const link = Array.isArray(s.health) ? s.health.find((h: AnyObj) => h?.stream === 'link') : null;
  return {
    synthetic: link?.detail === 'sim',
    lan: typeof s.link?.lan === 'string' ? s.link.lan : null,
    port: numOrNull(s.link?.port),
  };
}

export type ConnState = 'connecting' | 'open' | 'stalled' | 'offline';

export type BridgeHandlers = {
  onFrame: (f: Frame, meta: BridgeMeta) => void;
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
          hz = Math.round((frames * 1000) / (now - rateAt));
          frames = 0; rateAt = now;
          h.onState('open', `${hz} Hz`, hz);
        }
      }, 500);
    };
    ws.onmessage = (ev) => {
      if (sock !== ws) return;
      let s: AnyObj;
      try { s = JSON.parse(String(ev.data)); } catch { return; }
      if (!s || typeof s !== 'object') return;
      if ((s.type ?? s.kind) !== 'snap') { h.onMessage(s); return; }
      if (!t0) t0 = num(s.t_ms);
      lastFrameAt = Date.now();
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
