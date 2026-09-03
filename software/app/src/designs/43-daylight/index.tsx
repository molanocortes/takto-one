// 43-daylight - white sheets in the open air.
//
// A sky gradient behind a chrome hand, and three white sheets stacked at
// the foot of the screen: Live, Replay and Data are sheets of paper, the
// one in front is open, the two behind peek out above it by their title
// strips; tap a strip and that sheet comes to the front. Outfit, light and
// airy, sky blue as the one colour.
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Polyline, Rect, Circle, Line } from 'react-native-svg';
import { Outfit_300Light } from '@expo-google-fonts/outfit/300Light';
import { Outfit_500Medium } from '@expo-google-fonts/outfit/500Medium';
import { Outfit_700Bold } from '@expo-google-fonts/outfit/700Bold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin } from './twin';

const C = { skyTop: '#5B9BE0', skyMid: '#BBD7F3', skyLow: '#F2F6FA', white: '#FFFFFF', ink: '#1D2B3A', ink2: '#5C6B7A', ink3: '#98A5B2', line: '#E6ECF2', blue: '#3E8FD8', blueSoft: '#E4F0FB', warm: '#E0A35A' };
const F = { light: 'Outfit_300Light', medium: 'Outfit_500Medium', bold: 'Outfit_700Bold' };
const SHADOW = { boxShadow: '0 -8px 30px rgba(29,43,58,0.10), 0 2px 6px rgba(29,43,58,0.06)' } as any;
const PILL_SHADOW = { boxShadow: '0 6px 16px rgba(62,143,216,0.35)' } as any;

function T({ children, size = 15, weight = 'medium', color = C.ink, style, align, lh, tracking }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; style?: StyleProp<TextStyle>; align?: 'left' | 'center' | 'right'; lh?: number; tracking?: number;
}) {
  return <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: lh ?? Math.round(size * (size > 30 ? 1.05 : 1.35)), letterSpacing: tracking ?? (size > 30 ? -size * 0.02 : 0), fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}

/** A pill: solid sky blue with white text, or white with blue text and a soft edge. */
function Pill({ label, onPress, primary, style, on, glyph }: { label: string; onPress?: () => void; primary?: boolean; style?: StyleProp<ViewStyle>; on?: boolean; glyph?: React.ReactNode }) {
  const solid = primary || on;
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [st.pill, solid ? [{ backgroundColor: pressed ? '#2F7CC2' : C.blue }, PILL_SHADOW] : { backgroundColor: pressed ? C.blueSoft : C.white, borderWidth: 1, borderColor: C.line }, style]}>
      {glyph}
      {!!label && <T size={15} weight="medium" color={solid ? C.white : C.blue}>{label}</T>}
    </Pressable>
  );
}
const Glyph = ({ kind, color = C.blue }: { kind: 'play' | 'pause' | 'start' | 'end' | 'eject' | 'arrow'; color?: string }) => (
  <Svg width={14} height={14} viewBox="0 0 16 16">
    {kind === 'play' && <Path d="M4 2.5 L13.5 8 L4 13.5 Z" fill={color} />}
    {kind === 'pause' && <Path d="M4 3 H6.5 V13 H4 Z M9.5 3 H12 V13 H9.5 Z" fill={color} />}
    {kind === 'start' && <Path d="M3 3 H5 V13 H3 Z M13 3 L6 8 L13 13 Z" fill={color} />}
    {kind === 'end' && <Path d="M11 3 H13 V13 H11 Z M3 3 L10 8 L3 13 Z" fill={color} />}
    {kind === 'eject' && <Path d="M3 10 L8 4 L13 10 Z M3 12 H13 V14 H3 Z" fill={color} />}
    {kind === 'arrow' && <Path d="M2 8 H14 M9 3 L14 8 L9 13" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
  </Svg>
);

/** A soft ring gauge. */
function Ring({ frac, size = 64, absent, children, hot }: { frac: number; size?: number; absent?: boolean; children?: React.ReactNode; hot?: boolean }) {
  const r = size / 2 - 4, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.line} strokeWidth={6} fill="none" />
        {!absent && v > 0.004 && <Circle cx={size / 2} cy={size / 2} r={r} stroke={hot ? C.warm : C.blue} strokeWidth={6} fill="none" strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      </Svg>
      {children}
    </View>
  );
}
function Chart({ values, width, height, played }: { values: number[]; width: number; height: number; played?: number }) {
  const n = values.length;
  const pts = values.map((v, i) => [((i / Math.max(1, n - 1)) * width), (height - 2 - Math.max(0, Math.min(1, v)) * (height - 4))]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      {n > 1 && <Path d={`${line} L ${width} ${height} L 0 ${height} Z`} fill={C.blueSoft} />}
      {n > 1 && <Path d={line} stroke={C.blue} strokeWidth={2} fill="none" strokeLinejoin="round" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill="rgba(62,143,216,0.10)" /><Line x1={played * width} x2={played * width} y1={0} y2={height} stroke={C.ink} strokeWidth={2} /></>}
    </Svg>
  );
}

