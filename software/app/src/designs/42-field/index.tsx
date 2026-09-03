// 42-field - a colour field.
//
// International Klein Blue edge to edge, a matte white hand casting its
// shadow onto it, and Swiss typography: Work Sans, flush left, huge white
// numerals, hairline white rules, and three words at the top with a bar
// under the one you are on. No boxes, no icons, no second colour: only
// white on blue, and blue on white when a control is pressed.
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Polyline, Rect, Line } from 'react-native-svg';
import { WorkSans_400Regular } from '@expo-google-fonts/work-sans/400Regular';
import { WorkSans_500Medium } from '@expo-google-fonts/work-sans/500Medium';
import { WorkSans_700Bold } from '@expo-google-fonts/work-sans/700Bold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin, IKB } from './twin';

const C = { blue: IKB, white: '#FFFFFF', w2: 'rgba(255,255,255,0.7)', w3: 'rgba(255,255,255,0.45)', w4: 'rgba(255,255,255,0.2)' };
const F = { ui: 'WorkSans_400Regular', medium: 'WorkSans_500Medium', bold: 'WorkSans_700Bold' };
const M = 20;

function T({ children, size = 15, weight = 'ui', color = C.white, style, align, lh, tracking }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; style?: StyleProp<TextStyle>; align?: 'left' | 'center' | 'right'; lh?: number; tracking?: number;
}) {
  return <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: lh ?? Math.round(size * (size > 40 ? 0.95 : 1.3)), letterSpacing: tracking ?? (size > 40 ? -size * 0.04 : 0), fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}
const Rule = ({ style, strong }: { style?: StyleProp<ViewStyle>; strong?: boolean }) => <View style={[{ height: strong ? 2 : 1, backgroundColor: strong ? C.white : C.w4 }, style]} />;

/** A word as a control: bold, white; pressed, it inverts to a white block with blue text. */
function Word({ label, onPress, on, size = 16, style }: { label: string; onPress?: () => void; on?: boolean; size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [st.word, (on || pressed) && { backgroundColor: C.white }, style]}>
      {({ pressed }) => <T size={size} weight="bold" color={on || pressed ? C.blue : C.white}>{label}</T>}
    </Pressable>
  );
}
/** The primary: a white block. */
function Block({ label, onPress, style }: { label: string; onPress?: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.blockBtn, pressed && { backgroundColor: C.w2 }, style]}>
      <T size={18} weight="bold" color={C.blue}>{label}</T>
      <T size={18} weight="bold" color={C.blue}>→</T>
    </Pressable>
  );
}

