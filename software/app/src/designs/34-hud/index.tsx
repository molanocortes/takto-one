// 34-hud - a head-up display.
//
// Black glass, phosphor green, and a hologram of the hand turning over a
// radar rose. Readouts live in the corners in bracketed cells. Navigation
// is a radial dial at the foot: three sectors on an arc, a needle pointing
// at the one you are in. Chakra Petch, tracked capitals, tabular figures.
// Amber is the only other colour and it means "at the limit".
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Line, Polyline, Rect } from 'react-native-svg';
import { ChakraPetch_400Regular } from '@expo-google-fonts/chakra-petch/400Regular';
import { ChakraPetch_600SemiBold } from '@expo-google-fonts/chakra-petch/600SemiBold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin, GREEN, BG } from './twin';

const C = {
  bg: BG, g: GREEN, g2: 'rgba(98,245,163,0.62)', g3: 'rgba(98,245,163,0.34)', g4: 'rgba(98,245,163,0.14)',
  amber: '#FFB454', panel: 'rgba(4,14,9,0.93)', ink: '#04110A',
};
const F = { ui: 'ChakraPetch_400Regular', semi: 'ChakraPetch_600SemiBold' };

function T({ children, size = 11, semi, color = C.g, style, tracking, align }: {
  children: React.ReactNode; size?: number; semi?: boolean; color?: string; style?: StyleProp<TextStyle>; tracking?: number; align?: 'left' | 'center' | 'right';
}) {
  return <Text style={[{ fontFamily: semi ? F.semi : F.ui, fontSize: size, color, lineHeight: Math.round(size * 1.3), letterSpacing: tracking ?? size * 0.08, textTransform: 'uppercase', fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}

/** Corner brackets around a region. */
function Brackets({ size = 14, color = C.g2, style }: { size?: number; color?: string; style?: StyleProp<ViewStyle> }) {
  const b = (pos: object) => <View style={[{ position: 'absolute', width: size, height: size, borderColor: color }, pos]} pointerEvents="none" />;
  return (
    <View style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      {b({ top: 0, left: 0, borderTopWidth: 1, borderLeftWidth: 1 })}{b({ top: 0, right: 0, borderTopWidth: 1, borderRightWidth: 1 })}
      {b({ bottom: 0, left: 0, borderBottomWidth: 1, borderLeftWidth: 1 })}{b({ bottom: 0, right: 0, borderBottomWidth: 1, borderRightWidth: 1 })}
    </View>
  );
}

/** A readout cell: label, value, brackets. */
function Cell({ label, value, unit, hot, style, align = 'left', big }: { label: string; value: string; unit?: string; hot?: boolean; style?: StyleProp<ViewStyle>; align?: 'left' | 'right'; big?: boolean }) {
  return (
    <View style={[{ padding: 8, minWidth: 96 }, style]}>
      <Brackets size={8} color={hot ? C.amber : C.g3} />
      <T size={8.5} color={C.g2} align={align}>{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: align === 'right' ? 'flex-end' : 'flex-start', gap: 3 }}>
        <T size={big ? 30 : 20} semi color={hot ? C.amber : C.g} tracking={0}>{value}</T>
        {unit && <T size={10} color={C.g2}>{unit}</T>}
      </View>
    </View>
  );
}

/** A bracketed command. Pressed: filled green with black text. */
function Cmd({ label, onPress, primary, style, small, on }: { label: string; onPress?: () => void; primary?: boolean; style?: StyleProp<ViewStyle>; small?: boolean; on?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [st.cmd, small && st.cmdSmall, (primary || on) && st.cmdOn, pressed && st.cmdPressed, style]}>
      {({ pressed }) => (
        <>
          <Brackets size={small ? 6 : 9} color={(primary || on || pressed) ? C.ink : C.g} />
          <T size={small ? 10 : 12} semi color={(primary || on || pressed) ? C.ink : C.g}>{label}</T>
        </>
      )}
    </Pressable>
  );
}

/** The radar rose behind the hologram. */
function Rose({ size }: { size: number }) {
  const c = size / 2;
  const ticks = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2, r1 = c - 6, r2 = c - (i % 6 === 0 ? 16 : 10);
    ticks.push(<Line key={i} x1={c + r1 * Math.cos(a)} y1={c + r1 * Math.sin(a)} x2={c + r2 * Math.cos(a)} y2={c + r2 * Math.sin(a)} stroke={C.g3} strokeWidth={i % 6 === 0 ? 1 : 0.5} />);
  }
  return (
    <Svg width={size} height={size}>
      <Circle cx={c} cy={c} r={c - 6} stroke={C.g3} strokeWidth={0.75} fill="none" />
      <Circle cx={c} cy={c} r={c * 0.62} stroke={C.g4} strokeWidth={0.75} fill="none" strokeDasharray="3 5" />
      <Circle cx={c} cy={c} r={c * 0.28} stroke={C.g4} strokeWidth={0.75} fill="none" />
      <Line x1={c} y1={8} x2={c} y2={size - 8} stroke={C.g4} strokeWidth={0.5} />
      <Line x1={8} y1={c} x2={size - 8} y2={c} stroke={C.g4} strokeWidth={0.5} />
      {ticks}
    </Svg>
  );
}

