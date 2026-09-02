// primitives.tsx - the small set of shapes every screen is built from.
// Nothing here draws anything the design system has not already decided.
import React from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { C, F, S, R, SHADOW } from './tokens';

/** A section label: small, wide-tracked, quiet. Never a sentence. */
export function Label({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[st.label, style]}>{children}</Text>;
}

/** Every numeral in this app goes through here, so columns always align. */
export function Mono({
  children, size = 15, weight = '500', color = C.ink, style, tracking = 0,
}: {
  children: React.ReactNode; size?: number; weight?: TextStyle['fontWeight'];
  color?: string; style?: StyleProp<TextStyle>; tracking?: number;
}) {
  return (
    <Text style={[{ fontFamily: F.mono, fontSize: size, fontWeight: weight, color,
      letterSpacing: tracking, fontVariant: ['tabular-nums'] }, style]}>{children}</Text>
  );
}

export function UIText({
  children, size = 15, weight = '400', color = C.ink, style,
}: {
  children: React.ReactNode; size?: number; weight?: TextStyle['fontWeight'];
  color?: string; style?: StyleProp<TextStyle>;
}) {
  return <Text style={[{ fontFamily: F.ui, fontSize: size, fontWeight: weight, color }, style]}>{children}</Text>;
}

/** Raised paper. The stage variant is pure white and carries the machine. */
export function Card({ children, style, padded = true }: {
  children: React.ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean;
}) {
  return <View style={[st.card, padded && { padding: S.s4 }, style]}>{children}</View>;
}

export function Hairline({ inset = 0 }: { inset?: number }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: inset }} />;
}

/** iOS-style segmented control, flattened to the project's own language. */
export function Segmented<T extends string>({
  options, value, onChange,
}: { options: readonly { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={st.seg}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} onPress={() => onChange(o.key)}
            style={[st.segItem, on && st.segItemOn]}>
            <Text style={[st.segLabel, { color: on ? C.ink : C.ink2, fontWeight: on ? '600' : '500' }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A state dot. Accent means live; ink3 means simulated or idle. */
export function Dot({ on, color }: { on?: boolean; color?: string }) {
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color ?? (on ? C.accent : C.ink3) }} />;
}

const st = StyleSheet.create({
  label: {
    fontFamily: F.ui, fontSize: 11, fontWeight: '600', letterSpacing: 1.1,
    color: C.ink3, textTransform: 'uppercase',
  },
  card: { backgroundColor: C.card, borderRadius: R.r2, ...(SHADOW as object) },
  seg: {
    flexDirection: 'row', backgroundColor: C.paperSunk, borderRadius: R.r1,
    padding: 2, gap: 2,
  },
  segItem: { flex: 1, paddingVertical: 7, borderRadius: R.r1 - 2, alignItems: 'center' },
  segItemOn: { backgroundColor: C.card, ...(SHADOW as object) },
  segLabel: { fontFamily: F.ui, fontSize: 12.5, letterSpacing: 0.2 },
});
