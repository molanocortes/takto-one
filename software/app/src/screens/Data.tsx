// Data.tsx - the channels themselves, and where they are coming from.
//
// The rates card is not decoration. Loop rate, sampling rate, telemetry rate
// and display rate are four different numbers, and collapsing them into one
// is the easiest way to mislead someone about this device. The app shows the
// one it is actually drawing at, and names the others.
import React, { useState } from 'react';
import { View, ScrollView, Pressable, TextInput, StyleSheet } from 'react-native';
import { Card, Label, Mono, UIText, Hairline, Dot } from '../ui/primitives';
import { C, S, R, F, FINGERS, FINGER_LABEL } from '../ui/tokens';
import { useSession } from '../data/session';

// The wire name and the mechanical name are not the same word, and this is
// the one place in the app that says so out loud. A channel called `{f}_mcp`
// carries MCP ABDUCTION; `{f}_pip` carries MCP flexion; `{f}_dip` carries PIP
// flexion. There is no DIP joint in the mechanism.
const SEGMENTS = [
  { key: 'ab' as const, wire: 'mcp', name: 'MCP abduction', limit: 16 },
  { key: 'mcp' as const, wire: 'pip', name: 'MCP flexion', limit: 90 },
  { key: 'pip' as const, wire: 'dip', name: 'PIP flexion', limit: 110 },
];

const RATES = [
  ['This app', '60 Hz', 'what you are watching'],
  ['Firmware stream', '50 Hz', 'the serial line default'],
  ['Control loop', 'up to 2 kHz', 'on the Teensy, next to the actuator'],
  ['On-device capture', 'unbound', 'the SD log is not tied to any of these'],
];

export function Data() {
  const session = useSession();
  const frame = session.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={st.content}
      showsVerticalScrollIndicator={false}>
      <Card style={{ padding: S.s4 }}>
        <Label>Source</Label>
        <View style={{ height: S.s3 }} />
        <View style={st.srcRow}>
          <Dot on={session.link.live} />
          <UIText size={16} weight="500">{session.link.label}</UIText>
          <View style={{ flex: 1 }} />
          <Mono size={11.5} color={C.ink3}>{session.link.detail}</Mono>
        </View>
        <View style={{ height: S.s4 }} />
        <Hairline />
        <View style={{ height: S.s4 }} />
        <Label>Bridge address</Label>
        <TextInput value={url} onChangeText={setUrl} autoCapitalize="none"
          autoCorrect={false} style={st.input} placeholderTextColor={C.ink3} />
        <View style={st.btnRow}>
          <Pressable style={[st.btn, st.btnPrimary]} onPress={() => session.connect(url)}>
            <UIText size={14} weight="600" color="#FFFFFF">Connect</UIText>
          </Pressable>
          <Pressable style={st.btn} onPress={() => session.useSimulator()}>
            <UIText size={14} weight="600" color={C.ink}>Simulator</UIText>
          </Pressable>
        </View>
      </Card>

      <Card style={{ padding: S.s4 }}>
        <Label>Channels</Label>
        <UIText size={11.5} color={C.ink3} style={{ marginTop: 5, lineHeight: 16 }}>
          Wire name, then what the channel actually measures. A value past the
          mechanism's limit shows in accent; the twin clamps it.
        </UIText>
        <View style={{ height: S.s3 }} />
        {FINGERS.map((f, fi) => (
          <View key={f}>
            {fi > 0 && <View style={{ height: S.s3 }} />}
            <Mono size={10.5} color={C.ink3} tracking={0.9}>{FINGER_LABEL[f]}</Mono>
            <View style={{ height: 6 }} />
            {SEGMENTS.map((s, si) => (
              <View key={s.key}>
                {si > 0 && <Hairline />}
                <View style={st.chanRow}>
                  <Mono size={12.5} color={C.ink2} style={{ width: 92 }}>
                    {f}_{s.wire}
                  </Mono>
                  <UIText size={12.5} color={C.ink3} style={{ flex: 1 }}>{s.name}</UIText>
                  <Mono size={15} weight="500"
                    color={!frame.ok[f][s.key] ? C.ink3
                      : Math.abs(frame.joints[f][s.key]) > s.limit ? C.accent : C.ink}>
                    {frame.ok[f][s.key] ? `${frame.joints[f][s.key].toFixed(1)}°` : 'absent'}
                  </Mono>
                </View>
              </View>
            ))}
          </View>
        ))}
      </Card>

      <Card style={{ padding: S.s4 }}>
        <Label>Rates</Label>
        <View style={{ height: S.s3 }} />
        {RATES.map(([what, rate, note], i) => (
          <View key={what}>
            {i > 0 && <Hairline />}
            <View style={st.rateRow}>
              <View style={{ flex: 1 }}>
                <UIText size={14}>{what}</UIText>
                <UIText size={11.5} color={C.ink3} style={{ marginTop: 1 }}>{note}</UIText>
              </View>
              <Mono size={14} weight="500">{rate}</Mono>
            </View>
          </View>
        ))}
      </Card>

      <View style={st.note}>
        <Mono size={10.5} color={C.ink3}>Research prototype. Not a medical device.</Mono>
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  content: { padding: S.s4, paddingTop: S.s2, gap: S.s3, paddingBottom: S.s7 },
  srcRow: { flexDirection: 'row', alignItems: 'center', gap: S.s2 },
  input: {
    fontFamily: F.mono, fontSize: 13, color: C.ink, marginTop: S.s2,
    backgroundColor: C.paperSunk, borderRadius: R.r1, paddingHorizontal: S.s3,
    paddingVertical: 11,
  },
  btnRow: { flexDirection: 'row', gap: S.s2, marginTop: S.s3 },
  btn: {
    flex: 1, paddingVertical: 12, borderRadius: R.r1, alignItems: 'center',
    backgroundColor: C.paperSunk,
  },
  btnPrimary: { backgroundColor: C.accent },
  chanRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, gap: S.s2 },
  rateRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: S.s3 },
  note: { alignItems: 'center' },
});
