// Welcome.tsx - the first screen: the machine, the name, one button.
import React from 'react';
import { View, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Twin } from '../twin/Twin';
import { T, Label, PillButton } from '../ui/primitives';
import { Mark, GlassChip } from '../ui/Chrome';
import { C, S } from '../ui/tokens';

export function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Twin style={[StyleSheet.absoluteFill, { top: -height * 0.14, bottom: height * 0.14 }]} stage="dark" scale={0.92} />
      <LinearGradient colors={['rgba(10,10,11,0.55)', 'rgba(10,10,11,0)']} style={st.top} pointerEvents="none" />
      <LinearGradient colors={['rgba(10,10,11,0)', 'rgba(10,10,11,0.92)', C.bg]} locations={[0, 0.55, 1]}
        style={st.bottom} pointerEvents="none" />

      <View style={[st.header, { paddingTop: inset.top + S.s3 }]} pointerEvents="none">
        <Mark size={40} />
        <GlassChip icon="cpu" label="Research prototype" />
      </View>

      <View style={[st.foot, { paddingBottom: inset.bottom + S.s6 }]}>
        <Label color={C.t2}>Welcome to</Label>
        <T size={34} weight="500" style={{ marginTop: 4 }}>TAKTO ONE</T>
        <T size={14} color={C.t2} lineHeight={21} style={{ marginTop: S.s2, maxWidth: 280 }}>
          Every joint of the hand, live from the device or from a recorded take.
        </T>
        <PillButton label="Start session" onPress={onStart} style={{ marginTop: S.s6 }} />
        <Pressable onPress={onConnect} style={{ alignSelf: 'center', marginTop: S.s5, padding: S.s2 }}>
          <T size={13} weight="500" color={C.t2}>Connect a device</T>
        </Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  top: { position: 'absolute', top: 0, left: 0, right: 0, height: 180 },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '58%' },
  header: {
    position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: S.s5,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  foot: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: S.s6 },
});
