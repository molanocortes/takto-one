// 45-terminal - a phosphor terminal.
//
// Black, one green, DM Mono, a scanline overlay and a glow on the text.
// Everything is text: bar gauges in block characters, sparklines in
// eighth blocks, tables in box drawing, and every control is a bracketed
// word that goes to inverse video when pressed. Navigation is the prompt
// line at the foot: > live, > replay, > data.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DMMono_400Regular } from '@expo-google-fonts/dm-mono/400Regular';
import { DMMono_500Medium } from '@expo-google-fonts/dm-mono/500Medium';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin, PHOSPHOR, BLACK } from './twin';

const C = { bg: BLACK, g: PHOSPHOR, g2: 'rgba(51,255,102,0.65)', g3: 'rgba(51,255,102,0.38)', g4: 'rgba(51,255,102,0.14)', amber: '#FFC14D' };
const F = { ui: 'DMMono_400Regular', medium: 'DMMono_500Medium' };
const GLOW = { textShadowColor: 'rgba(51,255,102,0.55)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 } } as any;

function L({ children, color = C.g, dim, size = 12.5, style, medium }: { children: React.ReactNode; color?: string; dim?: boolean; size?: number; style?: StyleProp<TextStyle>; medium?: boolean }) {
  return <Text style={[{ fontFamily: medium ? F.medium : F.ui, fontSize: size, lineHeight: Math.round(size * 1.5), color: dim ? C.g2 : color }, !dim && GLOW, style]}>{children}</Text>;
}

/** A bracketed word. Pressed or on: inverse video. */
function Cmd({ label, onPress, on, size = 12.5 }: { label: string; onPress?: () => void; on?: boolean; size?: number }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => [{ paddingHorizontal: 2, backgroundColor: on || pressed ? C.g : 'transparent' }]}>
      {({ pressed }) => <Text style={[{ fontFamily: F.medium, fontSize: size, lineHeight: Math.round(size * 1.5), color: on || pressed ? C.bg : C.g }, !(on || pressed) && GLOW]}>[{label}]</Text>}
    </Pressable>
  );
}

const BLOCKS = '▁▂▃▄▅▆▇█';
function bar(frac: number, n = 16, absent = false) {
  if (absent) return '·'.repeat(n);
  const k = Math.round(Math.max(0, Math.min(1, frac)) * n);
  return '█'.repeat(k) + '░'.repeat(n - k);
}
function spark(values: number[], n = 24) {
  const v = values.slice(-n);
  const pad = ' '.repeat(Math.max(0, n - v.length));
  return pad + v.map((x) => BLOCKS[Math.min(7, Math.max(0, Math.round(Math.max(0, Math.min(1, x)) * 7)))]).join('');
}
const padR = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
const padL = (s: string, n: number) => (' '.repeat(n) + s).slice(-n);

function Cursor() {
  const [on, setOn] = useState(true);
  useEffect(() => { const t = setInterval(() => setOn((v) => !v), 530); return () => clearInterval(t); }, []);
  return <L>{on ? '█' : ' '}</L>;
}

function Scanlines({ width, height }: { width: number; height: number }) {
  const rows = Math.ceil(height / 3);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: rows }, (_, i) => <View key={i} style={{ position: 'absolute', top: i * 3, left: 0, width, height: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} />)}
    </View>
  );
}

const NAV: { key: ScreenKey; label: string }[] = [{ key: 'live', label: 'live' }, { key: 'replay', label: 'replay' }, { key: 'data', label: 'data' }];

function Term({ screen, onScreen, children, share = 0.4, title }: { screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; share?: number; title: string }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st_ = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: inset.top }}>
      <View style={st.line}>
        <L dim>takto@one:~$ {title}</L>
        <L dim>{feed.word.toLowerCase().replace(' ', '_')} {st_.liveJoints}/12</L>
      </View>
      <View style={{ height: height * share, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.g4 }}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', left: 12, bottom: 6 }} pointerEvents="none"><L dim size={10}>scan: {s.play ? `replay t=${clock(s.play.t)}` : 'live'} · pts</L></View>
      </View>
      <View style={{ flex: 1 }}>{children}</View>
      <View style={[st.prompt, { paddingBottom: inset.bottom + 8 }]}>
        <L>{'>'} </L>
        {NAV.map((n) => <View key={n.key} style={{ marginRight: 8 }}><Cmd label={n.label} on={screen === n.key} onPress={() => onScreen(n.key)} /></View>)}
        <Cursor />
      </View>
      <Scanlines width={width} height={height} />
    </View>
  );
}

