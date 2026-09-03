// 41-analog - a tape deck.
//
// Bakelite, cream silkscreen, amber phosphor numerals and VU meters with
// real ballistics. The navigation is three toggle switches: flip one up
// and the others fall. The transport is a row of piano keys. Speed is a
// three-position slide. Space Mono throughout, the way a deck is labelled.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, Animated, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Line, Rect, Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { SpaceMono_400Regular } from '@expo-google-fonts/space-mono/400Regular';
import { SpaceMono_700Bold } from '@expo-google-fonts/space-mono/700Bold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin } from './twin';

const C = {
  bake: '#1E1915', bake2: '#2A2420', bake3: '#141110', cream: '#E8DCC0', cream2: 'rgba(232,220,192,0.6)', cream3: 'rgba(232,220,192,0.3)',
  amber: '#FFB347', amberDim: 'rgba(255,179,71,0.35)', face: '#EFE4C8', faceInk: '#2B241E', red: '#C8442A', brass: '#C9A45C',
};
const F = { ui: 'SpaceMono_400Regular', bold: 'SpaceMono_700Bold' };

function T({ children, size = 12, bold, color = C.cream, style, caps, align, tracking }: {
  children: React.ReactNode; size?: number; bold?: boolean; color?: string; style?: StyleProp<TextStyle>; caps?: boolean; align?: 'left' | 'center' | 'right'; tracking?: number;
}) {
  return <Text style={[{ fontFamily: bold ? F.bold : F.ui, fontSize: size, color, lineHeight: Math.round(size * 1.35), textTransform: caps ? 'uppercase' : 'none', letterSpacing: tracking ?? (caps ? 1 : 0), textAlign: align }, style]}>{children}</Text>;
}
/** Amber phosphor numerals: a glow. */
function Amber({ children, size = 28, style, dim }: { children: React.ReactNode; size?: number; style?: StyleProp<TextStyle>; dim?: boolean }) {
  return <Text style={[{ fontFamily: F.bold, fontSize: size, color: dim ? C.amberDim : C.amber, lineHeight: Math.round(size * 1.15), textShadowColor: 'rgba(255,179,71,0.55)', textShadowRadius: dim ? 0 : 10, textShadowOffset: { width: 0, height: 0 }, fontVariant: ['tabular-nums'] }, style]}>{children}</Text>;
}

function useBallistic(value: number) {
  const v = useRef(new Animated.Value(value)).current;
  useEffect(() => { Animated.spring(v, { toValue: value, useNativeDriver: false, speed: 9, bounciness: 7 }).start(); }, [value]);
  return v;
}

/** A VU meter: cream face, black scale, red zone, a needle with mass. */
function VU({ frac, label, width = 150, absent, big }: { frac: number; label: string; width?: number; absent?: boolean; big?: boolean }) {
  const height = width * 0.6;
  const cx = width / 2, cy = height - 8, r = width * 0.44;
  const a0 = -138, a1 = -42;
  const needle = useBallistic(Math.max(0, Math.min(1, frac)));
  const rot = needle.interpolate({ inputRange: [0, 1], outputRange: [`${a0 + 90}deg`, `${a1 + 90}deg`] });
  const p = (a: number, rr = r) => [cx + rr * Math.cos((a * Math.PI) / 180), cy + rr * Math.sin((a * Math.PI) / 180)];
  const arc = (from: number, to: number, rr = r) => { const [x0, y0] = p(from, rr), [x1, y1] = p(to, rr); return `M ${x0} ${y0} A ${rr} ${rr} 0 0 1 ${x1} ${y1}`; };
  const redFrom = a0 + (a1 - a0) * 0.82;
  const ticks = [];
  for (let i = 0; i <= 10; i++) { const a = a0 + ((a1 - a0) * i) / 10; const [x1, y1] = p(a), [x2, y2] = p(a, r - (i % 5 === 0 ? 9 : 5)); ticks.push(<Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={a >= redFrom ? C.red : C.faceInk} strokeWidth={i % 5 === 0 ? 1.5 : 1} />); }
  return (
    <View style={{ width, height: height + 18 }}>
      <View style={[st.vuBezel, { width, height }]}>
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          <Rect x={3} y={3} width={width - 6} height={height - 6} rx={4} fill={C.face} />
          <Path d={arc(a0, a1)} stroke={C.faceInk} strokeWidth={1.2} fill="none" />
          <Path d={arc(redFrom, a1, r + 0.5)} stroke={C.red} strokeWidth={3} fill="none" />
          {ticks}
          {!absent && [0, 0.5, 1].map((k) => { const [x, y] = p(a0 + (a1 - a0) * k, r - 16); return <Line key={k} x1={x} y1={y} x2={x} y2={y} stroke={C.faceInk} strokeWidth={0} />; })}
        </Svg>
        {!absent && (
          <Animated.View style={{ position: 'absolute', left: cx - 0.75, top: cy - r + 2, width: 1.5, height: r - 2, backgroundColor: C.faceInk, transformOrigin: '50% 100%', transform: [{ rotate: rot }] } as any} />
        )}
        <View style={{ position: 'absolute', left: cx - 6, top: cy - 6, width: 12, height: 12, borderRadius: 6, backgroundColor: C.faceInk }} />
        <View style={{ position: 'absolute', left: 8, bottom: 6 }}><T size={big ? 9 : 8} bold caps color={C.faceInk} tracking={1}>{label}</T></View>
        <View style={{ position: 'absolute', right: 8, bottom: 6 }}><T size={8} caps color={C.red} tracking={1}>{absent ? 'absent' : 'VU'}</T></View>
      </View>
    </View>
  );
}

