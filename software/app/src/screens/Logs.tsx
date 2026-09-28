// Logs.tsx - the source, the bundled sessions, and the rates: everything a
// person needs to know where the numbers come from.
import React, { useEffect, useMemo, useState } from 'react';
import { View, ScrollView, TextInput, Pressable, StyleSheet, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TopRow, Title, SectionHead } from '../ui/Chrome';
import { M, T, Num, Hairline } from '../ui/primitives';
import { C, S, R } from '../ui/tokens';
import { useSession } from '../data/session';
import { bundledTakes } from '../data/takes';

const RATES = [
  { what: 'This app', rate: '60 Hz', note: 'what you are watching' },
  { what: 'Firmware stream', rate: '50 Hz', note: 'the serial line default' },
  { what: 'Control loop', rate: '2 kHz', note: 'on the Teensy, next to the actuator' },
  { what: 'On-device capture', rate: 'unbound', note: 'the SD log is not tied to any of these' },
];

export function Logs({ onMenu }: { onMenu?: () => void }) {
  const session = useSession();
  const takes = useMemo(bundledTakes, []);
  // the field opens with the last address that was tried; on a phone the
  // Mac's LAN address is what is needed, and localhost would be the phone
  const [url, setUrl] = useState(session.savedUrl || (Platform.OS === 'web' ? 'ws://localhost:8765/ws' : ''));
  useEffect(() => { if (session.savedUrl && !url) setUrl(session.savedUrl); }, [session.savedUrl]);
  const play = session.play;
  // the picker on the right of Sessions steps through the bundled takes and back to none
  const nextTake = () => {
    const i = play ? takes.findIndex((t) => t.id === play.take.id) : -1;
    session.setTake(i + 1 < takes.length ? takes[i + 1] : null);
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <TopRow live={session.link.live || session.link.kind !== 'bridge'} label={session.link.live ? 'Live' : session.link.kind === 'sim' ? 'Live' : session.link.kind === 'take' ? 'Replay' : 'Idle'} onMenu={onMenu} />
        <Title status={session.link.detail}>Logs</Title>

        <SectionHead label="Source" right={session.link.label} onRight={() => (session.link.kind === 'bridge' ? session.useSimulator() : session.connect(url))} style={{ marginTop: 34 }} />
        <View style={st.inputRow}>
          <Feather name="link" size={14} color={C.ink3} />
          <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go"
            onSubmitEditing={() => session.connect(url)} placeholder="192.168.1.20  (the Mac running the bridge)" style={st.input} placeholderTextColor={C.ink3} />
        </View>
        <View style={{ flexDirection: 'row', gap: 3, marginTop: 8 }}>
          <Pressable onPress={() => session.connect(url)} style={[st.btn, st.btnOn]}><M size={10.5} color={C.white}>Connect</M></Pressable>
          <Pressable onPress={() => session.useSimulator()} style={st.btn}><M size={10.5} color={C.ink}>Simulator</M></Pressable>
        </View>

        <SectionHead label="Sessions" right={play ? play.take.title : 'Bundled'} onRight={nextTake} style={{ marginTop: 30 }} />
        <View style={{ marginTop: 6 }}>
          {takes.map((t, i) => {
            const on = play?.take.id === t.id;
            return (
              <View key={t.id}>
                {i > 0 && <Hairline />}
                <Pressable onPress={() => session.setTake(on ? null : t)} style={st.row}>
                  <Feather name={on ? 'pause' : 'play'} size={15} color={C.ink2} style={{ width: 26 }} />
                  <View style={{ flex: 1 }}>
                    <T size={14} color={C.ink}>{t.title}</T>
                    <T size={11.5} color={C.ink2} numberOfLines={1}>{t.note}</T>
                  </View>
                  <Num size={13} color={C.ink2}>{t.durationS.toFixed(0)}s</Num>
                </Pressable>
              </View>
            );
          })}
        </View>

        <SectionHead label="Rates" style={{ marginTop: 30 }} />
        <View style={{ marginTop: 6 }}>
          {RATES.map((r, i) => (
            <View key={r.what}>
              {i > 0 && <Hairline />}
              <View style={st.row}>
                <View style={{ flex: 1 }}>
                  <T size={14} color={C.ink}>{r.what}</T>
                  <T size={11.5} color={C.ink2}>{r.note}</T>
                </View>
                <Num size={13} color={C.ink}>{r.rate}</Num>
              </View>
            </View>
          ))}
        </View>
        <T size={11} color={C.ink3} style={{ textAlign: 'center', marginVertical: 24 }}>Research prototype. Not a medical device.</T>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingVertical: 6, gap: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, backgroundColor: C.tile, borderRadius: R.r2, borderWidth: 1, borderColor: C.tileLine, paddingHorizontal: 12, height: 42 },
  input: { flex: 1, fontFamily: 'JetBrainsMono_400Regular', fontSize: 12, color: C.ink },
  btn: { flex: 1, height: 40, borderRadius: R.r2, alignItems: 'center', justifyContent: 'center', backgroundColor: C.tile, borderWidth: 1, borderColor: C.tileLine },
  btnOn: { backgroundColor: C.ink, borderColor: C.ink },
});
