// primitives.tsx - the small set of shapes every screen is built from.
import React from 'react';
import {
  View, Text, Pressable, StyleSheet, Platform,
  type StyleProp, type ViewStyle, type TextStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { C, S, R, SHADOW, LIFT, fontFor } from './tokens';

type TW = TextStyle['fontWeight'];

/** Body and display type. Weight selects the Inter face on native. */
export function T({
  children, size = 15, weight = '400', color = C.t1, style, tracking, lineHeight, numberOfLines,
}: {
  children: React.ReactNode; size?: number; weight?: TW; color?: string;
  style?: StyleProp<TextStyle>; tracking?: number; lineHeight?: number; numberOfLines?: number;
}) {
  const auto = size >= 28 ? -size * 0.035 : size >= 18 ? -size * 0.02 : 0;
  return (
    <Text numberOfLines={numberOfLines} style={[{
      fontFamily: fontFor(weight),
      fontSize: size, color, letterSpacing: tracking ?? auto,
      lineHeight: lineHeight ?? Math.round(size * (size >= 28 ? 1.05 : 1.35)),
    }, style]}>{children}</Text>
  );
}

/** Every numeral goes through here: tabular, so columns and tickers hold still. */
export function Num({
  children, size = 15, weight = '600', color = C.t1, style, tracking,
}: {
  children: React.ReactNode; size?: number; weight?: TW; color?: string;
  style?: StyleProp<TextStyle>; tracking?: number;
}) {
  return (
    <T size={size} weight={weight} color={color} tracking={tracking ?? (size >= 28 ? -size * 0.04 : -0.2)}
      style={[{ fontVariant: ['tabular-nums'] }, style]}>{children}</T>
  );
}

/** Section label: small caps, wide tracking, quiet. */
export function Label({ children, color = C.t3, style }: {
  children: React.ReactNode; color?: string; style?: StyleProp<TextStyle>;
}) {
  return (
    <T size={11} weight="600" color={color} tracking={1.4} style={[{ textTransform: 'uppercase' }, style]}>
      {children}
    </T>
  );
}

/**
 * Liquid glass: a lens rather than a frosted pane. Backdrop blur, a faint
 * milk fill, a highlight that pools along the top edge as if light entered
 * there, a fainter one along the bottom where it leaves, a rim that is
 * brightest on the lit side, and a soft shadow that lifts it off the stage.
 * Every control in the app sits on this.
 */
export function Glass({ children, style, intensity = 50, radius = R.r3, strong = false, padded = false }: {
  children?: React.ReactNode; style?: StyleProp<ViewStyle>; intensity?: number;
  radius?: number; strong?: boolean; padded?: boolean;
}) {
  return (
    <View style={[st.liquidOuter, { borderRadius: radius }, style]}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]} pointerEvents="none">
        <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: strong ? C.glassStrong : C.glass }]} />
        {/* light entering at the top: a shallow pool, never a band */}
        <LinearGradient colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.02)', 'rgba(255,255,255,0)']}
          locations={[0, 0.4, 0.75]} style={StyleSheet.absoluteFill} />
        {/* the inner edge of the lens: a hair of shade just inside the rim */}
        <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: 'rgba(0,0,0,0.07)' }]} />
      </View>
      <View style={[st.liquidRim, { borderRadius: radius }]} pointerEvents="none" />
      <View style={[padded && { padding: S.s5 }]}>{children}</View>
    </View>
  );
}

/** A solid dark card, for lists that do not sit over the stage. */
export function Card({ children, style, padded = true, raised = false }: {
  children: React.ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean; raised?: boolean;
}) {
  return (
    <View style={[st.card, raised && { backgroundColor: C.cardRaised }, padded && { padding: S.s5 }, style]}>
      {children}
    </View>
  );
}

/** A small rounded chip: an icon and a word, as in a spec row. */
export function Chip({ icon, children, tone = 'glass', style }: {
  icon?: keyof typeof Feather.glyphMap; children: React.ReactNode;
  tone?: 'glass' | 'accent' | 'live' | 'white'; style?: StyleProp<ViewStyle>;
}) {
  const bg = tone === 'accent' ? C.accentSoft : tone === 'live' ? C.liveSoft : tone === 'white' ? C.white : C.glassStrong;
  const fg = tone === 'accent' ? C.accent : tone === 'live' ? C.live : tone === 'white' ? C.ink : C.t2;
  return (
    <View style={[st.chip, { backgroundColor: bg }, style]}>
      {icon && <Feather name={icon} size={12} color={fg} />}
      <T size={12} weight="600" color={fg} tracking={0.2}>{children}</T>
    </View>
  );
}

