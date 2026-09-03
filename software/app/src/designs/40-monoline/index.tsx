// 40-monoline - one line weight, one ink, white.
//
// Everything on the screen is drawn with the same 1.25pt line: the hand,
// the gauges, the controls, the navigation. The navigation is a single
// line across the top with three nodes; the current node is filled. Type
// is Manrope, light, with the numerals large and thin. Nothing is filled
// except a pressed control and the one node you are on.
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Line, Polyline, Rect, Polygon } from 'react-native-svg';
import { Manrope_300Light } from '@expo-google-fonts/manrope/300Light';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_500Medium } from '@expo-google-fonts/manrope/500Medium';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin, INK, PAGE } from './twin';

const W = 1.25;
const C = { page: PAGE, ink: INK, ink2: 'rgba(30,42,56,0.6)', ink3: 'rgba(30,42,56,0.35)', ink4: 'rgba(30,42,56,0.14)', mark: '#1E2A38' };
const F = { light: 'Manrope_300Light', ui: 'Manrope_400Regular', medium: 'Manrope_500Medium' };

function T({ children, size = 14, weight = 'ui', color = C.ink, style, caps, tracking, align, lh }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; style?: StyleProp<TextStyle>; caps?: boolean; tracking?: number; align?: 'left' | 'center' | 'right'; lh?: number;
}) {
  return <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: lh ?? Math.round(size * (size > 30 ? 1.05 : 1.4)), textTransform: caps ? 'uppercase' : 'none', letterSpacing: tracking ?? (caps ? size * 0.14 : size > 30 ? -size * 0.03 : 0), fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}
const Label = ({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => <T size={10} weight="medium" caps color={C.ink2} style={style}>{children}</T>;

/** An outlined pill. Pressed: filled. */
function Pill({ label, onPress, icon, on, style, big }: { label: string; onPress?: () => void; icon?: 'arrow' | 'link' | 'play' | 'pause' | 'start' | 'end' | 'eject'; on?: boolean; style?: StyleProp<ViewStyle>; big?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [st.pill, big && st.pillBig, (on || pressed) && { backgroundColor: C.ink }, style]}>
      {({ pressed }) => {
        const c = on || pressed ? C.page : C.ink;
        return (
          <>
            {icon && <Glyph kind={icon} color={c} />}
            <T size={big ? 15 : 13} weight="medium" color={c}>{label}</T>
          </>
        );
      }}
    </Pressable>
  );
}

function Glyph({ kind, color = C.ink, size = 14 }: { kind: 'arrow' | 'link' | 'play' | 'pause' | 'start' | 'end' | 'eject'; color?: string; size?: number }) {
  const s = { stroke: color, strokeWidth: W, fill: 'none' as const, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      {kind === 'arrow' && <Path d="M2 8 H14 M10 4 L14 8 L10 12" {...s} />}
      {kind === 'link' && <Path d="M6.5 9.5 L9.5 6.5 M5 11 a2.5 2.5 0 0 1 0 -3.5 l2 -2 a2.5 2.5 0 0 1 3.5 3.5 M11 5 a2.5 2.5 0 0 1 0 3.5 l-2 2 a2.5 2.5 0 0 1 -3.5 -3.5" {...s} />}
      {kind === 'play' && <Polygon points="4,2.5 13.5,8 4,13.5" {...s} />}
      {kind === 'pause' && <Path d="M5 3 V13 M11 3 V13" {...s} />}
      {kind === 'start' && <Path d="M3 3 V13 M13 3 L6 8 L13 13 Z" {...s} />}
      {kind === 'end' && <Path d="M13 3 V13 M3 3 L10 8 L3 13 Z" {...s} />}
      {kind === 'eject' && <Path d="M3 10 L8 4 L13 10 Z M3 13 H13" {...s} />}
    </Svg>
  );
}

/** A thin ring gauge. */
function Ring({ frac, size = 72, absent, children }: { frac: number; size?: number; absent?: boolean; children?: React.ReactNode }) {
  const r = size / 2 - 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.ink4} strokeWidth={W} fill="none" />
        {!absent && <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.ink} strokeWidth={v > 0.82 ? W * 2.2 : W} fill="none" strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
        {!absent && <Circle cx={size / 2 + r * Math.cos((v * 360 - 90) * Math.PI / 180)} cy={size / 2 + r * Math.sin((v * 360 - 90) * Math.PI / 180)} r={2.5} fill={C.page} stroke={C.ink} strokeWidth={W} />}
      </Svg>
      {children}
    </View>
  );
}