/** A toggle switch: a plate, a lever that flips up when on. */
function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress?: () => void }) {
  const a = useBallistic(on ? 1 : 0);
  const rot = a.interpolate({ inputRange: [0, 1], outputRange: ['26deg', '-26deg'] });
  return (
    <Pressable onPress={onPress} hitSlop={8} style={{ alignItems: 'center', width: 78 }}>
      <View style={st.togglePlate}>
        <View style={st.toggleWell} />
        <Animated.View style={[st.toggleLever, { transform: [{ translateY: 12 }, { rotate: rot }, { translateY: -12 }] }]}>
          <View style={st.toggleKnob} />
        </Animated.View>
        <View style={[st.toggleLed, on && { backgroundColor: C.amber, ...({ boxShadow: `0 0 8px 2px ${C.amberDim}` } as any) }]} />
      </View>
      <T size={9} bold caps color={on ? C.amber : C.cream2} style={{ marginTop: 6 }}>{label}</T>
    </Pressable>
  );
}

/** A piano key on the transport. */
function PianoKey({ glyph, label, onPress, wide, lit }: { glyph: React.ReactNode; label: string; onPress?: () => void; wide?: boolean; lit?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.piano, wide && { flex: 1.6 }, pressed && st.pianoDown]}>
      <View style={{ height: 22, alignItems: 'center', justifyContent: 'center' }}>{glyph}</View>
      <T size={8} caps color={lit ? C.amber : C.cream2} align="center">{label}</T>
    </Pressable>
  );
}
const G = ({ d }: { d: string }) => <Svg width={18} height={14} viewBox="0 0 18 14"><Path d={d} fill={C.cream} /></Svg>;

/** A three-position slide switch. */
function Slide({ options, value, onChange, label }: { options: readonly number[]; value: number; onChange: (v: number) => void; label: string }) {
  const idx = Math.max(0, options.indexOf(value));
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 3 }}>{options.map((o) => <T key={o} size={8} color={o === value ? C.amber : C.cream3} style={{ width: 22, textAlign: 'center' }}>{o}×</T>)}</View>
      <View style={st.slideTrack}>
        {options.map((o, i) => <Pressable key={o} onPress={() => onChange(o)} style={{ width: 32, height: 20 }} />)}
        <View style={[st.slideKnob, { left: 2 + idx * 32 }]} pointerEvents="none" />
      </View>
      <T size={8} caps color={C.cream2} style={{ marginTop: 4 }}>{label}</T>
    </View>
  );
}

/** A counter: dark cell, amber numeral. */
function Counter({ value, label, hot, absent }: { value: string; label: string; hot?: boolean; absent?: boolean }) {
  return (
    <View style={[st.counter, hot && { borderColor: C.red }]}>
      <Amber size={19} dim={absent}>{value}</Amber>
      <T size={7.5} caps color={C.cream3}>{label}</T>
    </View>
  );
}

const NAV: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'Live' }, { key: 'replay', label: 'Replay' }, { key: 'data', label: 'Data' }];

