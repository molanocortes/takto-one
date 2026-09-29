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
import { AppState, Platform, Vibration, type AppStateStatus } from 'react-native';
import { emptyFrame, type Frame, type LibTake, type SdTake } from './types';
import { sampleTake, decodeTake, type Take } from './takes';
import { connectBridge, checkBridgeAddress, shortAddress, poseToFrame, type BridgeLink, type ConnState, type PoseStats } from './bridge';
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
/** one small text value kept across launches: localStorage on web, a file in the app's documents on a phone */
async function readText(key: string, file: string, legacy: string[] = []): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return null;
      for (const k of [key, ...legacy]) { const v = localStorage.getItem(k); if (v !== null) return v; }
      return null;
    }
    const FS: any = await import('expo-file-system/legacy');
    for (const name of [file, ...legacy]) {
      const info = await FS.getInfoAsync(FS.documentDirectory + name);
      if (info.exists) return await FS.readAsStringAsync(FS.documentDirectory + name);
    }
  } catch { /* a forgotten preference is an inconvenience, not an error */ }
  return null;
}
async function writeText(key: string, file: string, txt: string) {
  try {
    if (Platform.OS === 'web') { if (typeof localStorage !== 'undefined') localStorage.setItem(key, txt); return; }
    const FS: any = await import('expo-file-system/legacy');
    await FS.writeAsStringAsync(FS.documentDirectory + file, txt);
  } catch { /* see above */ }
}
async function readSaved(): Promise<string[]> {
  return parseSaved(await readText(SAVED_KEY, SAVED_FILE, Platform.OS === 'web' ? ['takto.bridgeUrl'] : ['bridge-url.txt']));
}
function writeSaved(urls: string[]) { return writeText(SAVED_KEY, SAVED_FILE, JSON.stringify(urls)); }

/**
 * What the app remembers about the person, besides addresses: which source
 * they used last (so a launch goes straight back to their bridge) and
 * whether the first-run guide has been finished or skipped.
 */
type Prefs = { lastSource: 'sim' | 'bridge'; setupDone: boolean };
const PREFS_KEY = 'takto.prefs';
const PREFS_FILE = 'prefs.json';
async function readPrefs(): Promise<Prefs | null> {
  const txt = await readText(PREFS_KEY, PREFS_FILE);
  if (!txt) return null;
  try {
    const v = JSON.parse(txt);
    return { lastSource: v?.lastSource === 'bridge' ? 'bridge' : 'sim', setupDone: !!v?.setupDone };
  } catch { return null; }
}

/** a short buzz for "the device heard you"; a no-op where there is no motor */
function buzz(ms = 25) { try { Vibration.vibrate(ms); } catch { /* no vibrator */ } }

const UI_HZ = 12;
/** an open socket whose last frame is older than this is "waiting", not LIVE */
const FRESH_MS = 1500;
/** the twin draws from the pose lane while its newest message is younger than this */
const POSE_FRESH_MS = 250;

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

