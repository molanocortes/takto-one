// Live.tsx - the device, right now.
//
// The machine fills the screen. Over it: the header and its picker chips, one
// floating glass card with the summary number, and a sheet at the foot that
// lists every channel and rises when asked. The machine keeps the drag.
import React, { useRef, useState } from 'react';
import { View, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Header, Backdrop, Sheet, Row, GlassChip, BadgeButton } from '../ui/Chrome';
import { Bar, Sparkline, JOINTS } from '../ui/Meters';
import { T, Num, Label, Glass, IconButton } from '../ui/primitives';
import { C, S, R, FINGERS, FINGER_LABEL, type Finger } from '../ui/tokens';
import { useSession } from '../data/session';

export function Live({ onOpenData }: { onOpenData: () => void }) {
  const session = useSession();
  const frame = session.frame;
  const history = useRef<number[]>([]).current;
  const { height } = useWindowDimensions();
  const [openFinger, setOpenFinger] = useState<Finger | null>('index');

  if (frame.emg >= 0) { history.push(frame.emg); if (history.length > 120) history.shift(); }

  let sum = 0, n = 0, liveJoints = 0, peakF: Finger = 'index', peak = -1;
  for (const f of FINGERS) {
    const p = frame.joints[f], ok = frame.ok[f];
    if (ok.mcp) { sum += p.mcp; n++; }
    if (ok.pip) { sum += p.pip; n++; }
    liveJoints += (ok.ab ? 1 : 0) + (ok.mcp ? 1 : 0) + (ok.pip ? 1 : 0);
    const m = Math.max(ok.mcp ? p.mcp : -1, ok.pip ? p.pip : -1);
    if (m > peak) { peak = m; peakF = f; }
  }
  const mean = n ? sum / n : 0;
  const emg = Math.max(0, frame.emg);
  const missing = 12 - liveJoints;
  const blend = Math.max(0, Math.min(1, frame.blend));
  const blendWord = blend < 0.15 ? 'Transparent' : blend > 0.85 ? 'Assisted' : 'Blended';

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Backdrop lift={0.13} scale={0.84} />
      <Header title="Live twin"
        right={<BadgeButton icon="bell" count={missing} onPress={onOpenData} />}
        chips={<>
          <GlassChip icon={session.link.live ? 'radio' : 'cpu'} label={session.link.live ? 'Bridge' : 'Simulated'}
            chevron onPress={onOpenData} tone={session.link.live ? 'live' : 'glass'} />
          <GlassChip icon="grid" label={`${liveJoints} / 12 joints`} />
        </>} />

      {/* the floating summary */}
      <Glass intensity={70} strong style={[st.float, { top: height * 0.40 }]}>
        <View style={{ padding: S.s5, paddingBottom: S.s4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <T size={17} weight="500">Mean flexion</T>
              <T size={13} color={C.t2} style={{ marginTop: 3 }}>Peak {FINGER_LABEL[peakF].toLowerCase()} {peak.toFixed(0)}°</T>
            </View>
            <Feather name="arrow-up-right" size={18} color={C.t2} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: S.s4 }}>
            <Num size={64} weight="300" tracking={-2}>{mean.toFixed(0)}</Num>
            <T size={18} weight="300" color={C.t2} style={{ marginLeft: 4 }}>°</T>
          </View>
        </View>
      </Glass>

      <Sheet title="Channels">
        <Row icon="zap" label="Effort" note="EMG" tone={emg > 0.8 ? 'accent' : undefined}
          value={<View style={{ flexDirection: 'row', alignItems: 'center', gap: S.s3 }}>
            <View style={{ width: 96, height: 18, justifyContent: 'flex-end' }}><Sparkline values={history} height={18} n={32} recent={4} /></View>
            <Num size={17} weight="400" color={emg > 0.8 ? C.accent : C.t1} style={{ width: 44, textAlign: 'right' }}>{frame.emg < 0 ? '–' : emg.toFixed(2)}</Num>
          </View>} />
        <Row icon="sliders" label="Assist" value={<T size={14} weight="400" color={C.t2}>{blendWord}</T>} />
        {FINGERS.map((f, i) => {
          const p = frame.joints[f], ok = frame.ok[f];
          const live = (ok.ab ? 1 : 0) + (ok.mcp ? 1 : 0) + (ok.pip ? 1 : 0);
          const open = openFinger === f;
          return (
            <View key={f}>
              <Row icon="git-commit" label={FINGER_LABEL[f]} note={live < 3 ? `${live} of 3 joints` : undefined}
                badge={3 - live || undefined}
                value={<View style={{ flexDirection: 'row', alignItems: 'center', gap: S.s3 }}>
                  <View style={{ width: 56 }}><Bar value={ok.pip ? p.pip : 0} max={110} live={ok.pip} /></View>
                  <Num size={17} weight="400" style={{ width: 44, textAlign: 'right' }}>{ok.pip ? `${p.pip.toFixed(0)}°` : '–'}</Num>
                  <Feather name={open ? 'chevron-up' : 'chevron-down'} size={18} color={C.t3} />
                </View>}
                onPress={undefined} last={open || i === FINGERS.length - 1} />
              <Pressable onPress={() => setOpenFinger(open ? null : f)} style={StyleSheet.absoluteFill} />
              {open && (
                <View style={st.detail}>
                  {JOINTS.map((j) => (
                    <View key={j.key} style={st.detailCell}>
                      <Label style={{ fontSize: 10 }}>{j.label}</Label>
                      <Num size={22} weight="300" style={{ marginTop: 4 }} color={ok[j.key] ? C.t1 : C.t3}>
                        {ok[j.key] ? `${j.signed && p[j.key] > 0 ? '+' : ''}${p[j.key].toFixed(0)}°` : '–'}
                      </Num>
                      <View style={{ marginTop: 8 }}><Bar value={p[j.key]} max={j.max} live={ok[j.key]} /></View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })}
        <T size={11.5} color={C.t4} style={{ textAlign: 'center', marginTop: S.s6 }}>
          {session.link.kind === 'bridge' ? 'Streaming from teensy_bridge.py' : 'Synthetic feed. No hand wore the device.'}
        </T>
      </Sheet>
    </View>
  );
}

const st = StyleSheet.create({
  float: { position: 'absolute', left: S.s5, width: 232 },
  detail: {
    flexDirection: 'row', gap: S.s2, paddingBottom: S.s4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.glassLine,
  },
  detailCell: { flex: 1, backgroundColor: C.glass, borderRadius: R.r2, padding: S.s3, borderWidth: 1, borderColor: C.glassLine },
});
