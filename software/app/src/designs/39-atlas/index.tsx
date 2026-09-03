// 39-atlas - a sheet from an atlas.
//
// Cream paper, contour lines around the hand as if it were a landform, a
// graticule, a title cartouche, a scale bar, a legend box for the readings
// and a compass rose in the corner whose four points are the navigation.
// Alegreya, with the wide-tracked italics of map labels. The effort trace
// is drawn as an elevation profile with hatching.
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Line, Polygon, Circle, Rect, Defs, Pattern } from 'react-native-svg';
import { Alegreya_400Regular } from '@expo-google-fonts/alegreya/400Regular';
import { Alegreya_400Regular_Italic } from '@expo-google-fonts/alegreya/400Regular_Italic';
import { Alegreya_500Medium } from '@expo-google-fonts/alegreya/500Medium';
import { Alegreya_700Bold } from '@expo-google-fonts/alegreya/700Bold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin } from './twin';

const C = {
  paper: '#EFE7D3', paper2: '#E6DCC4', ink: '#3A2E1E', ink2: '#6B5C46', ink3: '#9A8B72', contour: '#C8B48E', contourMajor: '#B49C72',
  olive: '#5F6B49', sienna: '#9E4F2C', cream: '#FBF6EA', water: '#8FA9B3',
};
const F = { ui: 'Alegreya_400Regular', italic: 'Alegreya_400Regular_Italic', medium: 'Alegreya_500Medium', bold: 'Alegreya_700Bold' };

