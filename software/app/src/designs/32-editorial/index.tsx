// 32-editorial - the hand as a plate in a book.
//
// One long page. The figure is pinned at the top and the text scrolls under
// it; a numbered rail down the left margin says where you are and takes you
// there. Fraunces throughout: a soft serif for the headlines and the big
// numerals, italic for captions, tracked capitals for the labels. Tables
// have rules. The one colour is a printer's red, spent on the playhead and
// on anything live.
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, Animated, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Polygon, Rect } from 'react-native-svg';
import { Fraunces_300Light } from '@expo-google-fonts/fraunces/300Light';
import { Fraunces_400Regular } from '@expo-google-fonts/fraunces/400Regular';
import { Fraunces_400Regular_Italic } from '@expo-google-fonts/fraunces/400Regular_Italic';
import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin } from './twin';

const C = {
  page: '#F6F3EC', ink: '#161513', ink2: '#5B5852', ink3: '#918D85', rule: '#D6D1C6', ruleSoft: '#E6E2D9',
  red: '#C3341C', redSoft: 'rgba(195,52,28,0.12)', black: '#111111', paper2: '#EEEAE1',
};
const F = { light: 'Fraunces_300Light', ui: 'Fraunces_400Regular', italic: 'Fraunces_400Regular_Italic', semi: 'Fraunces_600SemiBold' };
const RAIL = 34;

/* ---------- type ---------- */

function T({ children, size = 15, weight = 'ui', color = C.ink, caps, tracking, style, lh, tabular, align }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; caps?: boolean; tracking?: number;
  style?: StyleProp<TextStyle>; lh?: number; tabular?: boolean; align?: 'left' | 'center' | 'right';
}) {
  return (
    <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: lh ?? Math.round(size * (size > 30 ? 1.02 : 1.4)),
      letterSpacing: tracking ?? (caps ? size * 0.12 : size > 30 ? -size * 0.02 : 0), textTransform: caps ? 'uppercase' : 'none',
      fontVariant: tabular ? ['tabular-nums'] : undefined, textAlign: align }, style]}>{children}</Text>
  );
}
function Label({ children, color = C.ink3, style }: { children: React.ReactNode; color?: string; style?: StyleProp<TextStyle> }) {
  return <T size={10} caps color={color} style={style}>{children}</T>;
}
function Rule({ heavy, style }: { heavy?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: heavy ? 2 : 1, backgroundColor: heavy ? C.ink : C.rule }, style]} />;
}

/** A printed call to action: a black bar with a serif word and a drawn arrow. */
function Bar({ label, onPress, light, style }: { label: string; onPress?: () => void; light?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.bar, light && st.barLight, pressed && { opacity: 0.75 }, style]}>
      <T size={17} weight="semi" color={light ? C.ink : C.page}>{label}</T>
      <Svg width={22} height={12} viewBox="0 0 22 12"><Path d="M0 6 H20 M14 1 L20 6 L14 11" stroke={light ? C.ink : C.page} strokeWidth={1.6} fill="none" /></Svg>
    </Pressable>
  );
}

/** A word that is a control: serif, underlined in ink when chosen. */
function Word({ label, on, onPress, size = 14 }: { label: string; on?: boolean; onPress?: () => void; size?: number }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [{ paddingBottom: 3, borderBottomWidth: 2, borderBottomColor: on ? C.ink : 'transparent' }, pressed && { opacity: 0.6 }]}>
      <T size={size} weight={on ? 'semi' : 'ui'} color={on ? C.ink : C.ink3}>{label}</T>
    </Pressable>
  );
}