function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: inset.top }}>
      <View style={st.line}><L dim>takto@one:~$ boot</L><L dim>v1</L></View>
      <View style={{ height: height * 0.5, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.g4 }}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
      </View>
      <View style={{ flex: 1, paddingHorizontal: 14, paddingTop: 12 }}>
        <L size={22} medium>TAKTO ONE</L>
        <L dim>companion · digital twin · 12 joints · effort ch.</L>
        <L dim style={{ marginTop: 10 }}>loading kinematics ........ ok</L>
        <L dim>loading zero_hand_full.glb . ok (607k tri)</L>
        <L dim>feed ...................... {feed.word.toLowerCase()}</L>
        <L dim>device .................... {feed.detail}</L>
        <L style={{ marginTop: 10 }}>every joint of the hand, live from the device</L>
        <L>or from a recorded take.</L>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <Cmd label="start session" on onPress={onStart} size={14} />
          <Cmd label="connect device" onPress={onConnect} size={14} />
        </View>
        <View style={{ flex: 1 }} />
        <L dim size={10} style={{ marginBottom: inset.bottom + 12 }}># research prototype. not a medical device. no hand wore the device.</L>
      </View>
      <Scanlines width={width} height={height} />
    </View>
  );
}

function Live({ detail, onScreen }: { detail: boolean; onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const st_ = stats(frame);
  const [table, setTable] = useState(detail);
  const hist = useRef(new History(48)).current;
  hist.push(st_.emg);
  return (
    <Term screen="live" onScreen={onScreen} title="live" share={table ? 0.3 : 0.4}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8 }} showsVerticalScrollIndicator={false}>
        <L size={26} medium>{padL(st_.mean.toFixed(0), 3)}°<L size={12} dim> mean flexion · peak {FINGER_NAME[st_.peakFinger].toLowerCase()} {st_.peak.toFixed(0)}°</L></L>
        {!table ? (
          <>
            {FINGERS.map((f) => {
              const live = frame.ok[f].mcp || frame.ok[f].pip;
              return <L key={f}>{padR(f, 7)} {bar(st_.curl[f], 18, !live)} {padL(live ? (st_.curl[f] * 100).toFixed(0) : '--', 3)}%</L>;
            })}
            <L color={st_.emg > 0.8 ? C.amber : C.g} style={{ marginTop: 6 }}>{padR('effort', 7)} {bar(Math.max(0, st_.emg), 18, st_.emg < 0)} {st_.emg < 0 ? ' --' : st_.emg.toFixed(2)}</L>
            <L dim>{padR('hist', 7)} {spark(hist.values, 24)}</L>
            <L dim>{padR('assist', 7)} {st_.blendWord.toLowerCase()}</L>
            <View style={{ flexDirection: 'row', marginTop: 8 }}><Cmd label="show joints" onPress={() => setTable(true)} /></View>
          </>
        ) : (
          <>
            <L dim>┌─────────┬────────┬────────┬────────┐</L>
            <L dim>│ finger  │ abd/16 │ mcp/90 │ pip/110│</L>
            <L dim>├─────────┼────────┼────────┼────────┤</L>
            {FINGERS.map((f) => (
              <L key={f}><L dim>│ </L>{padR(f, 8)}<L dim>│</L>{JOINTS.map((j, i) => {
                const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                return <L key={j.key} color={!on ? C.g3 : Math.abs(v) > j.max * 0.9 ? C.amber : C.g}>{padL(fmtDeg(v, on, j.signed), 7)} <L dim>│</L></L>;
              })}</L>
            ))}
            <L dim>└─────────┴────────┴────────┴────────┘</L>
            <View style={{ flexDirection: 'row', marginTop: 8 }}><Cmd label="hide joints" onPress={() => setTable(false)} /></View>
          </>
        )}
      </ScrollView>
    </Term>
  );
}

