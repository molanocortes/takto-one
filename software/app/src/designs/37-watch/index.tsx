// 37-watch - a watch face.
//
// Black OLED. A round dial fills the width with a ticked bezel around it
// that rotates to choose the surface (LIVE, REPLAY, DATA at 12 o'clock),
// and a crown on the right edge that is the primary control. Inside the
// dial: the steel hand, and complications at the corners: mean flexion,
// effort, the four fingers as subdials. The strap under the dial carries
// the lists. Barlow Condensed, because a watch sets its numerals tall.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, Animated, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Line, Polyline, Rect, Polygon } from 'react-native-svg';
import { BarlowCondensed_400Regular } from '@expo-google-fonts/barlow-condensed/400Regular';
import { BarlowCondensed_600SemiBold } from '@expo-google-fonts/barlow-condensed/600SemiBold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin } from './twin';

const C = {
  bg: '#000000', face: '#07080A', steel: '#C4C7CB', steel2: 'rgba(196,199,203,0.6)', steel3: 'rgba(196,199,203,0.3)', steel4: 'rgba(196,199,203,0.12)',
  rose: '#D9A66A', red: '#FF3B30', white: '#F4F4F4',
};
const F = { ui: 'BarlowCondensed_400Regular', semi: 'BarlowCondensed_600SemiBold' };

function T({ children, size = 14, semi, color = C.white, style, caps, tracking, align }: {
  children: React.ReactNode; size?: number; semi?: boolean; color?: string; style?: StyleProp<TextStyle>; caps?: boolean; tracking?: number; align?: 'left' | 'center' | 'right';
}) {
  return <Text style={[{ fontFamily: semi ? F.semi : F.ui, fontSize: size, color, lineHeight: Math.round(size * 1.15), letterSpacing: tracking ?? (caps ? size * 0.1 : 0), textTransform: caps ? 'uppercase' : 'none', fontVariant: ['tabular-nums'], textAlign: align }, style]}>{children}</Text>;
}

/** A complication arc: a thin track and a bright sweep, 270 degrees from 7 o'clock. */
function Comp({ frac, size = 64, color = C.white, stroke = 3, hot, children }: { frac: number; size?: number; color?: string; stroke?: number; hot?: boolean; children?: React.ReactNode }) {
  const r = size / 2 - stroke, cx = size / 2, cy = size / 2;
  const a0 = 135, a1 = 405;
  const p = (a: number) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const arc = (from: number, to: number) => { const [x0, y0] = p(from), [x1, y1] = p(to); return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
  const v = Math.max(0, Math.min(1, frac));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Path d={arc(a0, a1)} stroke={C.steel4} strokeWidth={stroke} fill="none" strokeLinecap="round" />
        {v > 0.004 && <Path d={arc(a0, a0 + (a1 - a0) * v)} stroke={hot ? C.red : color} strokeWidth={stroke} fill="none" strokeLinecap="round" />}
      </Svg>
      {children}
    </View>
  );
}

/** The crown: a ridged cylinder on the case edge. Press it. */
function Crown({ onPress, label }: { onPress?: () => void; label?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} style={({ pressed }) => [st.crown, pressed && { transform: [{ translateX: 3 }], backgroundColor: '#8E9196' }]}>
      {Array.from({ length: 6 }, (_, i) => <View key={i} style={{ position: 'absolute', top: 4 + i * 6, left: 0, right: 0, height: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} />)}
      {label && <View style={{ position: 'absolute', right: 26, top: 8, width: 90, alignItems: 'flex-end' }}><T size={10} caps color={C.steel2}>{label}</T></View>}
    </Pressable>
  );
}

/** A pusher: a small steel pill on the case. */
function Pusher({ label, onPress, on, style }: { label: string; onPress?: () => void; on?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => [st.pusher, (on || pressed) && { backgroundColor: C.steel }, style]}>
      {({ pressed }) => <T size={12} semi caps color={(on || pressed) ? C.bg : C.steel}>{label}</T>}
    </Pressable>
  );
}

