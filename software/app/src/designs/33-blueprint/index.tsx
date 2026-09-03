// 33-blueprint - a drawing sheet.
//
// The whole screen is a cyanotype: a fine grid, a border with zone letters,
// the drawing in the middle, a title block at the foot and index tabs on
// the bottom edge that ARE the navigation (sheet 01 to 04). Every value is
// a dimension, every list is a table with ruled cells, every control is a
// boxed callout in drafting mono. One highlighter yellow marks the live
// thing: the playhead, the feed, a value at its limit.
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Line, Rect, Defs, Pattern, Polyline } from 'react-native-svg';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import { JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono/700Bold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin, BLUE } from './twin';

const C = {
  blue: BLUE, blueDeep: '#163C82', line: '#EEF4FF', line2: 'rgba(238,244,255,0.62)', line3: 'rgba(238,244,255,0.34)',
  grid: 'rgba(238,244,255,0.10)', gridMajor: 'rgba(238,244,255,0.20)', yellow: '#FFD84A', yellowInk: '#1A2B4F',
};
const F = { ui: 'JetBrainsMono_400Regular', bold: 'JetBrainsMono_700Bold' };
const M = 10;   // sheet margin

function T({ children, size = 11, bold, color = C.line, style, tracking = 0, align }: {
  children: React.ReactNode; size?: number; bold?: boolean; color?: string; style?: StyleProp<TextStyle>; tracking?: number; align?: 'left' | 'center' | 'right';
}) {
  return <Text style={[{ fontFamily: bold ? F.bold : F.ui, fontSize: size, color, lineHeight: Math.round(size * 1.35), letterSpacing: tracking, textAlign: align }, style]}>{children}</Text>;
}

/** A callout box: hairline, drafting corners; primary is filled white; pressed is highlighter. */
function Box({ label, onPress, primary, style, small, on }: { label: string; onPress?: () => void; primary?: boolean; style?: StyleProp<ViewStyle>; small?: boolean; on?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [st.box, small && st.boxSmall, (primary || on) && st.boxPrimary, pressed && st.boxPressed, style]}>
      {({ pressed }) => (
        <>
          <View style={[st.corner, { top: -1, left: -1 }]} /><View style={[st.corner, { top: -1, right: -1 }]} />
          <View style={[st.corner, { bottom: -1, left: -1 }]} /><View style={[st.corner, { bottom: -1, right: -1 }]} />
          <T size={small ? 10 : 11.5} bold color={pressed ? C.yellowInk : (primary || on) ? C.blue : C.line} tracking={1}>{label.toUpperCase()}</T>
        </>
      )}
    </Pressable>
  );
}

/** A dimension: a line with end ticks and the value in the middle, as on a drawing. */
function Dimension({ value, label, width, hot }: { value: string; label: string; width: number; hot?: boolean }) {
  const c = hot ? C.yellow : C.line;
  return (
    <View style={{ width, alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', width }}>
        <View style={{ width: 1, height: 12, backgroundColor: c }} />
        <View style={{ flex: 1, height: 1, backgroundColor: c }} />
        <View style={{ paddingHorizontal: 8 }}><T size={30} bold color={c}>{value}</T></View>
        <View style={{ flex: 1, height: 1, backgroundColor: c }} />
        <View style={{ width: 1, height: 12, backgroundColor: c }} />
      </View>
      <T size={9} color={C.line2} tracking={1.5} style={{ marginTop: 2 }}>{label.toUpperCase()}</T>
    </View>
  );
}

/** A finger as a dimension bar: the value's share of the range, ticked. */
function DimBar({ label, frac, value, absent }: { label: string; frac: number; value: string; absent?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: 22 }}>
      <T size={10} color={C.line2} style={{ width: 58 }}>{label.toUpperCase()}</T>
      <View style={{ flex: 1, height: 12, justifyContent: 'center' }}>
        <View style={{ height: 1, backgroundColor: C.line3 }} />
        {[0, 0.25, 0.5, 0.75, 1].map((k) => <View key={k} style={{ position: 'absolute', left: `${k * 100}%`, top: 2, width: 1, height: 8, backgroundColor: C.line3 }} />)}
        {!absent && <View style={{ position: 'absolute', left: 0, top: 5, width: `${Math.min(1, frac) * 100}%`, height: 2, backgroundColor: frac > 0.82 ? C.yellow : C.line }} />}
        {!absent && <View style={{ position: 'absolute', left: `${Math.min(1, frac) * 100}%`, top: 1, width: 1, height: 10, backgroundColor: frac > 0.82 ? C.yellow : C.line }} />}
      </View>
      <T size={11} bold color={absent ? C.line3 : C.line} style={{ width: 40, textAlign: 'right' }}>{value}</T>
    </View>
  );
}

