// TAKTO companion - a digital twin and instrument panel for TAKTO ONE.
//
// Six surfaces on one data path: Home (the machine at a glance), Twin (the
// device on the arm, in space or hand only), Record (start/stop, the SD card,
// the neutral calibration), Takes (the bridge's library, the SD card, the demo
// takes, replay), Data (the twelve joints and activation as traces) and Link
// (the bridge address and how to reach it). Everything also runs with no
// hardware attached, on a synthetic feed that is always labelled SIMULATED.
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
import { Link } from './src/screens/Link';
import { TwinScreen } from './src/screens/TwinScreen';
import { Record } from './src/screens/Record';
import { Takes } from './src/screens/Takes';
import { TabBar, NoticeBar, type TileIcon } from './src/ui/Chrome';
import { C } from './src/ui/tokens';
import { session } from './src/data/session';
import { bundledTakes } from './src/data/takes';

type Tab = 'overview' | 'twin' | 'record' | 'takes' | 'analytics' | 'link';
const TABS: { key: Tab; label: string; icon: TileIcon }[] = [
  { key: 'overview', label: 'Home', icon: { set: 'dot' } },
  { key: 'twin', label: 'Twin', icon: { set: 'mci', name: 'hand-back-right-outline' } },
  { key: 'record', label: 'Record', icon: { set: 'mci', name: 'record-circle-outline' } },
  { key: 'takes', label: 'Takes', icon: { set: 'feather', name: 'film' } },
  { key: 'analytics', label: 'Data', icon: { set: 'feather', name: 'bar-chart-2' } },
  { key: 'link', label: 'Link', icon: { set: 'feather', name: 'link' } },
];
// old capture URLs used ?screen=logs
const ALIAS: Record<string, Tab> = { logs: 'link' };

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
  const toLink = () => setTab('link');
  useEffect(() => {
    // Deterministic capture, web only: ?screen= pins the tab, ?t= the clock,
    // ?take= opens a bundled session. Used by tools/capture.mjs.
    if (Platform.OS === 'web' && typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const raw = q.get('screen');
      const scr = raw ? (ALIAS[raw] ?? raw) as Tab : null;
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
      {tab === 'overview' && <Overview onMenu={toLink} onStatus={toLink} />}
      {tab === 'twin' && <TwinScreen onMenu={toLink} onStatus={toLink} />}
      {tab === 'record' && <Record onMenu={toLink} onStatus={toLink} onLink={toLink} />}
      {tab === 'takes' && <Takes onMenu={toLink} onStatus={toLink} onTwin={() => setTab('twin')} />}
      {tab === 'analytics' && <Analytics onMenu={toLink} onStatus={toLink} />}
      {tab === 'link' && <Link onMenu={() => setTab('overview')} onStatus={() => setTab('overview')} />}
      <NoticeBar />
      <TabBar items={TABS} value={tab} onChange={setTab} />
    </View>
  );
}
