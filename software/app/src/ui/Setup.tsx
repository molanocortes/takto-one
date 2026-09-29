// Setup.tsx - the first-run guide and the launch reconnect banner.
//
// The guide walks the four things a session needs, in order: connect to the
// bridge, capture the neutral pose, check that the sensors are live, record.
// Every tick is earned from what the source reports (a delivering bridge, a
// calibrated body block, a sealed take); only "the sensors look right" is the
// person's own judgement, and it is shown next to the numbers it is about.
import React, { useEffect, useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Platform } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { M, T, Btn, Field, Pill } from './primitives';
import { C, S, R } from './tokens';
import { useSession, type SetupStep } from '../data/session';
import { checkBridgeAddress, shortAddress, DEFAULT_PORT } from '../data/bridge';
import { NeutralCard, SensorStrip } from './Controls';
import { STATUS_COLOR } from './Chrome';

const TITLES: Record<SetupStep['key'], string> = {
  connect: 'Connect to the bridge',
  calibrate: 'Calibrate the neutral pose',
  sensors: 'Check the sensors',
  record: 'Record a take',
};

export function SetupSheet({ onRecord, keyboard = 0 }: { onRecord: () => void; keyboard?: number }) {
  const session = useSession();
  const inset = useSafeAreaInsets();
  const steps = session.setupSteps;
  const firstOpen = steps.findIndex((s) => !s.done);
  const [open, setOpen] = useState<number>(firstOpen < 0 ? 3 : firstOpen);
  // advance on its own when a step is earned, never backwards
  const [seen, setSeen] = useState(firstOpen);
  useEffect(() => {
    if (firstOpen > seen) { setOpen(firstOpen < 0 ? 3 : firstOpen); setSeen(firstOpen); }
  }, [firstOpen]);
  const allDone = firstOpen < 0;
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <View style={[st.sheet, { paddingTop: inset.top + 12 }]} accessibilityViewIsModal>
      <View style={st.head}>
        <View style={{ flex: 1 }}>
          <M size={16.5} color={C.ink} tracking={2.4}>Get started</M>
          <M size={9} color={C.ink2} style={{ marginTop: 8 }}>{`${doneCount} of 4 done`}</M>
        </View>
        <Pressable onPress={() => session.closeSetup(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close the guide">
          <Feather name="x" size={20} color={C.ink} />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter, paddingBottom: 24 + (keyboard || inset.bottom) }}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {steps.map((s, i) => (
          <View key={s.key} style={[st.step, open === i && st.stepOpen]}>
            <Pressable onPress={() => setOpen(open === i ? -1 : i)} style={st.stepHead}
              accessibilityRole="button" accessibilityState={{ expanded: open === i }} accessibilityLabel={`Step ${i + 1}: ${TITLES[s.key]}${s.done ? ', done' : ''}`}>
              <View style={[st.num, s.done && { backgroundColor: C.green, borderColor: C.green }]}>
                {s.done ? <Feather name="check" size={13} color={C.white} /> : <M size={10} color={C.ink} weight="500">{String(i + 1)}</M>}
              </View>
              <T size={15} color={C.ink} style={{ flex: 1 }}>{TITLES[s.key]}</T>
              <Feather name={open === i ? 'chevron-up' : 'chevron-down'} size={16} color={C.ink3} />
            </Pressable>
            {open === i && (
              <View style={{ marginTop: 10 }}>
                {s.key === 'connect' && <ConnectStep />}
                {s.key === 'calibrate' && <NeutralCard />}
                {s.key === 'sensors' && (
                  <View style={{ gap: 12 }}>
                    <T size={12.5} color={C.ink2}>
                      Move each finger and turn the wrist. Hand and forearm IMUs should read live and every finger you move should report. A finger with no signal is drawn as a ghost in the twin, never as a confident 0 degrees.
                    </T>
                    <SensorStrip />
                    <Btn label={s.done ? 'Checked' : 'The sensors look right'} icon="check" kind={s.done ? 'ghost' : 'primary'}
                      onPress={() => session.confirmSensors()} disabled={session.source === 'bridge' && session.status.kind === 'offline'} />
                  </View>
                )}
                {s.key === 'record' && (
                  <View style={{ gap: 10 }}>
                    <T size={12.5} color={C.ink2}>
                      The Record tab has one big button: tap to start, tap to stop. The bridge seals the take into its library (Takes tab), and with firmware v16 the device also writes an archival copy to its SD card.
                    </T>
                    <Btn label="Go to Record" icon="circle" kind="primary" onPress={() => { session.closeSetup(true); onRecord(); }} />
                  </View>
                )}
              </View>
            )}
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 18 }}>
          <Btn label={allDone ? 'Done' : 'Skip for now'} icon={allDone ? 'check' : undefined} kind={allDone ? 'primary' : 'ghost'}
            onPress={() => session.closeSetup(true)} style={{ flex: 1 }} />
        </View>
        <T size={11} color={C.ink3} style={{ marginTop: 10, textAlign: 'center' }}>
          The guide stays under Link → Setup guide.
        </T>
      </ScrollView>
    </View>
  );
}