function Deck({ screen, onScreen, children, share = 0.36 }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; share?: number }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.bake }}>
      <View style={[st.plate, { paddingTop: inset.top + 8 }]}>
        <T size={12} bold caps tracking={3}>Takto one</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: feed.live ? C.amber : C.red, ...({ boxShadow: `0 0 6px 1px ${feed.live ? C.amberDim : 'rgba(200,68,42,0.5)'}` } as any) }} />
          <T size={9} caps color={C.cream2}>{feed.word} · {st_.liveJoints}/12</T>
        </View>
      </View>
      <View style={[st.window, { height: height * share }]}>
        <Svg width={width - 24} height={height * share} style={StyleSheet.absoluteFill}>
          <Defs><RadialGradient id="lamp" cx="50%" cy="45%" r="55%"><Stop offset="0" stopColor="#4A3520" /><Stop offset="1" stopColor="#120E0B" /></RadialGradient></Defs>
          <Rect width={width - 24} height={height * share} fill="url(#lamp)" />
        </Svg>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        <View style={st.windowGlass} pointerEvents="none" />
      </View>
      <View style={{ flex: 1 }}>{children}</View>
      <View style={[st.toggles, { paddingBottom: inset.bottom + 10 }]}>
        {NAV.map((n) => <Toggle key={n.key} label={n.label} on={screen === n.key} onPress={() => onScreen(n.key)} />)}
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
    <View style={{ flex: 1, backgroundColor: C.bake }}>
      <View style={[st.plate, { paddingTop: inset.top + 8 }]}>
        <T size={12} bold caps tracking={3}>Takto one</T>
        <T size={9} caps color={C.cream2}>Companion · model T-1</T>
      </View>
      <View style={[st.window, { height: height * 0.5 }]}>
        <Svg width={width - 24} height={height * 0.5} style={StyleSheet.absoluteFill}>
          <Defs><RadialGradient id="lamp2" cx="50%" cy="45%" r="55%"><Stop offset="0" stopColor="#4A3520" /><Stop offset="1" stopColor="#120E0B" /></RadialGradient></Defs>
          <Rect width={width - 24} height={height * 0.5} fill="url(#lamp2)" />
        </Svg>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        <View style={st.windowGlass} pointerEvents="none" />
      </View>
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View>
            <T size={9} caps color={C.cream2}>Digital twin · 12 joints · effort</T>
            <Amber size={30}>TAKTO ONE</Amber>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.red, marginBottom: 3, ...({ boxShadow: '0 0 6px 1px rgba(200,68,42,0.5)' } as any) }} />
            <T size={8} caps color={C.cream2}>{feed.word}</T>
          </View>
        </View>
        <T size={11} color={C.cream2} style={{ marginTop: 8 }}>Every joint of the hand, live from the device or from a recorded take. No hand wore the device to make the feed.</T>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 24, marginTop: 20 }}>
          <Toggle label="Power · start" on={false} onPress={onStart} />
          <Toggle label="Line · connect" on={false} onPress={onConnect} />
        </View>
        <View style={{ flex: 1 }} />
        <T size={8} caps color={C.cream3} style={{ marginBottom: inset.bottom + 14 }} align="center">Research prototype · not a medical device</T>
      </View>
    </View>
  );
}

