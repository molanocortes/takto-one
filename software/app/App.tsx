// TAKTO companion - a digital twin and instrument panel for TAKTO ONE.
//
// Six surfaces on one data path: Home (the machine at a glance), Twin (the
// device on the arm, in space or hand only), Record (start/stop, the SD card,
// the neutral calibration), Takes (the bridge's library, the SD card, the demo
// takes, replay), Data (the twelve joints and activation as traces) and Link
// (the bridge address and how to reach it). Everything also runs with no
// hardware attached, on a synthetic feed that is always labelled SIMULATED.
import React, { useEffect, useRef, useState } from 'react';
import { View, Platform, BackHandler, Keyboard, type KeyboardEvent } from 'react-native';
import { StatusBar } from 'expo-status-bar';
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
import { SetupSheet, LinkBanner } from './src/ui/Setup';
import { C } from './src/ui/tokens';
import { session, useSession } from './src/data/session';
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
      {/* a light page: dark status-bar icons (edge-to-edge, the page draws behind the bar) */}
      <StatusBar style="dark" />
      {ready ? <Shell /> : <View style={{ flex: 1, backgroundColor: C.page }} />}
    </SafeAreaProvider>
  );
}

/**
 * The keyboard's height over the page, 0 when it is down. Android draws
 * edge-to-edge, so the window is not resized for the keyboard; iOS never
 * resizes. Either way the page pads itself by the part of the keyboard that
 * actually covers it (measured against the root view, so a platform that
 * did resize gets 0 and nothing is counted twice).
 */
function useKeyboard(rootH: React.MutableRefObject<number>) {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = (e: KeyboardEvent) => setH(Math.max(0, rootH.current - e.endCoordinates.screenY));
    const hide = () => setH(0);
    const a = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', show);
    const b = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', hide);
    return () => { a.remove(); b.remove(); };
  }, []);
  return h;
}

function Shell() {
  const [tab, setTabState] = useState<Tab>('overview');
  // the tabs visited, so the hardware back button retraces them before leaving
  const history = useRef<Tab[]>([]);
  const tabRef = useRef<Tab>('overview');
  const setTab = (t: Tab) => {
    if (t === tabRef.current) return;
    history.current = [...history.current.filter((x) => x !== tabRef.current), tabRef.current].slice(-8);
    tabRef.current = t;
    setTabState(t);
  };
  const toLink = () => setTab('link');
  const rootH = useRef(0);
  const kb = useKeyboard(rootH);
  const [barH, setBarH] = useState(96);
  const session = useSession();

  useEffect(() => {
    // Deterministic capture, web only: ?screen= pins the tab, ?t= the clock,
    // ?take= opens a bundled session. Used by tools/capture.mjs. ?bridge=
    // opens that bridge instead of the remembered one.
    let bridge: string | null = null;
    let capture = false;
    if (Platform.OS === 'web' && typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const raw = q.get('screen');
      const scr = raw ? (ALIAS[raw] ?? raw) as Tab : null;
      if (scr && TABS.some((t) => t.key === scr)) { tabRef.current = scr; setTabState(scr); }
      const takeId = q.get('take');
      if (takeId) { const f = bundledTakes().find((t) => t.id === takeId); if (f) session.setTake(f); }
      const t = q.get('t');
      if (t !== null && Number.isFinite(Number(t))) { session.pin(Number(t)); capture = true; }
      if (takeId) capture = true;
      bridge = q.get('bridge');
    }
    session.start({ bridge, noAuto: capture });
    return () => session.stop();
  }, []);

  // Android's back: close the guide, then retrace the tabs, then Home, and
  // only from Home leave the app (the system default)
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (Keyboard.isVisible()) { Keyboard.dismiss(); return true; }
      if (session.setupOpen) { session.closeSetup(); return true; }
      const prev = history.current.pop();
      if (prev && prev !== tabRef.current) { tabRef.current = prev; setTabState(prev); return true; }
      if (tabRef.current !== 'overview') { tabRef.current = 'overview'; setTabState('overview'); return true; }
      return false;
    });
    return () => sub.remove();
  }, []);

  const bannerBottom = barH + 8;
  const bannerOn = tab !== 'link' && session.source === 'bridge' && session.status.kind === 'offline' && session.conn.state !== 'paused';
  return (
    <View style={{ flex: 1, backgroundColor: C.page }} onLayout={(e) => { rootH.current = e.nativeEvent.layout.height; }}>
      <View style={{ flex: 1, paddingBottom: kb }}>
        {tab === 'overview' && <Overview onMenu={toLink} onStatus={toLink} />}
        {tab === 'twin' && <TwinScreen onMenu={toLink} onStatus={toLink} />}
        {tab === 'record' && <Record onMenu={toLink} onStatus={toLink} onLink={toLink} />}
        {tab === 'takes' && <Takes onMenu={toLink} onStatus={toLink} onTwin={() => setTab('twin')} />}
        {tab === 'analytics' && <Analytics onMenu={toLink} onStatus={toLink} />}
        {tab === 'link' && <Link onMenu={() => setTab('overview')} onStatus={() => setTab('overview')} />}
      </View>
      {/* the tab bar steps aside while typing, so the field keeps the room */}
      {kb === 0 && (
        <View onLayout={(e) => setBarH(e.nativeEvent.layout.height)}>
          <TabBar items={TABS} value={tab} onChange={setTab} />
        </View>
      )}
      {kb === 0 && tab !== 'link' && <LinkBanner onLink={toLink} bottom={bannerBottom} />}
      <NoticeBar bottom={kb ? kb + 12 : bannerOn ? bannerBottom + 62 : barH + 8} />
      {session.setupOpen && <SetupSheet keyboard={kb} onRecord={() => setTab('record')} />}
    </View>
  );
}