function T({ children, size = 15, weight = 'ui', color = C.ink, style, caps, tracking, align, lh }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; style?: StyleProp<TextStyle>; caps?: boolean; tracking?: number; align?: 'left' | 'center' | 'right'; lh?: number;
}) {
  return <Text style={[{ fontFamily: F[weight], fontSize: size, color, lineHeight: lh ?? Math.round(size * 1.3), textTransform: caps ? 'uppercase' : 'none', letterSpacing: tracking ?? (caps ? size * 0.18 : 0), fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}
/** A map label: italic, wide, small caps feel. */
function MapLabel({ children, color = C.ink2, style, align }: { children: React.ReactNode; color?: string; style?: StyleProp<TextStyle>; align?: 'left' | 'center' | 'right' }) {
  return <T size={11} weight="italic" caps color={color} style={style} align={align}>{children}</T>;
}

/** Contour lines: closed, gently irregular rings around a centre. */
function Contours({ width, height, cx, cy }: { width: number; height: number; cx: number; cy: number }) {
  const paths = useMemo(() => {
    const out: { d: string; major: boolean }[] = [];
    for (let k = 1; k <= 14; k++) {
      const base = 34 * k;
      let d = '';
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const r = base * (1 + 0.16 * Math.sin(a * 3 + k * 0.7) + 0.09 * Math.sin(a * 5 - k * 1.3) + 0.05 * Math.sin(a * 8 + k));
        const x = cx + r * Math.cos(a) * 1.12, y = cy + r * Math.sin(a) * 0.86;
        d += (i ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      out.push({ d: d + ' Z', major: k % 5 === 0 });
    }
    return out;
  }, [width, height, cx, cy]);
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* graticule */}
      {Array.from({ length: 6 }, (_, i) => <Line key={`v${i}`} x1={(width / 5) * i} y1={0} x2={(width / 5) * i} y2={height} stroke={C.paper2} strokeWidth={1} />)}
      {Array.from({ length: 12 }, (_, i) => <Line key={`h${i}`} x1={0} y1={(height / 11) * i} x2={width} y2={(height / 11) * i} stroke={C.paper2} strokeWidth={1} />)}
      {paths.map((p, i) => <Path key={i} d={p.d} stroke={p.major ? C.contourMajor : C.contour} strokeWidth={p.major ? 1.1 : 0.7} fill="none" />)}
    </Svg>
  );
}

/** The compass rose: four points, the current one filled. */
function Rose({ screen, onScreen, size = 112 }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; size?: number }) {
  const c = size / 2, R = c - 14, r = R * 0.36;
  const points: { key: ScreenKey; label: string; a: number }[] = [
    { key: 'live', label: 'Live', a: -90 }, { key: 'replay', label: 'Replay', a: 0 }, { key: 'data', label: 'Data', a: 90 }, { key: 'welcome', label: 'Cover', a: 180 },
  ];
  const pt = (a: number, rr: number) => [c + rr * Math.cos((a * Math.PI) / 180), c + rr * Math.sin((a * Math.PI) / 180)];
  return (
    <View style={{ width: size + 40, height: size + 20, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size}>
        <Circle cx={c} cy={c} r={R + 4} stroke={C.ink3} strokeWidth={0.75} fill={C.cream} />
        <Circle cx={c} cy={c} r={R - 2} stroke={C.ink3} strokeWidth={0.5} fill="none" strokeDasharray="1 3" />
        {points.map((p) => {
          const [tx, ty] = pt(p.a, R), [lx, ly] = pt(p.a - 90, r), [rx, ry] = pt(p.a + 90, r);
          const on = p.key === screen;
          return <Polygon key={p.key} points={`${tx},${ty} ${lx},${ly} ${c},${c} ${rx},${ry}`} fill={on ? C.sienna : C.cream} stroke={C.ink} strokeWidth={0.9} />;
        })}
        <Circle cx={c} cy={c} r={3} fill={C.ink} />
      </Svg>
      {points.map((p) => {
        const [x, y] = pt(p.a, R + 16);
        const on = p.key === screen;
        return (
          <Pressable key={p.key} onPress={() => onScreen(p.key)} hitSlop={12} style={{ position: 'absolute', left: 20 + x - 26, top: 10 + y - 8, width: 52, height: 16, alignItems: 'center', justifyContent: 'center' }}>
            <T size={9.5} weight={on ? 'bold' : 'medium'} caps color={on ? C.sienna : C.ink2} tracking={1}>{p.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A legend entry as a control: a swatch and a word, in a boxed legend. Pressed: the swatch fills sienna. */
function Entry({ label, onPress, swatch = C.olive, primary, style }: { label: string; onPress?: () => void; swatch?: string; primary?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.entry, primary && { backgroundColor: C.ink }, pressed && { backgroundColor: C.sienna }, style]}>
      {({ pressed }) => (
        <>
          <View style={{ width: 14, height: 14, backgroundColor: primary || pressed ? C.cream : swatch, borderWidth: 1, borderColor: primary || pressed ? C.cream : C.ink }} />
          <T size={15} weight="medium" color={primary || pressed ? C.cream : C.ink}>{label}</T>
        </>
      )}
    </Pressable>
  );
}

/** A scale bar. */
function ScaleBar({ frac, label, width = 120, absent }: { frac: number; label: string; width?: number; absent?: boolean }) {
  const v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ width }}>
      <View style={{ flexDirection: 'row', height: 6, borderWidth: 1, borderColor: C.ink }}>
        {[0, 1, 2, 3].map((i) => <View key={i} style={{ flex: 1, backgroundColor: i % 2 ? C.cream : C.ink }} />)}
      </View>
      {!absent && <View style={{ position: 'absolute', left: v * width - 1, top: -4, width: 2, height: 14, backgroundColor: C.sienna }} />}
      <T size={9} weight="italic" color={C.ink2} style={{ marginTop: 2 }}>{label}</T>
    </View>
  );
}

/** An elevation profile: hatched fill under the line. */
function Profile({ values, width, height, played }: { values: number[]; width: number; height: number; played?: number }) {
  const n = values.length;
  const pts = values.map((v, i) => [((i / Math.max(1, n - 1)) * width), height - 1 - Math.max(0, Math.min(1, v)) * (height - 4)]);
  const line = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
  return (
    <Svg width={width} height={height}>
      <Defs><Pattern id="hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><Line x1={0} y1={0} x2={0} y2={4} stroke={C.ink3} strokeWidth={0.8} /></Pattern></Defs>
      {n > 1 && <Path d={`${line} L ${width} ${height} L 0 ${height} Z`} fill="url(#hatch)" />}
      {n > 1 && <Path d={line} stroke={C.ink} strokeWidth={1.2} fill="none" />}
      <Line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} stroke={C.ink} strokeWidth={1} />
      {played !== undefined && <Line x1={played * width} x2={played * width} y1={0} y2={height} stroke={C.sienna} strokeWidth={2} />}
    </Svg>
  );
}

/* ---------- the sheet ---------- */

function Sheet({ screen, onScreen, title, children, share = 0.5 }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; title: string; children: React.ReactNode; share?: number }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  const stageH = height * share;
  return (
    <View style={{ flex: 1, backgroundColor: C.paper }}>
      <Contours width={width} height={height} cx={width * 0.52} cy={inset.top + 40 + stageH * 0.55} />
      <View style={{ position: 'absolute', left: 0, right: 0, top: inset.top + 30, height: stageH }}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
      </View>
      {/* the cartouche */}
      <View style={[st.cartouche, { top: inset.top + 10 }]}>
        <T size={9} weight="italic" caps color={C.ink2} tracking={2}>Takto one · sheet</T>
        <T size={18} weight="bold" style={{ marginTop: -2 }}>{title}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: feed.live ? C.olive : C.sienna }} />
          <T size={10} weight="italic" color={C.ink2}>{feed.word} · {st_.liveJoints} of 12 joints</T>
        </View>
      </View>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: inset.top + 30 + stageH }} pointerEvents="box-none">
        {children}
      </View>
      <View style={[st.roseWrap, { bottom: inset.bottom + 6 }]}>
        <View style={st.roseInset}><Rose screen={screen} onScreen={onScreen} /></View>
      </View>
    </View>
  );
}

