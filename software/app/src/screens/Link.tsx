// Link.tsx - where the numbers come from: the bridge address, the state of the
// socket in plain words, the addresses used before, and how to get a phone
// onto the PC's bridge over the lab Wi-Fi.
import React, { useEffect, useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TopRow, Title, SectionHead, STATUS_COLOR } from '../ui/Chrome';
import { M, T, Num, Hairline, Btn, Field } from '../ui/primitives';
import { C, S, R } from '../ui/tokens';
import { useSession } from '../data/session';
import { DEFAULT_PORT, checkBridgeAddress, shortAddress } from '../data/bridge';

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

export function Link({ onMenu, onStatus }: { onMenu?: () => void; onStatus?: () => void }) {
  const session = useSession();
  // the field opens with the last address that was tried; on a phone the
  // PC's LAN address is what is needed, and localhost would be the phone
  // The field holds what a person would type ("192.168.1.20"), not the full
  // URL: less to get wrong, and a tap selects all of it, so typing replaces it.
  const [url, setUrl] = useState(session.savedUrl ? shortAddress(session.savedUrl) : Platform.OS === 'web' ? 'localhost' : '');
  useEffect(() => { if (session.savedUrl && !url) setUrl(shortAddress(session.savedUrl)); }, [session.savedUrl]);
  // the field follows the bridge actually in use (a Recent tap, the guide, a launch reconnect)
  useEffect(() => { if (session.bridgeUrl) setUrl(shortAddress(session.bridgeUrl)); }, [session.bridgeUrl]);
  const status = session.status;
  const c = session.conn;
  const onBridge = session.source === 'bridge';
  const check = checkBridgeAddress(url);
  const preview = check.url;
  const lanUrl = c.lan ? `ws://${c.lan}:${c.port ?? DEFAULT_PORT}/ws` : null;
  const p = session.pose;
  const dev = session.live.device;
  const flowing = status.kind === 'live' || status.kind === 'sim' || (status.kind === 'replay' && (session.source === 'sim' || c.state === 'open'));
  const ms = (v: number | null) => (v == null ? '–' : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);
  const rates: { what: string; rate: string; note: string }[] = session.source === 'sim' ? [
    { what: 'Pose lane', rate: p.lane === 'on' ? `${p.hz} Hz` : '–', note: 'in-app simulator, the same path a bridge uses' },
    { what: 'Arrival jitter', rate: ms(p.jitterMs), note: 'p95 minus median gap between pose messages' },
    { what: 'Control loop', rate: '2 kHz', note: 'on the Teensy (design value, not measured here)' },
  ] : [
    { what: 'Snapshot', rate: flowing ? `${c.hz} Hz` : '–', note: 'measured here: full frames from the bridge' },
    { what: 'Pose lane', rate: p.lane === 'on' ? `${p.hz} Hz` : p.lane === 'unsupported' ? 'n/a' : '–',
      note: p.lane === 'on' ? `measured here${p.gaps ? ` · ${p.gaps} frames skipped last second` : ''}`
        : p.lane === 'unsupported' ? 'this bridge has no pose lane yet: the twin draws from the snapshot'
          : p.lane === 'asked' ? 'asked for, nothing yet' : 'not connected' },
    { what: 'Bridge processing', rate: ms(p.procMs ?? session.bridgeLatencyMs), note: 'serial line in to pose out, bridge clock (median)' },
    { what: 'Network + app', rate: ms(p.ageMs), note: p.ageMs == null ? 'needs the pose lane and clocks that agree' : 'bridge send to arrival here; assumes both clocks agree' },
    { what: 'Arrival jitter', rate: ms(p.jitterMs), note: `p95 minus median gap between ${p.lane === 'on' ? 'pose messages' : 'snapshots'}, measured here` },
    { what: 'Device stream', rate: dev?.rateHz ? `${Math.round(dev.rateHz)} Hz` : '–', note: 'S-lines, as the bridge counts them (firmware v16: 100 Hz)' },
    { what: 'Control loop', rate: '2 kHz', note: 'on the Teensy (design value, not measured here)' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <TopRow onMenu={onMenu} onStatus={onStatus} />
        <Title status={status.detail} spinning={status.kind === 'offline'}>Link</Title>

        <View style={[st.card, { marginTop: 22 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={[st.bigDot, { backgroundColor: STATUS_COLOR[status.kind] }]} />
            <M size={14} color={C.ink} weight="500">{status.label}</M>
            <View style={{ flex: 1 }} />
            {onBridge && c.state === 'open' ? <Num size={13} color={C.ink}>{c.hz} Hz</Num> : null}
          </View>
          <T size={12.5} color={C.ink2}>
            {session.play ? 'A take is replaying; the source below keeps running underneath.' :
              session.source === 'sim' ? 'The in-app simulator: a synthetic hand and arm. Nothing on screen comes from a person.' :
                status.kind === 'live' ? 'A real device through the bridge.' :
                  status.label === 'SIMULATED' ? 'Connected, but the bridge itself is running --sim: synthetic data, not a person.' :
                    `Not receiving data (${c.detail || c.state}) for ${ago(c.since)}. The app keeps retrying.`}
          </T>
          {onBridge && <M size={9.5} color={C.ink2} upper={false}>{session.bridgeUrl}</M>}
          {lanUrl && <T size={11} color={C.ink3}>The bridge reports its LAN address as {lanUrl}. On the phone, type {c.lan}.</T>}
          {onBridge && flowing && p.lane === 'on' ? (
            <M size={8.5} color={C.ink2} upper={false}>{`pose lane ${p.hz} Hz · bridge ${ms(p.procMs ?? session.bridgeLatencyMs)}${p.ageMs != null ? ` · network+app ${ms(p.ageMs)}` : ''}`}</M>
          ) : onBridge && p.lane === 'unsupported' ? (
            <M size={8.5} color={C.ink3} upper={false}>no pose lane on this bridge: the twin draws from the {c.hz} Hz snapshot</M>
          ) : null}
        </View>

        <SectionHead label="Bridge address" style={{ marginTop: 26 }} />
        <Field value={url} onChange={setUrl} placeholder="192.168.x.x" keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'url'} mono icon="link"
          selectOnFocus clearable invalid={!!check.error} maxLength={200}
          onSubmit={() => { if (preview) session.connect(url); }} />
        <M size={8.5} color={check.error ? C.red : C.ink3} upper={false} style={{ marginTop: 6 }}>
          {check.error ?? (preview ? `→ ${preview}` : `the PC's IP, e.g. 192.168.1.20: ws://, port ${DEFAULT_PORT} and /ws are filled in`)}
        </M>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
          <Btn label={onBridge && session.bridgeUrl === preview ? 'Reconnect' : 'Connect'} icon="link" kind="primary" onPress={() => session.connect(url)} disabled={!preview} style={{ flex: 1 }} />
          <Btn label="Use simulator" icon="cpu" onPress={() => session.chooseSimulator()} disabled={!onBridge} style={{ flex: 1 }} />
        </View>
        <Btn label="Setup guide" icon="list" onPress={() => session.openSetup()} style={{ marginTop: 6 }} />

        {session.recentUrls.length > 0 && (
          <>
            <SectionHead label="Recent" style={{ marginTop: 22 }} />
            <View style={{ marginTop: 4 }}>
              {session.recentUrls.map((u, i) => (
                <View key={u}>
                  {i > 0 && <Hairline />}
                  <View style={st.row}>
                    <Pressable style={{ flex: 1, minHeight: 40, justifyContent: 'center' }} onPress={() => { setUrl(shortAddress(u)); session.connect(u); }}
                      accessibilityRole="button" accessibilityLabel={`Connect to ${u}`}>
                      <M size={10.5} color={C.ink} upper={false}>{shortAddress(u)}</M>
                    </Pressable>
                    {session.bridgeUrl === u && onBridge ? <M size={8.5} color={STATUS_COLOR[status.kind]}>in use</M> : null}
                    <Pressable onPress={() => session.forgetUrl(u)} hitSlop={8} accessibilityLabel={`Forget ${u}`}>
                      <Feather name="x" size={14} color={C.ink3} />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}

        <SectionHead label="Phone to PC over Wi-Fi" style={{ marginTop: 26 }} />
        <View style={{ marginTop: 8, gap: 8 }}>
          {[
            ['1', 'On the PC, start the bridge listening on the LAN:'],
            ['', 'python3 software/bridge/teensy_bridge.py --port /dev/cu.usbmodemXXXX --ws-host 0.0.0.0'],
            ['2', 'Put the phone on the same Wi-Fi as the PC (a guest network that isolates clients will not work).'],
            ['3', 'Find the PC\'s address: macOS "ipconfig getifaddr en0", Windows "ipconfig", Linux "hostname -I".'],
            ['4', 'Type it above, e.g. 192.168.1.20, and Connect. Allow incoming connections if the firewall asks.'],
          ].map(([n, txt], i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
              <M size={10} color={C.ink2} style={{ width: 12 }}>{n}</M>
              {n ? <T size={12.5} color={C.ink} style={{ flex: 1 }}>{txt}</T>
                : <View style={st.code}><M size={9.5} color={C.ink} upper={false}>{txt}</M></View>}
            </View>
          ))}
          <T size={11} color={C.ink3}>
            Without --ws-host 0.0.0.0 the bridge only answers on the PC itself. "localhost" on the phone is the phone.
          </T>
        </View>

        <SectionHead label="Rates and latency" right={session.source === 'sim' ? 'simulated' : flowing ? 'measured' : undefined} style={{ marginTop: 26 }} />
        <View style={{ marginTop: 6 }}>
          {rates.map((r, i) => (
            <View key={r.what}>
              {i > 0 && <Hairline />}
              <View style={st.row}>
                <View style={{ flex: 1 }}>
                  <T size={14} color={C.ink}>{r.what}</T>
                  <T size={11.5} color={C.ink2}>{r.note}</T>
                </View>
                <Num size={13} color={C.ink}>{r.rate}</Num>
              </View>
            </View>
          ))}
        </View>
        <T size={11} color={C.ink3} style={{ textAlign: 'center', marginVertical: 24 }}>Research prototype. Not a medical device.</T>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: C.white, borderRadius: R.r3, borderWidth: 1, borderColor: C.tileLine, padding: 14, gap: 8 },
  bigDot: { width: 10, height: 10, borderRadius: 5 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: 6, gap: 10 },
  code: { flex: 1, backgroundColor: C.tile, borderRadius: 6, borderWidth: 1, borderColor: C.tileLine, padding: 8 },
});
