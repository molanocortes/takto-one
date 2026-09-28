// simBridge.ts - an in-app stand-in for teensy_bridge.py, so every flow the
// phone offers (record, neutral calibration, the take library, SD import)
// can be walked through and demonstrated with no PC and no device.
//
// It speaks the bridge's own message shapes (MOTION_PIPELINE.md section 7 and
// the record/take_data handlers in teensy_bridge.py) so the session code
// cannot tell the two apart, which is exactly what keeps it honest: the ONLY
// difference the UI shows is the SIMULATED label, which the session derives
// from the source, never from anything this file says. Takes recorded here
// are synthetic, live in memory, and are gone when the app closes.
import { FINGERS } from '../ui/tokens';
import type { DeviceInfo, Frame, LibTake, RecInfo, SdTake } from './types';
import { simFrame } from './sim';

type Msg = Record<string, any>;

/** the bridge's ROW_COLS, then the v16 body columns */
export const SIM_COLS = [
  't_ms',
  ...FINGERS.flatMap((f) => [`${f}_mcp`, `${f}_pip`, `${f}_dip`]),
  'hq_w', 'hq_x', 'hq_y', 'hq_z', 'fq_w', 'fq_x', 'fq_y', 'fq_z',
  'tq_w', 'tq_x', 'tq_y', 'tq_z', 'blend', 'act',
  'px', 'py', 'pz', 'pq_w', 'pq_x', 'pq_y', 'pq_z',
  'thumb_abd', 'thumb_mcp', 'thumb_ip',
  'ihx', 'ihy', 'ihz', 'ifx', 'ify', 'ifz', 'i_conf',
  'b_ex', 'b_ey', 'b_ez', 'b_wx', 'b_wy', 'b_wz',
  'b_fq_w', 'b_fq_x', 'b_fq_y', 'b_fq_z', 'b_hq_w', 'b_hq_x', 'b_hq_y', 'b_hq_z', 'b_cal',
];
const RATE_HZ = 50;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r2 = (v: number) => Math.round(v * 100) / 100;

function rowOf(f: Frame, tMs: number, cal: number): (number | null)[] {
  const b = f.body!;
  return [
    Math.round(tMs),
    ...FINGERS.flatMap((k) => [r2(f.joints[k].ab), r2(f.joints[k].mcp), r2(f.joints[k].pip)]),
    ...f.hand.map(r4), ...f.forearm.map(r4), 1, 0, 0, 0, r2(f.blend), r2(Math.max(0, f.emg)),
    null, null, null, null, null, null, null,
    null, null, null,
    null, null, null, null, null, null, null,
    ...b.elbow.map(r4), ...b.wrist.map(r4), ...b.forearmQuat.map(r4), ...b.handQuat.map(r4), cal,
  ];
}

function synthRows(fromT: number, toT: number, cal: number) {
  const rows: (number | null)[][] = [];
  const n = Math.max(2, Math.round((toT - fromT) * RATE_HZ));
  for (let i = 0; i <= n; i++) {
    const t = fromT + i / RATE_HZ;
    rows.push(rowOf(simFrame(t), (t - fromT) * 1000, cal));
  }
  return rows;
}

type Neutral = { phase: 'countdown' | 'hold'; left: number } | null;

export class SimBridge {
  private emit: (m: Msg) => void;
  private cal: 'provisional' | 'calibrated' = 'provisional';
  private bootWall = Date.now();
  private neutralWall: number | null = null;
  private neutral: Neutral = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private rec: { id: string; startT: number; startWall: number; task: string; profile: string; notes: string; sdTake: number } | null = null;
  private takes: LibTake[] = [];
  private data = new Map<string, { id: string; cols: string[]; rows: (number | null)[][]; joint_source: string }>();
  private nextTake = 1;
  private sdNo = 5;
  private sd: SdTake[] = [
    // two standalone takes the "device" recorded on a power bank earlier
    { name: 'TK00003.CSV', bytes: 1_640_000, imported_take: null },
    { name: 'TK00004.CSV', bytes: 2_310_000, imported_take: null },
  ];
  private sdBusy = false;
  private autoRecord = true;

  constructor(emit: (m: Msg) => void) { this.emit = emit; }

  /** the library sync a bridge sends to every client on join */
  hello() {
    this.emit({ kind: 'takes', takes: this.takes });
    this.emitSd();
  }

  private emitSd() { this.emit({ kind: 'sd_takes', items: this.sd.map((s) => ({ ...s })), busy: this.sdBusy }); }
  private ack(m: Msg) { this.emit({ kind: 'ack', ...m }); }
  private later(ms: number, fn: () => void) { this.timers.push(setTimeout(fn, ms)); }

