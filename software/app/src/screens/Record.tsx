// Record.tsx - start and stop the one shared recording from the phone, watch
// it run, see what the device's own SD card is doing, and capture the neutral.
//
// The bridge owns the recording: {cmd:"record", action:"start"|"stop"} begins
// or seals the take every client sees, and the snapshot's `session` block is
// the truth about whether one is running. The phone only asks and reports.
import React, { useState } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TopRow, Title, SectionHead, STATUS_COLOR } from '../ui/Chrome';
import { M, T, Num, Hairline, Btn, Field, Pill } from '../ui/primitives';
import { C, S, R } from '../ui/tokens';
import { useSession } from '../data/session';
import { NeutralCard, fmtTime } from '../ui/Controls';

let draft = { task: '', profile: '', notes: '' };

export function Record({ onMenu, onStatus, onLink }: { onMenu?: () => void; onStatus?: () => void; onLink?: () => void }) {
  const session = useSession();
  const [form, setForm] = useState(draft);
  const upd = (k: keyof typeof form) => (v: string) => { const n = { ...form, [k]: v }; draft = n; setForm(n); };
  const status = session.status;
  const live = session.live;
  const rec = live.rec;
  const dev = live.device;
  const recording = !!rec?.recording;
  const can = session.canCommand;
  const sourceIsSim = session.source === 'sim' || session.conn.synthetic;

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <TopRow onMenu={onMenu} onStatus={onStatus} />
        <Title status={session.source === 'sim' ? 'Simulator: takes are synthetic' : status.detail} spinning={status.kind === 'offline'}>Record</Title>

        {!can && (
          <View style={[st.card, { marginTop: 22, borderColor: '#F3C7C9' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Feather name="wifi-off" size={14} color={C.red} />
              <T size={14} color={C.ink} style={{ flex: 1 }}>No bridge to record with</T>
            </View>
            <T size={12} color={C.ink2}>The bridge records; the phone asks it to. Connect to the PC running the bridge first.</T>
            <Btn label="Open Link" icon="link" onPress={onLink} />
          </View>
        )}

        {/* the running take */}
        <View style={[st.card, { marginTop: 22 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={[st.recDot, { backgroundColor: recording ? C.red : C.line }]} />
            <M size={10} color={recording ? C.red : C.ink2} weight="500">{recording ? 'Recording' : 'Not recording'}</M>
            <View style={{ flex: 1 }} />
            {sourceIsSim && <Pill color={C.orange} bg="#FDF3E1">Simulated</Pill>}
            {rec?.id ? <M size={9} color={C.ink2} upper={false}>{rec.id}</M> : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 14 }}>
            <Num size={48} weight="300" color={recording ? C.ink : C.ink3} tracking={-1}>{fmtTime((rec?.elapsedMs ?? 0) / 1000)}</Num>
            <View>
              <Num size={15} color={C.ink}>{rec ? rec.samples.toLocaleString() : '–'}</Num>
              <M size={8} color={C.ink2}>samples</M>
            </View>
          </View>
          {recording && (rec?.task || rec?.profile) ? (
            <T size={12} color={C.ink2}>{[rec.task, rec.profile].filter(Boolean).join(' · ')}</T>
          ) : null}
          {!recording && (
            <>
              <Field label="Task / take name" value={form.task} onChange={upd('task')} placeholder="e.g. cup grasp, trial 3" />
              <Field label="Subject" value={form.profile} onChange={upd('profile')} placeholder="Operator" />
              <Field label="Notes" value={form.notes} onChange={upd('notes')} placeholder="optional" />
            </>
          )}
          {recording
            ? <Btn label="Stop and save" icon="square" kind="danger" height={50} onPress={() => session.recordStop()} busy={session.recPending === 'stop'} disabled={!can} style={{ marginTop: 6 }} />
            : <Btn label="Start recording" icon="circle" kind="primary" height={50} onPress={() => session.recordStart(form)} busy={session.recPending === 'start'} disabled={!can} style={{ marginTop: 6 }} />}
          {session.play && <T size={11} color={C.ink3}>A replay is showing in the twin; recording still captures the live device.</T>}
          {!rec && can && <T size={11} color={C.ink3}>This bridge does not report its recording state; the start and stop acknowledgements are all there is.</T>}
          {live.body?.cal === 'provisional' && !recording && (
            <T size={11.5} color={C.orange}>Calibrate the neutral first (below) so the arm columns of the take are true.</T>
          )}
        </View>

        <SectionHead label="Device" right={dev?.fw ? `firmware v${dev.fw}` : undefined} style={{ marginTop: 26 }} />
        <View style={{ marginTop: 4 }}>
          {dev ? (
            ([
              ['SD card', dev.sdPresent ? 'present' : 'missing', dev.sdPresent ? C.green : C.red],
              ['Recording to card', dev.sdRecording ? `take ${dev.sdTake}` : 'no', dev.sdRecording ? C.red : C.ink2],
              ['Rows on card', dev.sdRecording ? dev.sdRows.toLocaleString() : '–', C.ink],
              ['Standalone auto-record', dev.autoRecord == null ? '–' : dev.autoRecord ? 'on' : 'off', C.ink],
              ['Power', dev.standby ? 'standby' : 'awake', dev.standby ? C.orange : C.ink],
              ['Boot', dev.bootId != null ? `#${dev.bootId}` : '–', C.ink],
            ] as const).map(([k, v, col], i) => (
              <View key={k}>
                {i > 0 && <Hairline />}
                <View style={st.kv}>
                  <T size={13.5} color={C.ink} style={{ flex: 1 }}>{k}</T>
                  <M size={10} color={col} upper={false}>{v}</M>
                </View>
              </View>
            ))
          ) : (
            <T size={12} color={C.ink2} style={{ marginTop: 6 }}>
              {status.kind === 'offline' ? 'No device status while offline.' : 'This bridge or firmware does not report the device block (needs firmware v16 and the upgraded bridge). Recording still works; the SD copy is just not visible here.'}
            </T>
          )}
        </View>

        <SectionHead label="Calibration" style={{ marginTop: 26 }} />
        <View style={{ marginTop: 10 }}><NeutralCard /></View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18 }}>
          <View style={[st.dot, { backgroundColor: STATUS_COLOR[status.kind] }]} />
          <T size={11} color={C.ink3} style={{ flex: 1 }}>
            Takes are sealed by the bridge into its library (Takes tab). With firmware v16 the device also writes an archival copy to its SD card.
          </T>
        </View>
        <View style={{ height: 28 }} />
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: C.white, borderRadius: R.r3, borderWidth: 1, borderColor: C.tileLine, padding: 14, gap: 10 },
  recDot: { width: 10, height: 10, borderRadius: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  kv: { flexDirection: 'row', alignItems: 'center', minHeight: 40 },
});