function Replay({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const play = s.play;
  const takes = useMemo(bundledTakes, []);
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 36) : []), [play?.take.id]);
  return (
    <Term screen="replay" onScreen={onScreen} title={play ? `replay ${play.take.id}` : 'replay --list'} share={0.4}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            <L dim># bundled takes · choreographed samples, not a person</L>
            {takes.map((t, i) => (
              <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                <L>{i + 1}. {padR(t.title.toLowerCase(), 10)} {padL(t.durationS.toFixed(0), 3)}s  </L>
                <Cmd label="load" onPress={() => s.setTake(t)} />
              </View>
            ))}
            <L dim style={{ marginTop: 6 }}>{takes.map((t) => `   ${t.note.toLowerCase()}`).join('\n')}</L>
          </>
        ) : (
          <>
            <L size={26} medium>{clock(play.t)}<L size={12} dim> / {clock(play.take.durationS)} · {play.speed}x · {play.playing ? 'playing' : 'paused'}</L></L>
            <View {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <L>{spark(trace, 36)}</L>
              <L dim>{'─'.repeat(Math.round(36 * play.t / Math.max(0.01, play.take.durationS)))}<L color={C.amber}>▲</L>{'─'.repeat(Math.max(0, 35 - Math.round(36 * play.t / Math.max(0.01, play.take.durationS))))}</L>
            </View>
            <L dim>drag the trace to seek</L>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <Cmd label="|<" onPress={() => s.seek(0)} />
              <Cmd label={play.playing ? 'pause' : 'play'} on onPress={() => s.togglePlay()} />
              <Cmd label=">|" onPress={() => s.seek(play.take.durationS)} />
              {[0.5, 1, 2].map((k) => <Cmd key={k} label={`${k}x`} on={play.speed === k} onPress={() => s.setSpeed(k)} />)}
              <Cmd label="eject" onPress={() => s.setTake(null)} />
            </View>
          </>
        )}
      </ScrollView>
    </Term>
  );
}

function Data({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const feed = feedWord(s);
  return (
    <Term screen="data" onScreen={onScreen} title="data" share={0.26}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8 }} showsVerticalScrollIndicator={false}>
        <L dim># source: {feed.word.toLowerCase()} · {feed.detail}</L>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <L>url=</L>
          <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.g3} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Cmd label="connect" on onPress={() => s.connect(url)} />
          <Cmd label="use simulator" onPress={() => s.useSimulator()} />
        </View>
        <L dim style={{ marginTop: 10 }}># channels · wire name != mechanical name</L>
        <L dim>┌────────────┬───────────────────┬─────────┐</L>
        {FINGERS.flatMap((f) => JOINTS.map((j, i) => {
          const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
          return <L key={f + j.key}><L dim>│ </L>{padR(`${f}_${j.wire}`, 11)}<L dim>│ </L><L dim>{padR(`${FINGER_NAME[f]} ${j.name}`.toLowerCase().slice(0, 18), 18)}</L><L dim>│</L><L color={!on ? C.g3 : Math.abs(v) > j.max ? C.amber : C.g}>{padL(on ? `${v.toFixed(1)}°` : 'absent', 8)} </L><L dim>│</L></L>;
        }))}
        <L dim>└────────────┴───────────────────┴─────────┘</L>
        <L dim style={{ marginTop: 10 }}># rates · four numbers, not one</L>
        {RATES.map((r) => <L key={r.what}>{padR(r.what.toLowerCase(), 18)}{padL(r.rate, 8)}<L dim>  {r.note}</L></L>)}
        <L dim size={10} style={{ marginTop: 10, marginBottom: 10 }}># research prototype. not a medical device.</L>
      </ScrollView>
    </Term>
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
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 6 },
  prompt: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 8, borderTopWidth: 1, borderColor: C.g4 },
  input: { flex: 1, fontFamily: 'DMMono_400Regular', fontSize: 12.5, color: C.g, borderBottomWidth: 1, borderColor: C.g3, paddingVertical: 2 },
});

export const design: Design = {
  id: '45', slug: 'terminal', name: 'Terminal',
  thesis: 'A phosphor terminal: the hand as a green point cloud, every reading in block characters and box drawing, every control a bracketed word, and the prompt line as the navigation.',
  fonts: { DMMono_400Regular, DMMono_500Medium },
  bg: BLACK, statusBar: 'light-content', App: Shell,
};
