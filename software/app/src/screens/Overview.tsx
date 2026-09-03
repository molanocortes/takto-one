// Overview.tsx - the device at a glance: the twin, the health number, the
// four housekeeping channels, the battery and the mode.
import React, { useRef, useState } from 'react';
import { View, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Twin } from '../twin/Twin';
import { TopRow, Title, SectionHead, Tiles, type TileIcon } from '../ui/Chrome';
import { M, T, Num, Hairline, Trace, Ring } from '../ui/primitives';
import { C, S, R } from '../ui/tokens';
import { useSession } from '../data/session';
import { simFrame } from '../data/sim';
import type { Telemetry } from '../data/types';

type Side = 'left' | 'active' | 'right';
const SIDES: { key: Side; label: string; icon: TileIcon }[] = [
  { key: 'left', label: 'Left', icon: { set: 'mci', name: 'hand-back-left-outline' } },
  { key: 'active', label: 'Active', icon: { set: 'bars' } },
  { key: 'right', label: 'Right', icon: { set: 'mci', name: 'hand-back-right-outline' } },
];

type Row = { key: keyof Telemetry; icon: keyof typeof Feather.glyphMap; label: string; unit: string; color: string; fmt: (v: number) => string };
const ROWS: Row[] = [
  { key: 'tempC', icon: 'thermometer', label: 'Temperature', unit: '°C', color: C.blue, fmt: (v) => v.toFixed(1) },
  { key: 'load', icon: 'zap', label: 'Motor load', unit: '%', color: C.blue, fmt: (v) => (v * 100).toFixed(0) },
  { key: 'accuracyMm', icon: 'crosshair', label: 'Position accuracy', unit: 'mm', color: C.green, fmt: (v) => v.toFixed(2) },
  { key: 'responseMs', icon: 'clock', label: 'Response time', unit: 'ms', color: C.orange, fmt: (v) => v.toFixed(0) },
];

const HIST = 40;

export function Overview() {
  const session = useSession();
  const frame = session.frame;
  const tel = frame.telemetry;
  const [side, setSide] = useState<Side>('active');
  const { width } = useWindowDimensions();
  const hist = useRef<Record<string, number[]>>({}).current;
  const lastT = useRef(NaN);

  const push = (k: string, v: number) => {
    const a = (hist[k] ??= []);
    a.push(v); if (a.length > HIST) a.shift();
  };
  // one sample per frame time: a pinned clock re-renders without advancing,
  // and must not flood the history with the same value
  if (tel && frame.t !== lastT.current) {
    lastT.current = frame.t;
    if (!hist.health) {
      // the first frame seeds the past from the feed's own function of time,
      // so a trace never starts as a flat line
      for (let i = HIST - 1; i > 0; i--) {
        const past = simFrame(frame.t - i * 0.5).telemetry!;
        push('health', past.health);
        for (const r of ROWS) push(r.key, past[r.key] as number);
      }
    }
    push('health', tel.health);
    for (const r of ROWS) push(r.key, tel[r.key] as number);
  }

  const health = tel ? Math.round(tel.health * 100) : null;
  const battery = tel ? Math.round(tel.battery * 100) : null;
  const left = tel ? `${Math.floor(tel.minutesLeft / 60)}h ${Math.round(tel.minutesLeft % 60)}m remaining` : '–';
  const blend = Math.max(0, Math.min(1, frame.blend));
  const mode = blend < 0.15 ? 'Transparent' : blend > 0.85 ? 'Full Assist' : 'Adaptive Grip';
  const twinW = width - S.gutter * 2;

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter }} showsVerticalScrollIndicator={false}>
        <TopRow live={session.link.live || session.link.kind === 'sim'} label={session.link.live ? 'Live' : session.link.kind === 'sim' ? 'Live' : 'Idle'} />

        {/* the hero: words on the left, the machine on the right */}
        <View style={{ height: 292 }}>
          <View style={[StyleSheet.absoluteFill, { left: 118, top: 78 }]} pointerEvents="box-none">
            <Twin style={{ width: twinW - 92, height: 220 }} stage="light" part="device" />
          </View>
          <Title status={session.link.live ? 'Connected' : 'Syncing'} spinning={!session.link.live}>Digital twin</Title>
          <View style={{ marginTop: 40 }} pointerEvents="none">
            <M size={9.5} color={C.ink2}>System status</M>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 6 }}>
              <Num size={54} weight="300" color={C.ink} tracking={-1}>{health ?? '–'}</Num>
              <T size={15} weight="400" color={C.ink} style={{ marginLeft: 5 }}>%</T>
            </View>
            <View style={{ marginTop: 8 }}>
              <Trace values={hist.health ?? []} width={98} height={20} color={C.green} stroke={1.1} />
            </View>
          </View>
        </View>

        <View style={{ marginTop: 6 }}>
          <Tiles items={SIDES} value={side} onChange={setSide} />
        </View>

        <SectionHead label="Telemetry" right="Real-time" style={{ marginTop: 22 }} />
        <View style={{ marginTop: 8 }}>
          {ROWS.map((r, i) => {
            const v = tel ? (tel[r.key] as number) : null;
            return (
              <View key={r.key}>
                {i > 0 && <Hairline />}
                <View style={st.row}>
                  <Feather name={r.icon} size={15} color={C.ink2} style={{ width: 26, marginLeft: 6 }} />
                  <M size={9} color={C.ink2} style={{ width: 118, marginLeft: 8 }}>{r.label}</M>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', width: 76 }}>
                    <Num size={15.5} color={C.ink}>{v === null ? '–' : r.fmt(v)}</Num>
                    <M size={8} color={C.ink2} upper={false} style={{ marginLeft: 5 }}>{r.unit}</M>
                  </View>
                  <View style={{ flex: 1, alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
                    <Trace values={hist[r.key] ?? []} width={90} height={16} color={r.color} dashed stroke={1} />
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: r.color }} />
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        <Hairline style={{ marginTop: 10, marginHorizontal: -S.gutter }} />
        <View style={st.twoCol}>
          <View style={st.col}>
            <M size={9.5} color={C.ink}>Battery</M>
            <View style={{ alignItems: 'center', marginTop: 8 }}>
              <Ring value={tel ? tel.battery : 0} size={66} stroke={3.5}>
                <Num size={16} weight="300" color={C.ink}>{battery ?? '–'}<T size={9.5} weight="300" color={C.ink}>%</T></Num>
              </Ring>
              <T size={11.5} color={C.ink2} style={{ marginTop: 8 }}>{left}</T>
            </View>
          </View>
          <View style={st.colLine} />
          <View style={[st.col, { paddingLeft: 24 }]}>
            <M size={9.5} color={C.ink}>Mode</M>
            <T size={18} weight="400" color={C.ink} style={{ marginTop: 16 }}>{mode}</T>
            <View style={st.autoPill}><M size={9} color={C.green} tracking={1}>Auto</M></View>
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
  autoPill: {
    alignSelf: 'flex-start', backgroundColor: C.greenSoft, borderRadius: 4,
    paddingHorizontal: 8, paddingVertical: 3, marginTop: 10,
  },
});