/** A drawn transport glyph in an ink disc. */
function Disc({ kind, onPress, size = 46, filled = true }: { kind: 'play' | 'pause' | 'start' | 'end' | 'eject'; onPress?: () => void; size?: number; filled?: boolean }) {
  const c = filled ? C.page : C.ink;
  return (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => [{ width: size, height: size, borderRadius: size / 2, backgroundColor: filled ? C.ink : 'transparent', borderWidth: 1.5, borderColor: C.ink, alignItems: 'center', justifyContent: 'center' }, pressed && { opacity: 0.6 }]}>
      <Svg width={18} height={18} viewBox="0 0 18 18">
        {kind === 'play' && <Polygon points="5,3 15,9 5,15" fill={c} />}
        {kind === 'pause' && <><Rect x={4} y={3} width={3.5} height={12} fill={c} /><Rect x={10.5} y={3} width={3.5} height={12} fill={c} /></>}
        {kind === 'start' && <><Rect x={3} y={3} width={2} height={12} fill={c} /><Polygon points="15,3 6,9 15,15" fill={c} /></>}
        {kind === 'end' && <><Rect x={13} y={3} width={2} height={12} fill={c} /><Polygon points="3,3 12,9 3,15" fill={c} /></>}
        {kind === 'eject' && <><Polygon points="3,10 9,3 15,10" fill={c} /><Rect x={3} y={12} width={12} height={2.5} fill={c} /></>}
      </Svg>
    </Pressable>
  );
}

/** A thin inked line through the values, as a figure in the text. */
function InkLine({ values, width, height, red = false }: { values: number[]; width: number; height: number; red?: boolean }) {
  if (!values.length || width <= 0) return <View style={{ width, height }} />;
  const n = values.length;
  let d = '';
  values.forEach((v, i) => {
    const x = (i / Math.max(1, n - 1)) * width, y = height - 1 - Math.max(0, Math.min(1, v)) * (height - 2);
    d += (i ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1);
  });
  return (
    <Svg width={width} height={height}>
      <Path d={`M0 ${height - 0.5} H${width}`} stroke={C.rule} strokeWidth={1} />
      <Path d={d} stroke={red ? C.red : C.ink} strokeWidth={1.4} fill="none" strokeLinejoin="round" />
    </Svg>
  );
}

/* ---------- the page ---------- */

const SECTIONS: { key: ScreenKey; n: string; title: string }[] = [
  { key: 'welcome', n: '01', title: 'Cover' }, { key: 'live', n: '02', title: 'Live' },
  { key: 'replay', n: '03', title: 'Replay' }, { key: 'data', n: '04', title: 'Data' },
];

