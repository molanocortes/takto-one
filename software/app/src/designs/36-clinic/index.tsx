// 36-clinic - a medical device.
//
// White, pale blue, navy text, one calm blue and one amber that means
// "outside the band". Large sober tabs at the foot with a line icon and a
// word, 56pt touch targets, 8pt radii, vitals in tiles like a patient
// monitor, and an arc gauge with a normal band for every one of the twelve
// joints. Source Sans 3 throughout.
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Line, Polyline, Rect } from 'react-native-svg';
import { SourceSans3_400Regular } from '@expo-google-fonts/source-sans-3/400Regular';
import { SourceSans3_600SemiBold } from '@expo-google-fonts/source-sans-3/600SemiBold';
import { SourceSans3_700Bold } from '@expo-google-fonts/source-sans-3/700Bold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin, BG } from './twin';

const C = {
  white: '#FFFFFF', pale: BG, pale2: '#DCE7F2', navy: '#0F2235', navy2: '#4A6078', navy3: '#8A9BAE', line: '#D5DFEA',
  blue: '#1F6FB2', blueSoft: '#E3EEF9', amber: '#D97706', amberSoft: '#FEF3E2', green: '#15803D', greenSoft: '#E6F4EC',
};
const F = { ui: 'SourceSans3_400Regular', semi: 'SourceSans3_600SemiBold', bold: 'SourceSans3_700Bold' };

function T({ children, size = 15, weight = 'ui', color = C.navy, style, align, caps }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; style?: StyleProp<TextStyle>; align?: 'left' | 'center' | 'right'; caps?: boolean;
}) {
  return <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: Math.round(size * 1.3), fontVariant: ['tabular-nums'], textAlign: align, letterSpacing: caps ? 0.8 : 0, textTransform: caps ? 'uppercase' : 'none' }, style]}>{children}</Text>;
}

/** A status chip: dot, word, tinted ground. */
function Chip({ label, tone }: { label: string; tone: 'amber' | 'green' | 'blue' | 'grey' }) {
  const bg = tone === 'amber' ? C.amberSoft : tone === 'green' ? C.greenSoft : tone === 'blue' ? C.blueSoft : C.pale;
  const fg = tone === 'amber' ? C.amber : tone === 'green' ? C.green : tone === 'blue' ? C.blue : C.navy2;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: bg, paddingHorizontal: 10, height: 26, borderRadius: 6 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: fg }} />
      <T size={12} weight="semi" color={fg} caps>{label}</T>
    </View>
  );
}

/** The button: 52pt, 8pt radius, solid blue or outlined navy. Pressed darkens. */
function Button({ label, onPress, kind = 'primary', style, icon }: { label: string; onPress?: () => void; kind?: 'primary' | 'secondary' | 'quiet'; style?: StyleProp<ViewStyle>; icon?: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.btn, kind === 'primary' && { backgroundColor: pressed ? '#175A91' : C.blue }, kind === 'secondary' && { borderWidth: 1.5, borderColor: pressed ? C.navy : C.line, backgroundColor: pressed ? C.pale : C.white }, kind === 'quiet' && { backgroundColor: pressed ? C.pale2 : C.pale }, style]}>
      {icon}
      <T size={16} weight="semi" color={kind === 'primary' ? C.white : C.navy}>{label}</T>
    </Pressable>
  );
}