function ConnectStep() {
  const session = useSession();
  const [url, setUrl] = useState(session.savedUrl ? shortAddress(session.savedUrl) : Platform.OS === 'web' ? 'localhost' : '');
  useEffect(() => { if (session.savedUrl && !url) setUrl(shortAddress(session.savedUrl)); }, [session.savedUrl]);
  const check = checkBridgeAddress(url);
  const status = session.status;
  const onBridge = session.source === 'bridge';
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: STATUS_COLOR[status.kind] }} />
        <M size={9.5} color={C.ink} weight="500">{status.label}</M>
        <M size={8.5} color={C.ink3} upper={false} style={{ flex: 1 }}>{status.detail}</M>
      </View>
      <T size={12.5} color={C.ink2} style={{ marginTop: 6 }}>
        On the PC with the device plugged in, start the bridge with --ws-host 0.0.0.0, put this phone on the same Wi-Fi, and type the PC's IP address.
      </T>
      <Field value={url} onChange={setUrl} placeholder="192.168.x.x" keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'url'} mono icon="link"
        selectOnFocus clearable invalid={!!check.error} maxLength={200} onSubmit={() => { if (check.url) session.connect(url); }} />
      <M size={8.5} color={check.error ? C.red : C.ink3} upper={false} style={{ marginTop: 4 }}>
        {check.error ?? (check.url ? `→ ${check.url}` : `e.g. 192.168.1.20 (port ${DEFAULT_PORT} and /ws are filled in)`)}
      </M>
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
        <Btn label="Connect" icon="link" kind="primary" onPress={() => session.connect(url)} disabled={!check.url} style={{ flex: 1 }} />
        <Btn label="No device: simulator" icon="cpu" onPress={() => session.chooseSimulator()} disabled={!onBridge && session.simChosen} style={{ flex: 1 }} />
      </View>
      {session.source === 'sim' && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <Pill color={C.orange} bg="#FDF3E1">Simulated</Pill>
          <T size={11} color={C.ink2} style={{ flex: 1 }}>You can walk the whole guide on the in-app simulator; nothing it shows comes from a person.</T>
        </View>
      )}
    </View>
  );
}

/**
 * While the app is trying to reach a bridge and nothing is arriving: where it
 * is dialling, and the one tap that gets a working app anyway (the simulator).
 */
export function LinkBanner({ onLink, bottom }: { onLink: () => void; bottom: number }) {
  const session = useSession();
  const status = session.status;
  if (session.source !== 'bridge' || status.kind !== 'offline' || session.conn.state === 'paused' || !session.bridgeUrl) return null;
  const addr = shortAddress(session.bridgeUrl);
  const c = session.conn;
  const long = Date.now() - c.since > 4000 || c.state === 'offline';
  const auto = session.autoConnect;
  const head = c.state === 'open' ? 'Bridge up, waiting for data' : long && c.state === 'offline' ? "Can't reach the bridge" : 'Connecting…';
  const sub = `${addr}${auto ? ' (last used)' : ''} · ${c.state === 'open' ? 'the device is not streaming' : c.detail}`;
  return (
    <View style={[st.banner, { bottom }]} accessibilityLiveRegion="polite">
      <MaterialCommunityIcons name={long ? 'wifi-off' : 'sync'} size={16} color={long ? C.red : C.ink2} />
      <View style={{ flex: 1 }}>
        <T size={13} color={C.ink} numberOfLines={1}>{head}</T>
        <M size={8} color={C.ink2} upper={false} style={{ marginTop: 2 }}>{sub}</M>
      </View>
      <Btn label="Simulator" height={34} onPress={() => session.chooseSimulator()} />
      <Pressable onPress={onLink} hitSlop={8} accessibilityRole="button" accessibilityLabel="Change the bridge address" style={{ paddingHorizontal: 4 }}>
        <Feather name="edit-2" size={15} color={C.ink2} />
      </Pressable>
    </View>
  );
}

const st = StyleSheet.create({
  sheet: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: C.page, zIndex: 20, elevation: 20 },
  head: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: S.gutter, paddingBottom: 16 },
  step: { borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 12 },
  stepOpen: { paddingBottom: 18 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40 },
  num: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: C.tileLine, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' },
  banner: {
    position: 'absolute', left: S.gutter - 10, right: S.gutter - 10, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.white, borderRadius: R.r2, borderWidth: 1, borderColor: C.tileLine, paddingLeft: 12, paddingRight: 8, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
});
