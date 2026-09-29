// Takes.tsx - the take library: what the bridge recorded, what is still on
// the device's SD card, and a few bundled demo takes for when there is no
// bridge at all. Any of them replays in the twin with a real transport.
import React, { useMemo } from 'react';
import { View, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TopRow, Title, SectionHead } from '../ui/Chrome';
import { M, T, Num, Hairline, Btn, Pill, Bar } from '../ui/primitives';
import { C, S, R } from '../ui/tokens';
import { useSession } from '../data/session';
import { bundledTakes } from '../data/takes';
import type { LibTake } from '../data/types';
import { Transport, OriginPill, QualityPills } from '../ui/Controls';

function when(ms?: number) {
  // imported and simulated takes carry wall-clock ms; a bridge take carries
  // the device clock, which is not a date
  if (!ms || ms < 1e12) return null;
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
function bytes(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`;
}

export function Takes({ onMenu, onStatus, onTwin }: { onMenu?: () => void; onStatus?: () => void; onTwin?: () => void }) {
  const session = useSession();
  const demos = useMemo(bundledTakes, []);
  const play = session.play;
  const status = session.status;
  const lib = session.library;
  const sd = session.sd;
  const srcName = session.source === 'sim' ? 'Simulator' : 'Bridge';
  const open = (t: LibTake) => { session.openTake(t); };

  const row = (t: LibTake, i: number) => {
    const on = play?.take.origin !== 'demo' && play?.take.id === t.id;
    const st8 = session.takeState[t.id];
    const noData = t.has_data === false;
    const meta = [t.id, when(t.created_ms), t.duration_s != null ? `${t.duration_s.toFixed(1)} s` : null, t.samples ? `${t.samples.toLocaleString()} samples` : null].filter(Boolean).join(' · ');
    return (
      <View key={t.id}>
        {i > 0 && <Hairline />}
        <Pressable disabled={noData || st8 === 'loading'} onPress={() => (on ? session.setTake(null) : open(t))} style={st.row}
          accessibilityRole="button" accessibilityLabel={`${on ? 'Stop' : 'Play'} ${t.task && t.task !== 'unlabelled' ? t.task : t.id}`}>
          <View style={st.icon}>
            {st8 === 'loading' ? <ActivityIndicator size="small" color={C.ink2} />
              : <Feather name={on ? 'pause-circle' : noData ? 'slash' : 'play-circle'} size={20} color={noData ? C.ink3 : C.ink} />}
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <T size={14} color={C.ink} numberOfLines={1}>{t.task && t.task !== 'unlabelled' ? t.task : t.id}</T>
            <T size={11} color={C.ink2} numberOfLines={1}>{meta}</T>
            <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
              {t.profile ? <Pill>{t.profile}</Pill> : null}
              {t.joint_source ? <Pill color={t.joint_source === 'encoders' ? C.green : t.joint_source === 'sim' ? C.orange : C.ink2}
                bg={t.joint_source === 'encoders' ? C.greenSoft : t.joint_source === 'sim' ? '#FDF3E1' : C.tile}>joints: {t.joint_source}</Pill> : null}
              {t.source === 'sd' ? <Pill color={C.blue} bg="#E8F0FE">from SD</Pill> : null}
              <QualityPills q={t.quality} fw={typeof t.provenance?.fw === 'number' ? t.provenance.fw : undefined} />
              {noData ? <Pill color={C.red} bg="#FDECEC">no rows</Pill> : null}
              {st8 === 'error' ? <Pill color={C.red} bg="#FDECEC">could not load</Pill> : null}
            </View>
          </View>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: S.gutter }} showsVerticalScrollIndicator={false}>
        <TopRow onMenu={onMenu} onStatus={onStatus} />
        <Title status={play ? `Replaying ${play.take.title}` : `${lib.length} take${lib.length === 1 ? '' : 's'} on the ${srcName.toLowerCase()}`} spinning={!!play}>Takes</Title>

        {play && (
          <View style={{ marginTop: 18, gap: 8 }}>
            <Transport />
            <Btn label="Watch in the twin" icon="eye" onPress={onTwin} />
          </View>
        )}

        <SectionHead label={session.source === 'sim' ? 'Recorded in the simulator' : 'Recorded on the bridge'} right={srcName} style={{ marginTop: 26 }} />
        <View style={{ marginTop: 6 }}>
          {status.kind === 'offline' && !lib.length ? (
            <T size={12} color={C.ink2} style={{ marginVertical: 8 }}>Connect to the bridge to see its takes.</T>
          ) : !lib.length ? (
            <T size={12} color={C.ink2} style={{ marginVertical: 8 }}>
              {session.libraryKnown ? 'No takes yet. Record one on the Record tab.' : 'Waiting for the library…'}
            </T>
          ) : lib.map(row)}
          {session.source === 'sim' && lib.length > 0 && (
            <T size={10.5} color={C.ink3} style={{ marginTop: 4 }}>Simulated takes live in memory and are gone when the app closes.</T>
          )}
        </View>

        <SectionHead label="On the device's SD card" right={sd.known ? 'Refresh' : undefined} onRight={() => session.sdList()} style={{ marginTop: 26 }} />
        <View style={{ marginTop: 6 }}>
          {!sd.known ? (
            <View style={{ gap: 8, marginVertical: 6 }}>
              <T size={12} color={C.ink2}>
                {status.kind === 'offline' ? 'Connect to the bridge to list the card.' : 'The bridge has not listed an SD card. Standalone takes need firmware v16 and the upgraded bridge.'}
              </T>
              {status.kind !== 'offline' && <Btn label="Ask for the list" icon="refresh-cw" onPress={() => session.sdList()} />}
            </View>
          ) : !sd.items.length ? (
            <T size={12} color={C.ink2} style={{ marginVertical: 8 }}>The card holds no takes.</T>
          ) : sd.items.map((it, i) => {
            const pct = session.sdProgress[it.name];
            const importing = pct !== undefined;
            const linked = it.imported_take ? lib.find((t) => t.id === it.imported_take) : undefined;
            return (
              <View key={it.name}>
                {i > 0 && <Hairline />}
                <View style={st.row}>
                  <View style={st.icon}><Feather name="hard-drive" size={17} color={C.ink2} /></View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                      <M size={11} color={C.ink} upper={false}>{it.name}</M>
                      <M size={9} color={C.ink3} upper={false}>{bytes(it.bytes)}</M>
                    </View>
                    {importing ? (
                      <View style={{ gap: 4 }}>
                        <Bar value={pct / 100} color={C.blue} />
                        <M size={8.5} color={C.blue}>Importing {pct}%</M>
                      </View>
                    ) : it.imported_take ? (
                      <M size={8.5} color={C.green} upper={false}>imported as {it.imported_take}</M>
                    ) : (
                      <M size={8.5} color={C.ink3} upper={false}>on the card only</M>
                    )}
                  </View>
                  {!importing && (it.imported_take
                    ? <Btn label="Play" icon="play" height={34} onPress={() => open(linked ?? { id: it.imported_take! })} />
                    : <Btn label="Import" icon="download" height={34} onPress={() => session.sdImport(it.name)} disabled={sd.busy || !session.canCommand} />)}
                </View>
              </View>
            );
          })}
          {sd.known && sd.busy && Object.keys(session.sdProgress).length === 0 && <M size={8.5} color={C.ink3} style={{ marginTop: 4 }}>Card busy</M>}
        </View>

        <SectionHead label="Demo takes · offline" style={{ marginTop: 26 }} />
        <T size={11} color={C.ink3} style={{ marginTop: 6 }}>
          Choreographed, synthetic sessions bundled with the app for when there is no bridge. No hand wore the device to make them.
        </T>
        <View style={{ marginTop: 4 }}>
          {demos.map((t, i) => {
            const on = play?.take.origin === 'demo' && play.take.id === t.id;
            return (
              <View key={t.id}>
                {i > 0 && <Hairline />}
                <Pressable onPress={() => session.setTake(on ? null : t)} style={st.row}>
                  <View style={st.icon}><Feather name={on ? 'pause-circle' : 'play-circle'} size={20} color={C.ink2} /></View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <T size={14} color={C.ink}>{t.title}</T>
                      <OriginPill origin="demo" />
                    </View>
                    <T size={11} color={C.ink2} numberOfLines={1}>{t.note}</T>
                  </View>
                  <Num size={13} color={C.ink2}>{t.durationS.toFixed(0)}s</Num>
                </Pressable>
              </View>
            );
          })}
        </View>
        <View style={{ height: 28 }} />
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: 8, gap: 10 },
  icon: { width: 26, alignItems: 'center' },
  card: { backgroundColor: C.white, borderRadius: R.r3, borderWidth: 1, borderColor: C.tileLine, padding: 14 },
});