/** A horizontal gauge with ticks, the lit share in green, amber past the mark. */
function Gauge({ frac, absent, hot = 0.82 }: { frac: number; absent?: boolean; hot?: number }) {
  const v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ height: 10, justifyContent: 'center' }}>
      <View style={{ height: 1, backgroundColor: C.g3 }} />
      {Array.from({ length: 11 }, (_, i) => <View key={i} style={{ position: 'absolute', left: `${i * 10}%`, top: 1, width: 1, height: i % 5 === 0 ? 8 : 4, backgroundColor: C.g3 }} />)}
      {!absent && <View style={{ position: 'absolute', left: 0, top: 3, height: 4, width: `${v * 100}%`, backgroundColor: v > hot ? C.amber : C.g }} />}
    </View>
  );
}

function Trace({ values, width, height, played, hot }: { values: number[]; width: number; height: number; played?: number; hot?: boolean }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 1 - Math.max(0, Math.min(1, v)) * (height - 2)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      <Rect x={0} y={0} width={width} height={height} stroke={C.g3} strokeWidth={0.5} fill="none" />
      {n > 1 && <Polyline points={pts} stroke={hot ? C.amber : C.g} strokeWidth={1.2} fill="none" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill={C.g4} /><Line x1={played * width} x2={played * width} y1={0} y2={height} stroke={C.amber} strokeWidth={1.5} /></>}
    </Svg>
  );
}

/* ---------- the dial ---------- */

const SECTORS: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'Live' }, { key: 'replay', label: 'Replay' }, { key: 'data', label: 'Data' }];

