// Chrome.tsx - the pieces every screen shares: the full-bleed stage, the
// floating header with its round glass buttons, and the bottom sheet that
// rises over the machine without taking the drag away from it.
import React, { useRef, useState } from 'react';
import { View, StyleSheet, Animated, Pressable, ScrollView, useWindowDimensions, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Twin } from '../twin/Twin';
import { T, Num, IconButton, Glass } from './primitives';
import { C, S, R } from './tokens';

export const NAV_H = 54;
export const NAV_GAP = 14;

/** The app mark: a white disc with the letter. */
export function Mark({ size = 44 }: { size?: number }) {
  return (
    <Glass radius={size / 2} style={{ width: size, height: size }}>
      <View style={[st.mark, { width: size, height: size }]}>
        <T size={Math.round(size * 0.38)} weight="600" color={C.t1} tracking={-0.5}>T</T>
      </View>
    </Glass>
  );
}

/** A round glass button with an optional count badge, as on a bell. */
export function BadgeButton({ icon, count, onPress }: { icon: any; count?: number; onPress?: () => void }) {
  return (
    <View>
      <IconButton icon={icon} size={40} onPress={onPress} />
      {!!count && (
        <View style={st.badge}><T size={10} weight="700" color={C.white}>{count}</T></View>
      )}
    </View>
  );
}

/**
 * The floating header: a round button each side, the title centred, and an
 * optional row of glass chips beneath. It draws no backdrop; the stage's
 * own top fade carries it.
 */
export function Header({ title, left, right, chips }: {
  title: string; left?: React.ReactNode; right?: React.ReactNode; chips?: React.ReactNode;
}) {
  const inset = useSafeAreaInsets();
  return (
    <View style={[st.header, { paddingTop: inset.top + S.s3 }]} pointerEvents="box-none">
      <View style={st.headerRow} pointerEvents="box-none">
        <View style={{ width: 40 }}>{left ?? <Mark size={40} />}</View>
        <T size={15} weight="500" style={{ flex: 1, textAlign: 'center' }}>{title}</T>
        <View style={{ width: 40, alignItems: 'flex-end' }}>{right}</View>
      </View>
      {chips && <View style={st.chips} pointerEvents="box-none">{chips}</View>}
    </View>
  );
}

/** A glass chip with an icon, a word and an optional chevron: a picker. */
export function GlassChip({ icon, label, onPress, chevron, tone = 'glass' }: {
  icon?: any; label: string; onPress?: () => void; chevron?: boolean; tone?: 'glass' | 'accent' | 'live';
}) {
  const fg = tone === 'accent' ? C.accent : tone === 'live' ? C.live : C.t1;
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}>
      <Glass radius={R.pill}>
        <View style={st.chip}>
          {icon && <Feather name={icon} size={13} color={fg} />}
          <T size={12.5} weight="500" color={fg}>{label}</T>
          {chevron && <Feather name="chevron-down" size={13} color={C.t2} style={{ marginLeft: 2 }} />}
        </View>
      </Glass>
    </Pressable>
  );
}

