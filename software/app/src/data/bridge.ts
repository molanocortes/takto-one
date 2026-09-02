// bridge.ts - the WebSocket client for teensy_bridge.py.
//
// The bridge broadcasts one `snap` object per tick (60 Hz by default) and this
// reads the four things a companion needs: the twelve joint channels, the EMG
// activation envelope, the assist blend, and the hand orientation. Everything
// else in a snapshot is the operator console's business, not this app's.
//
// Honesty rule carried from the console: a channel the bridge marked ok:false
// is a ZERO FILL, not a joint resting at 0 degrees. It is rendered as absent.
import { FINGERS } from '../ui/tokens';
import { emptyFrame, type Frame, type Quat } from './types';

type Snap = {
  type?: string; kind?: string; t_ms?: number;
  joints?: { id: string; deg: number; ok: boolean; calibrated?: boolean }[];
  activation?: { present?: boolean; level?: number };
  blend?: { present?: boolean; assist?: number };
  imu?: { hand?: { quat?: number[] }; forearm?: { quat?: number[] } };
};

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
  onState: (open: boolean, detail: string) => void;
};

/**
 * One socket, one reconnect timer, no library. Returns a stop function.
 * `url` is the same one the console uses, e.g. ws://192.168.1.20:8765/ws
 */
export function connectBridge(url: string, h: BridgeHandlers) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let t0 = 0;

  const open = () => {
    if (stopped) return;
    h.onState(false, 'connecting');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return schedule('bad address');
    }
    ws.onopen = () => { t0 = 0; h.onState(true, 'linked'); };
    ws.onmessage = (ev) => {
      let s: Snap;
      try { s = JSON.parse(String(ev.data)); } catch { return; }
      if ((s.type ?? s.kind) !== 'snap') return;
      if (!t0) t0 = s.t_ms ?? 0;
      h.onFrame(snapToFrame(s, t0));
    };
    ws.onerror = () => { /* onclose always follows; report there */ };
    ws.onclose = () => schedule('no bridge');
  };

  const schedule = (why: string) => {
    ws = null;
    if (stopped) return;
    h.onState(false, why);
    retry = setTimeout(open, 2000);
  };

  open();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    try { ws?.close(); } catch { /* already gone */ }
  };
}