function Bar({ frac, absent }: { frac: number; absent?: boolean }) {
  return (
    <View style={{ height: 8, backgroundColor: C.w4 }}>
      {!absent && <View style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%`, height: 8, backgroundColor: C.white }} />}
    </View>
  );
}
function Chart({ values, width, height, played }: { values: number[]; width: number; height: number; played?: number }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 1 - Math.max(0, Math.min(1, v)) * (height - 2)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      <Line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} stroke={C.w3} strokeWidth={1} />
      {n > 1 && <Polyline points={pts} stroke={C.white} strokeWidth={2} fill="none" strokeLinejoin="round" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill="rgba(255,255,255,0.15)" /><Rect x={played * width - 1} y={0} width={2} height={height} fill={C.white} /></>}
    </Svg>
  );
}

const TABS: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'Live' }, { key: 'replay', label: 'Replay' }, { key: 'data', label: 'Data' }];

function Field({ screen, onScreen, children, share = 0.42 }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; share?: number }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.blue, paddingTop: inset.top }}>
      <View style={st.tabs}>
        {TABS.map((t) => {
          const on = t.key === screen;
          return (
            <Pressable key={t.key} onPress={() => onScreen(t.key)} hitSlop={8} style={{ marginRight: 22 }}>
              <T size={17} weight={on ? 'bold' : 'ui'} color={on ? C.white : C.w2}>{t.label}</T>
              <View style={{ height: 3, marginTop: 4, backgroundColor: on ? C.white : 'transparent' }} />
            </Pressable>
          );
        })}
        <View style={{ flex: 1 }} />
        <T size={11} weight="medium" color={C.w2} style={{ paddingTop: 3 }}>{feed.word} · {st_.liveJoints}/12</T>
      </View>
      <View style={{ height: height * share }}><Stage spec={twin} style={StyleSheet.absoluteFill} /></View>
      <View style={{ flex: 1, paddingBottom: inset.bottom }}>{children}</View>
    </View>
  );
}

function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  return (
    <View style={{ flex: 1, backgroundColor: C.blue, paddingTop: inset.top }}>
      <View style={[st.tabs, { justifyContent: 'space-between' }]}>
        <T size={12} weight="bold" tracking={1}>TAKTO ONE</T>
        <T size={11} weight="medium" color={C.w2}>{feed.word}</T>
      </View>
      <View style={{ height: height * 0.5 }}><Stage spec={twin} style={StyleSheet.absoluteFill} /></View>
      <View style={{ flex: 1, paddingHorizontal: M }}>
        <T size={56} weight="bold" lh={54}>Every{'\n'}joint.</T>
        <T size={15} color={C.w2} style={{ marginTop: 12, maxWidth: 300 }}>A digital twin of the TAKTO ONE hand, live from the device or from a recorded take. Twelve joints, one effort channel. Research prototype, not a medical device.</T>
        <View style={{ flex: 1 }} />
        <Block label="Start session" onPress={onStart} />
        <Pressable onPress={onConnect} hitSlop={8} style={{ marginTop: 14, marginBottom: inset.bottom + 16, flexDirection: 'row', justifyContent: 'space-between' }}>
          <T size={15} weight="medium">Connect a device</T><T size={15} weight="medium">→</T>
        </Pressable>
      </View>
    </View>
  );
}

function Live({ detail, onScreen }: { detail: boolean; onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const [table, setTable] = useState(detail);
  const hist = useRef(new History(60)).current;
  hist.push(st_.emg);
  const { width } = useWindowDimensions();
  return (
    <Field screen="live" onScreen={onScreen} share={table ? 0.3 : 0.4}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: M }} showsVerticalScrollIndicator={false}>
        <Rule strong />
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingVertical: 8 }}>
          <View>
            <T size={72} weight="bold" lh={70}>{st_.mean.toFixed(0)}°</T>
            <T size={12} weight="medium" color={C.w2}>Mean flexion · peak {FINGER_NAME[st_.peakFinger]} {st_.peak.toFixed(0)}°</T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T size={30} weight="bold">{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T>
            <T size={12} weight="medium" color={C.w2}>Effort · {st_.blendWord}</T>
          </View>
        </View>
        <Rule />
        {!table ? (
          <>
            {FINGERS.map((f) => {
              const live = frame.ok[f].mcp || frame.ok[f].pip;
              return (
                <View key={f}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 }}>
                    <T size={14} weight="medium" style={{ width: 64 }}>{FINGER_NAME[f]}</T>
                    <View style={{ flex: 1 }}><Bar frac={st_.curl[f]} absent={!live} /></View>
                    <T size={16} weight="bold" style={{ width: 40, textAlign: 'right' }} color={live ? C.white : C.w3}>{live ? (st_.curl[f] * 100).toFixed(0) : '–'}</T>
                  </View>
                  <Rule />
                </View>
              );
            })}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingTop: 10 }}>
              <View><T size={11} weight="medium" color={C.w2}>Effort, last seconds</T><Chart values={hist.values} width={width - M * 2 - 140} height={36} /></View>
              <Word label="Twelve joints" onPress={() => setTable(true)} />
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}>
              <T size={12} weight="medium" color={C.w2}>Twelve joints · degrees</T>
              <Word label="Fingers" onPress={() => setTable(false)} />
            </View>
            <View style={{ flexDirection: 'row', paddingBottom: 4 }}>
              <View style={{ width: 64 }} />
              {JOINTS.map((j) => <T key={j.key} size={11} weight="medium" color={C.w2} style={{ flex: 1, textAlign: 'right' }}>{j.short} /{j.max}</T>)}
            </View>
            <Rule />
            {FINGERS.map((f) => (
              <View key={f}>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
                  <T size={14} weight="medium" style={{ width: 64 }}>{FINGER_NAME[f]}</T>
                  {JOINTS.map((j) => {
                    const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                    return <T key={j.key} size={24} weight="bold" color={on ? C.white : C.w3} style={{ flex: 1, textAlign: 'right' }}>{fmtDeg(v, on, j.signed)}</T>;
                  })}
                </View>
                <Rule />
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </Field>
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
    <Field screen="replay" onScreen={onScreen} share={0.4}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: M }} showsVerticalScrollIndicator={false}>
        <Rule strong />
        {!play ? (
          <>
            <T size={12} weight="medium" color={C.w2} style={{ paddingVertical: 8 }}>Recorded takes · choreographed samples, not a person</T>
            {takes.map((t) => (
              <Pressable key={t.id} onPress={() => s.setTake(t)} style={({ pressed }) => [pressed && { backgroundColor: 'rgba(255,255,255,0.12)' }]}>
                <Rule />
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12 }}>
                  <View style={{ flex: 1 }}>
                    <T size={26} weight="bold">{t.title}</T>
                    <T size={12} color={C.w2}>{t.note}</T>
                  </View>
                  <T size={20} weight="bold">{t.durationS.toFixed(0)} s</T>
                  <T size={20} weight="bold" style={{ marginLeft: 14 }}>→</T>
                </View>
              </Pressable>
            ))}
            <Rule />
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingVertical: 8 }}>
              <View><T size={64} weight="bold" lh={62}>{clock(play.t)}</T><T size={12} weight="medium" color={C.w2}>{play.take.title} · of {clock(play.take.durationS)}</T></View>
              <T size={30} weight="bold">{play.speed}×</T>
            </View>
            <Rule />
            <View style={{ paddingVertical: 10 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <Chart values={trace} width={width - M * 2} height={48} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <Rule />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 12 }}>
              <Word label="|◀" onPress={() => s.seek(0)} />
              <Word label={play.playing ? 'Pause' : 'Play'} on onPress={() => s.togglePlay()} />
              <Word label="▶|" onPress={() => s.seek(play.take.durationS)} />
              {[0.5, 1, 2].map((k) => <Word key={k} label={`${k}×`} on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
              <Word label="Eject" onPress={() => s.setTake(null)} />
            </View>
          </>
        )}
      </ScrollView>
    </Field>
  );
}

function Data({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const feed = feedWord(s);
  return (
    <Field screen="data" onScreen={onScreen} share={0.26}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: M }} showsVerticalScrollIndicator={false}>
        <Rule strong />
        <T size={12} weight="medium" color={C.w2} style={{ paddingTop: 8 }}>Source · {feed.word}, {feed.detail}</T>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingVertical: 8 }}>
          <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.w3} />
          <Word label="Connect" on onPress={() => s.connect(url)} />
          <Word label="Sim" onPress={() => s.useSimulator()} />
        </View>
        <Rule />
        <T size={12} weight="medium" color={C.w2} style={{ paddingTop: 12 }}>Channels · wire name and mechanical name</T>
        {FINGERS.map((f) => (
          <View key={f}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
              <T size={14} weight="medium" style={{ width: 64 }}>{FINGER_NAME[f]}</T>
              {JOINTS.map((j) => {
                const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                return <View key={j.key} style={{ flex: 1, alignItems: 'flex-end' }}><T size={18} weight="bold" color={on ? C.white : C.w3}>{on ? `${v.toFixed(1)}°` : '–'}</T><T size={9} color={C.w3}>{f}_{j.wire}</T></View>;
              })}
            </View>
            <Rule />
          </View>
        ))}
        <T size={12} weight="medium" color={C.w2} style={{ paddingTop: 12 }}>Rates · four numbers, not one</T>
        {RATES.map((r) => (
          <View key={r.what}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 8 }}>
              <T size={14} weight="medium" style={{ width: 130 }}>{r.what}</T>
              <T size={11} color={C.w2} style={{ flex: 1 }}>{r.note}</T>
              <T size={18} weight="bold">{r.rate}</T>
            </View>
            <Rule />
          </View>
        ))}
        <T size={11} color={C.w3} style={{ paddingVertical: 12 }}>Research prototype. Not a medical device.</T>
      </ScrollView>
    </Field>
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
  tabs: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: M, paddingTop: 10, paddingBottom: 6 },
  word: { paddingHorizontal: 10, height: 36, justifyContent: 'center', borderWidth: 2, borderColor: C.white },
  blockBtn: { height: 60, backgroundColor: C.white, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: { flex: 1, height: 40, borderBottomWidth: 2, borderColor: C.white, fontFamily: 'WorkSans_500Medium', fontSize: 15, color: C.white },
});

export const design: Design = {
  id: '42', slug: 'field', name: 'Blue field',
  thesis: 'A colour field: International Klein Blue edge to edge, a matte white hand and its shadow, Swiss typography, and three words at the top as the navigation.',
  fonts: { WorkSans_400Regular, WorkSans_500Medium, WorkSans_700Bold },
  bg: IKB, statusBar: 'light-content', App: Shell,
};
