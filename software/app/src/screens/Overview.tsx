// Overview.tsx - the device at a glance: the twin, how much of the sensing is
// live, four measured motion channels, the recording and the calibration.
//
// Every number on this page is MEASURED (or derived from a measurement) by the
// device. The earlier page showed temperature, battery, "position accuracy"
// and response time: the device has no sensor for any of them, so live they
// were dashes and in the simulator they were invented. What the rig does
// measure is motion, so that is what the home page reports.
import React, { useRef } from 'react';
import { View, ScrollView, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSyncExternalStore } from 'react';
import { Twin } from '../twin/Twin';
import { twinStatus } from '../twin/loadHand';
import { TopRow, Title, SectionHead } from '../ui/Chrome';
import { M, T, Num, Hairline, Trace, Ring } from '../ui/primitives';
import { C, S } from '../ui/tokens';
import { useSession } from '../data/session';
import { qrot } from '../data/quat';
import type { Frame, Vec3 } from '../data/types';

const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
const HIST = 60;

type Metric = { key: string; icon: keyof typeof Feather.glyphMap; label: string; unit: string; color: string;
                read: (f: Frame, speed: number | null) => number | null; digits: number };

const forearmElevation = (f: Frame): number | null => {
  if (!f.body || !f.body.live) return null;
  const d = qrot(f.body.forearmQuat, [0, 0, 1]);            // distal axis in the body frame
  return (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI;
};

const METRICS: Metric[] = [
  { key: 'flex', icon: 'corner-right-down', label: 'Wrist flexion', unit: '°', color: C.blue, digits: 0,
    read: (f) => (f.body && f.body.live && f.body.wristDeg ? f.body.wristDeg.flex : null) },
  { key: 'dev', icon: 'corner-up-right', label: 'Wrist deviation', unit: '°', color: C.blue, digits: 0,
    read: (f) => (f.body && f.body.live && f.body.wristDeg ? f.body.wristDeg.dev : null) },
  { key: 'elev', icon: 'trending-up', label: 'Forearm elevation', unit: '°', color: C.green, digits: 0,
    read: (f) => forearmElevation(f) },
  { key: 'speed', icon: 'wind', label: 'Hand speed', unit: 'cm/s', color: C.orange, digits: 0,
    read: (_f, speed) => speed },
];

/** fraction of the expected sensing that is live: 2 main IMUs + 12 finger channels */
function coverage(f: Frame): { live: number; total: number } {
  let live = f.body && f.body.live ? 2 : 0;
  for (const k of FINGERS) {
    const ok = f.ok[k];
    live += (ok.ab ? 1 : 0) + (ok.mcp ? 1 : 0) + (ok.pip ? 1 : 0);
  }
  return { live, total: 14 };
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function Overview({ onMenu, onStatus }: { onMenu?: () => void; onStatus?: () => void }) {
  const session = useSession();
  const frame = session.frame;
  const { width } = useWindowDimensions();
  const twin = useSyncExternalStore(twinStatus.subscribe, twinStatus.get, twinStatus.get);
  const hist = useRef<Record<string, number[]>>({}).current;
  const last = useRef<{ t: number; hand: Vec3 | null; speed: number | null }>({ t: NaN, hand: null, speed: null }).current;

  const push = (k: string, v: number | null) => {
    if (v === null || !Number.isFinite(v)) return;
    const a = (hist[k] ??= []);
    a.push(v); if (a.length > HIST) a.shift();
  };

  // one sample per frame time (a paused clock re-renders without advancing)
  if (frame.t !== last.t) {
    const dt = frame.t - last.t;
    const hand = frame.body && frame.body.live ? frame.body.hand : null;
    if (hand && last.hand && dt > 0 && dt < 0.5) {
      const d = Math.hypot(hand[0] - last.hand[0], hand[1] - last.hand[1], hand[2] - last.hand[2]);
      const v = (d / dt) * 100;                               // cm/s
      last.speed = last.speed === null ? v : last.speed + (v - last.speed) * 0.25;
    } else if (!hand) {
      last.speed = null;
    }
    last.t = frame.t; last.hand = hand;
    const cov = coverage(frame);
    push('cov', (cov.live / cov.total) * 100);
    for (const m of METRICS) push(m.key, m.read(frame, last.speed));
  }

  // no data from the source means no sensor is live that we know of: a dash, not a frozen percentage
  const noData = session.status.kind === 'offline';
  const cov = coverage(frame);
  const covPct = Math.round((cov.live / cov.total) * 100);
  const body = frame.body;
  const rec = frame.rec;
  const dev = frame.device;
  const twinW = width - S.gutter * 2;
  const statusWord = session.status.kind === 'live' ? 'Live device' : session.status.kind === 'replay' ? 'Replay'
                   : session.status.kind === 'sim' ? 'Simulated' : 'No data';

  const calWord = !body ? 'No IMU pose' : body.cal === 'calibrated' ? 'Calibrated'
                : body.cal === 'provisional' ? 'Provisional' : 'Not calibrated';
  const calColor = body && body.cal === 'calibrated' ? C.green : C.orange;
  const calDetail = body && body.cal === 'calibrated' && body.sinceNeutralS !== null
    ? `neutral ${Math.max(0, Math.round(body.sinceNeutralS / 60))} min ago`
    : 'hold your hand flat, then calibrate';

  const neutralRunning = ['requested', 'countdown', 'hold'].includes(session.neutral.phase);
  const canCal = !!body && body.origin === 'body' && body.cal !== 'calibrated' && session.canCommand && !session.play && !neutralRunning;
  const recording = !!(rec && rec.recording);
  const recDetail = recording
    ? `${rec!.samples} samples`
    : dev ? (dev.sdRecording ? `card take ${dev.sdTake}` : dev.sdPresent ? 'SD card ready' : 'no SD card')
    : 'not recording';

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter }} showsVerticalScrollIndicator={false}>
        <TopRow onMenu={onMenu} onStatus={onStatus} />

        {/* the hero: words on the left, the machine on the right */}
        <View style={{ height: 292 }}>
          <View style={[StyleSheet.absoluteFill, { left: 118, top: 78 }]} pointerEvents="box-none">
            <Twin style={{ width: twinW - 92, height: 220 }} stage="light" part="device" />
            {twin.state !== 'ready' && (
              <View style={{ position: 'absolute', left: 0, right: 0, top: 96, alignItems: 'center' }} pointerEvents="none">
                <M size={8.5} color={twin.state === 'error' ? C.orange : C.ink3}>
                  {twin.state === 'error' ? `Twin failed: ${twin.detail}` : twin.state === 'idle' ? '' : `Twin ${twin.detail}…`}
                </M>
              </View>
            )}
          </View>
          <Title status={statusWord} spinning={session.status.kind !== 'live' && session.status.kind !== 'replay'}>Digital twin</Title>
          <View style={{ marginTop: 40 }} pointerEvents="none">
            <M size={9.5} color={C.ink2}>Sensors live</M>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 6 }}>
              <Num size={54} weight="300" color={noData ? C.ink3 : C.ink} tracking={-1}>{noData ? '–' : covPct}</Num>
              {!noData && <T size={15} weight="400" color={C.ink} style={{ marginLeft: 5 }}>%</T>}
            </View>
            <M size={8} color={C.ink3} upper={false} style={{ marginTop: 2 }}>{noData ? 'no data from the source' : `${cov.live} of ${cov.total} channels`}</M>
            <View style={{ marginTop: 6 }}>
              <Trace values={hist.cov ?? []} width={98} height={20} color={C.green} stroke={1.1} />
            </View>
          </View>
        </View>

        <SectionHead label="Motion" right={session.isPaused() ? 'Paused' : 'Real-time'} onRight={() => (session.isPaused() ? session.resume() : session.pause())} style={{ marginTop: 18 }} />
        <View style={{ marginTop: 8 }}>
          {METRICS.map((m, i) => {
            const v = noData ? null : m.read(frame, last.speed);
            return (
              <View key={m.key}>
                {i > 0 && <Hairline />}
                <View style={st.row}>
                  <Feather name={m.icon} size={15} color={C.ink2} style={{ width: 26, marginLeft: 6 }} />
                  <M size={9} color={C.ink2} style={{ width: 118, marginLeft: 8 }}>{m.label}</M>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', width: 76 }}>
                    <Num size={15.5} color={C.ink}>{v === null ? '–' : (Math.abs(v) < 0.5 * 10 ** -m.digits ? 0 : v).toFixed(m.digits)}</Num>
                    <M size={8} color={C.ink2} upper={false} style={{ marginLeft: 5 }}>{m.unit}</M>
                  </View>
                  <View style={{ flex: 1, alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
                    <Trace values={hist[m.key] ?? []} width={90} height={16} color={m.color} dashed stroke={1} />
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: m.color }} />
                  </View>
                </View>
              </View>
            );
          })}
        </View>
        {body && (
          <M size={7.5} color={C.ink3} upper={false} style={{ marginTop: 6 }}>
            {`Position from the ${body.posSource === 'arm+inertial' ? 'jointed-arm model with inertial shoulder motion' : 'jointed-arm model'}: the IMUs measure orientation, not position.`}
          </M>
        )}

        <Hairline style={{ marginTop: 12, marginHorizontal: -S.gutter }} />
        <View style={st.twoCol}>
          <View style={st.col}>
            <M size={9.5} color={C.ink}>Recording</M>
            <View style={{ alignItems: 'center', marginTop: 8 }}>
              <Ring value={recording ? ((rec!.elapsedMs / 1000) % 60) / 60 : 0} size={66} stroke={3.5}>
                <Num size={14} weight="300" color={C.ink}>{recording ? mmss(rec!.elapsedMs) : '–'}</Num>
              </Ring>
              <T size={11.5} color={C.ink2} style={{ marginTop: 8 }}>{recDetail}</T>
            </View>
          </View>
          <View style={st.colLine} />
          <View style={[st.col, { paddingLeft: 24 }]}>
            <M size={9.5} color={C.ink}>Calibration</M>
            <T size={18} weight="400" color={C.ink} style={{ marginTop: 16 }}>{calWord}</T>
            {/* not calibrated: the pill is the button (the device counts down and beeps) */}
            <Pressable disabled={!canCal} onPress={() => session.calibrateNeutral()} hitSlop={8}
              accessibilityRole={canCal ? 'button' : undefined} accessibilityLabel={canCal ? 'Calibrate the neutral pose' : calDetail}
              style={[st.pill, { backgroundColor: body && body.cal === 'calibrated' ? C.greenSoft : 'rgba(240,140,60,0.12)' }]}>
              <M size={8.5} color={calColor} upper={false}>{neutralRunning ? 'hold the pose…' : canCal ? `${calDetail} · tap` : calDetail}</M>
            </Pressable>
          </View>
        </View>
        <Hairline style={{ marginHorizontal: -S.gutter }} />
        <View style={{ height: 4 }} />
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', height: 39 },
  twoCol: { flexDirection: 'row', paddingVertical: 16, minHeight: 120 },
  col: { flex: 1 },
  colLine: { width: 1, backgroundColor: C.line, marginVertical: -20, marginHorizontal: 0 },
  pill: { alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, marginTop: 10 },
});
