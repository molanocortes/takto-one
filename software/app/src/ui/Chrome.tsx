// Chrome.tsx - the pieces every screen shares: the page, the top row, the
// three-tile control, the section header, and the tab bar.
import React from 'react';
import { View, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { M, T } from './primitives';
import { C, S, R } from './tokens';
import { useSession, type StatusKind } from '../data/session';

export const NAV_H = 47;

/** one colour per kind of source, used by every status mark in the app */
export const STATUS_COLOR: Record<StatusKind, string> = {
  live: C.green, sim: C.orange, replay: C.blue, offline: C.red,
};

/**
 * The source label and the menu, at the top of every screen. It reads the
 * session itself, so no screen can word it differently: LIVE is a real
 * device through a delivering bridge, SIMULATED is synthetic (in-app or a
 * bridge on --sim), REPLAY is a take, and anything else says what is wrong.
 */
export function TopRow({ onMenu, onStatus }: { onMenu?: () => void; onStatus?: () => void }) {
  const inset = useSafeAreaInsets();
  const s = useSession().status;
  return (
    <View style={[st.top, { marginTop: Math.max(inset.top, 47) + 18 }]}>
      <Pressable onPress={onStatus} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}
        accessibilityRole="button" accessibilityLabel={`Source: ${s.label}, ${s.detail}`}>
        <View style={[st.dot, { backgroundColor: STATUS_COLOR[s.kind] }]} />
        <M size={9.5} color={C.ink} weight="500">{s.label}</M>
        <M size={8.5} color={C.ink3} upper={false} style={{ flexShrink: 1 }}>{s.detail}</M>
      </Pressable>
      <Pressable onPress={onMenu} hitSlop={10}><Feather name="menu" size={18} color={C.ink} /></Pressable>
    </View>
  );
}

/** The session's last notice (an ack, a refusal), for a few seconds. */
export function NoticeBar() {
  const session = useSession();
  const n = session.notice;
  if (!n || Date.now() - n.at > 4500) return null;
  return (
    <View pointerEvents="none" style={[st.notice, { borderColor: n.tone === 'error' ? C.red : C.tileLine }]}>
      <Feather name={n.tone === 'error' ? 'alert-circle' : 'check-circle'} size={13} color={n.tone === 'error' ? C.red : C.green} />
      <T size={12.5} color={C.ink} style={{ flex: 1 }}>{n.text}</T>
    </View>
  );
}

/** A screen title in mono capitals, with a status line under it. */
export function Title({ children, status, spinning }: { children: string; status?: string; spinning?: boolean }) {
  return (
    <View style={{ marginTop: 18 }}>
      <M size={16.5} color={C.ink} tracking={2.4}>{children}</M>
      {status && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
          {spinning ? <MaterialCommunityIcons name="sync" size={13} color={C.ink2} /> : <Feather name="check-circle" size={12} color={C.ink2} />}
          <M size={9.5} color={C.ink2}>{status}</M>
        </View>
      )}
    </View>
  );
}

/** A section header: label left, an optional picker right. */
export function SectionHead({ label, right, onRight, style }: {
  label: string; right?: string; onRight?: () => void; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[st.sectionHead, style]}>
      <M size={9.5} color={C.ink} weight="500">{label}</M>
      {right && (
        <Pressable onPress={onRight} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }} hitSlop={8}>
          <M size={8.5} color={C.ink2}>{right}</M>
          {onRight ? <Feather name="chevron-down" size={11} color={C.ink2} /> : null}
        </Pressable>
      )}
    </View>
  );
}

export type TileIcon = { set: 'feather'; name: keyof typeof Feather.glyphMap } | { set: 'mci'; name: keyof typeof MaterialCommunityIcons.glyphMap } | { set: 'dot' } | { set: 'bars' };

function TileGlyph({ icon, color, size = 22 }: { icon: TileIcon; color: string; size?: number }) {
  if (icon.set === 'dot') return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />;
  if (icon.set === 'bars') return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2.5, height: 16 }}>
      {[5, 9, 15, 8, 4, 11, 6].map((h, i) => <View key={i} style={{ width: 2, height: h, borderRadius: 1, backgroundColor: color }} />)}
    </View>
  );
  if (icon.set === 'mci') return <MaterialCommunityIcons name={icon.name} size={size} color={color} />;
  return <Feather name={icon.name} size={size - 2} color={color} />;
}

/** Three tiles in a row, one selected. Used for the hand picker and the tab bar. */
export function Tiles<K extends string>({ items, value, onChange, height = 60, raised = false, labelSize = 9.5 }: {
  items: readonly { key: K; label: string; icon: TileIcon }[]; value: K; onChange: (k: K) => void;
  height?: number; raised?: boolean; labelSize?: number;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 3 }}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable key={it.key} onPress={() => onChange(it.key)} style={({ pressed }) => [
            st.tile, { height },
            on ? (raised ? st.tileRaised : st.tileOn) : null,
            { opacity: pressed ? 0.8 : 1 },
          ]}>
            <View style={{ height: height === NAV_H ? 14 : 24, alignItems: 'center', justifyContent: 'center' }}>
              <TileGlyph icon={it.icon} color={on ? C.ink : C.ink3} size={height === NAV_H ? 17 : 21} />
            </View>
            <M size={labelSize} color={on ? C.ink : C.ink3} style={{ marginTop: height === NAV_H ? 3 : 9 }}>{it.label}</M>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The tab bar at the foot of the page, above the home indicator. */
export function TabBar<K extends string>({ items, value, onChange }: {
  items: readonly { key: K; label: string; icon: TileIcon }[]; value: K; onChange: (k: K) => void;
}) {
  const inset = useSafeAreaInsets();
  return (
    <View style={[st.tabBar, { paddingBottom: Math.max(inset.bottom, 32) }]}>
      <Tiles items={items} value={value} onChange={onChange} height={NAV_H} raised labelSize={8} />
    </View>
  );
}

const st = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 20 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  notice: {
    position: 'absolute', left: S.gutter - 10, right: S.gutter - 10, bottom: 104, flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.white, borderRadius: R.r2, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 20 },
  tile: {
    flex: 1, backgroundColor: C.tile, borderRadius: R.r2, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'transparent',
  },
  tileOn: { backgroundColor: C.tileActive, borderColor: C.tileLine },
  tileRaised: {
    backgroundColor: C.white, borderColor: C.tileLine,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  tabBar: { paddingHorizontal: S.gutter, paddingTop: 8, backgroundColor: C.page },
});