/** A thin arc gauge with a needle line, for the twelve-joint grid. */
function Arc({ value, max, signed, absent, size = 64 }: { value: number; max: number; signed?: boolean; absent?: boolean; size?: number }) {
  const r = size / 2 - 3, cx = size / 2, cy = size / 2 + 6;
  const a0 = -200, a1 = 20;
  const frac = signed ? (Math.max(-max, Math.min(max, value)) + max) / (2 * max) : Math.max(0, Math.min(1, value / max));
  const p = (a: number, rr = r) => [cx + rr * Math.cos((a * Math.PI) / 180), cy + rr * Math.sin((a * Math.PI) / 180)];
  const [sx, sy] = p(a0), [ex, ey] = p(a1), av = a0 + (a1 - a0) * frac, [nx, ny] = p(av, r - 2);
  return (
    <Svg width={size} height={size}>
      <Path d={`M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`} stroke={C.ink3} strokeWidth={W} fill="none" />
      {Array.from({ length: 5 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / 4; const [x1, y1] = p(a), [x2, y2] = p(a, r - 5); return <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.ink3} strokeWidth={W} />; })}
      {!absent && <Line x1={cx} y1={cy} x2={nx} y2={ny} stroke={C.ink} strokeWidth={W} strokeLinecap="round" />}
      <Circle cx={cx} cy={cy} r={2} fill={C.page} stroke={C.ink} strokeWidth={W} />
    </Svg>
  );
}

function LineChart({ values, width, height, played }: { values: number[]; width: number; height: number; played?: number }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 2 - Math.max(0, Math.min(1, v)) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      <Line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} stroke={C.ink4} strokeWidth={W} />
      {n > 1 && <Polyline points={pts} stroke={C.ink} strokeWidth={W} fill="none" strokeLinejoin="round" />}
      {played !== undefined && <><Line x1={played * width} x2={played * width} y1={0} y2={height} stroke={C.ink} strokeWidth={W} /><Circle cx={played * width} cy={height - 0.5} r={3.5} fill={C.page} stroke={C.ink} strokeWidth={W} /></>}
    </Svg>
  );
}

/* ---------- the line: navigation ---------- */

const NODES: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'Live' }, { key: 'replay', label: 'Replay' }, { key: 'data', label: 'Data' }];