/** The machine, at full bleed behind everything, dimmed if asked. */
export function Backdrop({ dim = 0, lift = 0.0, scale = 1 }: { dim?: number; lift?: number; scale?: number }) {
  const { height } = useWindowDimensions();
  return (
    <View style={StyleSheet.absoluteFill}>
      <Twin style={[StyleSheet.absoluteFill, { top: -height * lift, bottom: height * lift }]} stage="dark" scale={scale} />
      <LinearGradient colors={['rgba(10,10,11,0.6)', 'rgba(10,10,11,0)']} style={st.fadeTop} pointerEvents="none" />
      <LinearGradient colors={['rgba(10,10,11,0)', 'rgba(10,10,11,0.75)']} style={st.fadeBot} pointerEvents="none" />
      {dim > 0 && <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(10,10,11,${dim})` }]} pointerEvents="none" />}
    </View>
  );
}

/**
 * The bottom sheet. It owns its own scroll, so the machine above it keeps
 * the drag. A tap on the handle toggles peek and open.
 */
export function Sheet({ children, open, onClose, share = 0.78, title, subtitle }: {
  children: React.ReactNode; open: boolean; onClose: () => void; share?: number; title?: string; subtitle?: string;
}) {
  const { height } = useWindowDimensions();
  const inset = useSafeAreaInsets();
  const y = useRef(new Animated.Value(open ? 0 : height)).current;
  const [mounted, setMounted] = useState(open);
  React.useEffect(() => {
    if (open) setMounted(true);
    Animated.spring(y, { toValue: open ? 0 : height, useNativeDriver: true, bounciness: 2, speed: 14 })
      .start(({ finished }) => { if (finished && !open) setMounted(false); });
  }, [open]);
  if (!mounted) return null;
  return (
    <Animated.View style={[st.sheet, { height: share * height, transform: [{ translateY: y }] }]}>
      <BlurView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: C.sheet }]} />
      <LinearGradient colors={['rgba(255,255,255,0.07)', 'rgba(255,255,255,0)']} locations={[0, 0.3]}
        style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View style={st.sheetLine} pointerEvents="none" />
      <Pressable onPress={onClose} style={st.handle} hitSlop={10}>
        <Feather name="chevron-down" size={18} color={C.t2} />
      </Pressable>
      {title && (
        <View style={st.sheetHead}>
          <T size={18} weight="400">{title}</T>
          {subtitle && <T size={12} color={C.t3} style={{ marginTop: 2 }}>{subtitle}</T>}
        </View>
      )}
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: S.s5, paddingBottom: NAV_H + NAV_GAP * 2 + inset.bottom }}>
        {children}
      </ScrollView>
    </Animated.View>
  );
}

/** A sheet row: icon, words, a value, and a chevron or a badge. */
export function Row({ icon, label, note, value, badge, tone, onPress, last }: {
  icon?: any; label: string; note?: string; value?: React.ReactNode; badge?: number;
  tone?: 'accent' | 'live'; onPress?: () => void; last?: boolean;
}) {
  const fg = tone === 'accent' ? C.accent : tone === 'live' ? C.live : C.t1;
  return (
    <Pressable onPress={onPress} disabled={!onPress}
      style={({ pressed }) => [st.row, !last && st.rowLine, { opacity: pressed ? 0.7 : 1 }]}>
      {icon && <View style={st.rowIcon}><Feather name={icon} size={14} color={C.t2} /></View>}
      <View style={{ flex: 1 }}>
        <T size={14} weight="400" color={fg}>{label}</T>
        {note && <T size={11.5} color={C.t3} style={{ marginTop: 1 }}>{note}</T>}
      </View>
      {!!badge && <View style={[st.badge, { position: 'relative', top: 0, right: 0 }]}><T size={10} weight="700" color={C.white}>{badge}</T></View>}
      {value}
      {onPress && <Feather name="chevron-right" size={18} color={C.t3} />}
    </Pressable>
  );
}

/** A big number standing on the stage, no card under it. */
export function StageNumber({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <View>
      <T size={12} weight="500" color={C.t2}>{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <Num size={46} weight="300" tracking={-1.8}>{value}</Num>
        {unit && <T size={17} weight="300" color={C.t2} style={{ marginLeft: 3 }}>{unit}</T>}
      </View>
      {note && <T size={12} color={C.t3} style={{ marginTop: -2 }}>{note}</T>}
    </View>
  );
}

/** Padding under scroll content so the floating nav never hides the last card. */
export function useBottomPad() {
  const inset = useSafeAreaInsets();
  return NAV_H + NAV_GAP * 2 + inset.bottom + S.s4;
}

const st = StyleSheet.create({
  mark: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: C.stop, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  header: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, paddingHorizontal: S.s5 },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: S.s3 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12 },
  fadeTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 200 },
  fadeBot: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 260 },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden',
    borderTopLeftRadius: R.r4, borderTopRightRadius: R.r4,
  },
  sheetLine: { position: 'absolute', top: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.28)' },
  handle: { alignItems: 'center', paddingTop: 10, paddingBottom: 2 },
  sheetHead: { paddingHorizontal: S.s5, paddingTop: S.s2, paddingBottom: S.s3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.s3, paddingVertical: 12 },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.glassLine },
  rowIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.glassStrong, alignItems: 'center', justifyContent: 'center' },
});