/** A strip chart on the grid. */
function Strip({ values, width, height, hot, played }: { values: number[]; width: number; height: number; hot?: boolean; played?: number }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 1 - Math.max(0, Math.min(1, v)) * (height - 2)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      {[0.25, 0.5, 0.75].map((k) => <Line key={k} x1={0} x2={width} y1={height * (1 - k)} y2={height * (1 - k)} stroke={C.line3} strokeWidth={0.5} strokeDasharray="2 3" />)}
      <Rect x={0} y={0} width={width} height={height} stroke={C.line2} strokeWidth={0.75} fill="none" />
      {n > 1 && <Polyline points={pts} stroke={hot ? C.yellow : C.line} strokeWidth={1.25} fill="none" strokeLinejoin="round" />}
      {played !== undefined && <Line x1={played * width} x2={played * width} y1={-4} y2={height + 4} stroke={C.yellow} strokeWidth={1.5} />}
    </Svg>
  );
}

/** A ruled table: header row in bold, hairline cells. */
function Table({ head, rows, widths }: { head: string[]; rows: (React.ReactNode | string)[][]; widths: number[] }) {
  const cell = (v: React.ReactNode, i: number, bold = false, key: React.Key = i) => (
    <View key={key} style={[st.cell, { flex: widths[i] }, i === head.length - 1 && { borderRightWidth: 0 }]}>
      {typeof v === 'string' ? <T size={10} bold={bold} color={bold ? C.line : C.line2}>{v}</T> : v}
    </View>
  );
  return (
    <View style={st.table}>
      <View style={[st.row, { backgroundColor: 'rgba(238,244,255,0.08)' }]}>{head.map((h, i) => cell(h.toUpperCase(), i, true))}</View>
      {rows.map((r, ri) => <View key={ri} style={[st.row, ri === rows.length - 1 && { borderBottomWidth: 0 }]}>{r.map((v, i) => cell(v, i, false, `${ri}-${i}`))}</View>)}
    </View>
  );
}

const SHEETS: { key: ScreenKey; n: string; title: string }[] = [
  { key: 'welcome', n: '01', title: 'Cover' }, { key: 'live', n: '02', title: 'Live' },
  { key: 'replay', n: '03', title: 'Replay' }, { key: 'data', n: '04', title: 'Data' },
];

/* ---------- the sheet ---------- */