function LineNav({ screen, onScreen }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void }) {
  return (
    <View style={{ height: 44, justifyContent: 'center', paddingHorizontal: 24 }}>
      <View style={{ position: 'absolute', left: 24, right: 24, top: 15, height: W, backgroundColor: C.ink }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {NODES.map((n) => {
          const on = n.key === screen;
          return (
            <Pressable key={n.key} onPress={() => onScreen(n.key)} hitSlop={10} style={{ alignItems: 'center', width: 70 }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: W, borderColor: C.ink, backgroundColor: on ? C.ink : C.page, marginTop: 9 }} />
              <T size={10} weight={on ? 'medium' : 'ui'} caps color={on ? C.ink : C.ink2} style={{ marginTop: 4 }}>{n.label}</T>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Frame({ screen, onScreen, children, share = 0.42 }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; share?: number }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.page, paddingTop: inset.top }}>
      <View style={st.head}>
        <T size={12} weight="medium" tracking={2} caps>Takto one</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: W, borderColor: C.ink, backgroundColor: feed.live ? C.ink : C.page }} />
          <T size={10} caps color={C.ink2}>{feed.word} · {st_.liveJoints}/12</T>
        </View>
      </View>
      <LineNav screen={screen} onScreen={onScreen} />
      <View style={{ height: height * share }}><Stage spec={twin} style={StyleSheet.absoluteFill} /></View>
      <View style={{ flex: 1, paddingBottom: inset.bottom }}>{children}</View>
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
    <View style={{ flex: 1, backgroundColor: C.page, paddingTop: inset.top }}>
      <View style={st.head}>
        <T size={12} weight="medium" tracking={2} caps>Takto one</T>
        <T size={10} caps color={C.ink2}>{feed.word}</T>
      </View>
      <View style={{ height: height * 0.56 }}><Stage spec={twin} style={StyleSheet.absoluteFill} /></View>
      <View style={{ flex: 1, paddingHorizontal: 24 }}>
        <View style={{ height: W, backgroundColor: C.ink }} />
        <T size={34} weight="light" style={{ marginTop: 16 }}>Every joint,{'\n'}one line.</T>
        <T size={13} color={C.ink2} style={{ marginTop: 8, maxWidth: 290 }}>A digital twin of the TAKTO ONE hand, live from the device or from a recorded take. Twelve joints and an effort channel.</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 20 }}>
          <Pill label="Start session" icon="arrow" big onPress={onStart} />
          <Pill label="Connect" icon="link" big onPress={onConnect} />
        </View>
        <View style={{ flex: 1 }} />
        <T size={10} color={C.ink3} style={{ marginBottom: inset.bottom + 14 }}>Research prototype · not a medical device · the feed is synthetic</T>
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
    <Frame screen="live" onScreen={onScreen} share={all ? 0.3 : 0.4}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 6 }} showsVerticalScrollIndicator={false}>
        <View style={{ height: W, backgroundColor: C.ink }} />
        {!all ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 14 }}>
              <Ring frac={st_.mean / 110} size={104}>
                <T size={34} weight="light">{st_.mean.toFixed(0)}<T size={16} weight="light" color={C.ink2}>°</T></T>
              </Ring>
              <View style={{ flex: 1 }}>
                <Label>Mean flexion</Label>
                <T size={13} color={C.ink2} style={{ marginTop: 2 }}>Peak {FINGER_NAME[st_.peakFinger].toLowerCase()} {st_.peak.toFixed(0)}°, assist {st_.blendWord.toLowerCase()}</T>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
                  <T size={26} weight="light">{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T>
                  <Label>Effort</Label>
                </View>
                <LineChart values={hist.values} width={width - 48 - 104 - 18} height={26} />
              </View>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 18 }}>
              {FINGERS.map((f) => (
                <View key={f} style={{ alignItems: 'center' }}>
                  <Ring frac={st_.curl[f]} size={64} absent={!(frame.ok[f].mcp || frame.ok[f].pip)}>
                    <T size={17} weight="light">{(st_.curl[f] * 100).toFixed(0)}</T>
                  </Ring>
                  <T size={10} caps color={C.ink2} style={{ marginTop: 4 }}>{FINGER_NAME[f]}</T>
                </View>
              ))}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 14 }}>
              <Pill label="Twelve joints" onPress={() => setAll(true)} />
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
              <Label>Twelve joints · degrees</Label>
              <Pill label="Summary" onPress={() => setAll(false)} />
            </View>
            <View style={{ flexDirection: 'row', paddingLeft: 60, marginTop: 6 }}>
              {JOINTS.map((j) => <Label key={j.key} style={{ flex: 1, textAlign: 'center' }}>{j.short} · {j.max}</Label>)}
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: W, borderColor: C.ink4, paddingVertical: 2 }}>
                <T size={11} caps color={C.ink2} style={{ width: 60 }}>{FINGER_NAME[f]}</T>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return (
                    <View key={j.key} style={{ flex: 1, alignItems: 'center' }}>
                      <Arc value={v} max={j.max} signed={j.signed} absent={!on} size={58} />
                      <T size={14} weight="light" color={on ? C.ink : C.ink3} style={{ marginTop: -10 }}>{fmtDeg(v, on, j.signed)}</T>
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
    <Frame screen="replay" onScreen={onScreen} share={0.4}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 6 }} showsVerticalScrollIndicator={false}>
        <View style={{ height: W, backgroundColor: C.ink }} />
        {!play ? (
          <>
            <Label style={{ marginTop: 12 }}>Recorded takes · choreographed samples, not a person</Label>
            {takes.map((t) => (
              <View key={t.id} style={st.row}>
                <View style={{ flex: 1 }}>
                  <T size={18} weight="light">{t.title}</T>
                  <T size={12} color={C.ink2}>{t.note} · {t.durationS.toFixed(0)} s</T>
                </View>
                <Pill label="Play" icon="play" onPress={() => s.setTake(t)} />
              </View>
            ))}
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 12 }}>
              <View><Label>{play.take.title}</Label><T size={40} weight="light">{clock(play.t)}</T></View>
              <T size={12} color={C.ink2} style={{ paddingBottom: 6 }}>of {clock(play.take.durationS)} · {play.speed}×</T>
            </View>
            <View style={{ marginTop: 10 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <LineChart values={trace} width={width - 48} height={48} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
              <Pill label="" icon="start" onPress={() => s.seek(0)} />
              <Pill label={play.playing ? 'Pause' : 'Play'} icon={play.playing ? 'pause' : 'play'} on onPress={() => s.togglePlay()} />
              <Pill label="" icon="end" onPress={() => s.seek(play.take.durationS)} />
              {[0.5, 1, 2].map((k) => <Pill key={k} label={`${k}×`} on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
              <Pill label="" icon="eject" onPress={() => s.setTake(null)} />
            </View>
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
    <Frame screen="data" onScreen={onScreen} share={0.26}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 6 }} showsVerticalScrollIndicator={false}>
        <View style={{ height: W, backgroundColor: C.ink }} />
        <Label style={{ marginTop: 12 }}>Source · {feed.detail}</Label>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.ink3} />
          <Pill label="Connect" icon="link" onPress={() => s.connect(url)} />
          <Pill label="Sim" onPress={() => s.useSimulator()} />
        </View>
        <Label style={{ marginTop: 18 }}>Channels · wire name and mechanical name</Label>
        {FINGERS.map((f) => (
          <View key={f} style={[st.row, { gap: 6 }]}>
            <T size={11} caps color={C.ink2} style={{ width: 56 }}>{FINGER_NAME[f]}</T>
            {JOINTS.map((j) => {
              const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
              return <View key={j.key} style={{ flex: 1 }}><T size={16} weight="light" color={!on ? C.ink3 : C.ink}>{on ? `${v.toFixed(1)}°` : '–'}</T><T size={9} color={C.ink3}>{f}_{j.wire}</T></View>;
            })}
          </View>
        ))}
        <Label style={{ marginTop: 18 }}>Rates · four numbers, not one</Label>
        {RATES.map((r) => (
          <View key={r.what} style={st.row}>
            <T size={14} style={{ width: 130 }}>{r.what}</T>
            <T size={11} color={C.ink2} style={{ flex: 1 }}>{r.note}</T>
            <T size={16} weight="light">{r.rate}</T>
          </View>
        ))}
        <T size={10} color={C.ink3} style={{ marginTop: 12, marginBottom: 20 }}>Research prototype. Not a medical device.</T>
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
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 10 },
  pill: { height: 36, paddingHorizontal: 14, borderRadius: 18, borderWidth: W, borderColor: C.ink, flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  pillBig: { height: 46, paddingHorizontal: 18, borderRadius: 23 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: W, borderColor: C.ink4 },
  input: { flex: 1, height: 36, borderBottomWidth: W, borderColor: C.ink, fontFamily: 'Manrope_400Regular', fontSize: 14, color: C.ink },
});

export const design: Design = {
  id: '40', slug: 'monoline', name: 'Monoline',
  thesis: 'One line weight, one ink, white: the hand as a plan-view line illustration, every gauge a thin ring or arc, and a single line across the top with three nodes as the navigation.',
  fonts: { Manrope_300Light, Manrope_400Regular, Manrope_500Medium },
  bg: PAGE, statusBar: 'dark-content', App: Shell,
};
