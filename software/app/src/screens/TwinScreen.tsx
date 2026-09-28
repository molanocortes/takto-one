// TwinScreen.tsx - the device on the wearer's arm, from whatever the source is.
//
// Two views, the same two the web console offers: the arm moving through
// space in the shared body frame, or the hand alone with the forearm held
// still so the wrist and the fingers read at full size. The pose is the
// session's one frame, so a replay drives this exactly like the live feed.
import React, { useState } from 'react';
import { View, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { Twin } from '../twin/Twin';
import { TopRow, Title, Tiles, SectionHead, type TileIcon } from '../ui/Chrome';
import { M, T, Num, Hairline, Pill } from '../ui/primitives';
import { C, S, FINGERS, FINGER_LABEL } from '../ui/tokens';
import { useSession } from '../data/session';
import { Transport, CalPrompt, calLine } from '../ui/Controls';

type View3 = 'arm' | 'hand';
const VIEWS: { key: View3; label: string; icon: TileIcon }[] = [
  { key: 'arm', label: 'Arm in space', icon: { set: 'mci', name: 'arm-flex-outline' } },
  { key: 'hand', label: 'Hand only', icon: { set: 'mci', name: 'hand-back-right-outline' } },
];
let lastView: View3 = 'arm';

const f1 = (v: number) => { const r = Math.round(v); return `${r > 0 ? '+' : ''}${r === 0 ? 0 : r}`; };
const cm = (v: number) => { const r = Math.round(v * 100); return String(r === 0 ? 0 : r); };

export function TwinScreen({ onMenu, onStatus }: { onMenu?: () => void; onStatus?: () => void }) {
  const session = useSession();
  const [view, setViewState] = useState<View3>(lastView);
  const setView = (v: View3) => { lastView = v; setViewState(v); };
  const { width, height } = useWindowDimensions();
  const frame = session.frame;
  const b = frame.body;
  const status = session.status;
  const dead = FINGERS.filter((f) => !frame.ok[f].mcp && !frame.ok[f].pip);
  const partial = FINGERS.filter((f) => !dead.includes(f) && (!frame.ok[f].ab || !frame.ok[f].mcp || !frame.ok[f].pip));
  const twinH = Math.max(300, Math.min(460, height * 0.46));
  const noData = status.kind === 'offline';

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter }} showsVerticalScrollIndicator={false}>
        <TopRow onMenu={onMenu} onStatus={onStatus} />
        <Title status={session.play ? calLine(b) : calLine(session.live.body)} spinning={status.kind !== 'live'}>Twin</Title>

        <View style={{ marginTop: 18 }}>
          <Tiles items={VIEWS} value={view} onChange={setView} height={52} labelSize={8.5} />
        </View>

        <View style={{ marginTop: 12 }}><CalPrompt /></View>

        <View style={{ marginHorizontal: -S.gutter, height: twinH, marginTop: 4 }}>
          <Twin key={view} view={view} stage="light" part="device" scale={view === 'hand' ? 0.66 : 1} style={{ width, height: twinH }} />
          {noData && (
            <View style={st.overlay} pointerEvents="none">
              <M size={10} color={C.red}>{status.label}</M>
              <T size={12} color={C.ink2} style={{ marginTop: 4, textAlign: 'center' }}>
                {session.frame.t > 0 ? 'Showing the last pose received.' : 'No data yet.'} Nothing here is invented.
              </T>
            </View>
          )}
          {view === 'arm' && b?.origin === 'legacy' && (
            <View style={st.corner} pointerEvents="none"><Pill color={C.orange} bg="#FDF3E1">Approximate arm</Pill></View>
          )}
          <View style={st.hint} pointerEvents="none"><M size={8} color={C.ink3} upper={false}>drag to turn</M></View>
        </View>

        {session.play ? <View style={{ marginTop: 6 }}><Transport /></View> : null}

        <SectionHead label="Wrist" right={b ? (b.origin === 'body' ? b.posSource : 'legacy') : undefined} style={{ marginTop: 22 }} />
        <View style={st.row3}>
          {([['Flexion', b?.wristDeg?.flex], ['Deviation', b?.wristDeg?.dev], ['Pronation', b?.wristDeg?.pro]] as const).map(([k, v]) => (
            <View key={k} style={{ flex: 1 }}>
              <M size={8.5} color={C.ink2}>{k}</M>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 4 }}>
                <Num size={24} weight="300">{v == null ? '–' : f1(v)}</Num>
                <T size={12} color={C.ink2} style={{ marginLeft: 3 }}>°</T>
              </View>
            </View>
          ))}
        </View>
        <T size={10.5} color={C.ink3}>+ flexion is palm-ward, + deviation radial, + pronation</T>

        <SectionHead label="Arm in the body frame" style={{ marginTop: 22 }} />
        <View style={{ marginTop: 4 }}>
          {([['Elbow', b?.elbow], ['Wrist', b?.wrist], ['Palm', b?.hand]] as const).map(([k, v], i) => (
            <View key={k}>
              {i > 0 && <Hairline />}
              <View style={st.kv}>
                <M size={9.5} color={C.ink2} style={{ width: 70 }}>{k}</M>
                <Num size={13} color={C.ink}>{v ? `${cm(v[0])}  ${cm(v[1])}  ${cm(v[2])}` : '–'}</Num>
                <M size={8.5} color={C.ink3} upper={false} style={{ marginLeft: 6 }}>{v ? 'cm  x left · y up · z fwd' : ''}</M>
              </View>
            </View>
          ))}
          {b?.inertialConf != null && (<><Hairline /><View style={st.kv}>
            <M size={9.5} color={C.ink2} style={{ width: 70 }}>Inertial</M>
            <Num size={13}>{Math.round(b.inertialConf * 100)}%</Num>
            <M size={8.5} color={C.ink3} upper={false} style={{ marginLeft: 6 }}>confidence in shoulder motion</M>
          </View></>)}
        </View>
        <T size={10.5} color={C.ink3} style={{ marginTop: 4 }}>
          Positions are estimated from a jointed-arm model (the IMUs measure orientation, not position): the shoulder is the origin, the upper arm is 30 cm and the forearm 26 cm.
        </T>

        <SectionHead label="Fingers" style={{ marginTop: 22 }} />
        <View style={{ marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {FINGERS.map((f) => {
            const d = dead.includes(f), p = partial.includes(f);
            return <Pill key={f} color={d ? C.red : p ? C.orange : C.green} bg={d ? '#FDECEC' : p ? '#FDF3E1' : C.greenSoft}>{FINGER_LABEL[f]} {d ? 'no signal' : p ? 'partial' : 'ok'}</Pill>;
          })}
        </View>
        {(dead.length > 0 || partial.length > 0) && (
          <T size={10.5} color={C.ink3} style={{ marginTop: 6 }}>
            A channel the bridge marks dead is held at the neutral pose; a finger with no flexion signal is drawn as a ghost, never as a confident 0°.
          </T>
        )}
        <View style={{ height: 28 }} />
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  overlay: { position: 'absolute', left: 30, right: 30, top: '38%', alignItems: 'center', backgroundColor: 'rgba(242,242,242,0.85)', borderRadius: 10, paddingVertical: 10 },
  corner: { position: 'absolute', right: 20, top: 8 },
  hint: { position: 'absolute', right: 20, bottom: 6 },
  row3: { flexDirection: 'row', marginTop: 10, marginBottom: 6 },
  kv: { flexDirection: 'row', alignItems: 'center', height: 36 },
});
