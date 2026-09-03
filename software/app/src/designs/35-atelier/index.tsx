// 35-atelier - one screen, gestures only.
//
// The hand hangs in a pool of light on dark walnut. There are no tabs and
// no keys: the three surfaces are three pages you swipe between under the
// hand, marked by three small diamonds, and the detail rises when you swipe
// up on a page. Cormorant Garamond, light and italic, champagne on walnut.
// Controls are hairline medallions and words with a gold dot beneath.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, Animated, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path, Polygon, Rect, Defs, RadialGradient, Stop } from 'react-native-svg';
import { CormorantGaramond_300Light } from '@expo-google-fonts/cormorant-garamond/300Light';
import { CormorantGaramond_400Regular } from '@expo-google-fonts/cormorant-garamond/400Regular';
import { CormorantGaramond_400Regular_Italic } from '@expo-google-fonts/cormorant-garamond/400Regular_Italic';
import { CormorantGaramond_500Medium } from '@expo-google-fonts/cormorant-garamond/500Medium';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, effortTrace } from '../shared';
import { twin } from './twin';

const C = {
  bg: '#14100C', bg2: '#1F1710', cream: '#F3E9D6', gold: '#E6CFA3', gold2: 'rgba(230,207,163,0.6)', gold3: 'rgba(230,207,163,0.32)',
  line: 'rgba(230,207,163,0.22)', bright: '#F7DC9A', walnut: '#14100C',
};
const F = { light: 'CormorantGaramond_300Light', ui: 'CormorantGaramond_400Regular', italic: 'CormorantGaramond_400Regular_Italic', medium: 'CormorantGaramond_500Medium' };

function T({ children, size = 16, weight = 'ui', color = C.cream, caps, tracking, style, lh, align }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; caps?: boolean; tracking?: number;
  style?: StyleProp<TextStyle>; lh?: number; align?: 'left' | 'center' | 'right';
}) {
  return <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: lh ?? Math.round(size * (size > 30 ? 1.0 : 1.3)), letterSpacing: tracking ?? (caps ? size * 0.22 : 0), textTransform: caps ? 'uppercase' : 'none', fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}
function Small({ children, color = C.gold2, style, align }: { children: React.ReactNode; color?: string; style?: StyleProp<TextStyle>; align?: 'left' | 'center' | 'right' }) {
  return <T size={10.5} weight="medium" caps color={color} style={style} align={align}>{children}</T>;
}

/** A hairline medallion with a glyph; pressed, it fills champagne. */
function Medallion({ kind, onPress, size = 46, fill }: { kind: 'play' | 'pause' | 'start' | 'end' | 'eject' | 'arrow' | 'plus'; onPress?: () => void; size?: number; fill?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => [{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: C.gold, alignItems: 'center', justifyContent: 'center', backgroundColor: fill || pressed ? C.gold : 'transparent' }]}>
      {({ pressed }) => {
        const c = fill || pressed ? C.walnut : C.gold;
        return (
          <Svg width={16} height={16} viewBox="0 0 16 16">
            {kind === 'play' && <Polygon points="4,2 14,8 4,14" fill="none" stroke={c} strokeWidth={1} strokeLinejoin="round" />}
            {kind === 'pause' && <><Rect x={4} y={2.5} width={2.5} height={11} fill="none" stroke={c} strokeWidth={1} /><Rect x={9.5} y={2.5} width={2.5} height={11} fill="none" stroke={c} strokeWidth={1} /></>}
            {kind === 'start' && <><Path d="M3 2.5 V13.5" stroke={c} strokeWidth={1} /><Polygon points="13,2.5 5.5,8 13,13.5" fill="none" stroke={c} strokeWidth={1} strokeLinejoin="round" /></>}
            {kind === 'end' && <><Path d="M13 2.5 V13.5" stroke={c} strokeWidth={1} /><Polygon points="3,2.5 10.5,8 3,13.5" fill="none" stroke={c} strokeWidth={1} strokeLinejoin="round" /></>}
            {kind === 'eject' && <><Polygon points="3,9.5 8,3 13,9.5" fill="none" stroke={c} strokeWidth={1} strokeLinejoin="round" /><Path d="M3 12.5 H13" stroke={c} strokeWidth={1} /></>}
            {kind === 'arrow' && <Path d="M2 8 H13 M9 4 L13 8 L9 12" stroke={c} strokeWidth={1} fill="none" />}
            {kind === 'plus' && <Path d="M8 2 V14 M2 8 H14" stroke={c} strokeWidth={1} />}
          </Svg>
        );
      }}
    </Pressable>
  );
}