/** The legend box: a double rule border, a title strip. */
function Legend({ title, children, style }: { title: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[st.legend, style]}>
      <View style={st.legendInner}>
        <MapLabel style={{ marginBottom: 6 }}>{title}</MapLabel>
        {children}
      </View>
    </View>
  );
}

function Welcome({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const inset = useSafeAreaInsets();
  return (
    <Sheet screen="welcome" onScreen={onScreen} title="Cover" share={0.5}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <T size={40} weight="bold" lh={42}>Takto One</T>
        <T size={15} weight="italic" color={C.ink2} style={{ marginTop: 4, maxWidth: 250 }}>An atlas of the hand: every joint, live from the device or from a recorded take.</T>
        <Legend title="Legend · begin" style={{ marginTop: 14, width: 230 }}>
          <Entry label="Start session" primary onPress={() => onScreen('live')} />
          <Entry label="Connect a device" swatch={C.water} onPress={() => onScreen('data')} style={{ marginTop: 6 }} />
        </Legend>
        <T size={10} weight="italic" color={C.ink3} style={{ marginTop: 10, maxWidth: 230 }}>Research prototype. Not a medical device. The feed is synthetic: no hand wore the device.</T>
      </View>
    </Sheet>
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
    <Sheet screen="live" onScreen={onScreen} title="Live" share={all ? 0.34 : 0.44}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 170 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <View>
            <MapLabel>Mean flexion</MapLabel>
            <T size={52} weight="bold" lh={54}>{st_.mean.toFixed(0)}°</T>
            <T size={12} weight="italic" color={C.ink2}>summit {FINGER_NAME[st_.peakFinger]} at {st_.peak.toFixed(0)}°</T>
          </View>
          <View style={{ alignItems: 'flex-end', paddingBottom: 4 }}>
            <MapLabel>Effort</MapLabel>
            <T size={30} weight="bold" color={st_.emg > 0.8 ? C.sienna : C.ink}>{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T>
            <T size={12} weight="italic" color={C.ink2}>{st_.blendWord.toLowerCase()}</T>
          </View>
        </View>
        {!all ? (
          <Legend title="Legend · fingers, flexion of range" style={{ marginTop: 10, width: width - 32 }}>
            {FINGERS.map((f) => {
              const live = frame.ok[f].mcp || frame.ok[f].pip;
              return (
                <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <View style={{ width: 12, height: 12, backgroundColor: C.olive, borderWidth: 1, borderColor: C.ink }} />
                  <T size={14} weight="medium" style={{ width: 56 }}>{FINGER_NAME[f]}</T>
                  <ScaleBar frac={st_.curl[f]} label="" width={width - 32 - 24 - 150} absent={!live} />
                  <T size={15} weight="bold" style={{ width: 40, textAlign: 'right' }} color={live ? C.ink : C.ink3}>{live ? `${(st_.curl[f] * 100).toFixed(0)}%` : '–'}</T>
                </View>
              );
            })}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 4 }}>
              <View style={{ flex: 1 }}><MapLabel>Effort profile</MapLabel><Profile values={hist.values} width={width - 32 - 24 - 120} height={36} /></View>
              <Entry label="All twelve" swatch={C.sienna} onPress={() => setAll(true)} />
            </View>
          </Legend>
        ) : (
          <Legend title="Legend · twelve joints, degrees" style={{ marginTop: 10, width: width - 32 }}>
            <View style={{ flexDirection: 'row', marginBottom: 2 }}>
              <View style={{ width: 70 }} />
              {JOINTS.map((j) => <MapLabel key={j.key} style={{ flex: 1 }} align="right">{j.short} /{j.max}</MapLabel>)}
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: C.paper2, paddingVertical: 4 }}>
                <T size={14} weight="medium" style={{ width: 70 }}>{FINGER_NAME[f]}</T>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return <T key={j.key} size={18} weight="bold" color={!on ? C.ink3 : Math.abs(v) > j.max * 0.9 ? C.sienna : C.ink} style={{ flex: 1, textAlign: 'right' }}>{fmtDeg(v, on, j.signed)}</T>;
                })}
              </View>
            ))}
            <Entry label="Back to fingers" onPress={() => setAll(false)} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
          </Legend>
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
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 100) : []), [play?.take.id]);
  return (
    <Sheet screen="replay" onScreen={onScreen} title={play ? play.take.title : 'Replay'} share={0.42}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 170 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <Legend title="Legend · recorded takes, choreographed samples" style={{ width: width - 32 }}>
            {takes.map((t) => (
              <Pressable key={t.id} onPress={() => s.setTake(t)} style={({ pressed }) => [st.route, pressed && { backgroundColor: C.paper2 }]}>
                <Svg width={26} height={14}><Path d="M1 12 C 8 2, 14 12, 25 3" stroke={C.sienna} strokeWidth={1.5} fill="none" strokeDasharray="3 2" /></Svg>
                <View style={{ flex: 1 }}>
                  <T size={17} weight="medium">{t.title}</T>
                  <T size={12} weight="italic" color={C.ink2}>{t.note}</T>
                </View>
                <T size={13} weight="italic" color={C.ink2}>{t.durationS.toFixed(0)} s</T>
              </Pressable>
            ))}
          </Legend>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <View><MapLabel>Elapsed</MapLabel><T size={44} weight="bold" lh={46}>{clock(play.t)}</T></View>
              <View style={{ alignItems: 'flex-end' }}><MapLabel>Route</MapLabel><T size={14} weight="italic" color={C.ink2}>{clock(play.take.durationS)} · {play.take.frames.length} frames · {play.speed}×</T></View>
            </View>
            <Legend title="Effort profile · drag to travel" style={{ marginTop: 10, width: width - 32 }}>
              <View {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
                <Profile values={trace} width={width - 32 - 24} height={52} played={play.t / Math.max(0.01, play.take.durationS)} />
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                <Entry label="Start" onPress={() => s.seek(0)} />
                <Entry label={play.playing ? 'Pause' : 'Play'} primary onPress={() => s.togglePlay()} />
                <Entry label="End" onPress={() => s.seek(play.take.durationS)} />
                {[0.5, 1, 2].map((k) => <Entry key={k} label={`${k}×`} swatch={play.speed === k ? C.sienna : C.cream} onPress={() => s.setSpeed(k)} />)}
                <Entry label="Eject" swatch={C.water} onPress={() => s.setTake(null)} />
              </View>
            </Legend>
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
  const { width } = useWindowDimensions();
  return (
    <Sheet screen="data" onScreen={onScreen} title="Data" share={0.26}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 170 }} showsVerticalScrollIndicator={false}>
        <Legend title="Source" style={{ width: width - 32 }}>
          <T size={12} weight="italic" color={C.ink2}>{feed.word}, {feed.detail}</T>
          <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.ink3} />
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
            <Entry label="Connect" primary onPress={() => s.connect(url)} />
            <Entry label="Simulator" swatch={C.water} onPress={() => s.useSimulator()} />
          </View>
        </Legend>
        <Legend title="Legend · channels, wire name and mechanical name" style={{ marginTop: 10, width: width - 32 }}>
          {FINGERS.map((f) => (
            <View key={f} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: C.paper2, paddingVertical: 5 }}>
              <T size={14} weight="medium" style={{ width: 60 }}>{FINGER_NAME[f]}</T>
              {JOINTS.map((j) => {
                const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                return (
                  <View key={j.key} style={{ flex: 1, alignItems: 'flex-end' }}>
                    <T size={16} weight="bold" color={!on ? C.ink3 : Math.abs(v) > j.max ? C.sienna : C.ink}>{on ? `${v.toFixed(1)}°` : '–'}</T>
                    <T size={9} weight="italic" color={C.ink3}>{f}_{j.wire}</T>
                  </View>
                );
              })}
            </View>
          ))}
        </Legend>
        <Legend title="Rates · four numbers, not one" style={{ marginTop: 10, width: width - 32 }}>
          {RATES.map((r) => (
            <View key={r.what} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: C.paper2, paddingVertical: 5, gap: 8 }}>
              <T size={14} weight="medium" style={{ width: 120 }}>{r.what}</T>
              <T size={11} weight="italic" color={C.ink2} style={{ flex: 1 }}>{r.note}</T>
              <T size={16} weight="bold">{r.rate}</T>
            </View>
          ))}
        </Legend>
        <T size={10} weight="italic" color={C.ink3} style={{ marginTop: 8 }}>Research prototype. Not a medical device.</T>
      </ScrollView>
    </Sheet>
  );
}

