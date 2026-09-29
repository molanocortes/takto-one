// Controls.tsx - the interactive pieces more than one screen needs: the replay
// transport, the neutral-calibration card and the "calibrate" prompt.
import React, { useRef, useState } from 'react';
import { View, Pressable, PanResponder, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { M, T, Num, Btn, Pill, Bar } from './primitives';
import { C, R, FINGERS, FINGER_LABEL } from './tokens';
import { useSession } from '../data/session';

const SPEEDS = [0.25, 0.5, 1, 2];

export function fmtTime(s: number) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

export function OriginPill({ origin }: { origin: 'bridge' | 'sim' | 'demo' }) {
  if (origin === 'demo') return <Pill color={C.orange} bg="#FDF3E1">Demo · synthetic</Pill>;
  if (origin === 'sim') return <Pill color={C.orange} bg="#FDF3E1">Simulated</Pill>;
  return <Pill color={C.blue} bg="#E8F0FE">Bridge</Pill>;
}

/** Play / pause, a scrubber you can drag, the clock, the speed, and eject. */
export function Transport() {
  const session = useSession();
  const p = session.play;
  const [w, setW] = useState(1);
  const startX = useRef(0);
  const widthRef = useRef(1);
  const dur = p?.take.durationS ?? 0;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      startX.current = e.nativeEvent.locationX;
      const pl = session.play;
      if (pl) session.seek((startX.current / widthRef.current) * pl.take.durationS);
    },
    onPanResponderMove: (_, g) => {
      const pl = session.play;
      if (pl) session.seek(((startX.current + g.dx) / widthRef.current) * pl.take.durationS);
    },
  })).current;
  if (!p) return null;
  const k = dur > 0 ? p.t / dur : 0;
  return (
    <View style={st.box}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Feather name="film" size={13} color={C.blue} />
        <T size={14} color={C.ink} style={{ flex: 1 }} numberOfLines={1}>{p.take.title}</T>
        <OriginPill origin={p.take.origin} />
        {p.take.origin === 'bridge' && p.take.jointSource && p.take.jointSource !== 'encoders'
          ? <Pill color={C.orange} bg="#FDF3E1">joints: {p.take.jointSource}</Pill> : null}
        {p.take.hasBody ? <Pill>Arm</Pill> : null}
      </View>
      <View
        onLayout={(e) => { widthRef.current = Math.max(1, e.nativeEvent.layout.width); setW(widthRef.current); }}
        style={st.track} {...pan.panHandlers}
        accessibilityRole="adjustable" accessibilityLabel="Replay position">
        <View pointerEvents="none" style={st.rail}>
          <View style={{ width: `${k * 100}%`, height: 4, backgroundColor: C.ink, borderRadius: 2 }} />
        </View>
        <View pointerEvents="none" style={[st.knob, { left: Math.max(0, Math.min(w - 16, k * w - 8)) }]} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Pressable onPress={() => session.togglePlay()} style={st.round} hitSlop={6} accessibilityRole="button" accessibilityLabel={p.playing ? 'Pause' : 'Play'}>
          <Feather name={p.playing ? 'pause' : 'play'} size={16} color={C.white} />
        </Pressable>
        <View style={{ marginLeft: 2 }}>
          <Num size={13} color={C.ink}>{fmtTime(p.t)}</Num>
          <M size={8.5} color={C.ink3} upper={false}>of {fmtTime(dur)}</M>
        </View>
        <View style={{ flex: 1 }} />
        {SPEEDS.map((s) => (
          <Pressable key={s} onPress={() => session.setSpeed(s)} hitSlop={3} accessibilityRole="button" accessibilityLabel={`Speed ${s}x`}
            style={[st.speed, p.speed === s && { backgroundColor: C.ink, borderColor: C.ink }]}>
            <M size={8.5} color={p.speed === s ? C.white : C.ink2} upper={false} tracking={0}>{s}×</M>
          </Pressable>
        ))}
        <Pressable onPress={() => session.setTake(null)} hitSlop={8} style={{ marginLeft: 2 }} accessibilityRole="button" accessibilityLabel="Stop replay">
          <Feather name="x" size={18} color={C.ink2} />
        </Pressable>
      </View>
    </View>
  );
}

function sinceText(s: number | null | undefined) {
  if (s == null) return '';
  if (s < 90) return `${Math.round(s)} s ago`;
  return `${Math.round(s / 60)} min ago`;
}

