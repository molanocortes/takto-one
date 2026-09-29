// Record.tsx - start and stop the one shared recording from the phone, watch
// it run, see what the device's own SD card is doing, and capture the neutral.
//
// The bridge owns the recording: {cmd:"record", action:"start"|"stop"} begins
// or seals the take every client sees, and the snapshot's `session` block is
// the truth about whether one is running. The phone only asks and reports.
import React, { useState } from 'react';
import { View, ScrollView, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TopRow, Title, SectionHead, STATUS_COLOR } from '../ui/Chrome';
import { M, T, Num, Hairline, Btn, Field, Pill } from '../ui/primitives';
import { C, S, R } from '../ui/tokens';
import { useSession } from '../data/session';
import { NeutralCard, SensorStrip, fmtTime } from '../ui/Controls';

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

        {/* the primary action: one big button, the clock, and what is being captured */}
        <View style={[st.card, { marginTop: 22, alignItems: 'center', gap: 6 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' }}>
            <View style={[st.recDot, { backgroundColor: recording ? C.red : C.line }]} />
            <M size={10} color={recording ? C.red : C.ink2} weight="500">{recording ? 'Recording' : 'Ready'}</M>
            <View style={{ flex: 1 }} />
            {sourceIsSim && <Pill color={C.orange} bg="#FDF3E1">Simulated</Pill>}
            {rec?.id ? <M size={9} color={C.ink2} upper={false}>{rec.id}</M> : null}
          </View>
          <Num size={56} weight="300" color={recording ? C.ink : C.ink3} tracking={-1.5}>{fmtTime((rec?.elapsedMs ?? 0) / 1000)}</Num>
          <M size={8.5} color={C.ink2} upper={false}>
            {rec ? `${rec.samples.toLocaleString()} samples${recording && dev?.sdRecording ? ` · card take ${dev.sdTake}, ${dev.sdRows.toLocaleString()} rows` : ''}` : 'no recording state from this bridge'}
          </M>
          <Pressable
            onPress={() => (recording ? session.recordStop() : session.recordStart(form))}
            disabled={!can || !!session.recPending}
            accessibilityRole="button" accessibilityLabel={recording ? 'Stop and save the take' : 'Start recording'}
            accessibilityState={{ disabled: !can || !!session.recPending, busy: !!session.recPending }}
            style={({ pressed }) => [st.big, { opacity: !can ? 0.35 : pressed ? 0.75 : 1, borderColor: recording ? C.red : C.ink }]}>
            {session.recPending ? <ActivityIndicator color={recording ? C.red : C.ink} />
              : <View style={recording ? st.stopGlyph : st.recGlyph} />}
          </Pressable>
          <M size={9.5} color={recording ? C.red : C.ink} weight="500">
            {session.recPending === 'start' ? 'Starting…' : session.recPending === 'stop' ? 'Saving…' : recording ? 'Tap to stop and save' : 'Tap to record'}
          </M>
          {recording && (rec?.task || rec?.profile) ? (
            <T size={12} color={C.ink2}>{[rec.task, rec.profile].filter(Boolean).join(' · ')}</T>
          ) : null}
          {session.play && <T size={11} color={C.ink3} style={{ textAlign: 'center' }}>A replay is showing in the twin; recording still captures the live device.</T>}
          {live.body?.cal === 'provisional' && !recording && can && (
            <View style={st.warn}>
              <Feather name="alert-triangle" size={13} color={C.orange} />
              <T size={11.5} color={C.ink} style={{ flex: 1 }}>Neutral is provisional: calibrate first so the arm columns are true.</T>
              <Btn label="Calibrate" height={32} onPress={() => session.calibrateNeutral()} disabled={!!session.play} />
            </View>
          )}
        </View>

        <SectionHead label="Live quality" right={sourceIsSim ? 'simulated' : status.kind === 'live' ? 'measured' : undefined} style={{ marginTop: 22 }} />
        <View style={{ marginTop: 10 }}><SensorStrip /></View>

        {!recording && (
          <>
            <SectionHead label="Take details · optional" style={{ marginTop: 24 }} />
            <Field label="Task / take name" value={form.task} onChange={upd('task')} placeholder="e.g. cup grasp, trial 3" maxLength={80} />
            <Field label="Subject" value={form.profile} onChange={upd('profile')} placeholder="Operator" maxLength={60} />
            <Field label="Notes" value={form.notes} onChange={upd('notes')} placeholder="optional" maxLength={240} />
          </>
        )}

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
  big: { width: 92, height: 92, borderRadius: 46, borderWidth: 3, alignItems: 'center', justifyContent: 'center', marginTop: 10, marginBottom: 2, backgroundColor: C.white },
  recGlyph: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.red },
  stopGlyph: { width: 34, height: 34, borderRadius: 6, backgroundColor: C.red },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch', marginTop: 6, backgroundColor: '#FFF8EC', borderRadius: R.r2, borderWidth: 1, borderColor: '#F6D9A6', padding: 10 },
});
