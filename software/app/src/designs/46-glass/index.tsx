// 46-glass - liquid glass, done properly.
//
// Thick milky glass on charcoal: a heavy blur, a real white fill, a bright
// top edge where light enters, a darker bottom edge where it leaves, and
// a deep soft shadow so every pane has depth. Nothing is a smudge: the
// primary controls are opaque milk with dark text, the panes are dense
// enough to read on. Navigation is a glass capsule at the top with a milk
// thumb that slides to the surface you chose. Figtree.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, Animated, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path, Polyline, Rect, Line } from 'react-native-svg';
import { Figtree_400Regular } from '@expo-google-fonts/figtree/400Regular';
import { Figtree_600SemiBold } from '@expo-google-fonts/figtree/600SemiBold';
import { Figtree_800ExtraBold } from '@expo-google-fonts/figtree/800ExtraBold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin } from './twin';

const C = { bg: '#141518', bg2: '#0C0C0E', white: '#FFFFFF', t1: '#17181B', t2: 'rgba(23,24,27,0.64)', t3: 'rgba(23,24,27,0.42)', lt: 'rgba(244,244,246,0.55)', ink: '#141518', ink2: 'rgba(20,21,24,0.6)', mint: '#5EE0B0', coral: '#FF7A59', milk: 'rgba(255,255,255,0.22)', milkStrong: 'rgba(255,255,255,0.92)' };
const F = { ui: 'Figtree_400Regular', semi: 'Figtree_600SemiBold', black: 'Figtree_800ExtraBold' };
const DEPTH = { boxShadow: '0 24px 50px rgba(0,0,0,0.55), 0 4px 10px rgba(0,0,0,0.35)' } as any;
const EDGE = { boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.25), inset 0 0 0 1px rgba(255,255,255,0.18)' } as any;

function T({ children, size = 15, weight = 'ui', color = C.t1, style, align, lh, tracking }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; style?: StyleProp<TextStyle>; align?: 'left' | 'center' | 'right'; lh?: number; tracking?: number;
}) {
  return <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: lh ?? Math.round(size * (size > 30 ? 1.02 : 1.35)), letterSpacing: tracking ?? (size > 30 ? -size * 0.03 : 0), fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}

/** Thick glass: heavy blur, a real fill, an edge where light enters, a deep shadow. */
function Glass({ children, style, radius = 26, strong, pad }: { children?: React.ReactNode; style?: StyleProp<ViewStyle>; radius?: number; strong?: boolean; pad?: number }) {
  return (
    <View style={[{ borderRadius: radius }, DEPTH, style]}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]} pointerEvents="none">
        <BlurView intensity={90} tint="light" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: strong ? 'rgba(255,255,255,0.34)' : C.milk }]} />
        <LinearGradient colors={['rgba(255,255,255,0.28)', 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0)']} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
      </View>
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius }, EDGE]} pointerEvents="none" />
      <View style={{ padding: pad }}>{children}</View>
    </View>
  );
}

