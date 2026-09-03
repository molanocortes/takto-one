// Analytics.tsx - the twelve joints and the activation channel, as traces.
import React, { useRef } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { TopRow, Title, SectionHead } from '../ui/Chrome';
import { M, T, Num, Hairline, Trace } from '../ui/primitives';
import { C, S, FINGERS, FINGER_LABEL } from '../ui/tokens';
import { useSession } from '../data/session';
import { simFrame } from '../data/sim';

const JOINTS = [
  { key: 'ab' as const, label: 'Abd', unit: '°', color: C.orange },
  { key: 'mcp' as const, label: 'MCP', unit: '°', color: C.blue },
  { key: 'pip' as const, label: 'PIP', unit: '°', color: C.green },
];
const HIST = 48;

export function Analytics() {
  const session = useSession();
  const frame = session.frame;
  const hist = useRef<Record<string, number[]>>({}).current;
  const lastT = useRef(NaN);
  const push = (k: string, v: number) => { const a = (hist[k] ??= []); a.push(v); if (a.length > HIST) a.shift(); };
  // the very first frame is the empty one before the feed delivers; skip it
  if (frame.t !== lastT.current && (frame.telemetry || session.link.kind !== 'sim')) {
    lastT.current = frame.t;
    if (!hist.emg && session.link.kind === 'sim') {
      // seed the past from the feed's own function of time, so no trace starts flat
      for (let i = HIST - 1; i > 0; i--) {
        const past = simFrame(frame.t - i * 0.25);
        for (const f of FINGERS) for (const j of JOINTS) push(`${f}.${j.key}`, past.joints[f][j.key]);
        push('emg', Math.max(0, past.emg));
      }
    }
    for (const f of FINGERS) for (const j of JOINTS) push(`${f}.${j.key}`, frame.joints[f][j.key]);
    push('emg', Math.max(0, frame.emg));
  }

  let sum = 0, n = 0;
  for (const f of FINGERS) { if (frame.ok[f].mcp) { sum += frame.joints[f].mcp; n++; } if (frame.ok[f].pip) { sum += frame.joints[f].pip; n++; } }
  const mean = n ? sum / n : 0;

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter }} showsVerticalScrollIndicator={false}>
        <TopRow live={session.link.live || session.link.kind === 'sim'} label="Live" />
        <Title status={session.link.live ? 'Connected' : session.link.kind === 'take' ? 'Replay' : 'Synthetic feed'} spinning={!session.link.live}>Analytics</Title>

        <View style={{ marginTop: 34 }}>
          <M size={11} color={C.ink2}>Mean flexion</M>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 8 }}>
            <Num size={62} weight="300" tracking={-1}>{mean.toFixed(0)}</Num>
            <T size={17} style={{ marginLeft: 6 }}>°</T>
          </View>
        </View>

        <SectionHead label="Activation" right="EMG" style={{ marginTop: 30 }} />
        <View style={{ marginTop: 10 }}>
          <Trace values={hist.emg ?? []} width={341} height={44} color={C.green} stroke={1.2} />
        </View>

        {FINGERS.map((f) => (
          <View key={f}>
            <SectionHead label={FINGER_LABEL[f]} style={{ marginTop: 26 }} />
            <View style={{ marginTop: 8 }}>
              {JOINTS.map((j, i) => {
                const on = frame.ok[f][j.key]; const v = frame.joints[f][j.key];
                return (
                  <View key={j.key}>
                    {i > 0 && <Hairline />}
                    <View style={st.row}>
                      <M size={10.5} color={C.ink2} style={{ width: 60 }}>{j.label}</M>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', width: 78 }}>
                        <Num size={17}>{on ? `${j.key === 'ab' && v > 0 ? '+' : ''}${v.toFixed(0)}` : '–'}</Num>
                        <M size={9} color={C.ink2} upper={false} style={{ marginLeft: 5 }}>{j.unit}</M>
                      </View>
                      <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
                        <Trace values={hist[`${f}.${j.key}`] ?? []} width={92} height={18} color={j.color} dashed stroke={1.2} />
                        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: on ? j.color : C.line }} />
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        ))}
        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', height: 40 } });