function Live({ detail, onScreen }: { detail: boolean; onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const [counters, setCounters] = useState(detail);
  const { width } = useWindowDimensions();
  const vuW = (width - 24 - 12) / 2;
  return (
    <Deck screen="live" onScreen={onScreen} share={counters ? 0.28 : 0.34}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 10 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View><VU frac={st_.mean / 110} label="Mean flexion" width={vuW} big /><Amber size={22} style={{ position: 'absolute', right: 12, top: 8 }}>{st_.mean.toFixed(0)}°</Amber></View>
          <View><VU frac={Math.max(0, st_.emg)} label="Effort" width={vuW} big absent={st_.emg < 0} /><Amber size={22} style={{ position: 'absolute', right: 12, top: 8 }}>{st_.emg < 0 ? '--' : st_.emg.toFixed(2)}</Amber></View>
        </View>
        {!counters ? (
          <>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 2 }}>
              {FINGERS.map((f) => <VU key={f} frac={st_.curl[f]} label={FINGER_NAME[f]} width={(width - 24 - 18) / 4} absent={!(frame.ok[f].mcp || frame.ok[f].pip)} />)}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <T size={8} caps color={C.cream2}>Peak {FINGER_NAME[st_.peakFinger]} {st_.peak.toFixed(0)}° · assist {st_.blendWord}</T>
              <PianoKey glyph={<Amber size={12}>12</Amber>} label="Counters" onPress={() => setCounters(true)} />
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
              <T size={8} caps color={C.cream2}>Twelve joints · degrees</T>
              <PianoKey glyph={<G d="M2 7 L9 1 V13 Z M10 7 L17 1 V13 Z" />} label="Meters" onPress={() => setCounters(false)} />
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <T size={9} caps color={C.cream2} style={{ width: 52 }}>{FINGER_NAME[f]}</T>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return <Counter key={j.key} value={fmtDeg(v, on, j.signed)} label={`${j.short} /${j.max}`} hot={Math.abs(v) > j.max * 0.9} absent={!on} />;
                })}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </Deck>
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
    <Deck screen="replay" onScreen={onScreen} share={0.34}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 10 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            <T size={8} caps color={C.cream2}>Tapes · choreographed samples, not a person</T>
            {takes.map((t, i) => (
              <Pressable key={t.id} onPress={() => s.setTake(t)} style={({ pressed }) => [st.tape, pressed && { backgroundColor: C.bake2 }]}>
                <View style={st.reel}><View style={st.reelHub} /></View>
                <View style={{ flex: 1 }}>
                  <T size={13} bold>{String(i + 1).padStart(2, '0')} · {t.title.toUpperCase()}</T>
                  <T size={9} color={C.cream2}>{t.note}</T>
                </View>
                <Amber size={16}>{t.durationS.toFixed(0)}s</Amber>
              </Pressable>
            ))}
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <View><T size={8} caps color={C.cream2}>{play.take.title} · counter</T><Amber size={40}>{clock(play.t)}</Amber></View>
              <View style={{ alignItems: 'flex-end' }}><T size={8} caps color={C.cream2}>of</T><Amber size={18} dim>{clock(play.take.durationS)}</Amber></View>
            </View>
            <View style={st.tapeWindow} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 34 }}>
                {trace.map((v, i) => <View key={i} style={{ flex: 1, height: 2 + v * 32, backgroundColor: i / trace.length <= play.t / play.take.durationS ? C.amber : C.cream3 }} />)}
              </View>
              <View style={{ position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: C.red, left: `${(play.t / Math.max(0.01, play.take.durationS)) * 100}%` }} pointerEvents="none" />
            </View>
            <View style={{ flexDirection: 'row', gap: 4, marginTop: 10, alignItems: 'flex-end' }}>
              <PianoKey glyph={<G d="M1 7 L8 1 V13 Z M9 7 L16 1 V13 Z" />} label="Rew" onPress={() => s.seek(0)} />
              <PianoKey glyph={play.playing ? <G d="M3 1 H7 V13 H3 Z M11 1 H15 V13 H11 Z" /> : <G d="M4 1 L15 7 L4 13 Z" />} label={play.playing ? 'Pause' : 'Play'} wide lit={play.playing} onPress={() => s.togglePlay()} />
              <PianoKey glyph={<G d="M2 1 L9 7 L2 13 Z M10 1 L17 7 L10 13 Z" />} label="FF" onPress={() => s.seek(play.take.durationS)} />
              <PianoKey glyph={<G d="M2 9 L9 2 L16 9 Z M2 11 H16 V13 H2 Z" />} label="Eject" onPress={() => s.setTake(null)} />
              <View style={{ flex: 1 }} />
              <Slide options={[0.5, 1, 2] as const} value={play.speed} onChange={(k) => s.setSpeed(k)} label="Speed" />
            </View>
          </>
        )}
      </ScrollView>
    </Deck>
  );
}

