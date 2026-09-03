// 31-rams - a Braun instrument panel.
//
// The hand stands in a tuning window cut into warm grey enamel. Everything
// below the window is a printed panel: keys with a face and a side, a red
// needle on a printed scale, LED level meters, a rotary with detents.
// Nothing is translucent, nothing floats, and every control is something a
// finger could find with the eyes closed.
import React, { useMemo, useRef, useState } from 'react';
import { View, ScrollView, StyleSheet, TextInput, Pressable, useWindowDimensions, PanResponder } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Archivo_400Regular } from '@expo-google-fonts/archivo/400Regular';
import { Archivo_500Medium } from '@expo-google-fonts/archivo/500Medium';
import { Archivo_600SemiBold } from '@expo-google-fonts/archivo/600SemiBold';
import { Stage } from '../../twin/Stage';
import { useSession } from '../../data/session';
import { bundledTakes } from '../../data/takes';
import { FINGERS } from '../../ui/tokens';
import type { Design, DesignProps } from '../index';
import { type ScreenKey, JOINTS, FINGER_NAME, RATES, stats, feedWord, fmtDeg, clock, History, effortTrace } from '../shared';
import { twin } from './twin';
import { P, Key, Led, Scale, Meter, Dial, Rotary, ValueTile, Rule } from './ui';
import { C, RECESS } from './tokens';

const SPEEDS = [{ key: 0.5, label: '½×' }, { key: 1, label: '1×' }, { key: 2, label: '2×' }] as const;

/* ---------- the panel frame every screen shares ---------- */

function Frame({ screen, onScreen, children, windowShare = 0.5, statusRight }: {
  screen: ScreenKey; onScreen: (s: ScreenKey) => void; children: React.ReactNode; windowShare?: number; statusRight?: React.ReactNode;
}) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  const st = stats(s.frame);
  return (
    <View style={{ flex: 1, backgroundColor: C.panel, paddingTop: inset.top }}>
      {/* the window */}
      <View style={[fr.window, { height: height * windowShare }, RECESS as object]}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        <View style={fr.windowMark} pointerEvents="none">
          <P size={9} caps color={C.ink2}>TAKTO ONE</P>
          <P size={9} caps color={C.ink3}>twin · 12 joints</P>
        </View>
      </View>
      {/* the status strip: the feed says what it is on every screen */}
      <View style={fr.status}>
        <View style={fr.statusCell}>
          <Led on color={feed.live ? C.green : C.amber} />
          <P size={9.5} caps weight="medium" color={C.ink}>{feed.word}</P>
        </View>
        <View style={fr.statusCell}>
          <P size={9.5} caps color={C.ink2} tabular>{st.liveJoints}/12 joints</P>
        </View>
        <View style={[fr.statusCell, { borderRightWidth: 0, flex: 1, justifyContent: 'flex-end' }]}>
          {statusRight ?? <P size={9.5} caps color={C.ink2}>{s.play ? clock(s.play.t) : '60 Hz'}</P>}
        </View>
      </View>
      <View style={{ flex: 1 }}>{children}</View>
      {/* the keys: LIVE, REPLAY, DATA */}
      <View style={[fr.keys, { paddingBottom: inset.bottom + 12 }]}>
        {(['live', 'replay', 'data'] as const).map((k) => (
          <Key key={k} label={k} wide led={screen === k} onPress={() => onScreen(k)} />
        ))}
      </View>
    </View>
  );
}

const fr = StyleSheet.create({
  window: { marginHorizontal: 12, marginTop: 8, borderRadius: 10, backgroundColor: C.window, overflow: 'hidden' },
  windowMark: { position: 'absolute', left: 12, top: 10, right: 12, flexDirection: 'row', justifyContent: 'space-between' },
  status: { flexDirection: 'row', marginHorizontal: 12, marginTop: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.rule },
  statusCell: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRightWidth: 1, borderColor: C.rule },
  keys: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 10 },
});

/* ---------- WELCOME ---------- */

