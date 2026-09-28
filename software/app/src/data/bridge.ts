// bridge.ts - the WebSocket client for teensy_bridge.py.
//
// The bridge broadcasts one `snap` object per tick (60 Hz by default) and this
// reads the four things a companion needs: the twelve joint channels, the EMG
// activation envelope, the assist blend, and the hand orientation. Everything
// else in a snapshot is the operator console's business, not this app's.
//
// Honesty rule carried from the console: a channel the bridge marked ok:false
// is a ZERO FILL, not a joint resting at 0 degrees. It is rendered as absent.
//
// The link is built for a phone on a lab Wi-Fi: it retries with a short
// backoff, it notices a socket that is open but silent (a bridge that died
// mid-stream, a phone that slept) and reconnects, and it reports its own
// rate so "connected" always comes with a number that proves it.
import { FINGERS } from '../ui/tokens';
import { emptyFrame, type Frame, type Quat } from './types';

type Snap = {
  type?: string; kind?: string; t_ms?: number;
  joints?: { id: string; deg: number; ok: boolean; calibrated?: boolean }[];
  activation?: { present?: boolean; level?: number };
  blend?: { present?: boolean; assist?: number };
  imu?: { hand?: { quat?: number[] }; forearm?: { quat?: number[] } };
};

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

export function snapToFrame(s: Snap, t0: number): Frame {
  const f = emptyFrame();
  f.t = ((s.t_ms ?? 0) - t0) / 1000;
  const by = new Map((s.joints ?? []).map((j) => [j.id, j]));
  for (const finger of FINGERS) {
    const g = (seg: string) => by.get(`${finger}_${seg}`);
    const ab = g('mcp'), mcp = g('pip'), pip = g('dip');
    f.joints[finger] = {
      ab: ab?.ok ? ab.deg : 0,
      mcp: mcp?.ok ? mcp.deg : 0,
      pip: pip?.ok ? pip.deg : 0,
    };
    f.ok[finger] = { ab: !!ab?.ok, mcp: !!mcp?.ok, pip: !!pip?.ok };
  }
  f.emg = s.activation?.present ? (s.activation.level ?? 0) : -1;
  f.blend = s.blend?.present ? (s.blend.assist ?? 0) : 0;
  const hq = s.imu?.hand?.quat, fq = s.imu?.forearm?.quat;
  if (hq && hq.length === 4) f.hand = hq as Quat;
  if (fq && fq.length === 4) f.forearm = fq as Quat;
  return f;
}

export type BridgeHandlers = {
  onFrame: (f: Frame) => void;
  /** open/closed plus a short human reason ("linked · 60 Hz", "no bridge", "stalled") */
  onState: (open: boolean, detail: string) => void;
};

/** seconds without a frame on an open socket before it is declared dead */
const STALL_S = 3;
/** reconnect backoff, seconds: quick first, never slower than the last */
const BACKOFF_S = [0.5, 1, 2, 3, 5];

/**
 * One socket, one reconnect timer, no library. Returns a stop function.
 * `url` is the same one the console uses, e.g. ws://192.168.1.20:8765/ws
 */
export function connectBridge(url: string, h: BridgeHandlers) {
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

  const clearTimers = () => {
    if (retry) clearTimeout(retry);
    if (watchdog) clearInterval(watchdog);
    retry = watchdog = null;
  };

  const open = () => {
    if (stopped) return;
    h.onState(false, attempt ? `reconnecting (${attempt})` : 'connecting');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return schedule('bad address');
    }
    const sock = ws;
    ws.onopen = () => {
      if (sock !== ws) return;
      t0 = 0; attempt = 0; frames = 0; hz = 0;
      lastFrameAt = rateAt = Date.now();
      h.onState(true, 'linked');
      // the watchdog: an open socket that stops delivering is worse than a
      // closed one, because nothing else would ever notice
      watchdog = setInterval(() => {
        const now = Date.now();
        if (now - lastFrameAt > STALL_S * 1000) {
          h.onState(false, 'stalled');
          try { sock.close(); } catch { /* already gone */ }
          return;
        }
        if (now - rateAt >= 1000) {
          hz = Math.round((frames * 1000) / (now - rateAt));
          frames = 0; rateAt = now;
          h.onState(true, `linked · ${hz} Hz`);
        }
      }, 500);
    };
    ws.onmessage = (ev) => {
      let s: Snap;
      try { s = JSON.parse(String(ev.data)); } catch { return; }
      if ((s.type ?? s.kind) !== 'snap') return;
      if (!t0) t0 = s.t_ms ?? 0;
      lastFrameAt = Date.now();
      frames++;
      h.onFrame(snapToFrame(s, t0));
    };
    ws.onerror = () => { /* onclose always follows; report there */ };
    ws.onclose = () => { if (sock === ws) schedule('no bridge'); };
  };

  const schedule = (why: string) => {
    ws = null;
    clearTimers();
    if (stopped) return;
    h.onState(false, why);
    const wait = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)];
    attempt++;
    retry = setTimeout(open, wait * 1000);
  };

  open();
  return () => {
    stopped = true;
    clearTimers();
    const sock = ws; ws = null;
    try { sock?.close(); } catch { /* already gone */ }
  };
}