/** A line icon, drawn. */
function Icon({ kind, color = C.navy, size = 22 }: { kind: 'pulse' | 'play' | 'pause' | 'data' | 'start' | 'end' | 'eject' | 'link'; color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {kind === 'pulse' && <Polyline points="2,12 7,12 10,5 14,19 17,12 22,12" stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />}
      {kind === 'play' && <Path d="M7 4 L19 12 L7 20 Z" stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" />}
      {kind === 'pause' && <><Rect x={6} y={4} width={4} height={16} rx={1} stroke={color} strokeWidth={2} fill="none" /><Rect x={14} y={4} width={4} height={16} rx={1} stroke={color} strokeWidth={2} fill="none" /></>}
      {kind === 'data' && <><Rect x={3} y={12} width={4} height={9} rx={1} stroke={color} strokeWidth={2} fill="none" /><Rect x={10} y={6} width={4} height={15} rx={1} stroke={color} strokeWidth={2} fill="none" /><Rect x={17} y={3} width={4} height={18} rx={1} stroke={color} strokeWidth={2} fill="none" /></>}
      {kind === 'start' && <><Line x1={5} y1={5} x2={5} y2={19} stroke={color} strokeWidth={2} strokeLinecap="round" /><Path d="M19 5 L9 12 L19 19 Z" stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" /></>}
      {kind === 'end' && <><Line x1={19} y1={5} x2={19} y2={19} stroke={color} strokeWidth={2} strokeLinecap="round" /><Path d="M5 5 L15 12 L5 19 Z" stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" /></>}
      {kind === 'eject' && <><Path d="M4 14 L12 5 L20 14 Z" stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" /><Line x1={4} y1={19} x2={20} y2={19} stroke={color} strokeWidth={2} strokeLinecap="round" /></>}
      {kind === 'link' && <Path d="M10 14 L14 10 M8 16 a3 3 0 0 1 0 -4.2 l3 -3 a3 3 0 0 1 4.2 4.2 M16 8 a3 3 0 0 1 0 4.2 l-3 3 a3 3 0 0 1 -4.2 -4.2" stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" />}
    </Svg>
  );
}

/** A vital tile, as on a monitor: label, big number, unit, a tint when outside the band. */
function Vital({ label, value, unit, hot, style }: { label: string; value: string; unit?: string; hot?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[st.vital, hot && { backgroundColor: C.amberSoft, borderColor: '#F3D9AE' }, style]}>
      <T size={11} weight="semi" color={C.navy2} caps>{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
        <T size={30} weight="bold" color={hot ? C.amber : C.navy}>{value}</T>
        {unit && <T size={13} color={C.navy2}>{unit}</T>}
      </View>
    </View>
  );
}

/** An arc gauge with a normal band: 0 to max over 220 degrees, the last 10 percent amber. */
function Arc({ value, max, signed, absent, size = 82 }: { value: number; max: number; signed?: boolean; absent?: boolean; size?: number }) {
  const r = size / 2 - 7, cx = size / 2, cy = size / 2 + 4;
  const a0 = -200, a1 = 20;
  const frac = signed ? (Math.max(-max, Math.min(max, value)) + max) / (2 * max) : Math.max(0, Math.min(1, value / max));
  const p = (a: number, rr = r) => [cx + rr * Math.cos((a * Math.PI) / 180), cy + rr * Math.sin((a * Math.PI) / 180)];
  const arc = (from: number, to: number) => { const [x0, y0] = p(from), [x1, y1] = p(to); return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
  const av = a0 + (a1 - a0) * frac;
  const hot = signed ? Math.abs(value) > max * 0.9 : frac > 0.9;
  const band = signed ? [[a0, a0 + (a1 - a0) * 0.05], [a1 - (a1 - a0) * 0.05, a1]] : [[a1 - (a1 - a0) * 0.1, a1]];
  return (
    <Svg width={size} height={size}>
      <Path d={arc(a0, a1)} stroke={C.line} strokeWidth={7} fill="none" strokeLinecap="round" />
      {band.map(([b0, b1], i) => <Path key={i} d={arc(b0, b1)} stroke="#F3D9AE" strokeWidth={7} fill="none" strokeLinecap="round" />)}
      {!absent && frac > 0.005 && <Path d={arc(a0, av)} stroke={hot ? C.amber : C.blue} strokeWidth={7} fill="none" strokeLinecap="round" />}
      {signed && <Line x1={p(-90, r - 6)[0]} y1={p(-90, r - 6)[1]} x2={p(-90, r + 6)[0]} y2={p(-90, r + 6)[1]} stroke={C.navy3} strokeWidth={1.5} />}
    </Svg>
  );
}

/** A horizontal bar with a band. */
function Bar({ frac, absent }: { frac: number; absent?: boolean }) {
  const v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ height: 10, borderRadius: 5, backgroundColor: C.line, overflow: 'hidden' }}>
      <View style={{ position: 'absolute', right: 0, width: '18%', height: 10, backgroundColor: '#F3D9AE' }} />
      {!absent && <View style={{ width: `${v * 100}%`, height: 10, borderRadius: 5, backgroundColor: v > 0.82 ? C.amber : C.blue }} />}
    </View>
  );
}

function Trend({ values, width, height, played, hot }: { values: number[]; width: number; height: number; played?: number; hot?: boolean }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 2 - Math.max(0, Math.min(1, v)) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      {[0.5].map((k) => <Line key={k} x1={0} x2={width} y1={height * (1 - k)} y2={height * (1 - k)} stroke={C.line} strokeWidth={1} strokeDasharray="3 4" />)}
      {n > 1 && <Polyline points={pts} stroke={hot ? C.amber : C.blue} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill="rgba(31,111,178,0.10)" /><Line x1={played * width} x2={played * width} y1={0} y2={height} stroke={C.blue} strokeWidth={2} /></>}
    </Svg>
  );
}

/* ---------- frame ---------- */

const TABS: { key: ScreenKey; label: string; icon: 'pulse' | 'play' | 'data' }[] = [
  { key: 'live', label: 'Live', icon: 'pulse' }, { key: 'replay', label: 'Replay', icon: 'play' }, { key: 'data', label: 'Data', icon: 'data' },
];

function Frame({ screen, onScreen, children, share = 0.4, title }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; share?: number; title: string }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.white }}>
      <View style={[st.bar, { paddingTop: inset.top + 8 }]}>
        <T size={20} weight="bold">{title}</T>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Chip label={feed.word} tone={feed.live ? 'green' : 'amber'} />
          <Chip label={`${st_.liveJoints}/12`} tone={st_.liveJoints === 12 ? 'blue' : 'amber'} />
        </View>
      </View>
      <View style={[st.stage, { height: height * share }]}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
      </View>
      <View style={{ flex: 1 }}>{children}</View>
      <View style={[st.tabs, { paddingBottom: inset.bottom + 6 }]}>
        {TABS.map((t) => {
          const on = t.key === screen;
          return (
            <Pressable key={t.key} onPress={() => onScreen(t.key)} style={({ pressed }) => [st.tab, on && st.tabOn, pressed && { backgroundColor: C.pale2 }]}>
              <Icon kind={t.icon} color={on ? C.blue : C.navy2} />
              <T size={12} weight="semi" color={on ? C.blue : C.navy2}>{t.label}</T>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* ---------- screens ---------- */

function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  return (
    <View style={{ flex: 1, backgroundColor: C.white, paddingTop: inset.top }}>
      <View style={[st.stage, { height: height * 0.52, marginTop: 12 }]}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', top: 12, left: 12 }}><Chip label={feed.word} tone="amber" /></View>
      </View>
      <View style={{ paddingHorizontal: 20, paddingTop: 22, flex: 1 }}>
        <T size={12} weight="semi" color={C.navy2} caps>Companion · research prototype</T>
        <T size={32} weight="bold" style={{ marginTop: 4 }}>TAKTO ONE</T>
        <T size={16} color={C.navy2} style={{ marginTop: 6, maxWidth: 320 }}>Every joint of the hand, live from the device or from a recorded session. Twelve joints, one effort channel.</T>
        <View style={{ flex: 1 }} />
        <Button label="Start session" onPress={onStart} />
        <Button label="Connect a device" kind="secondary" onPress={onConnect} style={{ marginTop: 10 }} icon={<Icon kind="link" size={18} />} />
        <T size={12} color={C.navy3} align="center" style={{ marginTop: 14, marginBottom: inset.bottom + 14 }}>Not a medical device. The feed is synthetic: no hand wore the device.</T>
      </View>
    </View>
  );
}

function Live({ detail, onScreen }: { detail: boolean; onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const [all, setAll] = useState(detail);
  const hist = useRef(new History(60)).current;
  hist.push(st_.emg);
  const { width } = useWindowDimensions();
  return (
    <Frame screen="live" onScreen={onScreen} title="Live" share={all ? 0.3 : 0.38}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Vital label="Mean flexion" value={st_.mean.toFixed(0)} unit="°" hot={st_.mean > 90} style={{ flex: 1.1 }} />
          <Vital label="Effort" value={st_.emg < 0 ? '–' : st_.emg.toFixed(2)} hot={st_.emg > 0.8} style={{ flex: 1 }} />
          <Vital label="Peak" value={st_.peak.toFixed(0)} unit={FINGER_NAME[st_.peakFinger].slice(0, 3)} style={{ flex: 1 }} />
        </View>
        {!all ? (
          <>
            <View style={{ marginTop: 14, gap: 10 }}>
              {FINGERS.map((f) => {
                const live = frame.ok[f].mcp || frame.ok[f].pip;
                return (
                  <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <T size={14} weight="semi" style={{ width: 58 }}>{FINGER_NAME[f]}</T>
                    <View style={{ flex: 1 }}><Bar frac={st_.curl[f]} absent={!live} /></View>
                    <T size={14} weight="semi" color={live ? C.navy : C.navy3} style={{ width: 40, textAlign: 'right' }}>{live ? `${(st_.curl[f] * 100).toFixed(0)}%` : '–'}</T>
                  </View>
                );
              })}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 14 }}>
              <View style={{ flex: 1 }}>
                <T size={11} weight="semi" color={C.navy2} caps>Effort trend · {st_.blendWord}</T>
                <View style={{ marginTop: 4 }}><Trend values={hist.values} width={width - 32 - 132} height={44} hot={st_.emg > 0.8} /></View>
              </View>
              <Button label="All joints" kind="quiet" onPress={() => setAll(true)} style={{ height: 44, paddingHorizontal: 14 }} />
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
              <T size={11} weight="semi" color={C.navy2} caps>Twelve joints · amber band = outside range</T>
              <Button label="Summary" kind="quiet" onPress={() => setAll(false)} style={{ height: 36, paddingHorizontal: 12 }} />
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, borderTopWidth: 1, borderColor: C.line, paddingTop: 6 }}>
                <T size={13} weight="semi" style={{ width: 54 }}>{FINGER_NAME[f]}</T>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return (
                    <View key={j.key} style={{ flex: 1, alignItems: 'center' }}>
                      <Arc value={v} max={j.max} signed={j.signed} absent={!on} size={74} />
                      <T size={15} weight="bold" color={!on ? C.navy3 : Math.abs(v) > j.max * 0.9 ? C.amber : C.navy} style={{ marginTop: -14 }}>{fmtDeg(v, on, j.signed)}</T>
                      <T size={10} color={C.navy3}>{j.short}</T>
                    </View>
                  );
                })}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </Frame>
  );
}