/** Where the arm pose comes from and whether it is calibrated, in one line. */
export function calLine(b: ReturnType<typeof useSession>['live']['body']) {
  if (!b) return 'No arm pose from this source';
  if (b.origin === 'legacy') return 'Legacy IMU quaternions: approximate, no body model';
  if (b.cal === 'calibrated') return `Calibrated · neutral ${sinceText(b.sinceNeutralS)}`;
  if (b.cal === 'provisional') return 'Provisional neutral: calibrate for a true pose';
  return 'Not calibrated for this power-up';
}

/** The neutral capture: instructions, the device's countdown, the hold, done. */
export function NeutralCard() {
  const session = useSession();
  const n = session.neutral;
  const b = session.live.body;
  const running = n.phase === 'requested' || n.phase === 'countdown' || n.phase === 'hold';
  const recent = n.phase === 'done' && Date.now() - n.at < 5000;
  return (
    <View style={st.box}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Feather name="crosshair" size={14} color={C.ink} />
        <T size={14} color={C.ink} style={{ flex: 1 }}>Neutral pose</T>
        {b && b.origin === 'body' ? (
          b.cal === 'calibrated' ? <Pill color={C.green} bg={C.greenSoft}>Calibrated</Pill>
            : b.cal === 'provisional' ? <Pill color={C.orange} bg="#FDF3E1">Provisional</Pill>
              : <Pill color={C.red} bg="#FDECEC">None</Pill>
        ) : <Pill>{b ? 'Legacy' : 'No IMU'}</Pill>}
      </View>
      <T size={12} color={C.ink2} style={{ marginTop: 6 }}>{calLine(b)}</T>

      {running ? (
        <View style={{ marginTop: 12, alignItems: 'center' }}>
          {n.phase === 'requested' && <M size={10} color={C.ink2}>Asking the device…</M>}
          {n.phase === 'countdown' && (<>
            <M size={10} color={C.ink2}>Get into the pose</M>
            <Num size={52} weight="300" color={C.ink}>{Math.max(1, Math.round(n.t))}</Num>
          </>)}
          {n.phase === 'hold' && (<>
            <M size={10} color={C.orange}>Hold still</M>
            <Num size={52} weight="300" color={C.orange}>{Math.max(1, Math.round(n.t))}</Num>
            <View style={{ alignSelf: 'stretch', marginTop: 4 }}><Bar value={1 - (n.t - 1) / 2} color={C.orange} /></View>
          </>)}
        </View>
      ) : (
        <>
          <T size={12} color={C.ink2} style={{ marginTop: 10 }}>
            Forearm roughly horizontal and pointing forward, palm down, wrist straight, fingers extended. The device counts 3-2-1 and asks you to hold still for 2 s.
          </T>
          {recent && <M size={10} color={C.green} style={{ marginTop: 10 }}>Captured</M>}
          {(n.phase === 'abort' || n.phase === 'error') && (
            <M size={9.5} color={C.red} upper={false} style={{ marginTop: 10 }}>{n.phase === 'abort' ? 'Aborted: the arm moved during the hold.' : `Failed: ${n.msg ?? 'unknown error'}`}</M>
          )}
          <Btn label={b?.cal === 'calibrated' ? 'Recalibrate neutral' : 'Calibrate neutral'} icon="crosshair" kind="primary"
            onPress={() => session.calibrateNeutral()} disabled={!session.canCommand || !!session.play} style={{ marginTop: 12 }} />
          {session.play ? <M size={8.5} color={C.ink3} upper={false} style={{ marginTop: 6 }}>Stop the replay to calibrate the live device.</M> : null}
        </>
      )}
    </View>
  );
}

