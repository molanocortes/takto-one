// 44-cutaway - a sectioned drawing with callouts.
//
// Navy. The hand is cut open by a clipping plane so the slides and pins
// inside are visible, and the readings are engineering callouts: boxed
// labels with a leader line and a dot at its end. Navigation is a strip of
// vertical section tabs down the left edge, A-A, B-B, C-C, the way a
// drawing indexes its sections. IBM Plex Mono.
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Line, Circle, Polyline, Rect } from 'react-native-svg';
import { IBMPlexMono_400Regular } from '@expo-google-fonts/ibm-plex-mono/400Regular';
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import { IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono/600SemiBold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin, NAVY } from './twin';

const C = { navy: NAVY, navy2: '#12213F', text: '#E6EEF8', t2: 'rgba(230,238,248,0.62)', t3: 'rgba(230,238,248,0.35)', line: 'rgba(230,238,248,0.18)', cyan: '#22D3EE', orange: '#FF7A1A', cyanSoft: 'rgba(34,211,238,0.14)' };
const F = { ui: 'IBMPlexMono_400Regular', medium: 'IBMPlexMono_500Medium', semi: 'IBMPlexMono_600SemiBold' };
const RAIL = 34;

function T({ children, size = 12, weight = 'ui', color = C.text, style, caps, align, tracking }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; style?: StyleProp<TextStyle>; caps?: boolean; align?: 'left' | 'center' | 'right'; tracking?: number;
}) {
  return <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: Math.round(size * 1.35), textTransform: caps ? 'uppercase' : 'none', letterSpacing: tracking ?? (caps ? 1 : 0), fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}

/** A callout: a boxed label with a leader line to a point. dx, dy: the leader's run from the box's anchor. */
function Callout({ label, value, unit, dx, dy, side = 'left', hot, style }: { label: string; value: string; unit?: string; dx: number; dy: number; side?: 'left' | 'right'; hot?: boolean; style?: StyleProp<ViewStyle> }) {
  const w = Math.abs(dx) + 8, h = Math.abs(dy) + 8;
  const x0 = side === 'left' ? 0 : w, y0 = dy < 0 ? h - 4 : 4;
  const x1 = side === 'left' ? Math.abs(dx) : w - Math.abs(dx), y1 = dy < 0 ? 4 : h - 4;
  return (
    <View style={[{ flexDirection: side === 'left' ? 'row' : 'row-reverse', alignItems: dy < 0 ? 'flex-end' : 'flex-start' }, style]}>
      <View style={[st.callout, hot && { borderColor: C.orange }]}>
        <T size={8.5} caps color={C.t2}>{label}</T>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
          <T size={18} weight="semi" color={hot ? C.orange : C.text}>{value}</T>
          {unit && <T size={9} color={C.t2}>{unit}</T>}
        </View>
      </View>
      <Svg width={w} height={h}>
        <Line x1={x0} y1={y0} x2={x1} y2={y1} stroke={hot ? C.orange : C.cyan} strokeWidth={1} />
        <Circle cx={x1} cy={y1} r={2.5} fill={hot ? C.orange : C.cyan} />
      </Svg>
    </View>
  );
}

/** A boxed command with a cyan corner tick. Pressed: cyan fill, navy text. */
function Cmd({ label, onPress, on, style, small }: { label: string; onPress?: () => void; on?: boolean; style?: StyleProp<ViewStyle>; small?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [st.cmd, small && { height: 30, paddingHorizontal: 10 }, (on || pressed) && { backgroundColor: C.cyan, borderColor: C.cyan }, style]}>
      {({ pressed }) => (
        <>
          <View style={[st.tick, (on || pressed) && { backgroundColor: C.navy }]} />
          <T size={small ? 10.5 : 12} weight="medium" caps color={on || pressed ? C.navy : C.text}>{label}</T>
        </>
      )}
    </Pressable>
  );
}