/* ---------- the sheet stack ---------- */

const SHEETS: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'Live' }, { key: 'replay', label: 'Replay' }, { key: 'data', label: 'Data' }];
const PEEK = 30;

function Stack({ screen, onScreen, children, share = 0.5 }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; share?: number }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  const behind = SHEETS.filter((x) => x.key !== screen);
  const front = SHEETS.find((x) => x.key === screen)!;
  const sheetH = height * share;
  return (
    <View style={{ flex: 1 }}>
      <LinearGradient colors={[C.skyTop, C.skyMid, C.skyLow]} locations={[0, 0.55, 1]} style={StyleSheet.absoluteFill} />
      <Stage spec={twin} style={[StyleSheet.absoluteFill, { top: inset.top + 30, bottom: sheetH - 20 }]} />
      <View style={[st.head, { top: inset.top + 10 }]} pointerEvents="none">
        <T size={13} weight="bold" color={C.white} tracking={1.5}>TAKTO ONE</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.35)', paddingHorizontal: 10, height: 26, borderRadius: 13 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: feed.live ? '#4ADE80' : C.warm }} />
          <T size={12} weight="medium" color={C.ink}>{feed.word} · {st_.liveJoints}/12</T>
        </View>
      </View>
      {/* the sheets behind, peeking */}
      {behind.map((sh, i) => (
        <Pressable key={sh.key} onPress={() => onScreen(sh.key)} style={[st.sheet, SHADOW, { height: sheetH + PEEK * (behind.length - i), bottom: 0, marginHorizontal: 10 + 6 * (behind.length - i), opacity: 0.92 }]}>
          <View style={st.strip}><T size={14} weight="medium" color={C.ink2}>{sh.label}</T><T size={12} color={C.ink3}>tap to open</T></View>
        </Pressable>
      ))}
      {/* the sheet in front */}
      <View style={[st.sheet, SHADOW, { height: sheetH, bottom: 0, marginHorizontal: 10 }]}>
        <View style={st.strip}><T size={20} weight="bold">{front.label}</T><View style={st.grip} /></View>
        <View style={{ flex: 1, paddingBottom: inset.bottom }}>{children}</View>
      </View>
    </View>
  );
}

