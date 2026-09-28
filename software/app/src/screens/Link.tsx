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
import { DEFAULT_PORT, normalizeBridgeUrl } from '../data/bridge';

const RATES = [
  { what: 'This app', rate: '60 Hz', note: 'what you are watching' },
  { what: 'Bridge broadcast', rate: '60 Hz', note: 'the snapshot rate, --hz on the bridge' },
  { what: 'Firmware stream', rate: '100 Hz', note: 'S-lines, firmware v16 (v15: 50 Hz)' },
  { what: 'Control loop', rate: '2 kHz', note: 'on the Teensy, next to the actuator' },
];

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

export function Link({ onMenu, onStatus }: { onMenu?: () => void; onStatus?: () => void }) {
  const session = useSession();
  // the field opens with the last address that was tried; on a phone the
  // PC's LAN address is what is needed, and localhost would be the phone
  const [url, setUrl] = useState(session.savedUrl || (Platform.OS === 'web' ? `ws://localhost:${DEFAULT_PORT}/ws` : ''));
  useEffect(() => { if (session.savedUrl && !url) setUrl(session.savedUrl); }, [session.savedUrl]);
  const status = session.status;
  const c = session.conn;
  const onBridge = session.source === 'bridge';
  const preview = normalizeBridgeUrl(url);
  const lanUrl = c.lan ? `ws://${c.lan}:${c.port ?? DEFAULT_PORT}/ws` : null;

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
          {lanUrl && <T size={11} color={C.ink3}>The bridge reports its LAN address as {lanUrl}. Use that on the phone.</T>}
        </View>

        <SectionHead label="Bridge address" style={{ marginTop: 26 }} />
        <Field value={url} onChange={setUrl} placeholder="ws://192.168.x.x:8765/ws" keyboardType="url" mono icon="link"
          onSubmit={() => session.connect(url)} />
        <M size={8.5} color={preview ? C.ink3 : C.red} upper={false} style={{ marginTop: 6 }}>
          {preview ? `→ ${preview}` : url ? 'not an address' : 'e.g. 192.168.1.20: the scheme, port 8765 and /ws are filled in'}
        </M>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
          <Btn label={onBridge ? 'Reconnect' : 'Connect'} icon="link" kind="primary" onPress={() => session.connect(url)} disabled={!preview} style={{ flex: 1 }} />
          <Btn label="Use simulator" icon="cpu" onPress={() => session.useSimulator()} disabled={!onBridge} style={{ flex: 1 }} />
        </View>

        {session.recentUrls.length > 0 && (
          <>
            <SectionHead label="Recent" style={{ marginTop: 22 }} />
            <View style={{ marginTop: 4 }}>
              {session.recentUrls.map((u, i) => (
                <View key={u}>
                  {i > 0 && <Hairline />}
                  <View style={st.row}>
                    <Pressable style={{ flex: 1 }} onPress={() => { setUrl(u); session.connect(u); }}>
                      <M size={10.5} color={C.ink} upper={false}>{u}</M>
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

        <SectionHead label="Rates" style={{ marginTop: 26 }} />
        <View style={{ marginTop: 6 }}>
          {RATES.map((r, i) => (
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
