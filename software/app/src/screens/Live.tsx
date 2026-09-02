// Live.tsx - the device, right now.
//
// The twin is given the top half of the screen and a pure white stage,
// because the machine is the subject and everything else on this screen is a
// caption to it. Below the stage, the twelve joints and the activation
// channel, in that order: what the hand did, then what the wearer intended.
import React, { useRef } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { Twin } from '../twin/Twin';
import { JointMatrix, EffortMeter, BlendBar } from '../ui/Meters';
import { Card, Label, Mono, Hairline } from '../ui/primitives';
import { C, S, R, FINGERS } from '../ui/tokens';
import { useSession } from '../data/session';

export function Live({ stageHeight }: { stageHeight: number }) {
  const session = useSession();
  const frame = session.frame;
  const history = useRef<number[]>([]).current;

  if (frame.emg >= 0) {
    history.push(frame.emg);
    if (history.length > 120) history.shift();
  }

  // mean flexion across the live flexion channels, the same summary the
  // console calls curl. Abduction is excluded: it is small and signed, and
  // averaging it in only dilutes the number.
  let sum = 0, n = 0;
  for (const f of FINGERS) {
    if (frame.ok[f].mcp) { sum += frame.joints[f].mcp; n++; }
    if (frame.ok[f].pip) { sum += frame.joints[f].pip; n++; }
  }
  const mean = n ? sum / n : 0;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={st.content}
      showsVerticalScrollIndicator={false}>
      <Card style={[st.stage, { height: stageHeight }]} padded={false}>
        <Twin style={{ flex: 1 }} />
        <View style={st.stageFoot} pointerEvents="none">
          <Label style={{ fontSize: 9.5 }}>12 joints · live</Label>
          <Label style={{ fontSize: 9.5 }}>drag to orbit</Label>
        </View>
      </Card>

      <Card style={st.card}>
        <View style={st.cardHead}>
          <Label>Flexion</Label>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
            <Mono size={15} color={C.ink2}>{mean.toFixed(0)}</Mono>
            <Mono size={11} color={C.ink3}>° MEAN</Mono>
          </View>
        </View>
        <Hairline />
        <View style={{ height: S.s4 }} />
        <JointMatrix frame={frame} />
      </Card>

      <Card style={st.card}>
        <EffortMeter value={frame.emg} history={history} />
        <View style={{ height: S.s3 }} />
        <Hairline />
        <BlendBar value={frame.blend} />
      </Card>

      <View style={st.note}>
        <Mono size={10.5} color={C.ink3}>
          {session.link.kind === 'bridge'
            ? 'Streaming from teensy_bridge.py'
            : 'Synthetic feed. No hand wore the device to make this.'}
        </Mono>
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  content: { padding: S.s4, paddingTop: S.s2, gap: S.s3, paddingBottom: S.s7 },
  stage: { overflow: 'hidden', justifyContent: 'flex-end' },
  stageFoot: {
    position: 'absolute', left: S.s4, right: S.s4, bottom: S.s3,
    flexDirection: 'row', justifyContent: 'space-between',
  },
  card: { paddingVertical: S.s4 },
  cardHead: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'baseline', marginBottom: S.s3,
  },
  note: { alignItems: 'center', paddingTop: S.s2 },
});
