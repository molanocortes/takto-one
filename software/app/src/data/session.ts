// session.ts - the one place a frame comes from, whatever is producing it.
//
// SINGLE SOURCE OF TRUTH. There are two sources and one overlay:
//   - the source is either the in-app simulator or a bridge socket; its
//     newest frame is `session.live`;
//   - a loaded take (replay) overlays the source without closing it, so
//     unloading a take returns to whatever the source is, socket still open;
//   - `session.frame` is what every surface draws, and it is written in ONE
//     place, the animation loop below. The socket handler only stores the
//     bridge's newest frame; it never touches `frame`.
// The label follows the same rule (`session.status`): LIVE only for a real
// device through an open, delivering bridge; SIMULATED for the in-app feed
// and for a bridge running --sim; REPLAY for a take; OFFLINE / CONNECTING
// otherwise, with the last real frame frozen rather than anything invented.
//
// Two consumers with very different appetites read this:
//   - the 3D twin, which wants every frame and must never cause a React
//     render (it reads `session.frame` imperatively inside its own loop);
//   - the numeric read-outs, which want a legible update, not a 60 Hz blur.
// So the frame object is mutable and always current, while React is notified
// at UI_HZ.
import { useSyncExternalStore } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { emptyFrame, type Frame, type LibTake, type SdTake } from './types';
import { sampleTake, decodeTake, type Take } from './takes';
import { connectBridge, normalizeBridgeUrl, type BridgeLink, type ConnState } from './bridge';
import { SimBridge } from './simBridge';

/** the bridge addresses that were tried, newest first, kept across launches */
const SAVED_KEY = 'takto.bridgeUrls';
const SAVED_FILE = 'bridge-urls.json';
const MAX_RECENT = 4;
function parseSaved(txt: string | null): string[] {
  if (!txt) return [];
  try { const v = JSON.parse(txt); if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').slice(0, MAX_RECENT); } catch { /* a bare address */ }
  return txt.startsWith('ws') ? [txt.trim()] : [];
}
async function readSaved(): Promise<string[]> {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return [];
      return parseSaved(localStorage.getItem(SAVED_KEY) ?? localStorage.getItem('takto.bridgeUrl'));
    }
    const FS: any = await import('expo-file-system/legacy');
    for (const name of [SAVED_FILE, 'bridge-url.txt']) {
      const info = await FS.getInfoAsync(FS.documentDirectory + name);
      if (info.exists) return parseSaved(await FS.readAsStringAsync(FS.documentDirectory + name));
    }
  } catch { /* a forgotten address is an inconvenience, not an error */ }
  return [];
}
async function writeSaved(urls: string[]) {
  const txt = JSON.stringify(urls);
  try {
    if (Platform.OS === 'web') { if (typeof localStorage !== 'undefined') localStorage.setItem(SAVED_KEY, txt); return; }
    const FS: any = await import('expo-file-system/legacy');
    await FS.writeAsStringAsync(FS.documentDirectory + SAVED_FILE, txt);
  } catch { /* see above */ }
}

const UI_HZ = 12;
/** an open socket whose last frame is older than this is "waiting", not LIVE */
const FRESH_MS = 1500;

type Play = { take: Take; t: number; playing: boolean; speed: number };

export type Source = 'sim' | 'bridge';
export type StatusKind = 'live' | 'sim' | 'replay' | 'offline';
export type Status = { kind: StatusKind; label: string; detail: string };

export type Conn = {
  state: ConnState | 'idle' | 'paused';
  detail: string;
  hz: number;
  /** the bridge reports it runs --sim */
  synthetic: boolean;
  /** the bridge's own LAN address/port, as it reports them */
  lan: string | null;
  port: number | null;
  since: number;
};

export type NeutralState = {
  phase: 'idle' | 'requested' | 'countdown' | 'hold' | 'done' | 'abort' | 'error';
  /** seconds left in the phase, as the device reports it */
  t: number;
  at: number;
  msg?: string;
};