function Trace({ values, width, height, played, hot }: { values: number[]; width: number; height: number; played?: number; hot?: boolean }) {
  const n = values.length;
  const pts = values.map((v, i) => `${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 1 - Math.max(0, Math.min(1, v)) * (height - 2)).toFixed(1)}`).join(' ');
  return (
    <Svg width={width} height={height}>
      {n > 1 && <Polyline points={pts} stroke={hot ? C.red : C.steel} strokeWidth={1.5} fill="none" strokeLinejoin="round" />}
      {played !== undefined && <><Rect x={0} y={0} width={played * width} height={height} fill={C.steel4} /><Line x1={played * width} x2={played * width} y1={0} y2={height} stroke={C.rose} strokeWidth={2} /></>}
    </Svg>
  );
}

/* ---------- the face ---------- */

const MODES: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'Live' }, { key: 'replay', label: 'Replay' }, { key: 'data', label: 'Data' }];

function Face({ screen, onScreen, size, welcome, detail, onDetail }: {
  screen: ScreenKey; onScreen: (s: ScreenKey) => void; size: number; welcome?: boolean; detail?: boolean; onDetail?: () => void;
}) {
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const feed = feedWord(s);
  const idx = Math.max(0, MODES.findIndex((m) => m.key === screen));
  const rot = useRef(new Animated.Value(-idx * 40)).current;
  useEffect(() => { Animated.spring(rot, { toValue: -idx * 40, useNativeDriver: false, speed: 10, bounciness: 4 }).start(); }, [idx]);
  const r = size / 2, bezel = 22;
  const ticks = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    const major = i % 10 === 0;
    ticks.push(<Line key={i} x1={r + (r - 3) * Math.cos(a)} y1={r + (r - 3) * Math.sin(a)} x2={r + (r - (major ? 12 : 7)) * Math.cos(a)} y2={r + (r - (major ? 12 : 7)) * Math.sin(a)} stroke={major ? C.steel : C.steel3} strokeWidth={major ? 1.5 : 1} />);
  }
  const face = size - bezel * 2;
  return (
    <View style={{ width: size, height: size }}>
      {/* the bezel, rotating */}
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: rot.interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) }] }]}>
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Circle cx={r} cy={r} r={r - 1} stroke={C.steel3} strokeWidth={1} fill={C.face} />
          <Circle cx={r} cy={r} r={r - bezel + 1} stroke={C.steel3} strokeWidth={1} fill={C.bg} />
          {ticks}
        </Svg>
        {MODES.map((m, i) => {
          const a = ((-90 + i * 40) * Math.PI) / 180, rr = r - bezel / 2 - 1;
          const on = m.key === screen;
          return (
            <Pressable key={m.key} onPress={() => onScreen(m.key)} hitSlop={10} style={{ position: 'absolute', left: r + rr * Math.cos(a) - 30, top: r + rr * Math.sin(a) - 9, width: 60, height: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: C.face, transform: [{ rotate: `${i * 40}deg` }] }}>
              <T size={11} semi caps color={on ? C.white : C.steel2} tracking={1.5}>{m.label}</T>
            </Pressable>
          );
        })}
      </Animated.View>
      {/* the 12 o'clock marker */}
      <View style={{ position: 'absolute', left: r - 5, top: -2, width: 10, height: 8, alignItems: 'center' }} pointerEvents="none">
        <Svg width={10} height={8}><Polygon points="0,0 10,0 5,8" fill={C.rose} /></Svg>
      </View>
      {/* the twin, inside the face */}
      <View style={{ position: 'absolute', left: bezel, top: bezel, width: face, height: face, borderRadius: face / 2, overflow: 'hidden' }}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
      </View>
      {/* complications */}
      {!welcome ? (
        <>
          <View style={{ position: 'absolute', left: bezel + 12, top: bezel + 14 }}>
            <Comp frac={st_.mean / 110} size={66} hot={st_.mean > 90}><T size={26} semi>{st_.mean.toFixed(0)}<T size={12} color={C.steel2}>°</T></T></Comp>
            <T size={9} caps color={C.steel2} align="center">Flex</T>
          </View>
          <View style={{ position: 'absolute', right: bezel + 12, top: bezel + 14 }}>
            <Comp frac={Math.max(0, st_.emg)} size={66} color={C.rose} hot={st_.emg > 0.8}><T size={22} semi>{st_.emg < 0 ? '–' : st_.emg.toFixed(2)}</T></Comp>
            <T size={9} caps color={C.steel2} align="center">Effort</T>
          </View>
          <Pressable onPress={onDetail} style={{ position: 'absolute', left: bezel, right: bezel, bottom: bezel + 10, flexDirection: 'row', justifyContent: 'center', gap: 6 }}>
            {FINGERS.map((f) => (
              <Comp key={f} frac={st_.curl[f]} size={40} stroke={2.5} hot={st_.curl[f] > 0.82}><T size={13} semi color={frame.ok[f].mcp || frame.ok[f].pip ? C.white : C.steel3}>{FINGER_NAME[f][0]}</T></Comp>
            ))}
          </Pressable>
        </>
      ) : (
        <View style={{ position: 'absolute', left: bezel, right: bezel, bottom: bezel + 18, alignItems: 'center' }} pointerEvents="none">
          <T size={11} caps color={C.steel2} tracking={2}>Takto one</T>
        </View>
      )}
      <View style={{ position: 'absolute', left: bezel, right: bezel, top: bezel + 8, alignItems: 'center' }} pointerEvents="none">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: feed.live ? '#34C759' : C.red }} />
          <T size={9} caps color={C.steel2} tracking={1.5}>{feed.word}</T>
        </View>
      </View>
    </View>
  );
}