  dispose() { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  /** simFrame(t) plus the state a bridge would add: calibration, SD, recording */
  frame(t: number): Frame {
    const f = simFrame(t);
    const now = Date.now();
    if (f.body) {
      f.body.cal = this.cal;
      f.body.sinceNeutralS = Math.round((now - (this.neutralWall ?? this.bootWall)) / 1000);
      f.body.inertialConf = f.body.posSource === 'arm+inertial' ? 0.6 : 0;
    }
    const recS = this.rec ? t - this.rec.startT : 0;
    const device: DeviceInfo = {
      fw: 16, bootId: 4711, sdPresent: true, sdRecording: !!this.rec,
      sdTake: this.rec?.sdTake ?? 0, sdRows: this.rec ? Math.max(0, Math.floor(recS * 100)) : 0,
      standby: false, autoRecord: this.autoRecord, neutralRunning: !!this.neutral,
    };
    const rec: RecInfo = {
      recording: !!this.rec, id: this.rec?.id ?? null, task: this.rec?.task ?? null, profile: this.rec?.profile ?? null,
      elapsedMs: Math.max(0, Math.round(recS * 1000)), samples: Math.max(0, Math.floor(recS * RATE_HZ)),
    };
    f.device = device;
    f.rec = rec;
    return f;
  }

  /** one command, exactly as it would go up the socket; `t` is the feed clock */
  handle(cmd: Msg, t: number) {
    const name = cmd?.cmd;
    if (name === 'calibrate') {
      if (cmd.what !== 'neutral') { this.ack({ event: 'error', error: 'unknown calibration' }); return; }
      if (this.neutral) return;
      // the device's own sequence: 3-2-1 countdown, 2 s hold, done
      const steps: Neutral[] = [
        { phase: 'countdown', left: 3 }, { phase: 'countdown', left: 2 }, { phase: 'countdown', left: 1 },
        { phase: 'hold', left: 2 }, { phase: 'hold', left: 1 },
      ];
      steps.forEach((s, i) => this.later(i * 1000, () => {
        this.neutral = s;
        this.ack({ event: 'neutral', phase: s!.phase, t: s!.left });
      }));
      this.later(steps.length * 1000, () => {
        this.neutral = null;
        this.cal = 'calibrated';
        this.neutralWall = Date.now();
        this.ack({ event: 'neutral', phase: 'done', t: 0 });
      });
      return;
    }
    if (name === 'record') {
      if (cmd.action === 'start') {
        if (!this.rec) {
          const prof = cmd.profile;
          this.rec = {
            id: 'take_' + String(this.nextTake++).padStart(4, '0'), startT: t, startWall: Date.now(),
            task: cmd.task || 'unlabelled', profile: (prof && typeof prof === 'object' ? prof.name : prof) || 'Operator',
            notes: cmd.notes || '', sdTake: this.sdNo++,
          };
        }
        this.ack({ event: 'rec_started', id: this.rec.id });
      } else if (cmd.action === 'stop') {
        const r = this.rec;
        if (!r) { this.ack({ event: 'rec_stopped', id: null }); return; }
        this.rec = null;
        const dur = Math.max(0.1, t - r.startT);
        const rows = synthRows(r.startT, r.startT + dur, this.cal === 'calibrated' ? 2 : 1);
        this.data.set(r.id, { id: r.id, cols: SIM_COLS, rows, joint_source: 'sim' });
        this.takes.unshift({
          id: r.id, profile: r.profile, task: r.task, notes: r.notes || undefined,
          created_ms: r.startWall, duration_s: Math.round(dur * 10) / 10, samples: rows.length,
          quality: 'good', has_data: true, joint_source: 'sim',
        });
        // the card keeps the archival copy, already paired with this take
        this.sd.push({ name: `TK${String(r.sdTake).padStart(5, '0')}.CSV`, bytes: rows.length * 1100, imported_take: r.id });
        this.ack({ event: 'rec_stopped', id: r.id });
        this.emit({ kind: 'takes', takes: this.takes });
        this.emitSd();
      }
      return;
    }
    if (name === 'take_data') {
      const d = this.data.get(String(cmd.id));
      if (d) this.later(250, () => this.emit({ kind: 'take_data', ...d }));
      else this.ack({ event: 'error', error: 'no replay data', id: cmd.id });
      return;
    }
    if (name === 'sd') {
      if (cmd.action === 'list') { this.emitSd(); return; }
      if (cmd.action === 'auto') { this.autoRecord = !!cmd.on; return; }
      if (cmd.action === 'import') {
        const item = this.sd.find((s) => s.name === cmd.name);
        if (!item) { this.ack({ event: 'error', error: 'no such file', name: cmd.name }); return; }
        if (this.sdBusy) { this.ack({ event: 'error', error: 'sd busy', name: cmd.name }); return; }
        this.sdBusy = true;
        this.emitSd();
        for (let p = 0; p <= 100; p += 10) this.later(p * 25, () => this.ack({ event: 'sd_import', name: item.name, pct: p }));
        this.later(2700, () => {
          const id = 'take_' + String(this.nextTake++).padStart(4, '0');
          const num = Number(item.name.replace(/\D/g, '')) || 1;
          const dur = Math.round(item.bytes / 100 / 1100);
          const from = num * 7.3;
          const rows = synthRows(from, from + dur, 2);
          this.data.set(id, { id, cols: SIM_COLS, rows, joint_source: 'sim' });
          this.takes.unshift({
            id, profile: 'Standalone', task: `SD ${item.name}`, created_ms: Date.now(),
            duration_s: dur, samples: rows.length, quality: 'good', has_data: true, joint_source: 'sim', source: 'sd',
          });
          item.imported_take = id;
          this.sdBusy = false;
          this.ack({ event: 'sd_imported', name: item.name, take: id });
          this.emit({ kind: 'takes', takes: this.takes });
          this.emitSd();
        });
      }
      return;
    }
    this.ack({ event: 'error', error: 'unknown_cmd', cmd: String(name).slice(0, 32) });
  }
}