/** Opaque milk button with dark text, or glass with light text. Pressed: mint tint. */
function Button({ label, onPress, primary, style, glyph, on }: { label: string; onPress?: () => void; primary?: boolean; style?: StyleProp<ViewStyle>; glyph?: React.ReactNode; on?: boolean }) {
  const solid = primary || on;
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [{ borderRadius: 999 }, style, pressed && { transform: [{ scale: 0.97 }] }]}>
      {({ pressed }) => solid ? (
        <View style={[st.btn, { backgroundColor: pressed ? C.mint : C.white }, DEPTH, EDGE]}>
          {glyph}<T size={15} weight="semi" color={C.ink}>{label}</T>
        </View>
      ) : (
        <View style={[st.btn, { borderWidth: 1.5, borderColor: 'rgba(23,24,27,0.4)', backgroundColor: pressed ? 'rgba(23,24,27,0.1)' : 'transparent' }]}>{glyph}<T size={15} weight="semi">{label}</T></View>
      )}
    </Pressable>
  );
}
const Glyph = ({ kind, color = C.ink }: { kind: 'play' | 'pause' | 'start' | 'end' | 'eject' | 'arrow'; color?: string }) => (
  <Svg width={14} height={14} viewBox="0 0 16 16">
    {kind === 'play' && <Path d="M4 2.5 L13.5 8 L4 13.5 Z" fill={color} />}
    {kind === 'pause' && <Path d="M4 3 H6.5 V13 H4 Z M9.5 3 H12 V13 H9.5 Z" fill={color} />}
    {kind === 'start' && <Path d="M3 3 H5 V13 H3 Z M13 3 L6 8 L13 13 Z" fill={color} />}
    {kind === 'end' && <Path d="M11 3 H13 V13 H11 Z M3 3 L10 8 L3 13 Z" fill={color} />}
    {kind === 'eject' && <Path d="M3 10 L8 4 L13 10 Z M3 12 H13 V14 H3 Z" fill={color} />}
    {kind === 'arrow' && <Path d="M2 8 H14 M9 3 L14 8 L9 13" stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
  </Svg>
);

/** The capsule: a glass segmented control whose milk thumb slides. */
function Capsule({ screen, onScreen, width }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; width: number }) {
  const items: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'Live' }, { key: 'replay', label: 'Replay' }, { key: 'data', label: 'Data' }];
  const idx = Math.max(0, items.findIndex((i) => i.key === screen));
  const segW = (width - 8) / 3;
  const x = useRef(new Animated.Value(idx * segW)).current;
  useEffect(() => { Animated.spring(x, { toValue: idx * segW, useNativeDriver: false, speed: 16, bounciness: 5 }).start(); }, [idx, segW]);
  return (
    <Glass radius={999} style={{ width }}>
      <View style={{ height: 44, padding: 4 }}>
        <Animated.View style={[{ position: 'absolute', top: 4, left: 4, width: segW, height: 36, borderRadius: 18, backgroundColor: C.milkStrong, transform: [{ translateX: x }] }, EDGE]} />
        <View style={{ flexDirection: 'row', flex: 1 }}>
          {items.map((it) => (
            <Pressable key={it.key} onPress={() => onScreen(it.key)} style={{ width: segW, alignItems: 'center', justifyContent: 'center' }}>
              <T size={14} weight="semi" color={it.key === screen ? C.ink : C.t1}>{it.label}</T>
            </Pressable>
          ))}
        </View>
      </View>
    </Glass>
  );
}

function Ring({ frac, size = 70, absent, hot, children }: { frac: number; size?: number; absent?: boolean; hot?: boolean; children?: React.ReactNode }) {
  const r = size / 2 - 5, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(0,0,0,0.12)" strokeWidth={7} fill="none" />
        {!absent && v > 0.004 && <Circle cx={size / 2} cy={size / 2} r={r} stroke={hot ? C.coral : C.t1} strokeWidth={7} fill="none" strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      </Svg>
      {children}
    </View>
  );
}
function Chart({ values, width, height, played }: { values: number[]; width: number; height: number; played?: number }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 2 - Math.max(0, Math.min(1, v)) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      <Line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} stroke="rgba(0,0,0,0.15)" strokeWidth={1} />
      {n > 1 && <Polyline points={pts} stroke={C.t1} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill="rgba(0,0,0,0.08)" /><Line x1={played * width} x2={played * width} y1={0} y2={height} stroke={C.mint} strokeWidth={2} /></>}
    </Svg>
  );
}

function Frame({ screen, onScreen, children, sheetShare = 0.44 }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; sheetShare?: number }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#2A2C31', C.bg, C.bg2]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
      <Stage spec={twin} style={[StyleSheet.absoluteFill, { top: inset.top + 50, bottom: height * sheetShare - 30 }]} />
      <View style={[st.top, { top: inset.top + 8 }]}>
        <Capsule screen={screen} onScreen={onScreen} width={width - 32 - 86} />
        <Glass radius={999} style={{ marginLeft: 8 }}><View style={{ height: 44, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: feed.live ? C.mint : C.coral }} />
            <T size={12} weight="semi">{st_.liveJoints}/12</T>
          </View>
        </View></Glass>
      </View>
      <View style={[st.feed, { top: inset.top + 62 }]} pointerEvents="none"><T size={11} weight="semi" color={C.lt}>{feed.word.toUpperCase()} · {feed.detail}</T></View>
      <Glass radius={32} style={[st.sheet, { height: height * sheetShare }]}>
        <View style={{ flex: 1, height: height * sheetShare, paddingBottom: inset.bottom }}>{children}</View>
      </Glass>
    </View>
  );
}

