// 38-brutal - concrete.
//
// Raw concrete with formwork tie holes, cast iron hand, one safety orange.
// Anton at monumental sizes set straight over the image, 3pt black rules,
// no radius anywhere, black blocks with concrete text as the controls. The
// navigation is three enormous words stacked at the foot; the active one
// is a solid black block.
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Polyline, Rect, Line } from 'react-native-svg';
import { Anton_400Regular } from '@expo-google-fonts/anton/400Regular';
import { LibreFranklin_400Regular } from '@expo-google-fonts/libre-franklin/400Regular';
import { LibreFranklin_600SemiBold } from '@expo-google-fonts/libre-franklin/600SemiBold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin, CONCRETE } from './twin';

const C = { concrete: CONCRETE, concrete2: '#9C9993', black: '#111111', black2: '#2B2A28', white: '#F2F0EC', orange: '#FF4D00', grey: '#6A6864' };

function H({ children, size = 48, color = C.black, style, align }: { children: React.ReactNode; size?: number; color?: string; style?: StyleProp<TextStyle>; align?: 'left' | 'center' | 'right' }) {
  return <Text style={[{ fontFamily: 'Anton_400Regular', fontSize: size, color, lineHeight: Math.round(size * 1.0), textTransform: 'uppercase', letterSpacing: size * 0.005, fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}
function T({ children, size = 13, semi, color = C.black, style, caps, align }: { children: React.ReactNode; size?: number; semi?: boolean; color?: string; style?: StyleProp<TextStyle>; caps?: boolean; align?: 'left' | 'center' | 'right' }) {
  return <Text style={[{ fontFamily: semi ? 'LibreFranklin_600SemiBold' : 'LibreFranklin_400Regular', fontSize: size, color, lineHeight: Math.round(size * 1.3), textTransform: caps ? 'uppercase' : 'none', letterSpacing: caps ? 1 : 0, fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}

/** A block: solid black with concrete text. Pressed: orange. */
function Block({ label, onPress, style, size = 22, outline, small }: { label: string; onPress?: () => void; style?: StyleProp<ViewStyle>; size?: number; outline?: boolean; small?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.block, small && { height: 40, paddingHorizontal: 12 }, outline && st.blockOutline, pressed && { backgroundColor: C.orange, borderColor: C.orange }, style]}>
      {({ pressed }) => <H size={small ? 18 : size} color={pressed ? C.black : outline ? C.black : C.concrete}>{label}</H>}
    </Pressable>
  );
}

/** Tie holes: the formwork pattern of a concrete panel. */
function TieHoles({ width, height }: { width: number; height: number }) {
  const cols = Math.floor(width / 120), rows = Math.floor(height / 150);
  const dots = [];
  for (let i = 0; i <= cols; i++) for (let j = 0; j <= rows; j++) dots.push(<Circle key={`${i}-${j}`} cx={60 + i * 120} cy={75 + j * 150} r={4} fill="#8C8983" stroke="#75736E" strokeWidth={1} />);
  return <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">{dots}</Svg>;
}

function Slab({ frac, absent, height = 22 }: { frac: number; absent?: boolean; height?: number }) {
  return (
    <View style={{ height, backgroundColor: C.concrete2, borderWidth: 2, borderColor: C.black }}>
      {!absent && <View style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%`, height: height - 4, backgroundColor: frac > 0.82 ? C.orange : C.black }} />}
    </View>
  );
}

function Trace({ values, width, height, played, hot }: { values: number[]; width: number; height: number; played?: number; hot?: boolean }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 2 - Math.max(0, Math.min(1, v)) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      <Rect x={1} y={1} width={width - 2} height={height - 2} stroke={C.black} strokeWidth={2} fill="none" />
      {n > 1 && <Polyline points={pts} stroke={hot ? C.orange : C.black} strokeWidth={3} fill="none" strokeLinejoin="miter" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill="rgba(17,17,17,0.12)" /><Rect x={played * width - 4} y={0} width={8} height={height} fill={C.orange} /></>}
    </Svg>
  );
}

const NAV: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'Live' }, { key: 'replay', label: 'Replay' }, { key: 'data', label: 'Data' }];

function Frame({ screen, onScreen, children, share = 0.4, over }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; share?: number; over?: React.ReactNode }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.concrete }}>
      <TieHoles width={width} height={height} />
      <View style={[st.head, { paddingTop: inset.top + 8 }]}>
        <H size={22}>Takto one</H>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 10, height: 10, backgroundColor: feed.live ? C.black : C.orange }} />
          <T size={11} semi caps>{feed.word} · {st_.liveJoints}/12</T>
        </View>
      </View>
      <View style={{ height: height * share, borderTopWidth: 3, borderBottomWidth: 3, borderColor: C.black }}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        {over}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
      <View style={[st.nav, { paddingBottom: inset.bottom + 8 }]}>
        {NAV.map((n) => {
          const on = n.key === screen;
          return (
            <Pressable key={n.key} onPress={() => onScreen(n.key)} style={({ pressed }) => [st.navItem, on && { backgroundColor: C.black }, pressed && { backgroundColor: C.orange }]}>
              {({ pressed }) => <H size={34} color={on && !pressed ? C.concrete : C.black}>{n.label}</H>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  return (
    <View style={{ flex: 1, backgroundColor: C.concrete }}>
      <TieHoles width={width} height={height} />
      <View style={{ position: 'absolute', left: 0, right: 0, top: inset.top + 50, height: height * 0.5, borderTopWidth: 3, borderBottomWidth: 3, borderColor: C.black }}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', left: 16, top: 12 }} pointerEvents="none"><T size={11} semi caps>{feed.word} · research prototype</T></View>
      </View>
      <View style={{ position: 'absolute', left: 16, right: 16, top: inset.top + 4 }} pointerEvents="none"><T size={11} semi caps>Companion · v1</T></View>
      <View style={{ position: 'absolute', left: 16, right: 16, top: inset.top + 50 + height * 0.5 + 12 }}>
        <H size={64} style={{ marginTop: -4 }}>Takto{'\n'}one</H>
        <T size={14} style={{ marginTop: 8, maxWidth: 300 }}>Every joint of the hand, live from the device or from a recorded take. No hand wore the device to make the feed.</T>
      </View>
      <View style={{ position: 'absolute', left: 16, right: 16, bottom: inset.bottom + 16, gap: 8 }}>
        <Block label="Start session" onPress={onStart} />
        <Block label="Connect a device" outline onPress={onConnect} />
      </View>
    </View>
  );
}

function Live({ detail, onScreen }: { detail: boolean; onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const [grid, setGrid] = useState(detail);
  const hist = useRef(new History(60)).current;
  hist.push(st_.emg);
  const { width } = useWindowDimensions();
  return (
    <Frame screen="live" onScreen={onScreen} share={grid ? 0.3 : 0.4}
      over={<View style={{ position: 'absolute', left: 12, bottom: 4 }} pointerEvents="none">
        <H size={96} color={C.white} style={{ textShadowColor: C.black, textShadowOffset: { width: 3, height: 3 }, textShadowRadius: 0 } as any}>{st_.mean.toFixed(0)}°</H>
        <T size={11} semi caps color={C.white} style={{ marginTop: -6 }}>Mean flexion · peak {FINGER_NAME[st_.peakFinger]} {st_.peak.toFixed(0)}°</T>
      </View>}>
      <ScrollView contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
        {!grid ? (
          <>
            {FINGERS.map((f) => {
              const live = frame.ok[f].mcp || frame.ok[f].pip;
              return (
                <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <H size={18} style={{ width: 78 }}>{FINGER_NAME[f]}</H>
                  <View style={{ flex: 1 }}><Slab frac={st_.curl[f]} absent={!live} /></View>
                  <H size={22} style={{ width: 50, textAlign: 'right' }} color={live ? C.black : C.grey}>{live ? (st_.curl[f] * 100).toFixed(0) : '–'}</H>
                </View>
              );
            })}
            <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
              <View style={[st.tile, { flex: 1, backgroundColor: st_.emg > 0.8 ? C.orange : C.black }]}>
                <T size={10} semi caps color={C.concrete}>Effort · {st_.blendWord}</T>
                <H size={40} color={C.concrete}>{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</H>
              </View>
              <View style={{ flex: 1.3, justifyContent: 'space-between' }}>
                <Trace values={hist.values} width={(width - 40) * 0.56} height={46} hot={st_.emg > 0.8} />
                <Block label="12 joints" small onPress={() => setGrid(true)} />
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <T size={11} semi caps>Twelve joints · degrees</T>
              <Block label="Back" small onPress={() => setGrid(false)} />
            </View>
            <View style={{ flexDirection: 'row', gap: 4, marginBottom: 4, paddingLeft: 82 }}>
              {JOINTS.map((j) => <T key={j.key} size={10} semi caps style={{ flex: 1 }}>{j.short} /{j.max}</T>)}
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', gap: 4, marginBottom: 4 }}>
                <H size={16} style={{ width: 78, paddingTop: 10 }}>{FINGER_NAME[f]}</H>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return (
                    <View key={j.key} style={[st.cell, Math.abs(v) > j.max * 0.9 && { backgroundColor: C.orange }]}>
                      <H size={26} color={on ? C.concrete : C.grey}>{fmtDeg(v, on, j.signed)}</H>
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
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 80) : []), [play?.take.id]);
  return (
    <Frame screen="replay" onScreen={onScreen} share={0.36}
      over={play ? <View style={{ position: 'absolute', left: 12, bottom: 4 }} pointerEvents="none">
        <H size={80} color={C.white} style={{ textShadowColor: C.black, textShadowOffset: { width: 3, height: 3 }, textShadowRadius: 0 } as any}>{clock(play.t)}</H>
        <T size={11} semi caps color={C.white} style={{ marginTop: -4 }}>{play.take.title} · of {clock(play.take.durationS)} · {play.speed}×</T>
      </View> : <View style={{ position: 'absolute', left: 12, bottom: 8 }} pointerEvents="none"><H size={40} color={C.white} style={{ textShadowColor: C.black, textShadowOffset: { width: 3, height: 3 }, textShadowRadius: 0 } as any}>Recorded takes</H></View>}>
      <ScrollView contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            {takes.map((t) => (
              <Pressable key={t.id} onPress={() => s.setTake(t)} style={({ pressed }) => [st.take, pressed && { backgroundColor: C.orange }]}>
                <View style={{ flex: 1 }}>
                  <H size={28}>{t.title}</H>
                  <T size={12}>{t.note}</T>
                </View>
                <H size={28}>{t.durationS.toFixed(0)}s</H>
              </Pressable>
            ))}
            <T size={11} semi caps color={C.grey} style={{ marginTop: 6 }}>Choreographed samples · not recordings of a person</T>
          </>
        ) : (
          <>
            <View {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <Trace values={trace} width={width - 32} height={56} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
              <Block label="|<" small onPress={() => s.seek(0)} />
              <Block label={play.playing ? 'Pause' : 'Play'} small onPress={() => s.togglePlay()} style={{ flex: 1 }} />
              <Block label=">|" small onPress={() => s.seek(play.take.durationS)} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
              {[0.5, 1, 2].map((k) => <Block key={k} label={`${k}×`} small outline={play.speed !== k} onPress={() => s.setSpeed(k)} style={{ flex: 1 }} />)}
              <Block label="Eject" small outline onPress={() => s.setTake(null)} style={{ flex: 1 }} />
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
    <Frame screen="data" onScreen={onScreen} share={0.24}
      over={<View style={{ position: 'absolute', left: 12, bottom: 8 }} pointerEvents="none"><H size={40} color={C.white} style={{ textShadowColor: C.black, textShadowOffset: { width: 3, height: 3 }, textShadowRadius: 0 } as any}>Data</H></View>}>
      <ScrollView contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
        <T size={11} semi caps>Source · {feed.word} · {feed.detail}</T>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
          <View style={st.field}><TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.grey} /></View>
          <Block label="Connect" small onPress={() => s.connect(url)} />
          <Block label="Sim" small outline onPress={() => s.useSimulator()} />
        </View>
        <T size={11} semi caps style={{ marginTop: 16, marginBottom: 4 }}>Channels · wire name ≠ mechanical name</T>
        {FINGERS.map((f) => (
          <View key={f} style={{ flexDirection: 'row', gap: 4, marginBottom: 4 }}>
            <H size={16} style={{ width: 70, paddingTop: 8 }}>{FINGER_NAME[f]}</H>
            {JOINTS.map((j) => {
              const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
              return (
                <View key={j.key} style={[st.cell, { alignItems: 'flex-start', paddingHorizontal: 8 }, Math.abs(v) > j.max && { backgroundColor: C.orange }]}>
                  <T size={9} semi caps color={C.concrete2}>{f}_{j.wire}</T>
                  <H size={22} color={on ? C.concrete : C.grey}>{on ? `${v.toFixed(1)}°` : '–'}</H>
                </View>
              );
            })}
          </View>
        ))}
        <T size={11} semi caps style={{ marginTop: 16 }}>Rates · four numbers, not one</T>
        {RATES.map((r) => (
          <View key={r.what} style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 2, borderColor: C.black, paddingVertical: 6 }}>
            <H size={18} style={{ width: 150 }}>{r.what}</H>
            <T size={11} style={{ flex: 1 }}>{r.note}</T>
            <H size={22}>{r.rate}</H>
          </View>
        ))}
        <T size={11} semi caps color={C.grey} style={{ marginTop: 10 }}>Research prototype · not a medical device</T>
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
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8 },
  nav: { flexDirection: 'row', borderTopWidth: 3, borderColor: C.black },
  navItem: { flex: 1, height: 64, alignItems: 'center', justifyContent: 'center', borderRightWidth: 3, borderColor: C.black },
  block: { height: 56, backgroundColor: C.black, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, borderWidth: 3, borderColor: C.black },
  blockOutline: { backgroundColor: 'transparent' },
  tile: { padding: 10, justifyContent: 'space-between' },
  cell: { flex: 1, height: 44, backgroundColor: C.black, alignItems: 'center', justifyContent: 'center' },
  take: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 3, borderColor: C.black },
  field: { flex: 1, height: 40, borderWidth: 3, borderColor: C.black, justifyContent: 'center', paddingHorizontal: 10 },
  input: { fontFamily: 'LibreFranklin_600SemiBold', fontSize: 13, color: C.black },
});

export const design: Design = {
  id: '38', slug: 'brutal', name: 'Concrete',
  thesis: 'Brutalism: cast iron on a concrete slab under a hard sun, monumental type set straight over the image, black blocks for controls, three huge words as the navigation.',
  fonts: { Anton_400Regular, LibreFranklin_400Regular, LibreFranklin_600SemiBold },
  bg: CONCRETE, statusBar: 'dark-content', App: Shell,
};