export type SetupStep = { key: 'connect' | 'calibrate' | 'sensors' | 'record'; done: boolean };

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

  /** the fast pose lane, as measured here; `lane` 'off' on the in-app feed before it subscribes */
  pose: PoseStats = { lane: 'off', hz: 0, procMs: null, ageMs: null, jitterMs: null, gaps: 0 };
  /** the bridge's own reported pose-lane latency (link.latency_ms), ms */
  bridgeLatencyMs: number | null = null;
  /** the app is in the foreground; the twin stops drawing when it is not */
  appActive = true;
  /** the launch reconnect to the last bridge, while it has not delivered yet */
  autoConnect: { url: string; since: number } | null = null;
  /** preferences have been read (until then the launch source is not decided) */
  prefsLoaded = false;
  /** first-run guide */
  setupDone = true;
  setupOpen = false;
  sensorsChecked = false;
  recordedOnce = false;
  /** the person picked the simulator themselves (not merely launched on it) */
  simChosen = false;

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
  private sim = new SimBridge((m) => { if (this.source === 'sim') this.onMessage(m); }, () => this.pinnedT ?? this.simT());
  private poseFrame: Frame | null = null;
  private simBase: Frame | null = null;
  private simPoseAt = 0;
  private simPoses = 0;
  private simGaps: number[] = [];
  private simStatsAt = Date.now();
  private poseAt = 0;
  private poseOff: number | null = null;
  private prefs: Prefs = { lastSource: 'sim', setupDone: false };

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
    const where = this.bridgeUrl ? shortAddress(this.bridgeUrl) : '';
    if (c.state === 'paused') return { kind: 'offline', label: 'PAUSED', detail: 'app in background' };
    if (c.state === 'connecting' || c.state === 'open') return { kind: 'offline', label: 'CONNECTING', detail: `${where} · ${c.state === 'open' ? 'socket open, waiting for data' : c.detail}` };
    return { kind: 'offline', label: 'OFFLINE', detail: `${where} · ${c.detail || 'no bridge'}` };
  }

  /** commands can reach a backend right now */
  get canCommand() {
    return this.source === 'sim' || (this.conn.state === 'open' && Date.now() - this.bridgeFrameAt < FRESH_MS);
  }

  /**
   * `opts.bridge`: an address to open instead of the remembered one (web ?bridge=);
   * `opts.noAuto`: stay on the simulator whatever was used last (capture runs).
   */
  start(opts: { bridge?: string | null; noAuto?: boolean } = {}) {
    if (this.raf) return;
    Promise.all([readSaved(), readPrefs()]).then(([u, p]) => {
      if (u.length && !this.recentUrls.length) this.recentUrls = u;
      if (p) this.prefs = p;
      this.setupDone = !!p?.setupDone;
      this.prefsLoaded = true;
      // launch goes back to where the person was: the last bridge, if the
      // last thing they used was a bridge; a first run opens the guide
      const want = opts.bridge ? opts.bridge : !opts.noAuto && this.prefs.lastSource === 'bridge' ? this.recentUrls[0] : null;
      if (want && this.source === 'sim') this.connect(want, { auto: true });
      if (!this.setupDone && !opts.noAuto) this.setupOpen = true;
      this.bump();
    });
    // a phone that sleeps loses the socket; drop it cleanly and take it back
    // up on wake instead of waiting for the watchdog to notice. The loops stop
    // too: nothing is drawn in the background, so nothing should be computed.
    if (!this.appState) {
      this.appState = AppState.addEventListener('change', (s: AppStateStatus) => {
        if (s === 'active') {
          if (this.appActive) return;
          this.appActive = true;
          this.runLoops();
          if (this.source === 'bridge' && this.bridgeUrl && !this.link) this.openBridge(this.bridgeUrl);
          if (this.source === 'sim') this.sim.handle({ cmd: 'stream', pose: true }, this.simT());
          this.bump();
        } else if (s === 'background' || (s === 'inactive' && Platform.OS !== 'ios')) {
          // iOS reports 'inactive' for the app switcher and a pulled-down
          // notification centre; the socket survives those, so only background counts there
          this.appActive = false;
          this.stopLoops();
          this.sim.stopPose();
          if (this.link) {
            this.link.stop(); this.link = null;
            this.setConn({ state: 'paused', detail: 'app in background', hz: 0 });
          }
          this.bump();
        }
      });
    }
    this.started = Date.now();
    this.lastTick = this.started;
    if (this.source === 'sim') { this.sim.hello(); this.sim.handle({ cmd: 'stream', pose: true }, this.simT()); }
    this.runLoops();
  }

  private runLoops() {
    if (this.raf || this.uiTimer) return;
    this.lastTick = Date.now();
    const loop = () => { this.tick(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    this.uiTimer = setInterval(() => {
      // a hidden page throttles requestAnimationFrame to nothing; the frame
      // (and so every read-out) must not freeze with it
      if (Date.now() - this.lastTick > 150) this.tick();
      this.bump();
    }, 1000 / UI_HZ);
  }
  private stopLoops() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.raf = this.uiTimer = null;
  }

  stop() {
    this.stopLoops();
    this.sim.stopPose();
  }

  /** THE writer of `frame`. */
  private tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const t = this.pinnedT ?? this.simT();
    // the pose lane, when it is flowing, is the newest arm and fingers there
    // are; the snapshot (or the in-app feed) still owns everything else
    const poseFresh = this.poseFrame !== null && now - this.poseAt < POSE_FRESH_MS;
    if (this.source === 'sim') {
      this.simBase = this.sim.frame(t);
      this.live = poseFresh && this.pinnedT === null ? this.poseFrame! : this.simBase;
    } else {
      this.live = poseFresh ? this.poseFrame! : (this.bridgeFrame ?? this.live);
    }
    if (this.autoConnect && (this.source !== 'bridge' || this.status.kind === 'live' || this.status.kind === 'sim')) this.autoConnect = null;
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
    // pending BEFORE sending: the in-app simulator answers synchronously
    this.recPending = 'start';
    if (!this.send(cmd)) this.recPending = null;
    this.bump();
  }
  recordStop() {
    this.recPending = 'stop';
    if (!this.send({ cmd: 'record', action: 'stop' })) this.recPending = null;
    this.bump();
  }

  calibrateNeutral() {
    const before = this.neutral;
    this.neutral = { phase: 'requested', t: 0, at: Date.now() };
    if (!this.send({ cmd: 'calibrate', what: 'neutral' })) { this.neutral = before; this.bump(); return; }
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
    const before = this.sdProgress;
    this.sdProgress = { ...this.sdProgress, [name]: 0 };
    if (!this.send({ cmd: 'sd', action: 'import', name })) this.sdProgress = before;
    this.bump();
  }

  private say(text: string, tone: Notice['tone'] = 'info') { this.notice = { text, tone, at: Date.now() }; this.bump(); }

  // ---- messages from the source (bridge or simulator) ---------------------------

  private onMessage(m: Record<string, any>) {
    if (m.kind === 'pose') {
      // the in-app feed's pose lane: same path as a bridge's, no React render
      if (this.source !== 'sim') return;
      const now = Date.now();
      if (this.simPoseAt) this.simGaps.push(now - this.simPoseAt);
      this.simPoseAt = now; this.simPoses++;
      if (now - this.simStatsAt >= 1000) {
        const g = [...this.simGaps].sort((a, b) => a - b);
        const q = (p: number) => (g.length ? g[Math.min(g.length - 1, Math.floor(g.length * p))] : null);
        const p95 = q(0.95), p50 = q(0.5);
        this.pose = { lane: 'on', hz: Math.round((this.simPoses * 1000) / (now - this.simStatsAt || 1)), procMs: 0, ageMs: typeof m.tx === 'number' ? Math.max(0, now - m.tx) : null,
          jitterMs: p95 !== null && p50 !== null ? p95 - p50 : null, gaps: 0 };
        this.simPoses = 0; this.simGaps = []; this.simStatsAt = now;
      }
      this.onPose(m, this.simBase);
      return;
    }
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
        if (phase === 'done') { this.say('Neutral captured: the twin is calibrated for this power-up'); buzz(40); }
        if (phase === 'abort') { this.say('Neutral capture aborted: hold still and try again', 'error'); buzz(120); }
        if (phase === 'hold' && this.neutral.phase !== 'hold') buzz(15);
        break;
      }
      case 'calibrated':
        // a pre-v16 bridge answers a neutral with one immediate ack
        if (this.neutral.phase !== 'idle' && this.neutral.phase !== 'done') {
          this.neutral = { phase: 'done', t: 0, at: Date.now() };
          this.say('Neutral captured');
        }
        break;
      case 'rec_started': this.recPending = null; this.say(`Recording ${m.id ?? ''}`.trim()); buzz(30); break;
      case 'rec_stopped':
        this.recPending = null;
        this.say(m.id ? `Saved ${m.id} to the take library` : 'Nothing was recording');
        if (m.id) { this.recordedOnce = true; buzz(30); }
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
    // the guide's own ticks belong to a source: a take made on the simulator
    // says nothing about the device
    this.sensorsChecked = false; this.recordedOnce = false;
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
  connect(input: string, o: { auto?: boolean } = {}) {
    const { url, error } = checkBridgeAddress(input);
    if (!url) { this.say(error ? `Not connecting: ${error}` : 'Type the bridge address, e.g. 192.168.1.20', 'error'); return false; }
    this.recentUrls = [url, ...this.recentUrls.filter((u) => u !== url)].slice(0, MAX_RECENT);
    writeSaved(this.recentUrls);
    this.savePrefs({ lastSource: 'bridge' });
    this.autoConnect = o.auto ? { url, since: Date.now() } : null;
    this.sim.stopPose();
    this.play = null;
    this.source = 'bridge';
    this.bridgeFrame = null;
    this.bridgeFrameAt = 0;
    // nothing has arrived from this bridge yet: every channel is absent, not
    // a finger resting at the neutral pose
    this.live = emptyFrame();
    for (const k of Object.keys(this.live.ok) as (keyof Frame['ok'])[]) this.live.ok[k] = { ab: false, mcp: false, pip: false };
    this.resetSourceState();
    this.openBridge(url);
    return true;
  }

  private savePrefs(p: Partial<Prefs>) {
    this.prefs = { ...this.prefs, ...p };
    writeText(PREFS_KEY, PREFS_FILE, JSON.stringify(this.prefs));
  }

  // ---- first-run guide --------------------------------------------------------

  /** the four steps, each checked against what the source actually reports */
  get setupSteps(): SetupStep[] {
    const s = this.status.kind;
    const b = this.live.body;
    return [
      { key: 'connect', done: this.source === 'bridge' ? s === 'live' || (s === 'sim' && this.conn.synthetic) : this.simChosen },
      { key: 'calibrate', done: !!b && b.origin === 'body' && b.cal === 'calibrated' },
      { key: 'sensors', done: this.sensorsChecked },
      { key: 'record', done: this.recordedOnce },
    ];
  }
  openSetup() { this.setupOpen = true; this.bump(); }
  closeSetup(finished = false) {
    this.setupOpen = false;
    if (finished || !this.setupDone) { this.setupDone = true; this.savePrefs({ setupDone: true }); }
    this.bump();
  }
  confirmSensors() { this.sensorsChecked = true; this.bump(); }

  forgetUrl(url: string) {
    this.recentUrls = this.recentUrls.filter((u) => u !== url);
    writeSaved(this.recentUrls);
    this.bump();
  }

  private openBridge(url: string) {
    this.link?.stop();
    this.bridgeUrl = url;
    this.resetPose();
    this.setConn({ state: 'connecting', detail: 'opening socket', hz: 0, synthetic: false, lan: null, port: null });
    this.link = connectBridge(url, {
      onFrame: (f, meta) => {
        this.bridgeFrame = f;
        this.bridgeFrameAt = Date.now();
        this.bridgeLatencyMs = meta.latencyMs;
        if (meta.synthetic !== this.conn.synthetic || meta.lan !== this.conn.lan) this.setConn({ synthetic: meta.synthetic, lan: meta.lan, port: meta.port });
      },
      onPose: (m) => { if (this.source === 'bridge') this.onPose(m, this.bridgeFrame); },
      onPoseStats: (p) => { this.pose = p; },
      onMessage: (m) => { if (this.source === 'bridge') this.onMessage(m); },
      onState: (state, detail, hz) => this.setConn({ state, detail, hz }),
    });
  }

  private resetPose() {
    this.poseFrame = null; this.poseAt = 0; this.poseOff = null;
    this.pose = { lane: 'off', hz: 0, procMs: null, ageMs: null, jitterMs: null, gaps: 0 };
    this.bridgeLatencyMs = null;
  }

  /** one pose-lane message: laid over the newest full frame, never a React render */
  private onPose(m: Record<string, any>, base: Frame | null) {
    const devT = typeof m.t === 'number' ? m.t / 1000 : null;
    let t = base?.t ?? 0;
    if (devT !== null) {
      // map the device clock onto the frame clock the rest of the app uses;
      // re-anchor on a jump (a device reboot, a new socket)
      if (this.poseOff === null || Math.abs(devT + this.poseOff - (base?.t ?? devT + this.poseOff)) > 1) this.poseOff = (base?.t ?? 0) - devT;
      t = devT + this.poseOff;
    }
    const f = poseToFrame(m, base, t);
    if (!f) return;
    this.poseFrame = f;
    this.poseAt = Date.now();
  }

  /** the person's own choice of the simulator (a button), as opposed to the launch default */
  chooseSimulator() { this.simChosen = true; this.useSimulator(); }

  useSimulator() {
    this.link?.stop();
    this.link = null;
    this.bridgeUrl = null;
    this.autoConnect = null;
    this.play = null;
    this.source = 'sim';
    this.bridgeFrame = null;
    this.savePrefs({ lastSource: 'sim' });
    this.resetPose();
    this.setConn({ state: 'idle', detail: '', hz: 0, synthetic: false, lan: null, port: null });
    this.started = Date.now();
    this.resetSourceState();
    this.sim.hello();
    this.sim.handle({ cmd: 'stream', pose: true }, this.simT());
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
