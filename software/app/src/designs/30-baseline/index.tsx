// 30-baseline - the state the exploration inherited: one black stage, the
// hand alone in the midnight look, liquid glass chrome, Inter. Kept intact
// so judges can compare every later design against it.
import React, { useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Inter_300Light } from '@expo-google-fonts/inter/300Light';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Feather } from '@expo/vector-icons';
import { Welcome } from '../../screens/Welcome';
import { Live } from '../../screens/Live';
import { Replay } from '../../screens/Replay';
import { Data } from '../../screens/Data';
import { Glass } from '../../ui/primitives';
import { NAV_H, NAV_GAP } from '../../ui/Chrome';
import { C, R } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import type { ScreenKey } from '../shared';

type Tab = 'live' | 'replay' | 'data';
const TABS: { key: Tab; icon: keyof typeof Feather.glyphMap; label: string }[] = [
  { key: 'live', icon: 'activity', label: 'Live' },
  { key: 'replay', icon: 'play', label: 'Replay' },
  { key: 'data', icon: 'bar-chart-2', label: 'Data' },
];

function Shell({ initialScreen }: DesignProps) {
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
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

export const design: Design = {
  id: '30', slug: 'baseline', name: 'Midnight baseline',
  thesis: 'One black stage, the hand alone, liquid glass over it: the state designs 1 to 30 arrived at.',
  fonts: { Inter_300Light, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold },
  bg: C.bg, statusBar: 'light-content', App: Shell,
};