/** A banner over the twin while the pose is not trustworthy yet. */
export function CalPrompt() {
  const session = useSession();
  const b = session.live.body;
  const n = session.neutral;
  if (session.play || !b || b.origin !== 'body') return null;
  const running = n.phase === 'requested' || n.phase === 'countdown' || n.phase === 'hold';
  if (b.cal === 'calibrated' && !running) return null;
  return (
    <View style={st.prompt}>
      <Feather name="alert-triangle" size={14} color={C.orange} />
      <View style={{ flex: 1 }}>
        <T size={12.5} color={C.ink}>
          {running ? (n.phase === 'hold' ? `Hold still… ${Math.round(n.t)}` : n.phase === 'countdown' ? `Palm down, fingers flat… ${Math.round(n.t)}` : 'Asking the device…')
            : 'Calibrate: hold your hand flat'}
        </T>
        {!running && <T size={11} color={C.ink2}>{b.cal === 'provisional' ? 'The pose uses an automatic neutral until you do.' : 'No neutral for this power-up.'}</T>}
      </View>
      {!running && <Btn label="Calibrate" height={34} kind="primary" onPress={() => session.calibrateNeutral()} disabled={!session.canCommand} />}
    </View>
  );
}

const st = StyleSheet.create({
  box: { backgroundColor: C.white, borderRadius: R.r3, borderWidth: 1, borderColor: C.tileLine, padding: 14, gap: 10 },
  track: { height: 28, justifyContent: 'center' },
  rail: { height: 4, borderRadius: 2, backgroundColor: C.line, overflow: 'hidden' },
  knob: { position: 'absolute', top: 6, width: 16, height: 16, borderRadius: 8, backgroundColor: C.white, borderWidth: 2, borderColor: C.ink },
  round: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' },
  speed: { paddingHorizontal: 5, minWidth: 30, height: 26, borderRadius: 6, borderWidth: 1, borderColor: C.tileLine, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, columnGap: 10 },
  cell: { width: '47%', flexGrow: 1, gap: 3 },
  cellDot: { width: 6, height: 6, borderRadius: 3 },
  prompt: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFF8EC', borderRadius: R.r2,
    borderWidth: 1, borderColor: '#F6D9A6', paddingHorizontal: 12, paddingVertical: 10,
  },
});

type Tone = 'ok' | 'warn' | 'bad' | 'none';
const TONE: Record<Tone, string> = { ok: C.green, warn: C.orange, bad: C.red, none: C.ink3 };