/** A word as a control, a gold dot beneath when chosen. */
function Word({ label, on, onPress, size = 17 }: { label: string; on?: boolean; onPress?: () => void; size?: number }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [{ alignItems: 'center', gap: 3 }, pressed && { opacity: 0.6 }]}>
      <T size={size} weight={on ? 'medium' : 'light'} color={on ? C.bright : C.gold2}>{label}</T>
      <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: on ? C.bright : 'transparent' }} />
    </Pressable>
  );
}

/** A finger as a hairline ring with its initial. */
function Ring({ frac, label, absent, size = 58 }: { frac: number; label: string; absent?: boolean; size?: number }) {
  const r = size / 2 - 2, c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.line} strokeWidth={1} fill="none" />
        {!absent && <Circle cx={size / 2} cy={size / 2} r={r} stroke={v > 0.82 ? C.bright : C.gold} strokeWidth={1.5} fill="none" strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="round" />}
      </Svg>
      <T size={20} weight="light" color={absent ? C.gold3 : C.cream}>{label}</T>
    </View>
  );
}

function Trace({ values, width, height, played }: { values: number[]; width: number; height: number; played?: number }) {
  const n = values.length;
  let d = '';
  values.forEach((v, i) => { d += (i ? ' L ' : 'M ') + ((i / Math.max(1, n - 1)) * width).toFixed(1) + ' ' + (height - 1 - Math.max(0, Math.min(1, v)) * (height - 2)).toFixed(1); });
  return (
    <Svg width={width} height={height}>
      {n > 1 && <Path d={d} stroke={C.gold} strokeWidth={1} fill="none" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill="rgba(230,207,163,0.08)" /><Path d={`M${played * width} 0 V${height}`} stroke={C.bright} strokeWidth={1} /></>}
    </Svg>
  );
}

const PAGES: ScreenKey[] = ['live', 'replay', 'data'];

/* ---------- the one screen ---------- */

