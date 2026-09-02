// TAKTO companion - a digital twin and instrument panel for TAKTO ONE.
//
// Three surfaces, one data path, and the same articulated CAD the operator
// console renders: Live (the device now), Replay (a recorded session played
// back into the same twin) and Data (the channels, and where they come from).
// Everything runs with no hardware attached, on a synthetic feed that says so.
import React, { useEffect, useState } from 'react';
import { View, Pressable, StyleSheet, StatusBar, Platform } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
// per-weight entry points, so the bundle carries four faces and not eighteen
import { Inter_300Light } from '@expo-google-fonts/inter/300Light';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Feather } from '@expo/vector-icons';
import { Welcome } from './src/screens/Welcome';
import { Live } from './src/screens/Live';
import { Replay } from './src/screens/Replay';
import { Data } from './src/screens/Data';
import { Glass } from './src/ui/primitives';
import { NAV_H, NAV_GAP } from './src/ui/Chrome';
import { C, S, R } from './src/ui/tokens';
import { session } from './src/data/session';
import { bundledTakes } from './src/data/takes';

type Tab = 'live' | 'replay' | 'data';
type Screen = 'welcome' | Tab;
const TABS: { key: Tab; icon: keyof typeof Feather.glyphMap; label: string }[] = [
  { key: 'live', icon: 'activity', label: 'Live' },
  { key: 'replay', icon: 'play', label: 'Replay' },
  { key: 'data', icon: 'bar-chart-2', label: 'Data' },
];

export default function App() {
  const [ready] = useFonts({ Inter_300Light, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {ready ? <Shell /> : <View style={{ flex: 1, backgroundColor: C.bg }} />}
    </SafeAreaProvider>
  );
}

function Shell() {
  const [screen, setScreen] = useState<Screen>('welcome');

  useEffect(() => {
    // Deterministic capture, web only: ?screen=welcome|live|replay|data pins
    // the screen, ?t=<seconds> pins the clock, ?take=<id> opens a bundled
    // session. Used by tools/capture.mjs to render the media in docs/.
    if (Platform.OS === 'web' && typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const scr = q.get('screen') as Screen | null;
      if (scr && (scr === 'welcome' || TABS.some((t) => t.key === scr))) setScreen(scr);
      const takeId = q.get('take');
      if (takeId) {
        const found = bundledTakes().find((t) => t.id === takeId || t.title.toLowerCase() === takeId);
        if (found) session.setTake(found);
      }
      const t = q.get('t');
      if (t !== null && Number.isFinite(Number(t))) session.pin(Number(t));
    }
    session.start();
    return () => session.stop();
  }, []);

  if (screen === 'welcome') {
    return <Welcome onStart={() => setScreen('live')} onConnect={() => setScreen('data')} />;
  }
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {screen === 'live' && <Live onOpenData={() => setScreen('data')} />}
      {screen === 'replay' && <Replay />}
      {screen === 'data' && <Data />}
      <Nav tab={screen} onChange={setScreen} />
    </View>
  );
}

/** The floating nav: a glass pill, one disc per surface, the active one lit white. */
function Nav({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const inset = useSafeAreaInsets();
  return (
    <View style={[st.navWrap, { bottom: inset.bottom + NAV_GAP }]} pointerEvents="box-none">
      <Glass radius={R.pill} intensity={50} strong style={st.nav}>
        <View style={st.navRow}>
          {TABS.map((t) => {
            const on = t.key === tab;
            return (
              <Pressable key={t.key} onPress={() => onChange(t.key)} hitSlop={6}
                style={({ pressed }) => [st.navItem, on && st.navOn, { opacity: pressed ? 0.8 : 1 }]}>
                <Feather name={t.icon} size={17} color={on ? C.ink : C.t2} />
              </Pressable>
            );
          })}
        </View>
      </Glass>
    </View>
  );
}

const st = StyleSheet.create({
  navWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  nav: { height: NAV_H },
  navRow: { flexDirection: 'row', alignItems: 'center', height: NAV_H, paddingHorizontal: 6, gap: 4 },
  navItem: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  navOn: { backgroundColor: C.white },
});
