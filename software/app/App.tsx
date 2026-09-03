// TAKTO companion - a digital twin and instrument panel for TAKTO ONE.
//
// Three surfaces on one data path: Overview (the machine, its health and its
// housekeeping), Analytics (the twelve joints and the activation channel as
// traces) and Logs (sessions, the source, the rates). Everything runs with no
// hardware attached, on a synthetic feed.
import React, { useEffect, useState } from 'react';
import { View, StatusBar, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { Inter_300Light } from '@expo-google-fonts/inter/300Light';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import { Overview } from './src/screens/Overview';
import { Analytics } from './src/screens/Analytics';
import { Logs } from './src/screens/Logs';
import { TabBar, type TileIcon } from './src/ui/Chrome';
import { C } from './src/ui/tokens';
import { session } from './src/data/session';
import { bundledTakes } from './src/data/takes';

type Tab = 'overview' | 'analytics' | 'logs';
const TABS: { key: Tab; label: string; icon: TileIcon }[] = [
  { key: 'overview', label: 'Overview', icon: { set: 'dot' } },
  { key: 'analytics', label: 'Analytics', icon: { set: 'feather', name: 'bar-chart-2' } },
  { key: 'logs', label: 'Logs', icon: { set: 'feather', name: 'list' } },
];

export default function App() {
  const [ready] = useFonts({
    Inter_300Light, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
    JetBrainsMono_400Regular, JetBrainsMono_500Medium,
  });
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={C.page} />
      {ready ? <Shell /> : <View style={{ flex: 1, backgroundColor: C.page }} />}
    </SafeAreaProvider>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('overview');
  useEffect(() => {
    // Deterministic capture, web only: ?screen= pins the tab, ?t= the clock,
    // ?take= opens a bundled session. Used by tools/capture.mjs.
    if (Platform.OS === 'web' && typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const scr = q.get('screen') as Tab | null;
      if (scr && TABS.some((t) => t.key === scr)) setTab(scr);
      const takeId = q.get('take');
      if (takeId) { const f = bundledTakes().find((t) => t.id === takeId); if (f) session.setTake(f); }
      const t = q.get('t');
      if (t !== null && Number.isFinite(Number(t))) session.pin(Number(t));
    }
    session.start();
    return () => session.stop();
  }, []);
  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {tab === 'overview' && <Overview />}
      {tab === 'analytics' && <Analytics />}
      {tab === 'logs' && <Logs />}
      <TabBar items={TABS} value={tab} onChange={setTab} />
    </View>
  );
}