function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  return (
    <View style={{ flex: 1 }}>
      <LinearGradient colors={[C.skyTop, C.skyMid, C.skyLow]} locations={[0, 0.55, 1]} style={StyleSheet.absoluteFill} />
      <Stage spec={twin} style={[StyleSheet.absoluteFill, { top: inset.top + 20, bottom: height * 0.36 }]} />
      <View style={[st.head, { top: inset.top + 10 }]} pointerEvents="none">
        <T size={13} weight="bold" color={C.white} tracking={1.5}>TAKTO ONE</T>
        <T size={12} weight="medium" color={C.white}>{feed.word}</T>
      </View>
      <View style={[st.sheet, SHADOW, { height: height * 0.4, bottom: 0, marginHorizontal: 10, padding: 22, paddingBottom: inset.bottom + 20 }]}>
        <T size={13} weight="medium" color={C.blue}>Companion · research prototype</T>
        <T size={40} weight="light" lh={42} style={{ marginTop: 4 }}>Every joint,{'\n'}in daylight.</T>
        <T size={14} weight="light" color={C.ink2} style={{ marginTop: 8 }}>The TAKTO ONE hand, live from the device or from a recorded take. Twelve joints and an effort channel.</T>
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pill label="Start session" primary onPress={onStart} style={{ flex: 1.3 }} glyph={<Glyph kind="arrow" color={C.white} />} />
          <Pill label="Connect" onPress={onConnect} style={{ flex: 1 }} />
        </View>
        <T size={11} weight="light" color={C.ink3} style={{ marginTop: 12 }}>Not a medical device. The feed is synthetic: no hand wore the device.</T>
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
    <Stack screen="live" onScreen={onScreen} share={all ? 0.62 : 0.5}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingTop: 6 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <Ring frac={st_.mean / 110} size={92} hot={st_.mean > 90}><T size={30} weight="light">{st_.mean.toFixed(0)}<T size={14} weight="light" color={C.ink3}>°</T></T></Ring>
          <View style={{ flex: 1 }}>
            <T size={13} color={C.ink2}>Mean flexion</T>
            <T size={13} weight="light" color={C.ink3}>Peak {FINGER_NAME[st_.peakFinger].toLowerCase()} {st_.peak.toFixed(0)}° · {st_.blendWord.toLowerCase()}</T>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
              <T size={26} weight="light" color={st_.emg > 0.8 ? C.warm : C.ink}>{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T>
              <T size={13} color={C.ink2}>effort</T>
            </View>
          </View>
          <Chart values={hist.values} width={90} height={40} />
        </View>
        {!all ? (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 }}>
              {FINGERS.map((f) => (
                <View key={f} style={{ alignItems: 'center' }}>
                  <Ring frac={st_.curl[f]} size={62} absent={!(frame.ok[f].mcp || frame.ok[f].pip)} hot={st_.curl[f] > 0.82}><T size={17} weight="light">{(st_.curl[f] * 100).toFixed(0)}</T></Ring>
                  <T size={12} color={C.ink2} style={{ marginTop: 4 }}>{FINGER_NAME[f]}</T>
                </View>
              ))}
            </View>
            <View style={{ alignItems: 'flex-end', marginTop: 12 }}><Pill label="All twelve joints" onPress={() => setAll(true)} /></View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <T size={13} color={C.ink2}>Twelve joints · degrees</T>
              <Pill label="Fingers" onPress={() => setAll(false)} />
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, borderTopWidth: 1, borderColor: C.line, paddingTop: 6 }}>
                <T size={13} color={C.ink2} style={{ width: 60 }}>{FINGER_NAME[f]}</T>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return (
                    <View key={j.key} style={{ flex: 1, alignItems: 'center' }}>
                      <Ring frac={j.signed ? (v + j.max) / (2 * j.max) : v / j.max} size={50} absent={!on} hot={Math.abs(v) > j.max * 0.9}><T size={13} weight="light">{fmtDeg(v, on, j.signed)}</T></Ring>
                      <T size={10} color={C.ink3}>{j.short}</T>
                    </View>
                  );
                })}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </Stack>
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
    <Stack screen="replay" onScreen={onScreen} share={0.5}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingTop: 6 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            <T size={13} color={C.ink2}>Recorded takes · choreographed samples, not a person</T>
            {takes.map((t) => (
              <View key={t.id} style={st.row}>
                <View style={{ flex: 1 }}>
                  <T size={18} weight="light">{t.title}</T>
                  <T size={12} color={C.ink3}>{t.note} · {t.durationS.toFixed(0)} s</T>
                </View>
                <Pill label="" primary onPress={() => s.setTake(t)} glyph={<Glyph kind="play" color={C.white} />} style={{ width: 44, paddingHorizontal: 0 }} />
              </View>
            ))}
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <View><T size={13} color={C.ink2}>{play.take.title}</T><T size={40} weight="light">{clock(play.t)}</T></View>
              <T size={13} color={C.ink3} style={{ paddingBottom: 8 }}>of {clock(play.take.durationS)} · {play.speed}×</T>
            </View>
            <View style={{ marginTop: 6 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <Chart values={trace} width={width - 20 - 44} height={52} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
              <Pill label="" onPress={() => s.seek(0)} glyph={<Glyph kind="start" />} style={{ width: 44, paddingHorizontal: 0 }} />
              <Pill label={play.playing ? 'Pause' : 'Play'} primary onPress={() => s.togglePlay()} glyph={<Glyph kind={play.playing ? 'pause' : 'play'} color={C.white} />} />
              <Pill label="" onPress={() => s.seek(play.take.durationS)} glyph={<Glyph kind="end" />} style={{ width: 44, paddingHorizontal: 0 }} />
              {[0.5, 1, 2].map((k) => <Pill key={k} label={`${k}×`} on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
              <Pill label="" onPress={() => s.setTake(null)} glyph={<Glyph kind="eject" />} style={{ width: 44, paddingHorizontal: 0 }} />
            </View>
          </>
        )}
      </ScrollView>
    </Stack>
  );
}

