// TAKTO companion - a digital twin and instrument panel for TAKTO ONE.
//
// Three surfaces, one data path, and the same articulated CAD the operator
// console renders: Live (the device now), Replay (a recorded session played
// back into the same twin) and Data (the channels, and where they come from).
// Everything runs with no hardware attached, on a synthetic feed that says so.
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Pressable, StyleSheet, StatusBar, useWindowDimensions, Platform,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Live } from './src/screens/Live';
import { Replay } from './src/screens/Replay';
import { Data } from './src/screens/Data';
import { Label, Mono, UIText, Dot } from './src/ui/primitives';
import { C, S, R, F } from './src/ui/tokens';
import { session, useSession } from './src/data/session';
import { bundledTakes } from './src/data/takes';

type Tab = 'live' | 'replay' | 'data';
const TABS: { key: Tab; label: string }[] = [
  { key: 'live', label: 'Live' },
  { key: 'replay', label: 'Replay' },
  { key: 'data', label: 'Data' },
];

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('live');
  const s = useSession();
  const { height } = useWindowDimensions();

  useEffect(() => {
    // Deterministic capture, web only: ?screen=live|replay|data pins the tab,
    // ?t=<seconds> pins the clock, ?take=<id> opens a bundled session. Used by
    // tools/capture.mjs to render the media in docs/ reproducibly.
    if (Platform.OS === 'web' && typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const scr = q.get('screen') as Tab | null;
      if (scr && TABS.some((t) => t.key === scr)) setTab(scr);
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

  // The stage takes a little over 40% of the screen: enough that the machine
  // is unmistakably the subject, not so much that the numbers fall below the
  // fold on a small phone.
  const stageHeight = Math.round(Math.max(280, Math.min(430, height * 0.44)));

  return (
    <SafeAreaView style={st.root} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={C.paper} />
      <View style={st.header}>
        <View>
          <Label style={{ fontSize: 10, letterSpacing: 1.6 }}>TAKTO ONE</Label>
          <UIText size={32} weight="700" style={{ marginTop: 2, letterSpacing: -0.6 }}>
            {TABS.find((t) => t.key === tab)!.label}
          </UIText>
        </View>
        <View style={{ flex: 1 }} />
        <View style={st.pill}>
          <Dot on={s.link.live} />
          <Mono size={10.5} weight="600" color={s.link.live ? C.accent : C.ink2} tracking={0.8}>
            {s.link.label}
          </Mono>
        </View>
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'live' && <Live stageHeight={stageHeight} />}
        {tab === 'replay' && <Replay stageHeight={stageHeight} />}
        {tab === 'data' && <Data />}
      </View>

      <View style={st.tabBar}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Pressable key={t.key} style={st.tab} onPress={() => setTab(t.key)}>
              <Glyph kind={t.key} on={on} />
              <UIText size={10.5} weight={on ? '700' : '500'} color={on ? C.ink : C.ink3}
                style={{ marginTop: 5, letterSpacing: 0.7 }}>
                {t.label.toUpperCase()}
              </UIText>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

/** Geometric glyphs, drawn from primitives. No icon font, nothing to load. */
function Glyph({ kind, on }: { kind: Tab; on: boolean }) {
  const c = on ? C.ink : C.ink3;
  if (kind === 'live') {
    return (
      <View style={[st.ring, { borderColor: c }]}>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: on ? C.accent : c }} />
      </View>
    );
  }
  if (kind === 'replay') {
    return (
      <View style={st.glyphBox}>
        <View style={{
          width: 0, height: 0, marginLeft: 2,
          borderTopWidth: 6, borderBottomWidth: 6, borderLeftWidth: 10,
          borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: c,
        }} />
      </View>
    );
  }
  return (
    <View style={[st.glyphBox, { justifyContent: 'center', gap: 2.5 }]}>
      {[14, 9, 12].map((w, i) => (
        <View key={i} style={{ width: w, height: 2, borderRadius: 1, backgroundColor: c }} />
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.paper },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: S.s4, paddingTop: S.s3, paddingBottom: S.s3,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: C.card, borderRadius: R.pill,
    paddingHorizontal: 11, paddingVertical: 7,
  },
  tabBar: {
    flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.line, backgroundColor: C.paper,
    paddingTop: 9, paddingBottom: Platform.OS === 'web' ? 12 : 4,
  },
  tab: { flex: 1, alignItems: 'center' },
  ring: {
    width: 16, height: 16, borderRadius: 8, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  glyphBox: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
});
