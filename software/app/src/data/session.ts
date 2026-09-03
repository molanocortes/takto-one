// session.ts - the one place a frame comes from, whatever is producing it.
//
// Two consumers with very different appetites read this:
//   - the 3D twin, which wants every frame and must never cause a React
//     render (it reads `session.frame` imperatively inside its own loop);
//   - the numeric read-outs, which want a legible update, not a 60 Hz blur.
// So the frame object is mutable and always current, while React is notified
// at UI_HZ. That split is why the twin stays smooth while twelve numbers,
// four bars and a meter re-render alongside it.
import { useSyncExternalStore } from 'react';
import { emptyFrame, type Frame, type Link, type SourceKind } from './types';
import { simFrame } from './sim';
import { sampleTake, type Take } from './takes';
import { connectBridge } from './bridge';

const UI_HZ = 12;

type Play = { take: Take; t: number; playing: boolean; speed: number };

class Session {
  /** always the newest frame. Mutated in place; never rely on identity. */
  frame: Frame = emptyFrame();
  link: Link = { kind: 'sim', live: false, label: 'SIMULATED', detail: 'no device attached' };
  play: Play | null = null;

  private version = 0;
  private listeners = new Set<() => void>();
  private raf: any = null;
  private uiTimer: any = null;
  private started = 0;
  private disconnect: (() => void) | null = null;
  private lastTick = 0;
  /**
   * Media capture. With the clock pinned, the synthetic feed is a pure
   * function of t, so the same URL always renders the same pose: frame 41 of
   * a capture is byte-identical whenever it is taken. The project's render
   * work is reproducible by rule and this app is held to the same standard.
   */
  private pinnedT: number | null = null;
  pin(t: number | null) { this.pinnedT = t; this.bump(); }
  /**
   * True while the capture harness owns the clock. Anything that animates off
   * wall-clock time rather than off the feed must hold still when this is set,
   * or the render stops being a pure function of t and a loop cannot close.
   */
  get pinned() { return this.pinnedT !== null; }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getVersion = () => this.version;
  private bump() { this.version++; for (const l of this.listeners) l(); }

  start() {
    if (this.raf) return;
    this.started = Date.now();
    this.lastTick = this.started;
    const loop = () => {
      const now = Date.now();
      const dt = Math.min(0.1, (now - this.lastTick) / 1000);
      this.lastTick = now;
      if (this.pinnedT !== null) {
        if (this.play) {
          // keep the transport's own read-out honest: a pinned clock must move
          // the scrubber and the elapsed time too, not just the pose
          this.play.t = Math.min(this.pinnedT, this.play.take.durationS);
          this.frame = sampleTake(this.play.take, this.play.t);
        } else {
          this.frame = simFrame(this.pinnedT);
        }
      } else if (this.play) {
        if (this.play.playing) {
          this.play.t += dt * this.play.speed;
          if (this.play.t > this.play.take.durationS) this.play.t = 0;
        }
        this.frame = sampleTake(this.play.take, this.play.t);
      } else if (this.link.kind === 'sim') {
        this.frame = simFrame((now - this.started) / 1000);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.uiTimer = setInterval(() => this.bump(), 1000 / UI_HZ);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.raf = this.uiTimer = null;
  }

  /** Replay owns the frame while a take is loaded; null hands it back. */
  setTake(take: Take | null) {
    this.play = take ? { take, t: 0, playing: true, speed: 1 } : null;
    this.setKind(take ? 'take' : this.link.kind === 'take' ? 'sim' : this.link.kind);
    this.bump();
  }
  seek(t: number) { if (this.play) { this.play.t = t; this.bump(); } }
  togglePlay() { if (this.play) { this.play.playing = !this.play.playing; this.bump(); } }
  setSpeed(s: number) { if (this.play) { this.play.speed = s; this.bump(); } }

  private setKind(kind: SourceKind) {
    if (kind === 'sim') this.link = { kind, live: false, label: 'SIMULATED', detail: 'no device attached' };
    if (kind === 'take') this.link = { kind, live: false, label: 'REPLAY', detail: 'recorded session' };
  }

  /** Attach to a real teensy_bridge.py. Falls back to the simulator on loss. */
  connect(url: string) {
    this.disconnect?.();
    this.link = { kind: 'bridge', live: false, label: 'CONNECTING', detail: url };
    this.bump();
    this.disconnect = connectBridge(url, {
      onFrame: (f) => { if (!this.play) this.frame = f; },
      onState: (open, detail) => {
        this.link = {
          kind: 'bridge', live: open,
          label: open ? 'LINKED' : 'OFFLINE', detail,
        };
        this.bump();
      },
    });
  }

  useSimulator() {
    this.disconnect?.();
    this.disconnect = null;
    this.started = Date.now();
    this.setKind('sim');
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