function Data({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const feed = feedWord(s);
  return (
    <Deck screen="data" onScreen={onScreen} share={0.24}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 10 }} showsVerticalScrollIndicator={false}>
        <T size={8} caps color={C.cream2}>Line in · {feed.word} · {feed.detail}</T>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, alignItems: 'flex-end' }}>
          <View style={st.jack}><TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.cream3} /></View>
          <PianoKey glyph={<G d="M2 6 H12 V3 L17 7 L12 11 V8 H2 Z" />} label="Connect" onPress={() => s.connect(url)} />
          <PianoKey glyph={<G d="M2 2 H16 V12 H2 Z M4 4 V10 H14 V4 Z" />} label="Sim" onPress={() => s.useSimulator()} />
        </View>
        <T size={8} caps color={C.cream2} style={{ marginTop: 14 }}>Channels · wire name ≠ mechanical name</T>
        {FINGERS.map((f) => (
          <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <T size={9} caps color={C.cream2} style={{ width: 52 }}>{FINGER_NAME[f]}</T>
            {JOINTS.map((j) => {
              const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
              return <Counter key={j.key} value={on ? `${v.toFixed(1)}°` : '--'} label={`${f}_${j.wire}`} hot={Math.abs(v) > j.max} absent={!on} />;
            })}
          </View>
        ))}
        <T size={8} caps color={C.cream2} style={{ marginTop: 14 }}>Rates · four numbers, not one</T>
        {RATES.map((r) => (
          <View key={r.what} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.bake2 }}>
            <T size={11} bold style={{ width: 130 }}>{r.what}</T>
            <T size={9} color={C.cream2} style={{ flex: 1 }}>{r.note}</T>
            <Amber size={14}>{r.rate}</Amber>
          </View>
        ))}
        <T size={8} caps color={C.cream3} style={{ marginTop: 10, marginBottom: 10 }}>Research prototype · not a medical device</T>
      </ScrollView>
    </Deck>
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
  plate: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8 },
  window: { marginHorizontal: 12, borderRadius: 14, overflow: 'hidden', borderWidth: 3, borderColor: C.bake3, backgroundColor: '#120E0B' },
  windowGlass: { ...StyleSheet.absoluteFillObject, borderRadius: 11, borderWidth: 1, borderColor: 'rgba(232,220,192,0.10)' },
  toggles: { flexDirection: 'row', justifyContent: 'space-evenly', paddingTop: 10, borderTopWidth: 1, borderColor: C.bake2 },
  togglePlate: { width: 44, height: 56, borderRadius: 6, backgroundColor: C.bake2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.bake3 },
  toggleWell: { position: 'absolute', width: 14, height: 30, borderRadius: 7, backgroundColor: C.bake3 },
  toggleLever: { position: 'absolute', width: 8, height: 24, top: 8, alignItems: 'center' },
  toggleKnob: { width: 8, height: 24, borderRadius: 4, backgroundColor: '#B9B0A0', ...({ boxShadow: '0 2px 3px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.5)' } as any) },
  toggleLed: { position: 'absolute', bottom: 5, width: 5, height: 5, borderRadius: 3, backgroundColor: C.bake3 },
  vuBezel: { borderRadius: 6, backgroundColor: C.bake3, borderWidth: 1, borderColor: '#3A322A', overflow: 'hidden', ...({ boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.6)' } as any) },
  piano: { flex: 1, height: 46, backgroundColor: C.bake2, borderRadius: 3, borderWidth: 1, borderColor: C.bake3, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, minWidth: 56, ...({ boxShadow: '0 3px 0 #0E0B09, inset 0 1px 0 rgba(255,255,255,0.08)' } as any) },
  pianoDown: { transform: [{ translateY: 3 }], ...({ boxShadow: '0 0 0 #0E0B09' } as any) },
  slideTrack: { flexDirection: 'row', backgroundColor: C.bake3, borderRadius: 4, padding: 2, height: 24 },
  slideKnob: { position: 'absolute', top: 2, width: 32, height: 20, borderRadius: 3, backgroundColor: '#B9B0A0', ...({ boxShadow: '0 1px 2px rgba(0,0,0,0.6)' } as any) },
  counter: { flex: 1, backgroundColor: C.bake3, borderRadius: 3, borderWidth: 1, borderColor: '#3A322A', paddingHorizontal: 6, paddingVertical: 3 },
  tape: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.bake2 },
  reel: { width: 30, height: 30, borderRadius: 15, borderWidth: 3, borderColor: '#3A322A', alignItems: 'center', justifyContent: 'center' },
  reelHub: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.cream3 },
  tapeWindow: { marginTop: 8, backgroundColor: C.bake3, borderRadius: 4, padding: 6, borderWidth: 1, borderColor: '#3A322A' },
  jack: { flex: 1, height: 36, borderRadius: 4, backgroundColor: C.bake3, borderWidth: 1, borderColor: '#3A322A', justifyContent: 'center', paddingHorizontal: 8 },
  input: { fontFamily: 'SpaceMono_400Regular', fontSize: 11, color: C.amber },
});

export const design: Design = {
  id: '41', slug: 'analog', name: 'Tape deck',
  thesis: 'A tape deck: bronze under a tungsten lamp, VU meters with ballistics, amber phosphor counters, piano keys for the transport and three toggle switches as the navigation.',
  fonts: { SpaceMono_400Regular, SpaceMono_700Bold },
  bg: '#1E1915', statusBar: 'light-content', App: Shell,
};