function Welcome({ onStart, onConnect }: { onStart: () => void; onConnect: () => void }) {
  const inset = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const s = useSession();
  const feed = feedWord(s);
  return (
    <View style={{ flex: 1, backgroundColor: C.panel, paddingTop: inset.top }}>
      <View style={[fr.window, { height: height * 0.63 }, RECESS as object]}>
        <Stage spec={twin} style={StyleSheet.absoluteFill} />
        <View style={fr.windowMark} pointerEvents="none">
          <P size={9} caps color={C.ink2}>Research prototype</P>
          <P size={9} caps color={C.ink3}>T-1</P>
        </View>
      </View>
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 22 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View>
            <P size={26} weight="medium" tracking={-0.4}>TAKTO ONE</P>
            <P size={11} color={C.ink2} style={{ marginTop: 4, maxWidth: 220 }}>Every joint of the hand, live from the device or from a recorded take.</P>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Led on color={C.amber} /><P size={9} caps color={C.ink2}>{feed.word}</P>
            </View>
            <P size={9} caps color={C.ink3}>{feed.detail}</P>
          </View>
        </View>
        <Rule style={{ marginTop: 18 }} />
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <Key label="On" sub="start session" dark tall led ledColor={C.green} onPress={onStart} style={{ flex: 1.4 }} />
          <Key label="Connect" sub="a device" tall onPress={onConnect} style={{ flex: 1 }} />
        </View>
      </View>
      <View style={{ paddingHorizontal: 20, paddingBottom: inset.bottom + 14, flexDirection: 'row', justifyContent: 'space-between' }}>
        <P size={9} caps color={C.ink3}>Companion</P>
        <P size={9} caps color={C.ink3}>Not a medical device</P>
      </View>
    </View>
  );
}

/* ---------- LIVE ---------- */

function Live({ detail, onScreen }: { detail: boolean; onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const st = stats(frame);
  const [matrix, setMatrix] = useState(detail);
  const hist = useRef(new History(48)).current;
  hist.push(st.emg);
  const { width } = useWindowDimensions();
  const scaleW = width - 24 - 20 - 84;

  return (
    <Frame screen="live" onScreen={onScreen} windowShare={matrix ? 0.36 : 0.46}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12 }} showsVerticalScrollIndicator={false}>
        {!matrix ? (
          <>
            {/* the summary: one scale, one number */}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12 }}>
              <View style={{ width: 84 }}>
                <P size={9} caps color={C.ink2}>Mean flexion</P>
                <P size={34} weight="medium" tabular tracking={-1} style={{ marginTop: 2 }}>{st.mean.toFixed(0)}<P size={16} color={C.ink2}>°</P></P>
              </View>
              <View style={{ paddingBottom: 6 }}>
                <Scale value={st.mean} max={110} width={scaleW} minor={5} major={30} hot={st.mean > 90} />
              </View>
            </View>
            <Rule style={{ marginTop: 10 }} />
            {/* four fingers as level meters, then effort */}
            <View style={{ marginTop: 8, gap: 7 }}>
              {FINGERS.map((f) => {
                const live = frame.ok[f].mcp || frame.ok[f].pip;
                return (
                  <View key={f} style={lv.meterRow}>
                    <P size={9.5} caps color={C.ink2} style={{ width: 52 }}>{FINGER_NAME[f]}</P>
                    <View style={{ flex: 1 }}><Meter value={st.curl[f]} absent={!live} /></View>
                    <P size={11} tabular weight="medium" style={{ width: 36, textAlign: 'right' }} color={live ? C.ink : C.ink3}>{live ? `${(st.curl[f] * 100).toFixed(0)}` : '–'}</P>
                  </View>
                );
              })}
              <View style={[lv.meterRow, { marginTop: 2 }]}>
                <P size={9.5} caps color={C.red} style={{ width: 52 }}>Effort</P>
                <View style={{ flex: 1 }}><Meter value={st.emg} absent={st.emg < 0} hot={0.8} /></View>
                <P size={11} tabular weight="medium" style={{ width: 36, textAlign: 'right' }} color={st.emg > 0.8 ? C.red : C.ink}>{st.emg < 0 ? '–' : st.emg.toFixed(2)}</P>
              </View>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <P size={9} caps color={C.ink3}>Peak {FINGER_NAME[st.peakFinger]} {st.peak.toFixed(0)}° · assist {st.blendWord}</P>
              <Key label="Joints" sub="all twelve" onPress={() => setMatrix(true)} style={{ height: 40 }} />
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <P size={9} caps color={C.ink2}>Twelve joints · degrees</P>
              <Key label="Summary" onPress={() => setMatrix(false)} style={{ height: 34, minWidth: 0 }} />
            </View>
            <View style={{ flexDirection: 'row', marginTop: 8, paddingLeft: 52 }}>
              {JOINTS.map((j) => <P key={j.key} size={9} caps color={C.ink3} style={{ flex: 1, textAlign: 'center' }}>{j.short} · {j.max}°</P>)}
            </View>
            {FINGERS.map((f) => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: C.ruleSoft, paddingVertical: 4 }}>
                <P size={9.5} caps color={C.ink2} style={{ width: 52 }}>{FINGER_NAME[f]}</P>
                {JOINTS.map((j) => {
                  const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                  return (
                    <View key={j.key} style={{ flex: 1, alignItems: 'center' }}>
                      <Dial value={v} max={j.max} signed={j.signed} absent={!on} hot={Math.abs(v) > j.max * 0.9} size={56} />
                      <P size={11} tabular weight="medium" color={on ? C.ink : C.ink3} style={{ marginTop: -6 }}>{fmtDeg(v, on, j.signed)}</P>
                    </View>
                  );
                })}
              </View>
            ))}
          </>
        )}
        <P size={9} color={C.ink3} style={{ marginTop: 12, marginBottom: 8 }}>
          {s.link.kind === 'bridge' ? 'Streaming from teensy_bridge.py.' : 'Synthetic feed. No hand wore the device.'}
        </P>
      </ScrollView>
    </Frame>
  );
}