function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#2A2C31', C.bg, C.bg2]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
      <Stage spec={twin} style={[StyleSheet.absoluteFill, { top: inset.top + 20, bottom: height * 0.34 }]} />
      <View style={[st.top, { top: inset.top + 10, justifyContent: 'space-between' }]}>
        <Glass radius={999}><View style={{ height: 40, paddingHorizontal: 14, justifyContent: 'center' }}><T size={13} weight="black" tracking={1.5}>TAKTO ONE</T></View></Glass>
        <Glass radius={999}><View style={{ height: 40, paddingHorizontal: 12, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: 6 }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.coral }} /><T size={12} weight="semi">{feed.word}</T></View></Glass>
      </View>
      <Glass radius={32} style={[st.sheet, { height: height * 0.38 }]} pad={22}>
        <T size={12} weight="semi" color={C.t2}>Companion · research prototype</T>
        <T size={40} weight="black" lh={42} style={{ marginTop: 4 }}>Every joint,{'\n'}under glass.</T>
        <T size={14} color={C.t2} style={{ marginTop: 8 }}>The TAKTO ONE hand, live from the device or from a recorded take. Twelve joints and an effort channel.</T>
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: inset.bottom + 6 }}>
          <Button label="Start session" primary onPress={onStart} style={{ flex: 1.3 }} glyph={<Glyph kind="arrow" />} />
          <Button label="Connect" onPress={onConnect} style={{ flex: 1 }} />
        </View>
      </Glass>
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
    <Frame screen="live" onScreen={onScreen} sheetShare={all ? 0.58 : 0.44}>
      <ScrollView contentContainerStyle={{ padding: 22, paddingTop: 18 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <Ring frac={st_.mean / 110} size={96} hot={st_.mean > 90}><T size={32} weight="black">{st_.mean.toFixed(0)}<T size={14} weight="semi" color={C.t2}>°</T></T></Ring>
          <View style={{ flex: 1 }}>
            <T size={13} weight="semi" color={C.t2}>Mean flexion</T>
            <T size={13} color={C.t3}>Peak {FINGER_NAME[st_.peakFinger].toLowerCase()} {st_.peak.toFixed(0)}° · {st_.blendWord.toLowerCase()}</T>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
              <T size={26} weight="black" color={st_.emg > 0.8 ? C.coral : C.t1}>{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T>
              <T size={13} weight="semi" color={C.t2}>effort</T>
            </View>
          </View>
          <Chart values={hist.values} width={80} height={40} />
        </View>
        {!all ? (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 18 }}>
              {FINGERS.map((f) => (
                <View key={f} style={{ alignItems: 'center' }}>
                  <Ring frac={st_.curl[f]} size={62} absent={!(frame.ok[f].mcp || frame.ok[f].pip)} hot={st_.curl[f] > 0.82}><T size={17} weight="semi">{(st_.curl[f] * 100).toFixed(0)}</T></Ring>
                  <T size={12} weight="semi" color={C.t2} style={{ marginTop: 5 }}>{FINGER_NAME[f]}</T>
                </View>
              ))}
            </View>
            <View style={{ alignItems: 'flex-end', marginTop: 16 }}><Button label="All twelve" onPress={() => setAll(true)} /></View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
              <T size={13} weight="semi" color={C.t2}>Twelve joints · degrees</T>
              <Button label="Fingers" onPress={() => setAll(false)} />
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, borderTopWidth: 1, borderColor: 'rgba(0,0,0,0.12)', paddingTop: 8 }}>
                <T size={13} weight="semi" color={C.t2} style={{ width: 62 }}>{FINGER_NAME[f]}</T>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return (
                    <View key={j.key} style={{ flex: 1, alignItems: 'center' }}>
                      <Ring frac={j.signed ? (v + j.max) / (2 * j.max) : v / j.max} size={52} absent={!on} hot={Math.abs(v) > j.max * 0.9}><T size={13} weight="semi">{fmtDeg(v, on, j.signed)}</T></Ring>
                      <T size={10} weight="semi" color={C.t3}>{j.short}</T>
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
    <Frame screen="replay" onScreen={onScreen} sheetShare={0.44}>
      <ScrollView contentContainerStyle={{ padding: 22, paddingTop: 18 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            <T size={13} weight="semi" color={C.t2}>Recorded takes · choreographed samples, not a person</T>
            {takes.map((t) => (
              <View key={t.id} style={st.row}>
                <View style={{ flex: 1 }}>
                  <T size={18} weight="semi">{t.title}</T>
                  <T size={12} color={C.t3}>{t.note} · {t.durationS.toFixed(0)} s</T>
                </View>
                <Button label="Play" primary onPress={() => s.setTake(t)} glyph={<Glyph kind="play" />} />
              </View>
            ))}
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <View><T size={13} weight="semi" color={C.t2}>{play.take.title}</T><T size={40} weight="black">{clock(play.t)}</T></View>
              <T size={13} weight="semi" color={C.t3} style={{ paddingBottom: 8 }}>of {clock(play.take.durationS)} · {play.speed}×</T>
            </View>
            <View style={{ marginTop: 8 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <Chart values={trace} width={width - 32 - 44} height={50} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
              <Button label="" onPress={() => s.seek(0)} glyph={<Glyph kind="start" color={C.t1} />} />
              <Button label={play.playing ? 'Pause' : 'Play'} primary onPress={() => s.togglePlay()} glyph={<Glyph kind={play.playing ? 'pause' : 'play'} />} />
              <Button label="" onPress={() => s.seek(play.take.durationS)} glyph={<Glyph kind="end" color={C.t1} />} />
              {[0.5, 1, 2].map((k) => <Button key={k} label={`${k}×`} on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
              <Button label="" onPress={() => s.setTake(null)} glyph={<Glyph kind="eject" color={C.t1} />} />
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
    <Frame screen="data" onScreen={onScreen} sheetShare={0.62}>
      <ScrollView contentContainerStyle={{ padding: 22, paddingTop: 18 }} showsVerticalScrollIndicator={false}>
        <T size={13} weight="semi" color={C.t2}>Source · {feed.word}, {feed.detail}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <View style={[st.field, EDGE]}><TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.t3} /></View>
          <Button label="Connect" primary onPress={() => s.connect(url)} />
          <Button label="Sim" onPress={() => s.useSimulator()} />
        </View>
        <T size={13} weight="semi" color={C.t2} style={{ marginTop: 18 }}>Channels · wire name and mechanical name</T>
        {FINGERS.map((f) => (
          <View key={f} style={[st.row, { gap: 6 }]}>
            <T size={13} weight="semi" color={C.t2} style={{ width: 58 }}>{FINGER_NAME[f]}</T>
            {JOINTS.map((j) => {
              const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
              return <View key={j.key} style={{ flex: 1 }}><T size={18} weight="semi" color={!on ? C.t3 : Math.abs(v) > j.max ? C.coral : C.t1}>{on ? `${v.toFixed(1)}°` : '–'}</T><T size={10} color={C.t3}>{f}_{j.wire}</T></View>;
            })}
          </View>
        ))}
        <T size={13} weight="semi" color={C.t2} style={{ marginTop: 18 }}>Rates · four numbers, not one</T>
        {RATES.map((r) => (
          <View key={r.what} style={st.row}>
            <T size={15} weight="semi" style={{ width: 130 }}>{r.what}</T>
            <T size={12} color={C.t2} style={{ flex: 1 }}>{r.note}</T>
            <T size={17} weight="semi">{r.rate}</T>
          </View>
        ))}
        <T size={11} color={C.t3} style={{ marginVertical: 12 }}>Research prototype. Not a medical device.</T>
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
  top: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', zIndex: 5 },
  feed: { position: 'absolute', left: 24, right: 24 },
  sheet: { position: 'absolute', left: 10, right: 10, bottom: -34, overflow: 'hidden' },
  btn: { height: 44, borderRadius: 22, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minWidth: 44 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderColor: 'rgba(0,0,0,0.12)' },
  field: { flex: 1, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.08)', paddingHorizontal: 16, justifyContent: 'center' },
  input: { fontFamily: 'Figtree_600SemiBold', fontSize: 14, color: C.t1 },
});

export const design: Design = {
  id: '46', slug: 'glass', name: 'Thick glass',
  thesis: 'Liquid glass done properly: milky, thick, edge-lit and deep, over an anodised aluminium hand on charcoal, with a glass capsule whose milk thumb slides as the navigation.',
  fonts: { Figtree_400Regular, Figtree_600SemiBold, Figtree_800ExtraBold },
  bg: '#141518', statusBar: 'light-content', App: Shell,
};