export type Notice = { text: string; tone: 'info' | 'error'; at: number };

class Session {
  /** what every surface draws. Written only by the loop; never rely on identity. */
  frame: Frame = emptyFrame();
  /** the source's newest frame, even while a take is replaying */
  live: Frame = emptyFrame();
  source: Source = 'sim';
  play: Play | null = null;
  conn: Conn = { state: 'idle', detail: '', hz: 0, synthetic: false, lan: null, port: null, since: Date.now() };
  /** addresses tried, newest first; [0] is what the Link screen opens with */
  recentUrls: string[] = [];
  /** the address of the bridge being used or retried, null when none */
  bridgeUrl: string | null = null;

  /** the take library of the current source ({kind:"takes"}) */
  library: LibTake[] = [];
  libraryKnown = false;
  /** the device's SD card ({kind:"sd_takes"}) */
  sd: { items: SdTake[]; busy: boolean; known: boolean } = { items: [], busy: false, known: false };
  /** SD import progress by file name, 0..100 */
  sdProgress: Record<string, number> = {};
  /** take_data fetches in flight or failed, by take id */
  takeState: Record<string, 'loading' | 'error'> = {};
  neutral: NeutralState = { phase: 'idle', t: 0, at: 0 };
  recPending: 'start' | 'stop' | null = null;
  notice: Notice | null = null;

  private version = 0;
  private listeners = new Set<() => void>();
  private raf: any = null;
  private uiTimer: any = null;
  private started = Date.now();
  private link: BridgeLink | null = null;
  private bridgeFrame: Frame | null = null;
  private bridgeFrameAt = 0;
  private appState: { remove: () => void } | null = null;
  private lastTick = 0;
  private cache = new Map<string, Take>();
  private wantTake: string | null = null;
  private neutralTimer: any = null;
  private sim = new SimBridge((m) => { if (this.source === 'sim') this.onMessage(m); });