const lv = StyleSheet.create({
  meterRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});

/* ---------- REPLAY ---------- */

function Replay({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const takes = useMemo(bundledTakes, []);
  const play = s.play;
  const { width } = useWindowDimensions();
  const barW = useRef(1);
  const seekAt = (x: number) => { if (s.play) s.seek(Math.max(0, Math.min(1, x / Math.max(1, barW.current))) * s.play.take.durationS); };
  const scrub = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekAt(e.nativeEvent.locationX), onPanResponderMove: (e) => seekAt(e.nativeEvent.locationX),
  }), []);
  const trace = useMemo(() => (play ? effortTrace(play.take.frames, 60) : []), [play?.take.id]);

  return (
    <Frame screen="replay" onScreen={onScreen} windowShare={0.42}
      statusRight={play ? <P size={9.5} caps color={C.ink2} tabular>{clock(play.t)} / {clock(play.take.durationS)}</P> : undefined}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12 }} showsVerticalScrollIndicator={false}>
        {!play ? (
          <>
            <P size={9} caps color={C.ink2}>Bundled takes · choreographed samples, not recordings of a person</P>
            <View style={{ marginTop: 8 }}>
              {takes.map((t) => (
                <Pressable key={t.id} onPress={() => s.setTake(t)} style={({ pressed }) => [rp.take, { opacity: pressed ? 0.6 : 1 }]}>
                  <View style={{ flex: 1 }}>
                    <P size={14} weight="medium">{t.title}</P>
                    <P size={10} color={C.ink2} style={{ marginTop: 2 }}>{t.note}</P>
                  </View>
                  <View style={{ width: 64, marginRight: 12 }}><Meter value={Math.max(...effortTrace(t.frames, 20))} cells={12} height={6} /></View>
                  <P size={12} tabular color={C.ink2} style={{ width: 34, textAlign: 'right' }}>{t.durationS.toFixed(0)} s</P>
                  <View style={{ marginLeft: 12 }}><Key label="Play" style={{ height: 32, minWidth: 0, paddingHorizontal: 10 }} onPress={() => s.setTake(t)} /></View>
                </Pressable>
              ))}
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <P size={14} weight="medium">{play.take.title}</P>
              <P size={9} caps color={C.ink3}>{play.take.frames.length} frames</P>
            </View>
            {/* the tape: effort as a printed trace, the playhead a red needle you drag */}
            <View style={rp.tape} {...scrub.panHandlers} onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1, height: 40 }}>
                {trace.map((v, i) => <View key={i} style={{ flex: 1, height: 2 + v * 38, backgroundColor: i / trace.length <= play.t / play.take.durationS ? C.ink : C.rule }} />)}
              </View>
              <View style={{ position: 'absolute', top: -4, bottom: -4, width: 2, backgroundColor: C.red, left: `${(play.t / Math.max(0.01, play.take.durationS)) * 100}%` }} pointerEvents="none" />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
              <P size={9} tabular color={C.ink3}>0:00</P><P size={9} caps color={C.ink3}>Effort</P><P size={9} tabular color={C.ink3}>{clock(play.take.durationS, false)}</P>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 }}>
              <Key label="⏮" onPress={() => s.seek(0)} style={{ minWidth: 48, paddingHorizontal: 0 }} />
              <Key label={play.playing ? 'Pause' : 'Play'} dark led={play.playing} ledColor={C.green} onPress={() => s.togglePlay()} style={{ flex: 1 }} />
              <Key label="⏭" onPress={() => s.seek(play.take.durationS)} style={{ minWidth: 48, paddingHorizontal: 0 }} />
              <Key label="Eject" onPress={() => s.setTake(null)} style={{ minWidth: 56, paddingHorizontal: 8 }} />
              <Rotary value={play.speed} options={SPEEDS} onChange={(k) => s.setSpeed(k)} size={54} label="speed" />
            </View>
            <P size={9} color={C.ink3} style={{ marginTop: 8 }}>Sample takes write anatomical abduction into the MCP column; the twin clamps it at 16°.</P>
          </>
        )}
      </ScrollView>
    </Frame>
  );
}