function Replay({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const play = s.play;
  const takes = useMemo(bundledTakes, []);
  const { width } = useWindowDimensions();
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 100) : []), [play?.take.id]);
  return (
    <Frame screen="replay" onScreen={onScreen} title={play ? play.take.title : 'Replay'} share={0.38}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            <T size={11} weight="semi" color={C.navy2} caps>Recorded sessions · choreographed samples</T>
            {takes.map((t) => (
              <View key={t.id} style={st.card}>
                <View style={{ flex: 1 }}>
                  <T size={16} weight="semi">{t.title}</T>
                  <T size={13} color={C.navy2}>{t.note}</T>
                  <T size={12} color={C.navy3} style={{ marginTop: 2 }}>{t.durationS.toFixed(0)} s · {t.frames.length} frames</T>
                </View>
                <Pressable onPress={() => s.setTake(t)} style={({ pressed }) => [st.round, pressed && { backgroundColor: '#175A91' }]}><Icon kind="play" color={C.white} size={20} /></Pressable>
              </View>
            ))}
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Vital label="Elapsed" value={clock(play.t)} style={{ flex: 1.2 }} />
              <Vital label="Duration" value={clock(play.take.durationS)} style={{ flex: 1 }} />
              <Vital label="Speed" value={`${play.speed}×`} style={{ flex: 0.8 }} />
            </View>
            <T size={11} weight="semi" color={C.navy2} caps style={{ marginTop: 14 }}>Effort over the session · drag to seek</T>
            <View style={{ marginTop: 4 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <Trend values={trace} width={width - 32} height={56} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <Pressable onPress={() => s.seek(0)} style={({ pressed }) => [st.round, st.roundQuiet, pressed && { backgroundColor: C.pale2 }]}><Icon kind="start" size={20} /></Pressable>
              <Pressable onPress={() => s.togglePlay()} style={({ pressed }) => [st.round, { width: 60, height: 60, borderRadius: 30 }, pressed && { backgroundColor: '#175A91' }]}><Icon kind={play.playing ? 'pause' : 'play'} color={C.white} size={26} /></Pressable>
              <Pressable onPress={() => s.seek(play.take.durationS)} style={({ pressed }) => [st.round, st.roundQuiet, pressed && { backgroundColor: C.pale2 }]}><Icon kind="end" size={20} /></Pressable>
              <View style={{ flex: 1 }} />
              <View style={st.seg}>
                {[0.5, 1, 2].map((k) => (
                  <Pressable key={k} onPress={() => s.setSpeed(k)} style={[st.segItem, play.speed === k && st.segOn]}><T size={13} weight="semi" color={play.speed === k ? C.white : C.navy}>{k}×</T></Pressable>
                ))}
              </View>
              <Pressable onPress={() => s.setTake(null)} style={({ pressed }) => [st.round, st.roundQuiet, pressed && { backgroundColor: C.pale2 }]}><Icon kind="eject" size={20} /></Pressable>
            </View>
            <T size={12} color={C.navy3} style={{ marginTop: 12 }}>Sample takes write anatomical abduction into the MCP column; the twin clamps it at 16°.</T>
          </>
        )}
      </ScrollView>
    </Frame>
  );
}