  /**
   * Media capture. With the clock pinned, the synthetic feed is a pure
   * function of t, so the same URL always renders the same pose.
   */
  private pinnedT: number | null = null;
  pin(t: number | null) { this.pinnedT = t; this.bump(); }
  isPaused() { return this.pinnedT !== null; }
  /** Freeze the read-outs at the current instant; resume continues from it. */
  pause() { this.pinnedT = this.play ? this.play.t : this.simT(); this.bump(); }
  resume() {
    if (this.pinnedT === null) return;
    if (this.play) this.play.t = this.pinnedT; else this.started = Date.now() - this.pinnedT * 1000;
    this.lastTick = Date.now();
    this.pinnedT = null;
    this.bump();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getVersion = () => this.version;
  private bump() { this.version++; for (const l of this.listeners) l(); }
  private simT() { return (Date.now() - this.started) / 1000; }

  get savedUrl() { return this.recentUrls[0] ?? ''; }

  /** The one label every screen shows. A simulation is never called live. */
  get status(): Status {
    if (this.play) {
      const o = this.play.take.origin, js = this.play.take.jointSource;
      const tag = o === 'demo' ? ' · demo take, synthetic' : o === 'sim' ? ' · simulated take'
        : js === 'sim' ? ' · recorded from bridge --sim' : '';
      return { kind: 'replay', label: 'REPLAY', detail: `${this.play.take.title}${tag}` };
    }
    if (this.source === 'sim') return { kind: 'sim', label: 'SIMULATED', detail: 'in-app synthetic feed, no device' };
    const c = this.conn;
    const fresh = c.state === 'open' && Date.now() - this.bridgeFrameAt < FRESH_MS;
    if (fresh && c.synthetic) return { kind: 'sim', label: 'SIMULATED', detail: `bridge running --sim · ${c.hz} Hz` };
    if (fresh) return { kind: 'live', label: 'LIVE', detail: `device via bridge · ${c.hz} Hz` };
    if (c.state === 'paused') return { kind: 'offline', label: 'PAUSED', detail: 'app in background' };
    if (c.state === 'connecting' || c.state === 'open') return { kind: 'offline', label: 'CONNECTING', detail: c.state === 'open' ? 'socket open, waiting for data' : c.detail };
    return { kind: 'offline', label: 'OFFLINE', detail: c.detail || 'no bridge' };
  }

  /** commands can reach a backend right now */
  get canCommand() {
    return this.source === 'sim' || (this.conn.state === 'open' && Date.now() - this.bridgeFrameAt < FRESH_MS);
  }

  start() {
    if (this.raf) return;
    readSaved().then((u) => { if (u.length && !this.recentUrls.length) { this.recentUrls = u; this.bump(); } });
    // a phone that sleeps loses the socket; drop it cleanly and take it back
    // up on wake instead of waiting for the watchdog to notice
    if (!this.appState) {
      this.appState = AppState.addEventListener('change', (s: AppStateStatus) => {
        if (s === 'active') { if (this.source === 'bridge' && this.bridgeUrl && !this.link) this.openBridge(this.bridgeUrl); }
        else if (this.link) {
          this.link.stop(); this.link = null;
          this.setConn({ state: 'paused', detail: 'app in background', hz: 0 });
        }
      });
    }
    this.started = Date.now();
    this.lastTick = this.started;
    if (this.source === 'sim') this.sim.hello();
    const loop = () => { this.tick(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    this.uiTimer = setInterval(() => {
      // a hidden page throttles requestAnimationFrame to nothing; the frame
      // (and so every read-out) must not freeze with it
      if (Date.now() - this.lastTick > 150) this.tick();
      this.bump();
    }, 1000 / UI_HZ);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.raf = this.uiTimer = null;
  }

  /** THE writer of `frame`. */
  private tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const t = this.pinnedT ?? this.simT();
    this.live = this.source === 'sim' ? this.sim.frame(t) : (this.bridgeFrame ?? this.live);
    if (this.play) {
      if (this.pinnedT !== null) this.play.t = Math.min(this.pinnedT, this.play.take.durationS);
      else if (this.play.playing) {
        this.play.t += dt * this.play.speed;
        if (this.play.t > this.play.take.durationS) this.play.t = 0;
      }
      this.frame = sampleTake(this.play.take, this.play.t);
    } else {
      this.frame = this.live;
    }
  }

  // ---- replay ---------------------------------------------------------------

  /** Replay owns the frame while a take is loaded; null hands it back to the source. */
  setTake(take: Take | null) {
    this.play = take ? { take, t: 0, playing: true, speed: 1 } : null;
    this.wantTake = null;
    this.bump();
  }
  seek(t: number) { if (this.play) { this.play.t = Math.max(0, Math.min(this.play.take.durationS, t)); this.bump(); } }
  togglePlay() { if (this.play) { this.play.playing = !this.play.playing; this.bump(); } }
  setSpeed(s: number) { if (this.play) { this.play.speed = s; this.bump(); } }

  /** Replay a take of the current source's library: fetch its rows once, then play. */
  openTake(meta: LibTake) {
    const key = `${this.source}:${meta.id}`;
    const hit = this.cache.get(key);
    if (hit) { this.setTake(hit); return; }
    if (!this.send({ cmd: 'take_data', id: meta.id })) return;
    this.takeState = { ...this.takeState, [meta.id]: 'loading' };
    this.wantTake = meta.id;
    this.bump();
  }

  // ---- commands ---------------------------------------------------------------

  /** one command to the current source; false (with a notice) when it cannot go */
  send(cmd: Record<string, unknown>): boolean {
    if (this.source === 'sim') { this.sim.handle(cmd, this.pinnedT ?? this.simT()); return true; }
    const ok = !!this.link?.send(cmd);
    if (!ok) this.say('Not connected to a bridge: nothing was sent', 'error');
    return ok;
  }

  recordStart(o: { task: string; profile: string; notes: string }) {
    const cmd: Record<string, unknown> = { cmd: 'record', action: 'start', task: o.task.trim() || undefined };
    if (o.profile.trim()) cmd.profile = { name: o.profile.trim() };
    if (o.notes.trim()) cmd.notes = o.notes.trim();
    if (this.send(cmd)) { this.recPending = 'start'; this.bump(); }
  }
  recordStop() {
    if (this.send({ cmd: 'record', action: 'stop' })) { this.recPending = 'stop'; this.bump(); }
  }

  calibrateNeutral() {
    if (!this.send({ cmd: 'calibrate', what: 'neutral' })) return;
    this.neutral = { phase: 'requested', t: 0, at: Date.now() };
    clearTimeout(this.neutralTimer);
    // a v16 bridge answers within a second with the countdown; if nothing at
    // all comes back the request is reported as lost, not left spinning
    this.neutralTimer = setTimeout(() => {
      if (this.neutral.phase === 'requested') { this.neutral = { phase: 'error', t: 0, at: Date.now(), msg: 'no answer from the bridge' }; this.bump(); }
    }, 10000);
    this.bump();
  }

  sdList() { this.send({ cmd: 'sd', action: 'list' }); }
  sdImport(name: string) {
    if (this.send({ cmd: 'sd', action: 'import', name })) { this.sdProgress = { ...this.sdProgress, [name]: 0 }; this.bump(); }
  }

  private say(text: string, tone: Notice['tone'] = 'info') { this.notice = { text, tone, at: Date.now() }; this.bump(); }

  // ---- messages from the source (bridge or simulator) ---------------------------

  private onMessage(m: Record<string, any>) {
    switch (m.kind) {
      case 'takes':
        this.library = Array.isArray(m.takes) ? m.takes.filter((t: any) => t && typeof t.id === 'string') : [];
        this.libraryKnown = true;
        break;
      case 'sd_takes':
        this.sd = { items: Array.isArray(m.items) ? m.items : [], busy: !!m.busy, known: true };
        break;
      case 'take_data': {
        const id = String(m.id ?? '');
        const meta = this.library.find((t) => t.id === id);
        try {
          const take = decodeTake(m as any, {
            title: meta?.task && meta.task !== 'unlabelled' ? meta.task : id,
            note: [id, meta?.profile, meta?.joint_source ? `joints: ${meta.joint_source}` : null].filter(Boolean).join(' · '),
            origin: this.source === 'sim' ? 'sim' : 'bridge',
          });
          this.cache.set(`${this.source}:${id}`, take);
          const { [id]: _, ...rest } = this.takeState;
          this.takeState = rest;
          if (this.wantTake === id) this.setTake(take);
        } catch {
          this.takeState = { ...this.takeState, [id]: 'error' };
        }
        break;
      }
      case 'ack': this.onAck(m); break;
      default: return;
    }
    this.bump();
  }

  private onAck(m: Record<string, any>) {
    switch (m.event) {
      case 'neutral': {
        const phase = ['countdown', 'hold', 'done', 'abort'].includes(m.phase) ? m.phase : 'countdown';
        this.neutral = { phase, t: Number(m.t) || 0, at: Date.now() };
        if (phase === 'done') this.say('Neutral captured: the twin is calibrated for this power-up');
        if (phase === 'abort') this.say('Neutral capture aborted: hold still and try again', 'error');
        break;
      }
      case 'calibrated':
        // a pre-v16 bridge answers a neutral with one immediate ack
        if (this.neutral.phase !== 'idle' && this.neutral.phase !== 'done') {
          this.neutral = { phase: 'done', t: 0, at: Date.now() };
          this.say('Neutral captured');
        }
        break;
      case 'rec_started': this.recPending = null; this.say(`Recording ${m.id ?? ''}`.trim()); break;
      case 'rec_stopped':
        this.recPending = null;
        this.say(m.id ? `Saved ${m.id} to the take library` : 'Nothing was recording');
        break;
      case 'sd_import':
        if (m.name) this.sdProgress = { ...this.sdProgress, [m.name]: Math.max(0, Math.min(100, Number(m.pct) || 0)) };
        break;
      case 'sd_imported': {
        const { [m.name]: _, ...rest } = this.sdProgress;
        this.sdProgress = rest;
        this.say(`Imported ${m.name} as ${m.take}`);
        break;
      }
      case 'error': {
        const err = String(m.error ?? 'error');
        if (m.id && this.takeState[m.id] === 'loading') this.takeState = { ...this.takeState, [m.id]: 'error' };
        if (this.neutral.phase === 'requested' && /calibrat|device/i.test(err)) this.neutral = { phase: 'error', t: 0, at: Date.now(), msg: err };
        if (m.name && m.name in this.sdProgress) { const { [m.name]: _, ...rest } = this.sdProgress; this.sdProgress = rest; }
        if (this.recPending) this.recPending = null;
        this.say(err === 'unknown_cmd' ? `The bridge does not know "${m.cmd}" yet (older bridge?)` : err, 'error');
        break;
      }
    }
  }

  // ---- sources --------------------------------------------------------------

  private resetSourceState() {
    this.library = []; this.libraryKnown = false;
    this.sd = { items: [], busy: false, known: false };
    this.sdProgress = {}; this.takeState = {};
    this.neutral = { phase: 'idle', t: 0, at: 0 };
    this.recPending = null; this.wantTake = null;
  }

  private setConn(p: Partial<Conn>) {
    const stateChanged = p.state !== undefined && p.state !== this.conn.state;
    this.conn = { ...this.conn, ...p, since: stateChanged ? Date.now() : this.conn.since };
    this.bump();
  }

  /**
   * Attach to a real teensy_bridge.py. What was typed is completed to a full
   * address ("192.168.1.20" becomes ws://192.168.1.20:8765/ws), remembered,
   * and retried until it answers or the simulator is chosen instead.
   */
  connect(input: string) {
    const url = normalizeBridgeUrl(input);
    if (!url) { this.say('Type the bridge address, e.g. 192.168.1.20', 'error'); return; }
    this.recentUrls = [url, ...this.recentUrls.filter((u) => u !== url)].slice(0, MAX_RECENT);
    writeSaved(this.recentUrls);
    this.play = null;
    this.source = 'bridge';
    this.bridgeFrame = null;
    this.bridgeFrameAt = 0;
    this.live = emptyFrame();
    this.resetSourceState();
    this.openBridge(url);
  }

  forgetUrl(url: string) {
    this.recentUrls = this.recentUrls.filter((u) => u !== url);
    writeSaved(this.recentUrls);
    this.bump();
  }

  private openBridge(url: string) {
    this.link?.stop();
    this.bridgeUrl = url;
    this.setConn({ state: 'connecting', detail: url, hz: 0, synthetic: false, lan: null, port: null });
    this.link = connectBridge(url, {
      onFrame: (f, meta) => {
        this.bridgeFrame = f;
        this.bridgeFrameAt = Date.now();
        if (meta.synthetic !== this.conn.synthetic || meta.lan !== this.conn.lan) this.setConn({ synthetic: meta.synthetic, lan: meta.lan, port: meta.port });
      },
      onMessage: (m) => { if (this.source === 'bridge') this.onMessage(m); },
      onState: (state, detail, hz) => this.setConn({ state, detail, hz }),
    });
  }

  useSimulator() {
    this.link?.stop();
    this.link = null;
    this.bridgeUrl = null;
    this.play = null;
    this.source = 'sim';
    this.bridgeFrame = null;
    this.setConn({ state: 'idle', detail: '', hz: 0, synthetic: false, lan: null, port: null });
    this.started = Date.now();
    this.resetSourceState();
    this.sim.hello();
    this.bump();
  }
}

export const session = new Session();

// The capture tool drives the clock through this handle rather than reloading
// the page for every frame: one WebGL context, one model upload, N poses.
if (typeof globalThis !== 'undefined') (globalThis as any).__taktoSession = session;

/** Re-renders at UI_HZ. Read session.frame for the values. */
export function useSession() {
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
  return session;
}