const rp = StyleSheet.create({
  take: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderColor: C.rule },
  tape: { marginTop: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.rule, paddingVertical: 6 },
});

/* ---------- DATA ---------- */

function Data({ onScreen }: { onScreen: (s: ScreenKey) => void }) {
  const s = useSession();
  const frame = s.frame;
  const [url, setUrl] = useState('ws://localhost:8765/ws');
  const feed = feedWord(s);
  return (
    <Frame screen="data" onScreen={onScreen} windowShare={0.3}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12 }} showsVerticalScrollIndicator={false}>
        <P size={9} caps color={C.ink2}>Source</P>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <View style={dt.slot}>
            <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={dt.input} placeholder="ws://host:8765/ws" placeholderTextColor={C.ink3} />
          </View>
          <Key label="Connect" dark onPress={() => s.connect(url)} style={{ height: 40 }} />
          <Key label="Sim" onPress={() => s.useSimulator()} style={{ height: 40, minWidth: 0 }} />
        </View>
        <P size={9} color={C.ink3} style={{ marginTop: 6 }}>{feed.word} · {feed.detail}</P>

        <P size={9} caps color={C.ink2} style={{ marginTop: 14 }}>Channels · wire name, mechanical name, reading</P>
        {FINGERS.map((f) => (
          <View key={f} style={{ marginTop: 8 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <View style={{ width: 40, justifyContent: 'center' }}><P size={9.5} caps color={C.ink2}>{FINGER_NAME[f]}</P></View>
              {JOINTS.map((j) => {
                const v = frame.joints[f][j.key], on = frame.ok[f][j.key];
                return <ValueTile key={j.key} label={`${f}_${j.wire}`} value={on ? `${v.toFixed(1)}°` : 'absent'} absent={!on} hot={Math.abs(v) > j.max} />;
              })}
            </View>
          </View>
        ))}
        <View style={{ flexDirection: 'row', marginTop: 6, paddingLeft: 46, gap: 6 }}>
          {JOINTS.map((j) => <P key={j.key} size={8.5} caps color={C.ink3} style={{ flex: 1 }}>{j.name} · ±{j.max}°</P>)}
        </View>

        <P size={9} caps color={C.ink2} style={{ marginTop: 16 }}>Rates · four numbers, not one</P>
        <View style={{ marginTop: 4 }}>
          {RATES.map((r) => (
            <View key={r.what} style={dt.rate}>
              <P size={11} weight="medium" style={{ width: 120 }}>{r.what}</P>
              <P size={10} color={C.ink2} style={{ flex: 1 }}>{r.note}</P>
              <P size={12} tabular weight="semi">{r.rate}</P>
            </View>
          ))}
        </View>
        <P size={9} color={C.ink3} style={{ marginTop: 12, marginBottom: 8 }}>Research prototype. Not a medical device.</P>
      </ScrollView>
    </Frame>
  );
}

const dt = StyleSheet.create({
  slot: { flex: 1, height: 40, borderRadius: 5, backgroundColor: '#C3C0B9', paddingHorizontal: 10, justifyContent: 'center',
    ...({ boxShadow: 'inset 0 2px 3px rgba(0,0,0,0.18)' } as any) },
  input: { fontFamily: 'Archivo_500Medium', fontSize: 12, color: C.ink },
  rate: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderColor: C.rule },
});

/* ---------- SHELL ---------- */

function Shell({ initialScreen, detail }: DesignProps) {
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  if (screen === 'welcome') return <Welcome onStart={() => setScreen('live')} onConnect={() => setScreen('data')} />;
  if (screen === 'live') return <Live detail={detail} onScreen={setScreen} />;
  if (screen === 'replay') return <Replay onScreen={setScreen} />;
  return <Data onScreen={setScreen} />;
}

export const design: Design = {
  id: '31', slug: 'rams', name: 'Rams panel',
  thesis: 'A machine hand is an instrument, so show it the way Braun showed a radio: in a window cut into enamel, with keys you could find with your eyes closed.',
  fonts: { Archivo_400Regular, Archivo_500Medium, Archivo_600SemiBold },
  bg: C.panel, statusBar: 'dark-content', App: Shell,
};