function Cell({ label, value, tone, sub }: { label: string; value: string; tone: Tone; sub?: string }) {
  return (
    <View style={st.cell} accessible accessibilityLabel={`${label}: ${value}${sub ? `, ${sub}` : ''}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={[st.cellDot, { backgroundColor: TONE[tone] }]} />
        <M size={8} color={C.ink2}>{label}</M>
      </View>
      <T size={14.5} color={C.ink} numberOfLines={1}>{value}</T>
      {sub ? <M size={8} color={C.ink3} upper={false} style={{ marginTop: 1 }}>{sub}</M> : null}
    </View>
  );
}

/**
 * What the source is delivering right now, as six measured cells: the two
 * main IMUs, the encoders, the stream rate, the calibration and the SD card.
 * Everything comes from the source's own frame (never the replay), and a
 * value the source does not report is a dash, not a guess.
 */
export function SensorStrip() {
  const session = useSession();
  const f = session.live;
  const status = session.status;
  const offline = session.source === 'bridge' && status.kind === 'offline';
  const b = f.body;
  const imu = f.imu;
  const imuCell = (who: 'hand' | 'forearm'): [string, Tone] => {
    if (offline) return ['–', 'none'];
    const v = imu?.[who];
    if (v === true) return ['live', 'ok'];
    if (v === false) return ['no signal', 'bad'];
    if (b) return b.live ? ['live', 'ok'] : ['no signal', 'bad'];
    return ['not reported', 'none'];
  };
  let enc = 0;
  for (const k of FINGERS) enc += (f.ok[k].ab ? 1 : 0) + (f.ok[k].mcp ? 1 : 0) + (f.ok[k].pip ? 1 : 0);
  const deadFingers = FINGERS.filter((k) => !f.ok[k].mcp && !f.ok[k].pip).map((k) => FINGER_LABEL[k]);
  const [hv, ht] = imuCell('hand');
  const [fv, ft] = imuCell('forearm');
  const c = session.conn;
  const p = session.pose;
  const rate = session.source === 'sim' ? (p.lane === 'on' ? `${p.hz} Hz` : 'in-app') : offline ? '–' : `${c.hz} Hz`;
  const rateSub = session.source === 'sim' ? 'simulated pose lane'
    : offline ? 'no data' : p.lane === 'on' ? `pose lane ${p.hz} Hz` : f.device?.rateHz ? `device ${Math.round(f.device.rateHz)} Hz` : 'snapshot';
  const rateTone: Tone = offline ? 'none' : session.source === 'sim' ? 'ok' : c.hz >= 30 ? 'ok' : c.hz > 0 ? 'warn' : 'bad';
  const calV = !b ? 'no IMU pose' : b.origin === 'legacy' ? 'legacy' : b.cal === 'calibrated' ? 'calibrated' : b.cal === 'provisional' ? 'provisional' : 'none';
  const calT: Tone = offline || !b ? 'none' : b.cal === 'calibrated' ? 'ok' : b.origin === 'legacy' ? 'none' : 'warn';
  const dev = f.device;
  const sdV = offline || !dev ? '–' : dev.sdRecording ? `recording #${dev.sdTake}` : dev.sdPresent ? 'ready' : 'no card';
  const sdT: Tone = offline || !dev ? 'none' : dev.sdPresent ? 'ok' : 'warn';
  return (
    <View style={st.grid}>
      <Cell label="Hand IMU" value={hv} tone={ht} />
      <Cell label="Forearm IMU" value={fv} tone={ft} />
      <Cell label="Encoders" value={offline ? '–' : `${enc} of 12`} tone={offline ? 'none' : enc === 12 ? 'ok' : enc > 0 ? 'warn' : 'bad'}
        sub={!offline && deadFingers.length ? `no signal: ${deadFingers.join(', ')}` : undefined} />
      <Cell label="Rate" value={rate} tone={rateTone} sub={rateSub} />
      <Cell label="Neutral" value={offline ? '–' : calV} tone={calT} />
      <Cell label="SD card" value={sdV} tone={sdT} sub={!offline && !dev ? 'not reported' : undefined} />
    </View>
  );
}

/** A take's research quality block as a row of small, honest tags. */
export function QualityPills({ q, fw }: { q: unknown; fw?: number }) {
  if (typeof q === 'string') return q ? <Pill>{q}</Pill> : null;
  if (!q || typeof q !== 'object') return fw ? <Pill>fw {fw}</Pill> : null;
  const Q = q as import('../data/types').TakeQuality;
  const out: React.ReactNode[] = [];
  const good = (k: string, s: string) => out.push(<Pill key={k} color={C.green} bg={C.greenSoft}>{s}</Pill>);
  const warn = (k: string, s: string) => out.push(<Pill key={k} color={C.orange} bg="#FDF3E1">{s}</Pill>);
  const bad = (k: string, s: string) => out.push(<Pill key={k} color={C.red} bg="#FDECEC">{s}</Pill>);
  const plain = (k: string, s: string) => out.push(<Pill key={k}>{s}</Pill>);
  if (typeof Q.rate_hz === 'number') plain('rate', `${Math.round(Q.rate_hz)} Hz`);
  if (typeof Q.dropped === 'number') {
    const frac = Q.frames ? Q.dropped / (Q.frames + Q.dropped) : 0;
    (Q.dropped === 0 ? good : frac < 0.01 ? warn : bad)('drop', Q.dropped === 0 ? 'no drops' : `${Q.dropped} dropped`);
  }
  if (typeof Q.max_gap_ms === 'number' && Q.rate_hz && Q.max_gap_ms > 3 * (1000 / Q.rate_hz)) warn('gap', `gap ${Math.round(Q.max_gap_ms)} ms`);
  const ih = Q.imu_live_pct?.hand, ifa = Q.imu_live_pct?.forearm;
  if (typeof ih === 'number' || typeof ifa === 'number') {
    const m = Math.min(ih ?? 100, ifa ?? 100);
    (m >= 99 ? good : m >= 90 ? warn : bad)('imu', `IMU ${Math.round(m)}%`);
  }
  if (Array.isArray(Q.enc_live)) (Q.enc_live.length === 12 ? good : Q.enc_live.length > 0 ? warn : bad)('enc', `enc ${Q.enc_live.length}/12`);
  const nk = Q.neutral?.kind;
  if (nk) (nk === 'calibrated' ? good : nk === 'provisional' ? warn : bad)('neu', nk === 'calibrated' ? 'calibrated' : nk === 'provisional' ? 'provisional neutral' : `neutral: ${nk}`);
  if (typeof Q.latency_ms?.median === 'number') plain('lat', `lat ${Math.round(Q.latency_ms.median)} ms`);
  if (fw) plain('fw', `fw ${fw}`);
  return <>{out}</>;
}