function Shell({ initialScreen, detail }: DesignProps) {
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  if (screen === 'welcome') return <Welcome onScreen={setScreen} />;
  if (screen === 'live') return <Live detail={detail} onScreen={setScreen} />;
  if (screen === 'replay') return <Replay onScreen={setScreen} />;
  return <Data onScreen={setScreen} />;
}

const st = StyleSheet.create({
  cartouche: { position: 'absolute', left: 16, backgroundColor: C.cream, borderWidth: 1, borderColor: C.ink, paddingHorizontal: 10, paddingVertical: 6, ...({ boxShadow: `0 0 0 3px ${C.cream}, 0 0 0 4px ${C.ink3}` } as any) },
  roseWrap: { position: 'absolute', right: 6 },
  roseInset: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.ink, padding: 2, ...({ boxShadow: `0 0 0 3px ${C.paper}, 0 0 0 4px ${C.ink3}` } as any) },
  legend: { backgroundColor: C.cream, borderWidth: 1, borderColor: C.ink, padding: 3 },
  legendInner: { borderWidth: 0.75, borderColor: C.ink3, padding: 10 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingHorizontal: 10, borderWidth: 1, borderColor: C.ink, backgroundColor: C.cream, alignSelf: 'flex-start' },
  route: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderColor: C.paper2 },
  input: { fontFamily: 'Alegreya_400Regular', fontSize: 16, color: C.ink, borderBottomWidth: 1, borderColor: C.ink, paddingVertical: 4, marginTop: 6 },
});

export const design: Design = {
  id: '39', slug: 'atlas', name: 'Atlas',
  thesis: 'A sheet from an atlas: the hand as a landform on cream paper with contours and a graticule, readings in a legend box, and a compass rose whose four points are the navigation.',
  fonts: { Alegreya_400Regular, Alegreya_400Regular_Italic, Alegreya_500Medium, Alegreya_700Bold },
  bg: C.paper, statusBar: 'dark-content', App: Shell,
};