function Bar({ frac, absent }: { frac: number; absent?: boolean }) {
  const v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ height: 6, backgroundColor: C.line }}>
      {!absent && <View style={{ width: `${v * 100}%`, height: 6, backgroundColor: v > 0.82 ? C.orange : C.cyan }} />}
    </View>
  );
}
function Trace({ values, width, height, played }: { values: number[]; width: number; height: number; played?: number }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 1 - Math.max(0, Math.min(1, v)) * (height - 2)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      <Rect x={0.5} y={0.5} width={width - 1} height={height - 1} stroke={C.line} strokeWidth={1} fill="none" />
      {n > 1 && <Polyline points={pts} stroke={C.cyan} strokeWidth={1.25} fill="none" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill={C.cyanSoft} /><Line x1={played * width} x2={played * width} y1={0} y2={height} stroke={C.orange} strokeWidth={1.5} /></>}
    </Svg>
  );
}

/* ---------- frame ---------- */

const SECTIONS: { key: ScreenKey; mark: string; label: string }[] = [
  { key: 'live', mark: 'A-A', label: 'Live' }, { key: 'replay', mark: 'B-B', label: 'Replay' }, { key: 'data', mark: 'C-C', label: 'Data' },
];

function Frame({ screen, onScreen, children, share = 0.46, over }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; share?: number; over?: React.ReactNode }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.navy, flexDirection: 'row' }}>
      {/* the section tabs down the left edge */}
      <View style={[st.rail, { paddingTop: inset.top + 8, paddingBottom: inset.bottom + 8 }]}>
        <T size={9} weight="semi" color={C.t2} style={{ transform: [{ rotate: '-90deg' }], width: 60, marginLeft: -13, marginTop: 24 }} align="center">TAKTO</T>
        <View style={{ flex: 1 }} />
        {SECTIONS.map((sec) => {
          const on = sec.key === screen;
          return (
            <Pressable key={sec.key} onPress={() => onScreen(sec.key)} style={({ pressed }) => [st.tab, (on || pressed) && { backgroundColor: C.cyan }]}>
              {({ pressed }) => (
                <View style={{ transform: [{ rotate: '-90deg' }], width: 96, alignItems: 'center' }}>
                  <T size={9.5} weight="semi" color={on || pressed ? C.navy : C.t2} tracking={1}>{sec.mark} {sec.label.toUpperCase()}</T>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1 }}>
        <View style={[st.head, { paddingTop: inset.top + 8 }]}>
          <T size={9.5} caps color={C.t2}>Section {SECTIONS.find((x) => x.key === screen)?.mark} · {SECTIONS.find((x) => x.key === screen)?.label}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 6, height: 6, backgroundColor: feed.live ? C.cyan : C.orange }} />
            <T size={9.5} caps color={C.t2}>{feed.word} · {st_.liveJoints}/12</T>
          </View>
        </View>
        <View style={{ height: height * share }}>
          <Stage spec={twin} style={StyleSheet.absoluteFill} />
          {over}
        </View>
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
    <View style={{ flex: 1, backgroundColor: C.navy, paddingTop: inset.top }}>
      <View style={[st.head, { paddingTop: 8 }]}>
        <T size={9.5} caps color={C.t2}>Takto one · companion</T>
        <T size={9.5} caps color={C.orange}>{feed.word}</T>
      </View>
      <View style={{ height: height * 0.54 }}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', left: 12, bottom: 12 }} pointerEvents="none">
          <Callout label="Section A-A" value="12" unit="joints" dx={40} dy={-30} />
        </View>
      </View>
      <View style={{ flex: 1, paddingHorizontal: 20 }}>
        <T size={9.5} caps color={C.cyan}>Cutaway · the mechanism inside</T>
        <T size={28} weight="semi" style={{ marginTop: 4 }}>TAKTO ONE</T>
        <T size={11.5} color={C.t2} style={{ marginTop: 6 }}>Every joint of the hand, sectioned live from the device or from a recorded take. The telescopic slides, the pins and the encoder boards, seen from inside.</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 18 }}>
          <Cmd label="Start session" on onPress={onStart} style={{ flex: 1.3 }} />
          <Cmd label="Connect" onPress={onConnect} style={{ flex: 1 }} />
        </View>
        <View style={{ flex: 1 }} />
        <T size={9} color={C.t3} style={{ marginBottom: inset.bottom + 14 }}>RESEARCH PROTOTYPE · NOT A MEDICAL DEVICE · NO HAND WORE THE DEVICE TO MAKE THE FEED</T>
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
  const w = width - RAIL - 32;
  return (
    <Frame screen="live" onScreen={onScreen} share={table ? 0.34 : 0.46}
      over={<>
        <View style={{ position: 'absolute', left: 10, top: 14 }} pointerEvents="none"><Callout label="Mean flexion" value={st_.mean.toFixed(0)} unit="deg" dx={54} dy={40} hot={st_.mean > 90} /></View>
        <View style={{ position: 'absolute', right: 10, top: 14 }} pointerEvents="none"><Callout label="Effort" value={st_.emg < 0 ? '–' : st_.emg.toFixed(2)} unit={st_.blendWord.toLowerCase()} dx={40} dy={56} side="right" hot={st_.emg > 0.8} /></View>
        <View style={{ position: 'absolute', left: 10, bottom: 10 }} pointerEvents="none"><Callout label={`Peak · ${FINGER_NAME[st_.peakFinger]}`} value={st_.peak.toFixed(0)} unit="deg" dx={70} dy={-36} /></View>
        <View style={{ position: 'absolute', right: 10, bottom: 10 }} pointerEvents="none"><Callout label="Pins · encoders" value={`${st_.liveJoints}`} unit="/12" dx={50} dy={-50} side="right" /></View>
      </>}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }} showsVerticalScrollIndicator={false}>
        {!table ? (
          <>
            {FINGERS.map((f) => {
              const live = frame.ok[f].mcp || frame.ok[f].pip;
              return (
                <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line }}>
                  <T size={10} caps color={C.t2} style={{ width: 56 }}>{FINGER_NAME[f]}</T>
                  <View style={{ flex: 1 }}><Bar frac={st_.curl[f]} absent={!live} /></View>
                  <T size={13} weight="semi" style={{ width: 40, textAlign: 'right' }} color={live ? C.text : C.t3}>{live ? `${(st_.curl[f] * 100).toFixed(0)}%` : '–'}</T>
                </View>
              );
            })}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 10 }}>
              <View style={{ flex: 1 }}><T size={8.5} caps color={C.t2} style={{ marginBottom: 3 }}>Effort · last seconds</T><Trace values={hist.values} width={w - 120} height={36} /></View>
              <Cmd label="12 joints" small onPress={() => setTable(true)} />
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T size={8.5} caps color={C.t2}>Twelve joints · degrees</T>
              <Cmd label="Summary" small onPress={() => setTable(false)} />
            </View>
            <View style={{ flexDirection: 'row', paddingLeft: 56, marginTop: 6 }}>
              {JOINTS.map((j) => <T key={j.key} size={8.5} caps color={C.t3} style={{ flex: 1, textAlign: 'right' }}>{j.short} /{j.max}</T>)}
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: C.line, paddingVertical: 6 }}>
                <T size={10} caps color={C.t2} style={{ width: 56 }}>{FINGER_NAME[f]}</T>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return (
                    <View key={j.key} style={{ flex: 1, alignItems: 'flex-end' }}>
                      <T size={17} weight="semi" color={!on ? C.t3 : Math.abs(v) > j.max * 0.9 ? C.orange : C.text}>{fmtDeg(v, on, j.signed)}</T>
                      <View style={{ width: '80%' }}><Bar frac={j.signed ? (v + j.max) / (2 * j.max) : v / j.max} absent={!on} /></View>
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
  const w = width - RAIL - 32;
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 100) : []), [play?.take.id]);
  return (
    <Frame screen="replay" onScreen={onScreen} share={0.42}
      over={play ? <>
        <View style={{ position: 'absolute', left: 10, top: 14 }} pointerEvents="none"><Callout label={play.take.title} value={clock(play.t)} dx={54} dy={40} /></View>
        <View style={{ position: 'absolute', right: 10, bottom: 10 }} pointerEvents="none"><Callout label="Of" value={clock(play.take.durationS)} unit={`${play.speed}×`} dx={50} dy={-50} side="right" /></View>
      </> : <View style={{ position: 'absolute', left: 10, top: 14 }} pointerEvents="none"><Callout label="Recorded takes" value={String(takes.length)} unit="bundled" dx={54} dy={40} /></View>}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            <T size={8.5} caps color={C.t2}>Choreographed samples, not recordings of a person</T>
            {takes.map((t, i) => (
              <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.line }}>
                <T size={10} color={C.t3} style={{ width: 24 }}>{String(i + 1).padStart(2, '0')}</T>
                <View style={{ flex: 1 }}>
                  <T size={13} weight="semi">{t.title.toUpperCase()}</T>
                  <T size={9.5} color={C.t2}>{t.note}</T>
                </View>
                <T size={11} color={C.t2}>{t.durationS.toFixed(0)}s</T>
                <Cmd label="Load" small onPress={() => s.setTake(t)} />
              </View>
            ))}
          </>
        ) : (
          <>
            <View {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <Trace values={trace} width={w} height={48} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <T size={8.5} caps color={C.t3} style={{ marginTop: 3 }}>Effort over the take · drag to seek</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              <Cmd label="|<" small onPress={() => s.seek(0)} />
              <Cmd label={play.playing ? 'Pause' : 'Play'} small on onPress={() => s.togglePlay()} />
              <Cmd label=">|" small onPress={() => s.seek(play.take.durationS)} />
              {[0.5, 1, 2].map((k) => <Cmd key={k} label={`${k}×`} small on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
              <Cmd label="Eject" small onPress={() => s.setTake(null)} />
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
    <Frame screen="data" onScreen={onScreen} share={0.26}
      over={<View style={{ position: 'absolute', left: 10, top: 10 }} pointerEvents="none"><Callout label="Source" value={feed.word.split(' ')[0]} unit={feed.detail} dx={50} dy={36} /></View>}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <View style={st.field}><TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.t3} /></View>
          <Cmd label="Connect" small on onPress={() => s.connect(url)} />
          <Cmd label="Sim" small onPress={() => s.useSimulator()} />
        </View>
        <T size={8.5} caps color={C.t2} style={{ marginTop: 14 }}>Channels · wire name ≠ mechanical name</T>
        {FINGERS.map((f) => (
          <View key={f} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: C.line, paddingVertical: 6 }}>
            <T size={10} caps color={C.t2} style={{ width: 52 }}>{FINGER_NAME[f]}</T>
            {JOINTS.map((j) => {
              const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
              return <View key={j.key} style={{ flex: 1 }}><T size={14} weight="semi" color={!on ? C.t3 : Math.abs(v) > j.max ? C.orange : C.text}>{on ? `${v.toFixed(1)}°` : '–'}</T><T size={8} color={C.t3}>{f}_{j.wire}</T></View>;
            })}
          </View>
        ))}
        <T size={8.5} caps color={C.t2} style={{ marginTop: 14 }}>Rates · four numbers, not one</T>
        {RATES.map((r) => (
          <View key={r.what} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderColor: C.line, paddingVertical: 6 }}>
            <T size={11} weight="medium" style={{ width: 120 }}>{r.what}</T>
            <T size={9} color={C.t2} style={{ flex: 1 }}>{r.note}</T>
            <T size={13} weight="semi" color={C.cyan}>{r.rate}</T>
          </View>
        ))}
        <T size={8.5} color={C.t3} style={{ marginTop: 10, marginBottom: 10 }}>RESEARCH PROTOTYPE · NOT A MEDICAL DEVICE</T>
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
  rail: { width: RAIL, backgroundColor: C.navy2, borderRightWidth: 1, borderColor: C.line, alignItems: 'center' },
  tab: { width: RAIL, height: 104, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderColor: C.line },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 6 },
  callout: { borderWidth: 1, borderColor: C.cyan, backgroundColor: 'rgba(11,23,48,0.85)', paddingHorizontal: 8, paddingVertical: 4 },
  cmd: { height: 40, paddingHorizontal: 14, borderWidth: 1, borderColor: C.text, flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  tick: { width: 6, height: 6, backgroundColor: C.cyan },
  field: { flex: 1, height: 30, borderWidth: 1, borderColor: C.line, paddingHorizontal: 8, justifyContent: 'center' },
  input: { fontFamily: 'IBMPlexMono_400Regular', fontSize: 11, color: C.text },
});

export const design: Design = {
  id: '44', slug: 'cutaway', name: 'Cutaway',
  thesis: 'A section through the mechanism: a clipping plane opens the hand so the slides and pins inside are visible, readings are engineering callouts with leader lines, and vertical section tabs down the left edge are the navigation.',
  fonts: { IBMPlexMono_400Regular, IBMPlexMono_500Medium, IBMPlexMono_600SemiBold },
  bg: NAVY, statusBar: 'light-content', App: Shell,
};