function Data({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const feed = feedWord(s);
  return (
    <Frame screen="data" onScreen={onScreen} title="Data" share={0.26}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12 }} showsVerticalScrollIndicator={false}>
        <T size={11} weight="semi" color={C.navy2} caps>Device connection</T>
        <T size={13} color={C.navy2} style={{ marginTop: 2 }}>{feed.word} · {feed.detail}</T>
        <T size={12} weight="semi" color={C.navy2} style={{ marginTop: 10 }}>Bridge address</T>
        <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.navy3} />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <Button label="Connect" onPress={() => s.connect(url)} style={{ flex: 1, height: 46 }} />
          <Button label="Use simulator" kind="secondary" onPress={() => s.useSimulator()} style={{ flex: 1, height: 46 }} />
        </View>
        <T size={11} weight="semi" color={C.navy2} caps style={{ marginTop: 18 }}>Channels</T>
        <View style={st.table}>
          <View style={[st.tr, { backgroundColor: C.pale }]}>
            <T size={11} weight="semi" color={C.navy2} style={{ flex: 1.2 }}>Wire</T><T size={11} weight="semi" color={C.navy2} style={{ flex: 1.6 }}>Measures</T><T size={11} weight="semi" color={C.navy2} style={{ flex: 0.8, textAlign: 'right' }}>Reading</T><T size={11} weight="semi" color={C.navy2} style={{ flex: 0.7, textAlign: 'right' }}>Status</T>
          </View>
          {FINGERS.flatMap((f) => JOINTS.map((j, i) => {
            const v = frame.joints[f][j.key], on = frame.ok[f][j.key], over = Math.abs(v) > j.max;
            return (
              <View key={f + j.key} style={[st.tr, i === 2 && { borderBottomColor: C.navy3 }]}>
                <T size={12} color={C.navy2} style={{ flex: 1.2 }}>{f}_{j.wire}</T>
                <T size={13} style={{ flex: 1.6 }}>{FINGER_NAME[f]} {j.name}</T>
                <T size={13} weight="semi" color={!on ? C.navy3 : over ? C.amber : C.navy} style={{ flex: 0.8, textAlign: 'right' }}>{on ? `${v.toFixed(1)}°` : '–'}</T>
                <T size={11} weight="semi" color={!on ? C.amber : over ? C.amber : C.green} style={{ flex: 0.7, textAlign: 'right' }}>{!on ? 'ABSENT' : over ? 'OVER' : 'OK'}</T>
              </View>
            );
          }))}
        </View>
        <T size={11} weight="semi" color={C.navy2} caps style={{ marginTop: 18 }}>Rates</T>
        <View style={st.table}>
          {RATES.map((r) => (
            <View key={r.what} style={st.tr}>
              <T size={13} weight="semi" style={{ flex: 1.2 }}>{r.what}</T>
              <T size={12} color={C.navy2} style={{ flex: 1.8 }}>{r.note}</T>
              <T size={13} weight="semi" style={{ flex: 0.7, textAlign: 'right' }}>{r.rate}</T>
            </View>
          ))}
        </View>
        <T size={12} color={C.navy3} style={{ marginTop: 14 }}>Research prototype. Not a medical device.</T>
      </ScrollView>
    </Frame>
  );
}