function One({ initialScreen, detail }: DesignProps) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const feed = feedWord(s);
  const [welcome, setWelcome] = useState(initialScreen === 'welcome');
  const [page, setPage] = useState<ScreenKey>(initialScreen === 'welcome' ? 'live' : initialScreen);
  const [open, setOpen] = useState(detail);
  const pager = useRef<ScrollView>(null);
  const takes = useMemo(bundledTakes, []);
  const play = s.play;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 100) : []), [play?.take.id]);
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  // swipe up on the page opens the detail, swipe down closes it
  const vertical = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 12 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
    onPanResponderRelease: (_, g) => { if (g.dy < -30) setOpen(true); if (g.dy > 30) setOpen(false); },
  }), []);

  useEffect(() => {
    const i = PAGES.indexOf(page);
    setTimeout(() => pager.current?.scrollTo({ x: i * width, animated: false }), 20);
  }, []);

  const pool = Math.min(width, height * 0.5);
  const stageBottom = open ? height * 0.5 : height * 0.36;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* the pool of light */}
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="pool" cx="50%" cy="38%" r="45%"><Stop offset="0" stopColor="#3A2C1E" stopOpacity="1" /><Stop offset="1" stopColor={C.bg} stopOpacity="1" /></RadialGradient>
        </Defs>
        <Rect width={width} height={height} fill="url(#pool)" />
      </Svg>
      <Stage spec={twin} style={[StyleSheet.absoluteFill, { top: inset.top + 30, bottom: stageBottom }]} />

      {/* masthead */}
      <View style={[st.head, { top: inset.top + 10 }]} pointerEvents="none">
        <T size={13} weight="medium" caps tracking={4} color={C.gold}>Takto one</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 5, height: 5, transform: [{ rotate: '45deg' }], backgroundColor: feed.live ? C.bright : 'transparent', borderWidth: 0.75, borderColor: C.gold }} />
          <Small>{feed.word}</Small>
        </View>
      </View>

      {/* the pages */}
      {!welcome && <View style={[st.pages, { height: open ? height * 0.5 : height * 0.36, paddingBottom: inset.bottom }]} {...vertical.panHandlers}>
        <View style={st.diamonds}>
          {PAGES.map((p) => <View key={p} style={[st.diamond, p === page && st.diamondOn]} />)}
        </View>
        <ScrollView ref={pager} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => setPage(PAGES[Math.round(e.nativeEvent.contentOffset.x / width)] ?? 'live')}>
          {/* LIVE */}
          <View style={{ width, paddingHorizontal: 28 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <View>
                <T size={64} weight="light" color={C.cream} tracking={-1}>{st_.mean.toFixed(0)}<T size={30} weight="light" color={C.gold2}>°</T></T>
                <T size={15} weight="italic" color={C.gold2}>mean flexion, peak {FINGER_NAME[st_.peakFinger].toLowerCase()} {st_.peak.toFixed(0)}°</T>
              </View>
              <View style={{ alignItems: 'flex-end', paddingBottom: 8 }}>
                <T size={28} weight="light" color={st_.emg > 0.8 ? C.bright : C.cream}>{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T>
                <T size={13} weight="italic" color={C.gold2}>effort, {st_.blendWord.toLowerCase()}</T>
              </View>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16, paddingHorizontal: 6 }}>
              {FINGERS.map((f) => <Ring key={f} frac={st_.curl[f]} label={FINGER_NAME[f][0]} absent={!(frame.ok[f].mcp || frame.ok[f].pip)} />)}
            </View>
            {!open ? (
              <Pressable onPress={() => setOpen(true)} style={{ alignItems: 'center', marginTop: 14 }}>
                <Small color={C.gold3}>Swipe up for the twelve joints</Small>
              </Pressable>
            ) : (
              <View style={{ marginTop: 16 }}>
                <View style={[st.tr, { borderBottomColor: C.gold3 }]}>
                  <Small style={{ flex: 1.3 }}>Finger</Small>
                  {JOINTS.map((j) => <Small key={j.key} style={{ flex: 1, textAlign: 'right' }}>{j.short}</Small>)}
                </View>
                {FINGERS.map((f) => (
                  <View key={f} style={st.tr}>
                    <T size={16} weight="italic" color={C.gold2} style={{ flex: 1.3 }}>{FINGER_NAME[f]}</T>
                    {JOINTS.map((j) => {
                      const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                      return <T key={j.key} size={19} weight="light" color={!on ? C.gold3 : Math.abs(v) > j.max * 0.9 ? C.bright : C.cream} style={{ flex: 1, textAlign: 'right' }}>{fmtDeg(v, on, j.signed)}</T>;
                    })}
                  </View>
                ))}
                <Pressable onPress={() => setOpen(false)} style={{ alignItems: 'center', marginTop: 10 }}><Small color={C.gold3}>Swipe down to close</Small></Pressable>
              </View>
            )}
          </View>
          {/* REPLAY */}
          <View style={{ width, paddingHorizontal: 28 }}>
            {!play ? (
              <>
                <T size={30} weight="light">Recorded takes</T>
                <T size={13} weight="italic" color={C.gold2}>Choreographed samples, not recordings of a person.</T>
                <View style={{ marginTop: 10 }}>
                  {takes.map((t) => (
                    <Pressable key={t.id} onPress={() => s.setTake(t)} style={({ pressed }) => [st.take, pressed && { opacity: 0.6 }]}>
                      <View style={[st.diamond, { backgroundColor: C.gold, marginRight: 12 }]} />
                      <View style={{ flex: 1 }}>
                        <T size={20} weight="light">{t.title}</T>
                        <T size={12.5} weight="italic" color={C.gold2}>{t.note}</T>
                      </View>
                      <T size={14} color={C.gold2}>{t.durationS.toFixed(0)} s</T>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <T size={30} weight="light">{play.take.title}</T>
                  <T size={26} weight="light">{clock(play.t)}</T>
                </View>
                <T size={12.5} weight="italic" color={C.gold2}>{play.take.note} · {play.take.durationS.toFixed(0)} s · {play.speed}×</T>
                <View style={{ marginTop: 12 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
                  <Trace values={trace} width={width - 56} height={44} played={play.t / Math.max(0.01, play.take.durationS)} />
                  <View style={{ height: 1, backgroundColor: C.line }} />
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 }}>
                  <Medallion kind="start" size={38} onPress={() => s.seek(0)} />
                  <Medallion kind={play.playing ? 'pause' : 'play'} size={50} fill onPress={() => s.togglePlay()} />
                  <Medallion kind="end" size={38} onPress={() => s.seek(play.take.durationS)} />
                  <View style={{ flex: 1 }} />
                  <View style={{ flexDirection: 'row', gap: 14 }}>
                    {[0.5, 1, 2].map((k) => <Word key={k} label={`${k}×`} on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
                  </View>
                  <Medallion kind="eject" size={38} onPress={() => s.setTake(null)} />
                </View>
              </>
            )}
          </View>
          {/* DATA */}
          <View style={{ width, paddingHorizontal: 28 }}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <T size={30} weight="light">Provenance</T>
              <T size={13} weight="italic" color={C.gold2}>{feed.word}, {feed.detail}.</T>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 10 }}>
                <View style={{ flex: 1 }}>
                  <Small>Bridge address</Small>
                  <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.gold3} />
                </View>
                <Medallion kind="arrow" size={40} fill onPress={() => s.connect(url)} />
                <Word label="Simulator" size={15} onPress={() => s.useSimulator()} />
              </View>
              <Small style={{ marginTop: 18 }}>Channels · wire name and mechanical name</Small>
              {FINGERS.map((f) => (
                <View key={f} style={st.tr}>
                  <T size={16} weight="italic" color={C.gold2} style={{ width: 64 }}>{FINGER_NAME[f]}</T>
                  {JOINTS.map((j) => {
                    const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                    return (
                      <View key={j.key} style={{ flex: 1, alignItems: 'flex-end' }}>
                        <T size={17} weight="light" color={!on ? C.gold3 : Math.abs(v) > j.max ? C.bright : C.cream}>{on ? `${v.toFixed(1)}°` : 'absent'}</T>
                        <T size={9.5} color={C.gold3}>{f}_{j.wire}</T>
                      </View>
                    );
                  })}
                </View>
              ))}
              <Small style={{ marginTop: 18 }}>Rates · four numbers, not one</Small>
              {RATES.map((r) => (
                <View key={r.what} style={st.tr}>
                  <T size={16} style={{ width: 130 }}>{r.what}</T>
                  <T size={12.5} weight="italic" color={C.gold2} style={{ flex: 1 }}>{r.note}</T>
                  <T size={17} weight="light">{r.rate}</T>
                </View>
              ))}
              <T size={12} weight="italic" color={C.gold3} style={{ marginTop: 14, marginBottom: 20 }}>Research prototype. Not a medical device.</T>
            </ScrollView>
          </View>
        </ScrollView>
      </View>}

      {/* the welcome veil */}
      {welcome && (
        <Pressable onPress={() => setWelcome(false)} style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end', paddingBottom: inset.bottom + 56, paddingHorizontal: 28 }]}>
          <LinearGradient colors={['rgba(20,16,12,0)', 'rgba(20,16,12,0.85)', C.bg]} locations={[0, 0.55, 1]} style={[StyleSheet.absoluteFill, { top: height * 0.3 }]} pointerEvents="none" />
          <Small color={C.gold2}>Companion · research prototype</Small>
          <T size={58} weight="light" color={C.cream} lh={60} style={{ marginTop: 6 }}>Takto <T size={58} weight="italic" lh={60}>One</T></T>
          <T size={16} weight="italic" color={C.gold2} style={{ marginTop: 8, maxWidth: 300 }}>Every joint of the hand, live from the device or from a recorded take.</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 28 }}>
            <Medallion kind="arrow" size={54} fill onPress={() => setWelcome(false)} />
            <T size={15} weight="italic" color={C.gold2}>Tap to begin, or</T>
            <Word label="connect a device" size={15} onPress={() => { setWelcome(false); setPage('data'); pager.current?.scrollTo({ x: 2 * width, animated: true }); }} />
          </View>
        </Pressable>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  head: { position: 'absolute', left: 28, right: 28, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pages: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  diamonds: { flexDirection: 'row', justifyContent: 'center', gap: 10, paddingVertical: 10 },
  diamond: { width: 6, height: 6, transform: [{ rotate: '45deg' }], borderWidth: 0.75, borderColor: C.gold, backgroundColor: 'transparent' },
  diamondOn: { backgroundColor: C.gold },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line },
  take: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  input: { fontFamily: 'CormorantGaramond_400Regular', fontSize: 18, color: C.cream, borderBottomWidth: 1, borderColor: C.gold, paddingVertical: 4 },
});

export const design: Design = {
  id: '35', slug: 'atelier', name: 'Atelier',
  thesis: 'A jewel on walnut: a polished gold-titanium hand in a pool of light, garamond, and one screen you swipe across and up, with no tabs and no keys.',
  fonts: { CormorantGaramond_300Light, CormorantGaramond_400Regular, CormorantGaramond_400Regular_Italic, CormorantGaramond_500Medium },
  bg: '#14100C', statusBar: 'light-content', App: One,
};