function Dial({ screen, onScreen, width }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; width: number }) {
  const H = 108, R = 200, cx = width / 2, cy = H + 100;
  const pt = (a: number, r: number) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const arc = (a0: number, a1: number, r: number) => {
    const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const span = 19, gap = 2.5, start = -90 - span * 1.5 - gap;
  const idx = Math.max(0, SECTORS.findIndex((x) => x.key === screen));
  const mid = start + gap + idx * (span + gap) + span / 2;
  const [nx, ny] = pt(mid, R - 16);
  return (
    <View style={{ height: H, width }}>
      <Svg width={width} height={H} style={StyleSheet.absoluteFill}>
        <Path d={arc(start - 4, start + 3 * (span + gap) + 1.5, R + 18)} stroke={C.g3} strokeWidth={0.75} fill="none" />
        {Array.from({ length: 13 }, (_, i) => {
          const a = start - 4 + ((3 * (span + gap) + 5.5) * i) / 12;
          const [x0, y0] = pt(a, R + 18), [x1, y1] = pt(a, R + 24);
          return <Line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={C.g3} strokeWidth={0.75} />;
        })}
        {SECTORS.map((sec, i) => {
          const a0 = start + gap + i * (span + gap), a1 = a0 + span;
          const on = sec.key === screen;
          return <Path key={sec.key} d={arc(a0, a1, R)} stroke={on ? C.g : C.g4} strokeWidth={on ? 24 : 20} fill="none" />;
        })}
        <Line x1={cx} y1={cy} x2={nx} y2={ny} stroke={C.g} strokeWidth={1} />
      </Svg>
      {SECTORS.map((sec, i) => {
        const a = start + gap + i * (span + gap) + span / 2;
        const [x, y] = pt(a, R);
        const on = sec.key === screen;
        return (
          <Pressable key={sec.key} onPress={() => onScreen(sec.key)} hitSlop={14} style={{ position: 'absolute', left: x - 34, top: y - 14, width: 68, height: 28, alignItems: 'center', justifyContent: 'center' }}>
            <T size={10} semi color={on ? C.ink : C.g2}>{sec.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ---------- frame ---------- */

function Frame({ screen, onScreen, children, overlay }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children?: React.ReactNode; overlay?: React.ReactNode }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  const rose = Math.min(width * 0.86, height * 0.42);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ position: 'absolute', left: (width - rose) / 2, top: inset.top + 92 + (height * 0.5 - rose) / 2, opacity: 0.9 }} pointerEvents="none"><Rose size={rose} /></View>
      <Stage spec={twin} style={[StyleSheet.absoluteFill, { top: inset.top + 60, bottom: height * 0.3 }]} />
      {/* the top strip */}
      <View style={[st.top, { paddingTop: inset.top + 8 }]} pointerEvents="box-none">
        <T size={11} semi>Takto one</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 6, height: 6, backgroundColor: feed.live ? C.g : 'transparent', borderWidth: 1, borderColor: C.g }} />
          <T size={10} color={C.g2}>{feed.word}</T>
        </View>
        <T size={10} color={C.g2}>{st_.liveJoints}/12</T>
      </View>
      <View style={[st.topLine, { top: inset.top + 34 }]} />
      {children}
      {overlay}
      <View style={[st.foot, { paddingBottom: inset.bottom }]} pointerEvents="box-none">
        <Dial screen={screen} onScreen={onScreen} width={width} />
      </View>
    </View>
  );
}

/* ---------- screens ---------- */

function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const rose = Math.min(width * 0.9, height * 0.46);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ position: 'absolute', left: (width - rose) / 2, top: inset.top + 40 + (height * 0.56 - rose) / 2 }} pointerEvents="none"><Rose size={rose} /></View>
      <Stage spec={twin} style={[StyleSheet.absoluteFill, { top: inset.top + 20, bottom: height * 0.36 }]} />
      <View style={[st.top, { paddingTop: inset.top + 8 }]} pointerEvents="none">
        <T size={10} color={C.g2}>Companion · v1</T>
        <T size={10} color={C.g2}>{feed.word}</T>
      </View>
      <View style={[st.welcomeFoot, { paddingBottom: inset.bottom + 24 }]}>
        <View style={{ padding: 14 }}>
          <Brackets size={16} color={C.g} />
          <T size={9} color={C.g2}>Digital twin · 12 joints · effort channel</T>
          <T size={34} semi tracking={2} style={{ marginTop: 4 }}>Takto one</T>
          <T size={10} color={C.g2} style={{ marginTop: 6 }} tracking={0.5}>Every joint of the hand, live from the device or from a recorded take. Synthetic feed until a bridge is linked.</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
            <Cmd label="Initialise" primary onPress={onStart} style={{ flex: 1.3 }} />
            <Cmd label="Link device" onPress={onConnect} style={{ flex: 1 }} />
          </View>
        </View>
        <T size={8.5} color={C.g3} style={{ marginTop: 10 }} align="center">Research prototype · not a medical device</T>
      </View>
    </View>
  );
}

