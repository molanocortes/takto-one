// Data.tsx - the channels themselves, and where they are coming from.
//
// The rates list is not decoration. Loop rate, sampling rate, telemetry rate
// and display rate are four different numbers, and collapsing them into one
// is the easiest way to mislead someone about this device.
import React, { useState } from 'react';
import { View, TextInput, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Header, Backdrop, Sheet, Row, GlassChip, BadgeButton, NAV_H, NAV_GAP } from '../ui/Chrome';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T, Num, Label, Glass, PillButton, Hairline } from '../ui/primitives';
import { Bar } from '../ui/Meters';
import { C, S, R, FINGERS, FINGER_LABEL } from '../ui/tokens';
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
const RATES: { what: string; rate: string; note: string; icon: any }[] = [
  { what: 'This app', rate: '60 Hz', note: 'what you are watching', icon: 'smartphone' },
  { what: 'Firmware stream', rate: '50 Hz', note: 'the serial line default', icon: 'radio' },
  { what: 'Control loop', rate: '2 kHz', note: 'on the Teensy, next to the actuator', icon: 'cpu' },
  { what: 'On-device capture', rate: 'unbound', note: 'the SD log is not tied to any of these', icon: 'hard-drive' },
];

export function Data() {
  const session = useSession();
  const frame = session.frame;
  const { height } = useWindowDimensions();
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  let live = 0;
  for (const f of FINGERS) live += (frame.ok[f].ab ? 1 : 0) + (frame.ok[f].mcp ? 1 : 0) + (frame.ok[f].pip ? 1 : 0);
  const isLive = session.link.live;
  const [sheet, setSheet] = useState(false);
  const inset = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Backdrop dim={0.3} lift={0.04} scale={0.92} />
      <Header title="Data" right={<BadgeButton icon="settings" />}
        chips={<>
          <GlassChip icon={isLive ? 'radio' : 'cpu'} label={isLive ? 'Bridge' : 'Simulated'} tone={isLive ? 'live' : 'glass'} />
          <GlassChip icon="grid" label={`${live} / 12 live`} />
        </>} />

      <Glass intensity={70} strong style={[st.float, { bottom: NAV_H + NAV_GAP * 2 + inset.bottom + S.s2 }]}>
        <View style={{ padding: S.s5 }}>
          <T size={17} weight="500">Bridge address</T>
          <T size={13} color={C.t2} style={{ marginTop: 3 }}>{session.link.detail}</T>
          <View style={st.inputRow}>
            <Feather name="link" size={15} color={C.t3} />
            <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false}
              style={st.input} placeholderTextColor={C.t3} placeholder="ws://host:8765/ws" />
          </View>
          <View style={{ flexDirection: 'row', gap: S.s2, marginTop: S.s3 }}>
            <PillButton label="Connect" onPress={() => session.connect(url)} style={{ flex: 1, height: 50 }} />
            <Pressable onPress={() => session.useSimulator()} style={({ pressed }) => [st.ghost, { opacity: pressed ? 0.7 : 1 }]}>
              <T size={14} weight="500">Simulator</T>
            </Pressable>
          </View>
          <Pressable onPress={() => setSheet(true)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: S.s4 }}>
            <T size={14} weight="500" color={C.t2}>{live} of 12 channels</T>
            <Feather name="chevron-up" size={18} color={C.t2} />
          </Pressable>
        </View>
      </Glass>

      <Sheet title="Channels" open={sheet} onClose={() => setSheet(false)}>
        {FINGERS.map((f) => (
          <View key={f} style={{ marginBottom: S.s4 }}>
            <Label style={{ marginBottom: 2 }}>{FINGER_LABEL[f]}</Label>
            {SEGMENTS.map((s, i) => {
              const on = frame.ok[f][s.key], v = frame.joints[f][s.key], over = Math.abs(v) > s.limit;
              return (
                <Row key={s.key} label={s.name} note={`${f}_${s.wire}`} last={i === SEGMENTS.length - 1}
                  value={<View style={{ flexDirection: 'row', alignItems: 'center', gap: S.s3 }}>
                    <View style={{ width: 56 }}><Bar value={v} max={s.limit} live={on} /></View>
                    <Num size={17} weight="400" color={!on ? C.t3 : over ? C.accent : C.t1} style={{ width: 60, textAlign: 'right' }}>
                      {on ? `${v.toFixed(1)}°` : 'absent'}
                    </Num>
                  </View>} />
              );
            })}
          </View>
        ))}
        <Label style={{ marginBottom: 2 }}>Rates</Label>
        {RATES.map((r, i) => (
          <Row key={r.what} icon={r.icon} label={r.what} note={r.note} last={i === RATES.length - 1}
            value={<Num size={15} weight="400">{r.rate}</Num>} />
        ))}
        <T size={11.5} color={C.t4} style={{ textAlign: 'center', marginTop: S.s6 }}>Research prototype. Not a medical device.</T>
      </Sheet>
    </View>
  );
}

const st = StyleSheet.create({
  float: { position: 'absolute', left: S.s5, right: S.s5 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: S.s2, marginTop: S.s4,
    backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: R.r2, paddingHorizontal: S.s4, height: 48,
    borderWidth: 1, borderColor: C.glassLine,
  },
  input: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 14, color: C.t1 },
  ghost: {
    paddingHorizontal: S.s5, height: 50, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.glassLineStrong, backgroundColor: C.glass,
  },
});