/** Round icon button, glass or inverted. */
export function IconButton({ icon, onPress, size = 44, tone = 'glass', style, iconSize }: {
  icon: keyof typeof Feather.glyphMap; onPress?: () => void; size?: number;
  tone?: 'glass' | 'white' | 'accent' | 'ghost'; style?: StyleProp<ViewStyle>; iconSize?: number;
}) {
  const bg = tone === 'white' ? C.white : tone === 'accent' ? C.accent : tone === 'ghost' ? 'transparent' : C.glassStrong;
  const fg = tone === 'white' ? C.ink : tone === 'accent' ? C.white : C.t1;
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }, style]}>
      {tone === 'glass' ? (
        <Glass radius={size / 2} style={[st.iconBtn, { width: size, height: size }]}>
          <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Feather name={icon} size={iconSize ?? Math.round(size * 0.42)} color={fg} />
          </View>
        </Glass>
      ) : (
        <View style={[st.iconBtn, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg }]}>
          <Feather name={icon} size={iconSize ?? Math.round(size * 0.42)} color={fg} />
        </View>
      )}
    </Pressable>
  );
}

/** The primary control: a white pill with the arrow in its own black disc. */
export function PillButton({ label, onPress, icon = 'arrow-right', tone = 'white', style }: {
  label: string; onPress?: () => void; icon?: keyof typeof Feather.glyphMap;
  tone?: 'white' | 'accent' | 'glass'; style?: StyleProp<ViewStyle>;
}) {
  const bg = tone === 'white' ? C.white : tone === 'accent' ? C.accent : C.glassStrong;
  const fg = tone === 'glass' ? C.t1 : tone === 'accent' ? C.white : C.ink;
  const discBg = tone === 'white' ? C.ink : tone === 'accent' ? 'rgba(0,0,0,0.28)' : C.white;
  const discFg = tone === 'glass' ? C.ink : C.white;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [
      st.pill, { backgroundColor: bg, opacity: pressed ? 0.85 : 1 }, tone === 'glass' && st.iconBtnLine, style,
    ]}>
      <T size={16} weight="600" color={fg} tracking={-0.2} style={{ marginLeft: S.s2 }}>{label}</T>
      <View style={[st.pillDisc, { backgroundColor: discBg }]}>
        <Feather name={icon} size={17} color={discFg} />
      </View>
    </Pressable>
  );
}

/** A live dot with a soft halo. */
export function Dot({ tone = 'idle', size = 7 }: { tone?: 'live' | 'accent' | 'idle'; size?: number }) {
  const c = tone === 'live' ? C.live : tone === 'accent' ? C.accent : C.t3;
  return (
    <View style={{ width: size * 2.2, height: size * 2.2, alignItems: 'center', justifyContent: 'center' }}>
      {tone !== 'idle' && (
        <View style={{ position: 'absolute', width: size * 2.2, height: size * 2.2, borderRadius: size * 1.1,
          backgroundColor: c, opacity: 0.25 }} />
      )}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c }} />
    </View>
  );
}

export function Hairline({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: C.glassLine }, style]} />;
}

/** Segmented pills for a small set of choices. */
export function Segmented<K extends string>({ options, value, onChange, style }: {
  options: readonly { key: K; label: string }[]; value: K; onChange: (k: K) => void; style?: StyleProp<ViewStyle>;
}) {
  return (
    <Glass radius={R.pill} style={style}>
    <View style={st.seg}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} onPress={() => onChange(o.key)} style={[st.segItem, on && st.segOn]}>
            <T size={12.5} weight="600" color={on ? C.ink : C.t2}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
    </Glass>
  );
}

const st = StyleSheet.create({
  liquidOuter: { ...(LIFT as object) },
  liquidRim: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.30)', borderLeftColor: 'rgba(255,255,255,0.20)',
    borderRightColor: 'rgba(255,255,255,0.16)', borderBottomColor: 'rgba(255,255,255,0.12)',
    ...(Platform.OS === 'web' ? {
      borderWidth: 0,
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.13), inset 0 1px 0 rgba(255,255,255,0.20), inset 0 -0.5px 0 rgba(255,255,255,0.06)',
    } as any : {}),
  },
  card: { backgroundColor: C.card, borderRadius: R.r3, borderWidth: 1, borderColor: C.glassLine },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    paddingHorizontal: 10, height: 28, borderRadius: R.pill,
  },
  iconBtn: { alignItems: 'center', justifyContent: 'center' },
  iconBtnLine: { borderWidth: 1, borderColor: C.glassLineStrong },
  pill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    height: 60, borderRadius: R.pill, paddingLeft: S.s5, paddingRight: 6, ...(SHADOW as object),
  },
  pillDisc: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  seg: { flexDirection: 'row', padding: 3, gap: 2 },
  segItem: { flex: 1, height: 32, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.white },
});
