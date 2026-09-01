// audio.js - the generative score, produced like a record, not a beeper.
// Everything pitched sits in D-major pentatonic (D, E, F#, A, B) so any event
// at any time is consonant. The magic is in the SPACE and the MOTION:
//
//   - a real hall: convolution reverb on a send bus (seeded impulse), so every
//     voice blooms into the same air instead of stopping dead
//   - an evolving pad: four slow-breathing voices whose color chord morphs on
//     a long cycle, a shimmer an octave up, a whisper of filtered air, and a
//     sub-heartbeat far below
//   - bells with inharmonic partials and a delayed octave sparkle, so each
//     strike glitters instead of plinking
//   - a distant music box: rare, quiet, seeded high notes drifting through
//     heavy reverb even when nothing happens - the room is alive
//
// All RNG is seeded. Public API unchanged: start, setBedLevel, swell, onBeat,
// beatSeconds, setBpm, bell, tak, thum, hum, resolve, setListener, noteHz.

import { rng } from "../world/materials.js";

const PENTA = [0, 2, 4, 7, 9];             // semitones over D
const D3 = 146.832;                        // D3 [Hz]

export function noteHz(degree = 0, octave = 0) {
  const d = ((degree % 5) + 5) % 5;
  const semis = PENTA[d] + 12 * (octave + Math.floor(degree / 5));
  return D3 * Math.pow(2, semis / 12);
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.bedGain = null;
    this._bedTarget = 0.24;
    this._started = false;
    this.bpm = 72;
    this._beatCbs = [];
    this._beatTimer = null;
    this._beatCount = 0;
    this._rng = rng(20260703);
  }

  // must be called from a user gesture; safe to call again
  start() {
    if (this._started) { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this._started = true;

    // ---- master chain: gentle glue compression ---------------------------
    this.master = this.ctx.createDynamicsCompressor();
    this.master.threshold.value = -18; this.master.knee.value = 24;
    this.master.ratio.value = 4; this.master.attack.value = 0.01; this.master.release.value = 0.2;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;
    this.master.connect(this.masterGain).connect(this.ctx.destination);

    // ---- the hall: one shared convolution reverb (seeded impulse) --------
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.2, 2.4);
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 1.05;
    this.reverb.connect(this.reverbReturn).connect(this.master);

    this._buildBed();
    this._startBeatClock();
    this._startMusicBox();
  }

  get ready() { return this._started && this.ctx && this.ctx.state === "running"; }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  // a seeded stereo impulse response: dense early air, long silk tail
  _impulse(seconds, decay) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(2, len, c.sampleRate);
    const r = rng(4242);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, decay);
        const n = (r() * 2 - 1) * env;
        lp = lp * 0.62 + n * 0.38;           // soften: a velvet hall, not a tin can
        d[i] = lp;
      }
    }
    return buf;
  }

  // route a voice: dry into the master, and a measured send into the hall
  _route(node, { pos = null, rev = 0.35 } = {}) {
    let out = node;
    if (pos) {
      const p = this.ctx.createPanner();
      p.panningModel = "HRTF"; p.distanceModel = "inverse";
      p.refDistance = 0.5; p.rolloffFactor = 1.2;
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
      out.connect(p);
      out = p;
    }
    out.connect(this.master);
    if (rev > 0) {
      const send = this.ctx.createGain();
      send.gain.value = rev;
      out.connect(send).connect(this.reverb);
    }
    return out;
  }

  // ---- the bed: an evolving pad that never sits still --------------------
  _buildBed() {
    const c = this.ctx;
    this.bedGain = c.createGain(); this.bedGain.gain.value = 0;
    const filt = c.createBiquadFilter();
    filt.type = "lowpass"; filt.frequency.value = 340; filt.Q.value = 0.5;
    filt.connect(this.bedGain);
    this._route(this.bedGain, { rev: 0.5 });

    // a pad voice: two detuned oscillators, its own slow amplitude breath
    const voice = (hz, type, g, breathHz, phase, pan = 0) => {
      const sum = c.createGain(); sum.gain.value = g;
      for (const det of [-4, 4]) {
        const o = c.createOscillator();
        o.type = type; o.frequency.value = hz; o.detune.value = det;
        const og = c.createGain(); og.gain.value = 0.5;
        o.connect(og).connect(sum); o.start();
      }
      // the breath
      const lfo = c.createOscillator(); lfo.frequency.value = breathHz;
      lfo.detune.value = phase;
      const lfoG = c.createGain(); lfoG.gain.value = g * 0.4;
      lfo.connect(lfoG).connect(sum.gain); lfo.start();
      if (pan !== 0 && c.createStereoPanner) {
        const sp = c.createStereoPanner(); sp.pan.value = pan;
        sum.connect(sp).connect(filt);
      } else sum.connect(filt);
      return sum;
    };

    voice(noteHz(0, -2), "sine", 0.42, 0.031, 0, -0.2);      // D2, the ground
    voice(noteHz(3, -2), "sine", 0.26, 0.043, 40, 0.2);      // A2, the fifth
    voice(noteHz(0, -1), "triangle", 0.14, 0.037, 80, -0.35); // D3 body
    this._colorVoice = voice(noteHz(2, -1), "sine", 0.0, 0.05, 120, 0.35); // F#3, morphing color

    // shimmer: one octave up, slow tremolo, mostly hall
    const sh = c.createGain(); sh.gain.value = 0.05;
    const so = c.createOscillator(); so.type = "sine"; so.frequency.value = noteHz(0, 0);
    so.detune.value = 3;
    so.connect(sh); so.start();
    const trem = c.createOscillator(); trem.frequency.value = 0.13;
    const tremG = c.createGain(); tremG.gain.value = 0.035;
    trem.connect(tremG).connect(sh.gain); trem.start();
    sh.connect(filt);

    // air: a whisper of band-passed noise, slowly sweeping
    const nb = c.createBuffer(1, c.sampleRate * 4, c.sampleRate);
    const nd = nb.getChannelData(0);
    const nr = rng(777);
    for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;
    const noise = c.createBufferSource(); noise.buffer = nb; noise.loop = true;
    const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 2.2;
    bp.frequency.value = 1200;
    const bpLfo = c.createOscillator(); bpLfo.frequency.value = 0.021;
    const bpLfoG = c.createGain(); bpLfoG.gain.value = 700;
    bpLfo.connect(bpLfoG).connect(bp.frequency); bpLfo.start();
    const ng = c.createGain(); ng.gain.value = 0.012;
    noise.connect(bp).connect(ng).connect(this.bedGain);
    noise.start();

    // sub-heartbeat: D1, felt more than heard
    const sub = c.createOscillator(); sub.type = "sine"; sub.frequency.value = noteHz(0, -3);
    const subG = c.createGain(); subG.gain.value = 0.10;
    const subLfo = c.createOscillator(); subLfo.frequency.value = 0.05;
    const subLfoG = c.createGain(); subLfoG.gain.value = 0.05;
    subLfo.connect(subLfoG).connect(subG.gain); subLfo.start();
    sub.connect(subG).connect(this.bedGain);
    sub.start();

    // filter breath + long color-chord morph (D-A-D <-> +F#)
    const lfo = c.createOscillator(); lfo.frequency.value = 0.045;
    const lfoG = c.createGain(); lfoG.gain.value = 150;
    lfo.connect(lfoG).connect(filt.frequency); lfo.start();
    this._colorTimer = setInterval(() => {
      if (!this.ctx) return;
      const on = this._colorOn = !this._colorOn;
      this._colorVoice.gain.setTargetAtTime(on ? 0.12 : 0.0, this.now, 7);
    }, 14000);
    this._colorOn = false;

    this.bedGain.gain.setTargetAtTime(this._bedTarget, this.now + 0.5, 4.0);
  }

  // 0..1 how present the bed is (modes dim or lift it); eases over seconds
  setBedLevel(v, tc = 2.0) {
    this._bedTarget = 0.24 * v;
    if (this.bedGain) this.bedGain.gain.setTargetAtTime(this._bedTarget, this.now, tc);
  }
  // brief swell with activity
  swell(amount = 0.3) {
    if (!this.bedGain) return;
    const g = this.bedGain.gain;
    g.setTargetAtTime(this._bedTarget * (1 + amount), this.now, 0.15);
    g.setTargetAtTime(this._bedTarget, this.now + 0.6, 1.2);
  }

  // ---- the distant music box: seeded pentatonic PHRASES through the hall,
  // so the room is unmistakably making music even when nothing happens ----
  _startMusicBox() {
    this._boxNext = this.now + 2.5 + this._rng() * 3;
    this._boxDeg = 0;
    this._boxTimer = setInterval(() => {
      if (!this.ready || this.now < this._boxNext) return;
      this._boxNext = this.now + 6 + this._rng() * 6;
      // a little phrase: 3-5 steps of a pentatonic walk, gently staggered
      const len = 3 + Math.floor(this._rng() * 3);
      const pan = (this._rng() - 0.5) * 1.2;
      for (let i = 0; i < len; i++) {
        this._boxDeg += this._rng() < 0.6 ? 1 : -1;
        const deg = ((this._boxDeg % 5) + 5) % 5;
        const oct = this._rng() < 0.7 ? 1 : 2;
        this.bell(deg, oct, {
          gain: 0.06 + this._rng() * 0.03,
          warmth: this._rng() * 0.3,
          when: i * (0.32 + this._rng() * 0.1),
          rev: 0.85, dry: 0.4, pan,
        });
      }
    }, 400);
  }

  // ---- beat clock for RHYTHM (scheduled on the audio clock; live tempo) ---
  _startBeatClock() {
    let next = this.now + 60 / this.bpm;
    this._beatTimer = setInterval(() => {
      if (!this.ctx) return;
      while (next < this.now + 0.12) {
        const when = next, count = this._beatCount++;
        for (const cb of this._beatCbs) cb(count, when);
        next += 60 / this.bpm;
      }
    }, 40);
  }
  onBeat(cb) { this._beatCbs.push(cb); return () => { this._beatCbs = this._beatCbs.filter(c => c !== cb); }; }
  get beatSeconds() { return 60 / this.bpm; }
  setBpm(v) { this.bpm = Math.max(50, Math.min(132, v)); }

  // keep the listener on the head (world camera); position + facing
  setListener(cam) {
    if (!this.ctx || !cam) return;
    const l = this.ctx.listener;
    const p = cam.position;
    const e = cam.matrixWorld.elements;
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    if (l.positionX) {
      const t = this.now;
      l.positionX.setTargetAtTime(p.x, t, 0.05);
      l.positionY.setTargetAtTime(p.y, t, 0.05);
      l.positionZ.setTargetAtTime(p.z, t, 0.05);
      l.forwardX.setTargetAtTime(fx, t, 0.05);
      l.forwardY.setTargetAtTime(fy, t, 0.05);
      l.forwardZ.setTargetAtTime(fz, t, 0.05);
      l.upX.setTargetAtTime(ux, t, 0.05);
      l.upY.setTargetAtTime(uy, t, 0.05);
      l.upZ.setTargetAtTime(uz, t, 0.05);
    } else if (l.setPosition) {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // ---- voices --------------------------------------------------------------
  // the bell: inharmonic partials + a delayed octave sparkle, blooming in the
  // hall. warmth 0..1 rounds the tone; pan spreads unpositioned bells.
  bell(degree = 0, octave = 0, { gain = 0.22, warmth = 0, pos = null, when = 0, rev = 0.45, dry = 1, pan = 0 } = {}) {
    if (!this.ready) return;
    const c = this.ctx, t = Math.max(this.now, this.now + when);
    const hz = noteHz(degree, octave);
    const g = c.createGain(); g.gain.value = 0;
    let head = g;
    if (!pos && pan !== 0 && c.createStereoPanner) {
      const sp = c.createStereoPanner(); sp.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(sp); head = sp;
    }
    const dryG = c.createGain(); dryG.gain.value = dry;
    head.connect(dryG);
    this._route(dryG, { pos, rev });

    // struck partials: slightly inharmonic, the glitter of real metal/glass
    const partials = [
      [1, 1.0, 2.4],
      [2.02, 0.32 * (1 - warmth * 0.4), 1.6],
      [2.76, 0.20 * (1 - warmth * 0.6), 1.2],
      [4.51, 0.08 * (1 - warmth * 0.8), 0.8],
    ];
    for (const [ratio, amp, durS] of partials) {
      const o = c.createOscillator(); o.type = "sine"; o.frequency.value = hz * ratio;
      const og = c.createGain(); og.gain.value = 0;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + durS + 0.1);
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(amp, t + 0.006);
      og.gain.exponentialRampToValueAtTime(0.0004, t + durS);
    }
    // the sparkle: a faint octave answer, a heartbeat later
    const so = c.createOscillator(); so.type = "sine"; so.frequency.value = hz * 2;
    const sog = c.createGain(); sog.gain.value = 0;
    so.connect(sog).connect(g);
    so.start(t + 0.09); so.stop(t + 1.4);
    sog.gain.setValueAtTime(0, t + 0.09);
    sog.gain.linearRampToValueAtTime(0.12 * (1 - warmth * 0.5), t + 0.12);
    sog.gain.exponentialRampToValueAtTime(0.0004, t + 1.3);

    const peak = gain * (0.8 + warmth * 0.5);
    g.gain.setValueAtTime(peak, t);
  }

  // hard contact: glass striking glass - a resonant tick with air
  tak(pos = null, gain = 0.3) {
    if (!this.ready) return;
    const c = this.ctx, t = this.now;
    const g = c.createGain(); g.gain.value = gain;
    this._route(g, { pos, rev: 0.4 });
    // the body: a high damped ping through a resonant bandpass
    const o = c.createOscillator(); o.type = "triangle";
    o.frequency.setValueAtTime(noteHz(4, 2), t);
    o.frequency.exponentialRampToValueAtTime(noteHz(3, 1), t + 0.05);
    const bp = c.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = noteHz(4, 2); bp.Q.value = 9;
    const og = c.createGain(); og.gain.value = 0;
    o.connect(bp).connect(og).connect(g);
    o.start(t); o.stop(t + 0.3);
    og.gain.setValueAtTime(1.0, t);
    og.gain.exponentialRampToValueAtTime(0.0005, t + 0.22);
    // the strike air
    const nb = c.createBuffer(1, 2205, c.sampleRate);
    const ch = nb.getChannelData(0);
    const nr = rng(1234567);
    for (let i = 0; i < ch.length; i++) ch[i] = (nr() * 2 - 1) * (1 - i / ch.length);
    const n = c.createBufferSource(); n.buffer = nb;
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 3200;
    const ng = c.createGain(); ng.gain.value = 0.10;
    n.connect(hp).connect(ng).connect(g); n.start(t);
  }

  // soft contact: a low round "thum" that bends with depth, with a sub thump
  thum(pos = null, depth = 0.3, gain = 0.26) {
    if (!this.ready) return;
    const c = this.ctx, t = this.now;
    const g = c.createGain(); g.gain.value = gain;
    this._route(g, { pos, rev: 0.35 });
    const o = c.createOscillator(); o.type = "sine";
    const base = noteHz(0, -1);
    o.frequency.setValueAtTime(base * (1 + 0.1 * depth), t);
    o.frequency.exponentialRampToValueAtTime(base * 0.92, t + 0.5);
    const og = c.createGain(); og.gain.value = 0;
    o.connect(og).connect(g); o.start(t); o.stop(t + 0.9);
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.6 + 0.5 * depth, t + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0004, t + 0.7 + depth * 0.3);
    // the felt part: one octave below, brief
    const s = c.createOscillator(); s.type = "sine"; s.frequency.value = base / 2;
    const sg = c.createGain(); sg.gain.value = 0;
    s.connect(sg).connect(g); s.start(t); s.stop(t + 0.35);
    sg.gain.setValueAtTime(0.35 * depth, t);
    sg.gain.exponentialRampToValueAtTime(0.0005, t + 0.3);
  }

  // a soft rising hum for proximity/wake, now with a slow living vibrato
  hum(pos = null, degree = 3, octave = 0) {
    if (!this.ready) return { set() {}, stop() {} };
    const c = this.ctx;
    const g = c.createGain(); g.gain.value = 0;
    this._route(g, { pos, rev: 0.5 });
    const o = c.createOscillator(); o.type = "sine"; o.frequency.value = noteHz(degree, octave);
    const o2 = c.createOscillator(); o2.type = "sine"; o2.frequency.value = noteHz(degree, octave) * 2.01;
    const vib = c.createOscillator(); vib.frequency.value = 4.3;
    const vibG = c.createGain(); vibG.gain.value = 1.6;
    vib.connect(vibG).connect(o.frequency);
    const g2 = c.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2).connect(g);
    o.start(); o2.start(); vib.start();
    return {
      set: (v) => g.gain.setTargetAtTime(0.10 * v, this.now, 0.08),
      stop: () => {
        g.gain.setTargetAtTime(0, this.now, 0.12);
        setTimeout(() => { try { o.stop(); o2.stop(); vib.stop(); } catch (_) {} }, 800);
      },
    };
  }

  // resolving chord (seal / finale): D major color, staggered, deep in the hall
  resolve(pos = null, { gain = 0.2 } = {}) {
    if (!this.ready) return;
    this.bell(0, 0, { gain, pos, rev: 0.6 });
    this.bell(2, 0, { gain: gain * 0.8, pos, when: 0.09, rev: 0.6 });
    this.bell(3, 0, { gain: gain * 0.7, pos, when: 0.18, rev: 0.65 });
    this.bell(0, 1, { gain: gain * 0.5, pos, when: 0.3, rev: 0.7 });
    this.bell(4, 1, { gain: gain * 0.25, pos, when: 0.55, rev: 0.9, dry: 0.4 });
    this.swell(0.4);
  }
}