function Live({ detail, onScreen }: { detail: boolean; onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const [matrix, setMatrix] = useState(detail);
  const hist = useRef(new History(80)).current;
  hist.push(st_.emg);
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  return (
    <Frame screen="live" onScreen={onScreen}
      overlay={matrix ? (
        <View style={[st.panel, { bottom: inset.bottom + 112 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <T size={9} color={C.g2}>Joint matrix · degrees</T>
            <Cmd label="Close" small onPress={() => setMatrix(false)} />
          </View>
          <View style={{ flexDirection: 'row', paddingLeft: 60, marginBottom: 2 }}>
            {JOINTS.map((j) => <T key={j.key} size={8.5} color={C.g2} style={{ flex: 1 }} align="center">{j.short} /{j.max}</T>)}
          </View>
          {FINGERS.map((f) => (
            <View key={f} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: C.g4, paddingVertical: 5 }}>
              <T size={9} color={C.g2} style={{ width: 60 }}>{FINGER_NAME[f]}</T>
              {JOINTS.map((j) => {
                const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                const fr = j.signed ? (v + j.max) / (2 * j.max) : v / j.max;
                return (
                  <View key={j.key} style={{ flex: 1, paddingHorizontal: 6 }}>
                    <T size={15} semi color={!on ? C.g3 : Math.abs(v) > j.max * 0.9 ? C.amber : C.g} tracking={0} align="center">{fmtDeg(v, on, j.signed)}</T>
                    <Gauge frac={fr} absent={!on} hot={0.9} />
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      ) : undefined}>
      {/* corner readouts */}
      <View style={[st.corners, { top: inset.top + 44 }]} pointerEvents="box-none">
        <Cell label="Mean flexion" value={st_.mean.toFixed(0)} unit="deg" big hot={st_.mean > 90} />
        <Cell label="Effort" value={st_.emg < 0 ? '–' : st_.emg.toFixed(2)} unit={st_.blendWord} big hot={st_.emg > 0.8} align="right" />
      </View>
      <View style={[st.corners, { bottom: inset.bottom + 112 }]} pointerEvents="box-none">
        <View style={{ width: width * 0.5, padding: 8 }}>
          <Brackets size={8} color={C.g3} />
          {FINGERS.map((f) => (
            <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 2 }}>
              <T size={8.5} color={C.g2} style={{ width: 44 }}>{FINGER_NAME[f]}</T>
              <View style={{ flex: 1 }}><Gauge frac={st_.curl[f]} absent={!(frame.ok[f].mcp || frame.ok[f].pip)} /></View>
              <T size={10} semi tracking={0} style={{ width: 26 }} align="right">{(st_.curl[f] * 100).toFixed(0)}</T>
            </View>
          ))}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <View style={{ padding: 6 }}>
            <Brackets size={8} color={C.g3} />
            <Trace values={hist.values} width={110} height={34} hot={st_.emg > 0.8} />
            <T size={8} color={C.g2} align="right" style={{ marginTop: 2 }}>Effort trace</T>
          </View>
          <Cmd label="Matrix" small onPress={() => setMatrix(true)} />
        </View>
      </View>
    </Frame>
  );
}

function Replay({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const play = s.play;
  const takes = useMemo(bundledTakes, []);
  const inset = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 100) : []), [play?.take.id]);
  const w = width - 24 - 16;
  return (
    <Frame screen="replay" onScreen={onScreen}>
      <View style={[st.corners, { top: inset.top + 44 }]} pointerEvents="box-none">
        <Cell label={play ? 'Elapsed' : 'Records'} value={play ? clock(play.t) : String(takes.length)} big />
        {play && <Cell label="Of" value={clock(play.take.durationS)} unit={`${play.speed}×`} align="right" />}
      </View>
      <View style={[st.panel, { bottom: inset.bottom + 112 }]}>
        {!play ? (
          <>
            <T size={9} color={C.g2} style={{ marginBottom: 6 }}>Recorded takes · choreographed samples, not a person</T>
            {takes.map((t) => (
              <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderColor: C.g4, paddingVertical: 7 }}>
                <View style={{ flex: 1 }}>
                  <T size={13} semi>{t.title}</T>
                  <T size={8.5} color={C.g2} tracking={0.3}>{t.note}</T>
                </View>
                <T size={10} color={C.g2}>{t.durationS.toFixed(0)} s</T>
                <Cmd label="Load" small onPress={() => s.setTake(t)} />
              </View>
            ))}
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <T size={12} semi>{play.take.title}</T>
              <T size={8.5} color={C.g2}>{play.take.frames.length} frames</T>
            </View>
            <View {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <Trace values={trace} width={w} height={44} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
              <Cmd label="|<" small onPress={() => s.seek(0)} />
              <Cmd label={play.playing ? 'Pause' : 'Play'} primary small onPress={() => s.togglePlay()} style={{ flex: 1 }} />
              <Cmd label=">|" small onPress={() => s.seek(play.take.durationS)} />
              {[0.5, 1, 2].map((k) => <Cmd key={k} label={`${k}×`} small on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
              <Cmd label="Eject" small onPress={() => s.setTake(null)} />
            </View>
          </>
        )}
      </View>
    </Frame>
  );
}

function Data({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const feed = feedWord(s);
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <Frame screen="data" onScreen={onScreen}>
      <View style={[st.panel, { bottom: inset.bottom + 112, top: inset.top + 44 + height * 0.18 }]}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <T size={9} color={C.g2}>Source · {feed.detail}</T>
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, alignItems: 'center' }}>
            <View style={st.field}><TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.g3} /></View>
            <Cmd label="Link" primary small onPress={() => s.connect(url)} />
            <Cmd label="Sim" small onPress={() => s.useSimulator()} />
          </View>
          <T size={9} color={C.g2} style={{ marginTop: 14, marginBottom: 4 }}>Channels · wire name ≠ mechanical name</T>
          {FINGERS.map((f) => (
            <View key={f} style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: C.g4, paddingVertical: 6, alignItems: 'center' }}>
              <T size={9} color={C.g2} style={{ width: 52 }}>{FINGER_NAME[f]}</T>
              {JOINTS.map((j) => {
                const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                return (
                  <View key={j.key} style={{ flex: 1 }}>
                    <T size={7.5} color={C.g3} tracking={0.5}>{f}_{j.wire}</T>
                    <T size={13} semi tracking={0} color={!on ? C.g3 : Math.abs(v) > j.max ? C.amber : C.g}>{on ? `${v.toFixed(1)}°` : 'absent'}</T>
                  </View>
                );
              })}
            </View>
          ))}
          <View style={{ flexDirection: 'row', paddingLeft: 52, marginTop: 2 }}>
            {JOINTS.map((j) => <T key={j.key} size={7.5} color={C.g3} style={{ flex: 1 }} tracking={0.5}>{j.name} ±{j.max}</T>)}
          </View>
          <T size={9} color={C.g2} style={{ marginTop: 14, marginBottom: 2 }}>Rates · four numbers, not one</T>
          {RATES.map((r) => (
            <View key={r.what} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: C.g4, paddingVertical: 6 }}>
              <T size={10} style={{ width: 120 }}>{r.what}</T>
              <T size={8.5} color={C.g2} style={{ flex: 1 }} tracking={0.3}>{r.note}</T>
              <T size={12} semi tracking={0}>{r.rate}</T>
            </View>
          ))}
          <T size={8} color={C.g3} style={{ marginTop: 10 }}>Research prototype · not a medical device</T>
        </ScrollView>
      </View>
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
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, zIndex: 5 },
  topLine: { position: 'absolute', left: 14, right: 14, height: 1, backgroundColor: C.g3 },
  foot: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  corners: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  panel: { position: 'absolute', left: 12, right: 12, backgroundColor: C.panel, borderWidth: 1, borderColor: C.g3, padding: 10 },
  welcomeFoot: { position: 'absolute', left: 14, right: 14, bottom: 0 },
  cmd: { height: 42, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(98,245,163,0.06)' },
  cmdSmall: { height: 30, paddingHorizontal: 10 },
  cmdOn: { backgroundColor: C.g },
  cmdPressed: { backgroundColor: '#B8FFD8' },
  field: { flex: 1, height: 30, borderWidth: 1, borderColor: C.g3, paddingHorizontal: 8, justifyContent: 'center' },
  input: { fontFamily: 'ChakraPetch_400Regular', fontSize: 11, color: C.g },
});

export const design: Design = {
  id: '34', slug: 'hud', name: 'HUD',
  thesis: 'A head-up display: a hologram of the hand turning over a radar rose, readouts bracketed into the corners, and a radial dial at the foot as the navigation.',
  fonts: { ChakraPetch_400Regular, ChakraPetch_600SemiBold },
  bg: BG, statusBar: 'light-content', App: Shell,
};