function Sheet({ screen, onScreen, drawingShare, children, title, note }: {
  screen: ScreenKey; onScreen: (s: ScreenKey) => void; drawingShare: number; children: React.ReactNode; title: string; note: string;
}) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  const innerW = width - M * 2;
  const idx = SHEETS.findIndex((x) => x.key === screen);
  return (
    <View style={{ flex: 1, backgroundColor: C.blue }}>
      {/* the grid, under everything */}
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <Pattern id="g" width={8} height={8} patternUnits="userSpaceOnUse"><Path d="M8 0 H0 V8" stroke={C.grid} strokeWidth={0.5} fill="none" /></Pattern>
          <Pattern id="G" width={40} height={40} patternUnits="userSpaceOnUse"><Path d="M40 0 H0 V40" stroke={C.gridMajor} strokeWidth={0.6} fill="none" /></Pattern>
        </Defs>
        <Rect width={width} height={height} fill="url(#g)" /><Rect width={width} height={height} fill="url(#G)" />
      </Svg>
      <View style={[st.frame, { top: inset.top + M, bottom: inset.bottom + M + 26 }]}>
        {/* header strip */}
        <View style={st.strip}>
          <T size={10} bold tracking={1.5}>TAKTO ONE · DIGITAL TWIN</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 7, height: 7, backgroundColor: feed.live ? C.yellow : 'transparent', borderWidth: 1, borderColor: C.yellow }} />
            <T size={10} bold color={C.yellow} tracking={1}>{feed.word.toUpperCase()}</T>
          </View>
        </View>
        {/* the drawing, with zone marks */}
        <View style={{ height: Math.round((height - inset.top - inset.bottom) * drawingShare), borderBottomWidth: 1, borderColor: C.line2 }}>
          <Stage spec={twin} style={StyleSheet.absoluteFill} />
          <View style={st.zones} pointerEvents="none">{['A', 'B', 'C', 'D'].map((z) => <T key={z} size={9} color={C.line3}>{z}</T>)}</View>
          <View style={st.zonesV} pointerEvents="none">{['1', '2', '3'].map((z) => <T key={z} size={9} color={C.line3}>{z}</T>)}</View>
          <View style={st.drawNote} pointerEvents="none">
            <T size={9} color={C.line2}>VIEW: ISO · {st_.liveJoints}/12 JOINTS · {s.play ? `T=${clock(s.play.t)}` : 'LIVE'}</T>
          </View>
        </View>
        {/* the sheet body */}
        <View style={{ flex: 1 }}>{children}</View>
        {/* title block */}
        <View style={st.titleBlock}>
          <View style={[st.tb, { flex: 2.2 }]}><T size={8} color={C.line3}>TITLE</T><T size={11} bold>{title.toUpperCase()}</T></View>
          <View style={[st.tb, { flex: 1.6 }]}><T size={8} color={C.line3}>NOTE</T><T size={9} color={C.line2}>{note}</T></View>
          <View style={[st.tb, { flex: 1 }]}><T size={8} color={C.line3}>SHEET</T><T size={11} bold>{idx + 1} OF 4</T></View>
          <View style={[st.tb, { flex: 0.8, borderRightWidth: 0 }]}><T size={8} color={C.line3}>REV</T><T size={11} bold>A</T></View>
        </View>
      </View>
      {/* index tabs on the bottom edge: the navigation */}
      <View style={[st.tabs, { bottom: inset.bottom + M, width: innerW }]}>
        {SHEETS.map((sh) => {
          const on = sh.key === screen;
          return (
            <Pressable key={sh.key} onPress={() => onScreen(sh.key)} style={({ pressed }) => [st.tab, on && st.tabOn, pressed && { backgroundColor: C.yellow }]}>
              {({ pressed }) => <T size={10} bold color={on || pressed ? C.blue : C.line} tracking={1}>{sh.n} {sh.title.toUpperCase()}</T>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* ---------- sheets ---------- */

function Cover({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  return (
    <Sheet screen="welcome" onScreen={onScreen} drawingShare={0.5} title="Cover sheet" note="Research prototype">
      <View style={{ padding: 14, flex: 1 }}>
        <T size={9} color={C.line2} tracking={1.5}>DRAWING SET · COMPANION APP</T>
        <T size={28} bold style={{ marginTop: 4 }}>TAKTO ONE</T>
        <T size={11} color={C.line2} style={{ marginTop: 6, maxWidth: 320 }}>Every joint of the hand, dimensioned live from the device or from a recorded take. The real CAD, the shared kinematics, a synthetic feed until a bridge is attached.</T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <Box label="Start session" primary onPress={() => onScreen('live')} style={{ flex: 1.3 }} />
          <Box label="Connect device" onPress={() => onScreen('data')} style={{ flex: 1 }} />
        </View>
        <View style={{ flex: 1 }} />
        <T size={9} color={C.line3}>NOT A MEDICAL DEVICE · NO HAND WORE THE DEVICE TO MAKE THE FEED</T>
      </View>
    </Sheet>
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
  const w = width - M * 2 - 28;
  return (
    <Sheet screen="live" onScreen={onScreen} drawingShare={table ? 0.34 : 0.44} title="Live twin" note={`Peak ${FINGER_NAME[st_.peakFinger]} ${st_.peak.toFixed(0)}°`}>
      <ScrollView contentContainerStyle={{ padding: 14 }} showsVerticalScrollIndicator={false}>
        {!table ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <Dimension value={`${st_.mean.toFixed(0)}°`} label="Mean flexion" width={w * 0.56} hot={st_.mean > 90} />
              <View style={{ alignItems: 'flex-end' }}>
                <T size={22} bold color={st_.emg > 0.8 ? C.yellow : C.line}>{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T>
                <T size={9} color={C.line2} tracking={1.5}>EFFORT · {st_.blendWord.toUpperCase()}</T>
              </View>
            </View>
            <View style={{ marginTop: 12, gap: 2 }}>
              {FINGERS.map((f) => <DimBar key={f} label={FINGER_NAME[f]} frac={st_.curl[f]} value={`${(st_.curl[f] * 100).toFixed(0)}%`} absent={!(frame.ok[f].mcp || frame.ok[f].pip)} />)}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 12 }}>
              <View style={{ flex: 1 }}><Strip values={hist.values} width={w - 130} height={40} hot={st_.emg > 0.8} /><T size={8} color={C.line3} style={{ marginTop: 2 }}>EFFORT, LAST 5 S</T></View>
              <Box label="12 joints" small onPress={() => setTable(true)} />
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <T size={9} color={C.line2} tracking={1.5}>TABLE 1 · JOINT ANGLES, DEGREES</T>
              <Box label="Summary" small onPress={() => setTable(false)} />
            </View>
            <Table head={['Finger', ...JOINTS.map((j) => `${j.short} /${j.max}`)]} widths={[1.3, 1, 1, 1]}
              rows={FINGERS.map((f) => [FINGER_NAME[f].toUpperCase(), ...JOINTS.map((j) => {
                const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                return <T key={j.key} size={13} bold color={!on ? C.line3 : Math.abs(v) > j.max * 0.9 ? C.yellow : C.line}>{fmtDeg(v, on, j.signed)}</T>;
              })])} />
            <T size={8} color={C.line3} style={{ marginTop: 6 }}>ABD SIGNED ±16 · MCP 0-90 · PIP 0-110 · YELLOW PAST 90% OF RANGE</T>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

function Replay({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const play = s.play;
  const takes = useMemo(bundledTakes, []);
  const { width } = useWindowDimensions();
  const w = width - M * 2 - 28;
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 100) : []), [play?.take.id]);
  return (
    <Sheet screen="replay" onScreen={onScreen} drawingShare={0.42} title={play ? `Replay · ${play.take.title}` : 'Replay'} note={play ? `${play.take.frames.length} frames` : 'Bundled samples'}>
      <ScrollView contentContainerStyle={{ padding: 14 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            <T size={9} color={C.line2} tracking={1.5} style={{ marginBottom: 8 }}>REVISION TABLE · CHOREOGRAPHED SAMPLES, NOT A PERSON</T>
            <Table head={['Rev', 'Description', 'Dur', '']} widths={[0.5, 2.6, 0.7, 0.9]}
              rows={takes.map((t, i) => [String(i + 1).padStart(2, '0'), <View key="d"><T size={11} bold>{t.title.toUpperCase()}</T><T size={9} color={C.line2}>{t.note}</T></View>,
                `${t.durationS.toFixed(0)} s`, <Box key="b" label="Load" small onPress={() => s.setTake(t)} />])} />
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <T size={30} bold>{clock(play.t)}</T>
              <T size={9} color={C.line2}>OF {clock(play.take.durationS)} · {play.speed}×</T>
            </View>
            <View style={{ marginTop: 8 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <Strip values={trace} width={w} height={48} played={play.t / Math.max(0.01, play.take.durationS)} />
            </View>
            <T size={8} color={C.line3} style={{ marginTop: 2 }}>EFFORT OVER THE TAKE · DRAG TO SEEK</T>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 12 }}>
              <Box label="|<" small onPress={() => s.seek(0)} />
              <Box label={play.playing ? 'Pause' : 'Play'} primary small onPress={() => s.togglePlay()} style={{ flex: 1 }} />
              <Box label=">|" small onPress={() => s.seek(play.take.durationS)} />
              {[0.5, 1, 2].map((k) => <Box key={k} label={`${k}×`} small on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
              <Box label="Eject" small onPress={() => s.setTake(null)} />
            </View>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

function Data({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const feed = feedWord(s);
  return (
    <Sheet screen="data" onScreen={onScreen} drawingShare={0.26} title="Data · sources" note={feed.detail}>
      <ScrollView contentContainerStyle={{ padding: 14 }} showsVerticalScrollIndicator={false}>
        <T size={9} color={C.line2} tracking={1.5}>SOURCE · BRIDGE ADDRESS</T>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <View style={st.field}><TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.line3} /></View>
          <Box label="Connect" primary small onPress={() => s.connect(url)} />
          <Box label="Sim" small onPress={() => s.useSimulator()} />
        </View>
        <T size={9} color={C.line2} tracking={1.5} style={{ marginTop: 14, marginBottom: 6 }}>TABLE 2 · CHANNELS · WIRE NAME ≠ MECHANICAL NAME</T>
        <Table head={['Wire', 'Measures', 'Limit', 'Now']} widths={[1.2, 1.7, 0.7, 0.9]}
          rows={FINGERS.flatMap((f) => JOINTS.map((j) => {
            const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
            return [`${f}_${j.wire}`, `${FINGER_NAME[f]} ${j.name}`, `${j.signed ? '±' : ''}${j.max}°`, <T key="v" size={11} bold color={!on ? C.line3 : Math.abs(v) > j.max ? C.yellow : C.line}>{on ? `${v.toFixed(1)}°` : 'ABSENT'}</T>];
          }))} />
        <T size={9} color={C.line2} tracking={1.5} style={{ marginTop: 14, marginBottom: 6 }}>TABLE 3 · RATES · FOUR NUMBERS, NOT ONE</T>
        <Table head={['Where', 'Note', 'Rate']} widths={[1.2, 2, 0.8]} rows={RATES.map((r) => [r.what, r.note, <T key="r" size={11} bold>{r.rate}</T>])} />
        <T size={8} color={C.line3} style={{ marginTop: 10 }}>RESEARCH PROTOTYPE · NOT A MEDICAL DEVICE</T>
      </ScrollView>
    </Sheet>
  );
}

function Shell({ initialScreen, detail }: DesignProps) {
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  if (screen === 'welcome') return <Cover onScreen={setScreen} />;
  if (screen === 'live') return <Live detail={detail} onScreen={setScreen} />;
  if (screen === 'replay') return <Replay onScreen={setScreen} />;
  return <Data onScreen={setScreen} />;
}

const st = StyleSheet.create({
  frame: { position: 'absolute', left: M, right: M, borderWidth: 1, borderColor: C.line, overflow: 'hidden' },
  strip: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, height: 26, borderBottomWidth: 1, borderColor: C.line2 },
  zones: { position: 'absolute', top: 4, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-evenly' },
  zonesV: { position: 'absolute', left: 6, top: 0, bottom: 0, justifyContent: 'space-evenly' },
  drawNote: { position: 'absolute', right: 8, bottom: 6 },
  titleBlock: { flexDirection: 'row', borderTopWidth: 1, borderColor: C.line },
  tb: { paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderColor: C.line2, gap: 1 },
  tabs: { position: 'absolute', left: M, flexDirection: 'row', height: 26 },
  tab: { flex: 1, borderWidth: 1, borderTopWidth: 0, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginRight: -1 },
  tabOn: { backgroundColor: C.line },
  box: { height: 40, paddingHorizontal: 12, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed' },
  boxSmall: { height: 30, paddingHorizontal: 9 },
  boxPrimary: { backgroundColor: C.line, borderStyle: 'solid' },
  boxPressed: { backgroundColor: C.yellow, borderColor: C.yellow, borderStyle: 'solid' },
  corner: { position: 'absolute', width: 5, height: 5, borderColor: C.line, borderWidth: 1, backgroundColor: C.blue },
  table: { borderWidth: 1, borderColor: C.line2 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: C.line3 },
  cell: { paddingHorizontal: 6, paddingVertical: 5, borderRightWidth: 1, borderColor: C.line3, justifyContent: 'center' },
  field: { flex: 1, height: 30, borderWidth: 1, borderColor: C.line2, paddingHorizontal: 8, justifyContent: 'center' },
  input: { fontFamily: 'JetBrainsMono_400Regular', fontSize: 11, color: C.line },
});

export const design: Design = {
  id: '33', slug: 'blueprint', name: 'Blueprint sheet',
  thesis: 'The twin is a drawing set: a cyanotype sheet with a grid, zone marks, a title block, and index tabs on the bottom edge that are the navigation.',
  fonts: { JetBrainsMono_400Regular, JetBrainsMono_700Bold },
  bg: BLUE, statusBar: 'light-content', App: Shell,
};