function Data({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const feed = feedWord(s);
  return (
    <Stack screen="data" onScreen={onScreen} share={0.66}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingTop: 6 }} showsVerticalScrollIndicator={false}>
        <T size={13} color={C.ink2}>Source · {feed.word}, {feed.detail}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.ink3} />
          <Pill label="Connect" primary onPress={() => s.connect(url)} />
          <Pill label="Sim" onPress={() => s.useSimulator()} />
        </View>
        <T size={13} color={C.ink2} style={{ marginTop: 18 }}>Channels · wire name and mechanical name</T>
        {FINGERS.map((f) => (
          <View key={f} style={[st.row, { gap: 6 }]}>
            <T size={13} color={C.ink2} style={{ width: 58 }}>{FINGER_NAME[f]}</T>
            {JOINTS.map((j) => {
              const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
              return <View key={j.key} style={{ flex: 1 }}><T size={18} weight="light" color={!on ? C.ink3 : Math.abs(v) > j.max ? C.warm : C.ink}>{on ? `${v.toFixed(1)}°` : '–'}</T><T size={10} color={C.ink3}>{f}_{j.wire}</T></View>;
            })}
          </View>
        ))}
        <T size={13} color={C.ink2} style={{ marginTop: 18 }}>Rates · four numbers, not one</T>
        {RATES.map((r) => (
          <View key={r.what} style={st.row}>
            <T size={15} style={{ width: 130 }}>{r.what}</T>
            <T size={12} weight="light" color={C.ink2} style={{ flex: 1 }}>{r.note}</T>
            <T size={17} weight="light">{r.rate}</T>
          </View>
        ))}
        <T size={11} weight="light" color={C.ink3} style={{ marginVertical: 12 }}>Research prototype. Not a medical device.</T>
      </ScrollView>
    </Stack>
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
  head: { position: 'absolute', left: 20, right: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sheet: { position: 'absolute', left: 0, right: 0, backgroundColor: C.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  strip: { height: PEEK + 16, paddingHorizontal: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  grip: { width: 36, height: 4, borderRadius: 2, backgroundColor: C.line },
  pill: { height: 44, borderRadius: 22, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderColor: C.line },
  input: { flex: 1, height: 44, borderRadius: 22, backgroundColor: C.skyLow, paddingHorizontal: 16, fontFamily: 'Outfit_500Medium', fontSize: 14, color: C.ink },
});

export const design: Design = {
  id: '43', slug: 'daylight', name: 'Daylight',
  thesis: 'Open air: a chrome hand mirroring a sky gradient, and three white sheets stacked at the foot of the screen, the front one open, the others peeking, as the navigation.',
  fonts: { Outfit_300Light, Outfit_500Medium, Outfit_700Bold },
  bg: '#BBD7F3', statusBar: 'light-content', App: Shell,
};