function Shell({ initialScreen, detail }: DesignProps) {
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  if (screen === 'welcome') return <Welcome onStart={() => setScreen('live')} onConnect={() => setScreen('data')} />;
  if (screen === 'live') return <Live detail={detail} onScreen={setScreen} />;
  if (screen === 'replay') return <Replay onScreen={setScreen} />;
  return <Data onScreen={setScreen} />;
}

const st = StyleSheet.create({
  bar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10 },
  stage: { marginHorizontal: 12, borderRadius: 12, backgroundColor: BG, overflow: 'hidden', borderWidth: 1, borderColor: C.line },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.white, paddingTop: 6, paddingHorizontal: 8 },
  tab: { flex: 1, height: 56, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabOn: { backgroundColor: C.blueSoft },
  btn: { height: 54, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18 },
  vital: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.white },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center' },
  roundQuiet: { backgroundColor: C.pale },
  seg: { flexDirection: 'row', backgroundColor: C.pale, borderRadius: 8, padding: 3 },
  segItem: { paddingHorizontal: 10, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.blue },
  input: { height: 48, borderRadius: 8, borderWidth: 1.5, borderColor: C.line, paddingHorizontal: 12, fontFamily: 'SourceSans3_400Regular', fontSize: 16, color: C.navy, marginTop: 4, backgroundColor: C.white },
  table: { borderWidth: 1, borderColor: C.line, borderRadius: 8, overflow: 'hidden', marginTop: 6 },
  tr: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line, gap: 6 },
});

export const design: Design = {
  id: '36', slug: 'clinic', name: 'Clinic',
  thesis: 'A medical device: porcelain on pale blue, vitals in tiles, an arc gauge with a normal band for every joint, and large sober tabs you cannot miss.',
  fonts: { SourceSans3_400Regular, SourceSans3_600SemiBold, SourceSans3_700Bold },
  bg: '#FFFFFF', statusBar: 'dark-content', App: Shell,
};