function Page({ initialScreen, detail }: DesignProps) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const feed = feedWord(s);
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef<Record<string, number>>({});
  const [current, setCurrent] = useState<ScreenKey>(initialScreen);
  const [showTable, setShowTable] = useState(detail);
  const hist = useRef(new History(64)).current;
  hist.push(st_.emg);
  const takes = useMemo(bundledTakes, []);
  const play = s.play;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const plateH = Math.round(height * 0.44);
  const colW = width - RAIL - 24;
  const scrolledTo = useRef(false);
  const stickyH = useRef(0);

  const go = (k: ScreenKey, animated = true) => {
    const y = offsets.current[k];
    if (y === undefined) return;
    // the plate is pinned over the content, so a section starts under it
    scroll.current?.scrollTo({ y: k === 'welcome' ? 0 : y - stickyH.current, animated });
  };
  const onLayoutOf = (k: ScreenKey) => (e: any) => {
    offsets.current[k] = e.nativeEvent.layout.y;
    if (!scrolledTo.current && k === initialScreen && initialScreen !== 'welcome') {
      scrolledTo.current = true;
      setTimeout(() => go(initialScreen, false), 30);
    }
  };
  const onScroll = (e: any) => {
    const y = e.nativeEvent.contentOffset.y + stickyH.current + 40;
    let k: ScreenKey = 'welcome';
    for (const sec of SECTIONS) if ((offsets.current[sec.key] ?? Infinity) <= y) k = sec.key;
    if (k !== current) setCurrent(k);
  };

  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 120) : []), [play?.take.id]);

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView ref={scroll} stickyHeaderIndices={[0]} onScroll={onScroll} scrollEventThrottle={48} showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: inset.bottom + 40 }}>
        {/* the plate, pinned */}
        <View style={{ backgroundColor: C.page, paddingTop: inset.top }} onLayout={(e) => { stickyH.current = e.nativeEvent.layout.height; }}>
          <View style={[st.masthead, { marginLeft: RAIL }]}>
            <T size={11} weight="semi" tracking={1.2}>TAKTO ONE</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: feed.live ? C.red : C.ink3 }} />
              <Label>{feed.word}</Label>
            </View>
          </View>
          <View style={{ height: plateH, marginLeft: RAIL, marginRight: 12 }}>
            <Stage spec={twin} style={StyleSheet.absoluteFill} />
          </View>
          <View style={[st.caption, { marginLeft: RAIL }]}>
            <T size={11} weight="italic" color={C.ink2}>Fig. 1 — The twin, twelve joints, {play ? `replaying “${play.take.title}”` : 'from the synthetic feed'}.</T>
            <T size={11} tabular color={C.ink3}>{play ? clock(play.t) : `${st_.liveJoints}/12`}</T>
          </View>
          <Rule heavy style={{ marginLeft: RAIL, marginRight: 12 }} />
        </View>

        {/* 01 cover */}
        <View onLayout={onLayoutOf('welcome')} style={[st.section, { marginLeft: RAIL }]}>
          <T size={44} weight="light" lh={46} style={{ marginTop: 10 }}>Every joint of the hand,{'\n'}<T size={44} weight="italic" lh={46}>live.</T></T>
          <T size={15} lh={23} color={C.ink2} style={{ marginTop: 14, maxWidth: 300 }}>A digital twin of the TAKTO ONE hand: the real CAD, the shared kinematics, from the device or from a recorded take.</T>
          <Bar label="Start session" onPress={() => go('live')} style={{ marginTop: 24 }} />
          <Bar label="Connect a device" light onPress={() => go('data')} style={{ marginTop: 8 }} />
          <T size={11} weight="italic" color={C.ink3} style={{ marginTop: 16 }}>Research prototype. Not a medical device. The feed is synthetic: no hand wore the device.</T>
        </View>

        {/* 02 live */}
        <View onLayout={onLayoutOf('live')} style={[st.section, { marginLeft: RAIL }]}>
          <Label>02 · Live</Label>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 6 }}>
            <View>
              <T size={72} weight="light" lh={72} tabular tracking={-3}>{st_.mean.toFixed(0)}<T size={30} weight="light" color={C.ink3}>°</T></T>
              <T size={13} weight="italic" color={C.ink2}>mean flexion, peak {FINGER_NAME[st_.peakFinger].toLowerCase()} {st_.peak.toFixed(0)}°</T>
            </View>
            <View style={{ alignItems: 'flex-end', paddingBottom: 6 }}>
              <T size={24} weight="light" tabular color={st_.emg > 0.8 ? C.red : C.ink}>{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T>
              <T size={11} weight="italic" color={C.ink2}>effort, {st_.blendWord.toLowerCase()}</T>
            </View>
          </View>
          <View style={{ marginTop: 10 }}><InkLine values={hist.values} width={colW} height={40} red={st_.emg > 0.8} /></View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
            <Label>Effort, last seconds</Label>
            <Word label={showTable ? 'Hide table' : 'Table 1'} on={showTable} onPress={() => setShowTable(!showTable)} size={12} />
          </View>
          {showTable ? (
            <View style={{ marginTop: 14 }}>
              <T size={11} weight="italic" color={C.ink2}>Table 1 — Joint angles in degrees, as the encoders report them.</T>
              <Rule heavy style={{ marginTop: 6 }} />
              <View style={st.tr}>
                <Label style={{ flex: 1.2 }}>Finger</Label>
                {JOINTS.map((j) => <Label key={j.key} style={{ flex: 1, textAlign: 'right' }}>{j.short} <T size={10} color={C.ink3}>/{j.max}</T></Label>)}
              </View>
              <Rule />
              {FINGERS.map((f) => (
                <View key={f}>
                  <View style={st.tr}>
                    <T size={14} style={{ flex: 1.2 }}>{FINGER_NAME[f]}</T>
                    {JOINTS.map((j) => {
                      const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                      return <T key={j.key} size={16} weight="light" tabular color={!on ? C.ink3 : Math.abs(v) > j.max * 0.9 ? C.red : C.ink} style={{ flex: 1, textAlign: 'right' }}>{fmtDeg(v, on, j.signed)}</T>;
                    })}
                  </View>
                  <Rule />
                </View>
              ))}
            </View>
          ) : (
            <View style={{ marginTop: 14 }}>
              {FINGERS.map((f) => (
                <View key={f} style={[st.tr, { borderBottomWidth: 1, borderColor: C.rule }]}>
                  <T size={14} style={{ width: 70 }}>{FINGER_NAME[f]}</T>
                  <View style={{ flex: 1, height: 6, justifyContent: 'center' }}>
                    <View style={{ height: 1, backgroundColor: C.rule }} />
                    <View style={{ position: 'absolute', left: 0, width: `${st_.curl[f] * 100}%`, height: 3, backgroundColor: st_.curl[f] > 0.82 ? C.red : C.ink }} />
                  </View>
                  <T size={16} weight="light" tabular style={{ width: 44, textAlign: 'right' }}>{(st_.curl[f] * 100).toFixed(0)}</T>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* 03 replay */}
        <View onLayout={onLayoutOf('replay')} style={[st.section, { marginLeft: RAIL }]}>
          <Label>03 · Replay</Label>
          {!play ? (
            <>
              <T size={26} weight="light" style={{ marginTop: 6 }}>Recorded takes</T>
              <T size={12} weight="italic" color={C.ink2} style={{ marginTop: 2 }}>Choreographed samples, not recordings of a person.</T>
              <View style={{ marginTop: 12 }}>
                {takes.map((t, i) => (
                  <Pressable key={t.id} onPress={() => s.setTake(t)} style={({ pressed }) => [st.toc, pressed && { opacity: 0.6 }]}>
                    <T size={12} tabular color={C.ink3} style={{ width: 28 }}>{i + 1}.</T>
                    <View style={{ flex: 1 }}>
                      <T size={17}>{t.title}</T>
                      <T size={11.5} weight="italic" color={C.ink2}>{t.note}</T>
                    </View>
                    <T size={13} tabular color={C.ink2}>{t.durationS.toFixed(0)} s</T>
                    <Disc kind="play" size={34} filled={false} onPress={() => s.setTake(t)} />
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 }}>
                <T size={26} weight="light">{play.take.title}</T>
                <T size={22} weight="light" tabular>{clock(play.t)}</T>
              </View>
              <T size={12} weight="italic" color={C.ink2}>{play.take.note}. {play.take.frames.length} frames, {play.take.durationS.toFixed(0)} seconds.</T>
              <View style={{ marginTop: 14 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
                <InkLine values={trace} width={colW} height={56} />
                <View style={{ position: 'absolute', top: -6, bottom: -6, width: 2, backgroundColor: C.red, left: `${(play.t / Math.max(0.01, play.take.durationS)) * 100}%` }} pointerEvents="none" />
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                <Label>0:00</Label><Label>Effort</Label><Label>{clock(play.take.durationS, false)}</Label>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
                <Disc kind="start" filled={false} size={38} onPress={() => s.seek(0)} />
                <Disc kind={play.playing ? 'pause' : 'play'} size={54} onPress={() => s.togglePlay()} />
                <Disc kind="end" filled={false} size={38} onPress={() => s.seek(play.take.durationS)} />
                <View style={{ flex: 1 }} />
                <View style={{ flexDirection: 'row', gap: 14 }}>
                  {[0.5, 1, 2].map((k) => <Word key={k} label={`${k}×`} on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
                </View>
                <Disc kind="eject" filled={false} size={38} onPress={() => s.setTake(null)} />
              </View>
              <T size={11} weight="italic" color={C.ink3} style={{ marginTop: 14 }}>Sample takes write anatomical abduction into the MCP column; the twin clamps it at 16°.</T>
            </>
          )}
        </View>

        {/* 04 data */}
        <View onLayout={onLayoutOf('data')} style={[st.section, { marginLeft: RAIL }]}>
          <Label>04 · Data</Label>
          <T size={26} weight="light" style={{ marginTop: 6 }}>Where the numbers come from</T>
          <T size={12} weight="italic" color={C.ink2} style={{ marginTop: 2 }}>{feed.word}, {feed.detail}.</T>
          <View style={{ marginTop: 14 }}>
            <Label>Bridge address</Label>
            <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.ink3} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Bar label="Connect" onPress={() => s.connect(url)} style={{ flex: 1 }} />
            <Bar label="Simulator" light onPress={() => s.useSimulator()} style={{ flex: 1 }} />
          </View>
          <T size={11} weight="italic" color={C.ink2} style={{ marginTop: 22 }}>Table 2 — Channels. The wire name and the mechanical name are not the same word.</T>
          <Rule heavy style={{ marginTop: 6 }} />
          {FINGERS.map((f) => JOINTS.map((j, i) => {
            const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
            return (
              <View key={f + j.key} style={[st.tr, { borderBottomWidth: 1, borderColor: i === 2 ? C.rule : C.ruleSoft }]}>
                <T size={12} tabular color={C.ink3} style={{ width: 96 }}>{f}_{j.wire}</T>
                <T size={13} style={{ flex: 1 }}>{FINGER_NAME[f]} {j.name.toLowerCase()}</T>
                <T size={14} weight="light" tabular color={!on ? C.ink3 : Math.abs(v) > j.max ? C.red : C.ink}>{on ? `${v.toFixed(1)}°` : 'absent'}</T>
              </View>
            );
          }))}
          <T size={11} weight="italic" color={C.ink2} style={{ marginTop: 22 }}>Table 3 — Rates. Four different numbers, not one.</T>
          <Rule heavy style={{ marginTop: 6 }} />
          {RATES.map((r) => (
            <View key={r.what} style={[st.tr, { borderBottomWidth: 1, borderColor: C.rule }]}>
              <T size={13} style={{ width: 130 }}>{r.what}</T>
              <T size={11.5} weight="italic" color={C.ink2} style={{ flex: 1 }}>{r.note}</T>
              <T size={14} tabular>{r.rate}</T>
            </View>
          ))}
          <T size={11} weight="italic" color={C.ink3} style={{ marginTop: 16 }}>Research prototype. Not a medical device.</T>
        </View>
      </ScrollView>

      {/* the rail: a line down the margin, four numbered marks, the current one inked */}
      <View style={[st.rail, { top: inset.top + 48, bottom: inset.bottom + 48 }]} pointerEvents="box-none">
        <View style={st.railLine} />
        {SECTIONS.map((sec) => {
          const on = sec.key === current;
          return (
            <Pressable key={sec.key} onPress={() => go(sec.key)} hitSlop={10} style={({ pressed }) => [st.mark, pressed && { opacity: 0.6 }]}>
              <View style={[st.markDot, on && { backgroundColor: C.ink, borderColor: C.ink }]} />
              <T size={9} tabular weight={on ? 'semi' : 'ui'} color={on ? C.ink : C.ink3}>{sec.n}</T>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  masthead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginRight: 12, paddingVertical: 8 },
  caption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginRight: 12, paddingVertical: 6 },
  section: { marginRight: 12, paddingTop: 22, paddingBottom: 28, borderBottomWidth: 1, borderColor: C.rule },
  bar: { height: 54, backgroundColor: C.ink, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  barLight: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: C.ink },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 },
  toc: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderColor: C.rule },
  input: { fontFamily: 'Fraunces_400Regular', fontSize: 16, color: C.ink, borderBottomWidth: 1.5, borderColor: C.ink, paddingVertical: 6, marginTop: 4 },
  rail: { position: 'absolute', left: 0, width: RAIL, alignItems: 'center', justifyContent: 'space-between' },
  railLine: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: C.rule },
  mark: { alignItems: 'center', backgroundColor: C.page, paddingVertical: 4 },
  markDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: C.ink3, backgroundColor: C.page, marginBottom: 3 },
});

export const design: Design = {
  id: '32', slug: 'editorial', name: 'Editorial plate',
  thesis: 'The hand as a plate in a book: a printed page you read downward, a serif headline, tables with rules, and a numbered rail in the margin for navigation.',
  fonts: { Fraunces_300Light, Fraunces_400Regular, Fraunces_400Regular_Italic, Fraunces_600SemiBold },
  bg: C.page, statusBar: 'dark-content', App: Page,
};