/* ---------- the shell ---------- */

function Shell({ initialScreen, detail }: DesignProps) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  const [open, setOpen] = useState(detail);
  const takes = useMemo(bundledTakes, []);
  const play = s.play;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const hist = useRef(new History(60)).current;
  hist.push(st_.emg);
  const size = Math.min(width - 28, height * 0.5);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 100) : []), [play?.take.id]);
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const welcome = screen === 'welcome';
  const strapW = width - 32;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: inset.top + 10, alignItems: 'center' }}>
        <View style={{ width: size + 20, height: size }}>
          <View style={{ position: 'absolute', left: 0, top: 0 }}>
            <Face screen={welcome ? 'live' : screen} onScreen={setScreen} size={size} welcome={welcome} detail={open} onDetail={() => setOpen(!open)} />
          </View>
          {/* the crown and the pushers on the case */}
          <View style={{ position: 'absolute', right: -4, top: size * 0.42 }}>
            <Crown label={welcome ? 'Press to start' : play ? (play.playing ? 'Pause' : 'Play') : screen === 'replay' ? 'Load first' : screen === 'data' ? 'Connect' : 'Joints'}
              onPress={() => {
                if (welcome) setScreen('live');
                else if (screen === 'replay') { if (play) s.togglePlay(); else s.setTake(takes[0]); }
                else if (screen === 'data') s.connect(url);
                else setOpen(!open);
              }} />
          </View>
        </View>
      </View>

      {/* the strap */}
      <View style={[st.strap, { marginTop: 14, paddingBottom: inset.bottom + 12 }]}>
        <View style={st.lug} />
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12 }} showsVerticalScrollIndicator={false}>
          {welcome && (
            <>
              <T size={34} semi caps tracking={1}>Takto one</T>
              <T size={15} color={C.steel2}>Every joint of the hand, live from the device or from a recorded take. Press the crown to start.</T>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                <Pusher label="Start" on onPress={() => setScreen('live')} />
                <Pusher label="Connect a device" onPress={() => setScreen('data')} />
              </View>
              <T size={11} color={C.steel3} style={{ marginTop: 14 }}>Research prototype · not a medical device · the feed is synthetic</T>
            </>
          )}
          {screen === 'live' && (
            !open ? (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                  <View>
                    <T size={11} caps color={C.steel2}>Peak</T>
                    <T size={26} semi>{st_.peak.toFixed(0)}° <T size={14} color={C.steel2}>{FINGER_NAME[st_.peakFinger]}</T></T>
                  </View>
                  <View>
                    <T size={11} caps color={C.steel2}>Assist</T>
                    <T size={26} semi>{st_.blendWord}</T>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <T size={11} caps color={C.steel2}>Joints</T>
                    <T size={26} semi>{st_.liveJoints}<T size={14} color={C.steel2}>/12</T></T>
                  </View>
                </View>
                <View style={{ marginTop: 12, borderTopWidth: 1, borderColor: C.steel4 }}>
                  {FINGERS.map((f) => {
                    const live = frame.ok[f].mcp || frame.ok[f].pip;
                    return (
                      <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.steel4 }}>
                        <T size={14} caps color={C.steel2} style={{ width: 60 }}>{FINGER_NAME[f]}</T>
                        <View style={{ flex: 1, height: 3, backgroundColor: C.steel4, borderRadius: 2 }}>
                          {live && <View style={{ width: `${st_.curl[f] * 100}%`, height: 3, borderRadius: 2, backgroundColor: st_.curl[f] > 0.82 ? C.red : C.steel }} />}
                        </View>
                        <T size={18} semi color={live ? C.white : C.steel3} style={{ width: 44, textAlign: 'right' }}>{live ? `${(st_.curl[f] * 100).toFixed(0)}%` : '–'}</T>
                        <View style={{ width: 40 }}><T size={12} semi color={C.steel2}>{fmtDeg(frame.joints[f].pip, frame.ok[f].pip)}</T><T size={8} caps color={C.steel3}>pip</T></View>
                      </View>
                    );
                  })}
                </View>
                <View style={{ marginTop: 10 }}><Trace values={hist.values} width={strapW} height={36} hot={st_.emg > 0.8} /></View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <T size={11} caps color={C.steel3}>Effort, last seconds</T>
                  <Pusher label="12 joints" onPress={() => setOpen(true)} />
                </View>
              </>
            ) : (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <T size={11} caps color={C.steel2}>Twelve joints · degrees</T>
                  <Pusher label="Close" onPress={() => setOpen(false)} />
                </View>
                {FINGERS.map((f) => (
                  <View key={f} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                    <T size={14} caps color={C.steel2} style={{ width: 60 }}>{FINGER_NAME[f]}</T>
                    {JOINTS.map((j) => {
                      const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                      const fr = j.signed ? (v + j.max) / (2 * j.max) : v / j.max;
                      return (
                        <View key={j.key} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Comp frac={fr} size={30} stroke={2} hot={Math.abs(v) > j.max * 0.9} />
                          <View><T size={16} semi color={on ? C.white : C.steel3}>{fmtDeg(v, on, j.signed)}</T><T size={8} caps color={C.steel3}>{j.short}</T></View>
                        </View>
                      );
                    })}
                  </View>
                ))}
              </>
            )
          )}
          {screen === 'replay' && (
            !play ? (
              <>
                <T size={11} caps color={C.steel2}>Recorded takes · choreographed samples</T>
                {takes.map((t) => (
                  <View key={t.id} style={st.row}>
                    <View style={{ flex: 1 }}>
                      <T size={20} semi>{t.title}</T>
                      <T size={12} color={C.steel2}>{t.note}</T>
                    </View>
                    <T size={14} color={C.steel2}>{t.durationS.toFixed(0)} s</T>
                    <Pusher label="Load" onPress={() => s.setTake(t)} />
                  </View>
                ))}
              </>
            ) : (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                  <View><T size={11} caps color={C.steel2}>{play.take.title}</T><T size={34} semi>{clock(play.t)}</T></View>
                  <View style={{ alignItems: 'flex-end' }}><T size={11} caps color={C.steel2}>of</T><T size={20} semi color={C.steel2}>{clock(play.take.durationS)}</T></View>
                </View>
                <View style={{ marginTop: 8 }} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
                  <Trace values={trace} width={strapW} height={44} played={play.t / Math.max(0.01, play.take.durationS)} />
                </View>
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  <Pusher label="|<" onPress={() => s.seek(0)} />
                  <Pusher label={play.playing ? 'Pause' : 'Play'} on onPress={() => s.togglePlay()} />
                  <Pusher label=">|" onPress={() => s.seek(play.take.durationS)} />
                  {[0.5, 1, 2].map((k) => <Pusher key={k} label={`${k}×`} on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
                  <Pusher label="Eject" onPress={() => s.setTake(null)} />
                </View>
              </>
            )
          )}
          {screen === 'data' && (
            <>
              <T size={11} caps color={C.steel2}>Bridge address · {feedWord(s).detail}</T>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, alignItems: 'center' }}>
                <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.steel3} />
                <Pusher label="Connect" on onPress={() => s.connect(url)} />
                <Pusher label="Sim" onPress={() => s.useSimulator()} />
              </View>
              <T size={11} caps color={C.steel2} style={{ marginTop: 14 }}>Channels · wire ≠ mechanical</T>
              {FINGERS.map((f) => (
                <View key={f} style={[st.row, { gap: 6 }]}>
                  <T size={14} caps color={C.steel2} style={{ width: 56 }}>{FINGER_NAME[f]}</T>
                  {JOINTS.map((j) => {
                    const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                    return <View key={j.key} style={{ flex: 1 }}><T size={18} semi color={!on ? C.steel3 : Math.abs(v) > j.max ? C.red : C.white}>{on ? `${v.toFixed(1)}°` : '–'}</T><T size={9} color={C.steel3}>{f}_{j.wire}</T></View>;
                  })}
                </View>
              ))}
              <T size={11} caps color={C.steel2} style={{ marginTop: 14 }}>Rates</T>
              {RATES.map((r) => (
                <View key={r.what} style={st.row}>
                  <T size={16} style={{ width: 120 }}>{r.what}</T>
                  <T size={12} color={C.steel2} style={{ flex: 1 }}>{r.note}</T>
                  <T size={18} semi>{r.rate}</T>
                </View>
              ))}
              <T size={11} color={C.steel3} style={{ marginTop: 12 }}>Research prototype. Not a medical device.</T>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  crown: { width: 16, height: 42, borderRadius: 5, backgroundColor: '#B9BCC0', borderWidth: 1, borderColor: '#2A2B2E' },
  pusher: { height: 30, paddingHorizontal: 12, borderRadius: 15, borderWidth: 1, borderColor: C.steel2, alignItems: 'center', justifyContent: 'center' },
  strap: { flex: 1, marginHorizontal: 0, borderTopWidth: 1, borderColor: C.steel4 },
  lug: { alignSelf: 'center', width: 60, height: 3, borderRadius: 2, backgroundColor: C.steel4, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.steel4 },
  input: { flex: 1, height: 34, borderBottomWidth: 1, borderColor: C.steel2, fontFamily: 'BarlowCondensed_400Regular', fontSize: 16, color: C.white },
});

export const design: Design = {
  id: '37', slug: 'watch', name: 'Watch face',
  thesis: 'A watch: a brushed steel hand inside a round dial with complications, a ticked bezel that rotates to choose the surface, and a crown on the case that is the primary control.',
  fonts: { BarlowCondensed_400Regular, BarlowCondensed_600SemiBold },
  bg: '#000000', statusBar: 'light-content', App: Shell,
};
