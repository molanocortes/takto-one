// Meters.tsx - the read-outs.
//
// Three rules borrowed from the device's own instrument face and obeyed here:
// the accent is spent only on state, never on routine readings; motion is
// information, never decoration; and a value that is not being measured is
// drawn as ABSENT rather than as zero, because a zero-filled channel and a
// joint resting at zero degrees are not the same claim.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { C, S, R, FINGERS, FINGER_LABEL, type Finger } from './tokens';
import { Label, Mono } from './primitives';
import type { Frame } from '../data/types';

const ROWS = [
  { key: 'ab' as const, label: 'ABD', max: 16, signed: true },
  { key: 'mcp' as const, label: 'MCP', max: 90, signed: false },
  { key: 'pip' as const, label: 'PIP', max: 110, signed: false },
];

/** The twelve instrumented joints as one matrix: four fingers, three joints. */
export function JointMatrix({ frame }: { frame: Frame }) {
  return (
    <View>
      <View style={st.headRow}>
        <View style={st.rowLabel} />
        {FINGERS.map((f) => (
          <View key={f} style={st.cell}>
            <Label style={{ fontSize: 9.5, letterSpacing: 0.9 }}>{FINGER_LABEL[f].slice(0, 3)}</Label>
          </View>
        ))}
      </View>
      {ROWS.map((row) => (
        <View key={row.key} style={st.row}>
          <View style={st.rowLabel}>
            <Label style={{ fontSize: 9.5, letterSpacing: 0.9 }}>{row.label}</Label>
          </View>
          {FINGERS.map((f) => (
            <Cell key={f} value={frame.joints[f][row.key]} live={frame.ok[f][row.key]}
              max={row.max} signed={row.signed} />
          ))}
        </View>
      ))}
    </View>
  );
}

function Cell({ value, live, max, signed }: {
  value: number; live: boolean; max: number; signed: boolean;
}) {
  const mag = Math.min(1, Math.abs(value) / max);
  const hot = mag > 0.82;
  return (
    <View style={st.cell}>
      <Mono size={17} weight="500" color={live ? C.ink : C.ink3}
        style={{ marginBottom: 5 }}>
        {live ? `${signed && value > 0 ? '+' : ''}${value.toFixed(0)}` : '–'}
      </Mono>
      <View style={st.track}>
        <View style={[st.fill, {
          width: `${mag * 100}%`,
          backgroundColor: !live ? 'transparent' : hot ? C.accent : C.ink,
        }]} />
      </View>
    </View>
  );
}

/**
 * The activation channel. It gets the one big numeral on the screen because
 * it is the only channel that says what the wearer INTENDED, and it leads the
 * joints by a fraction of a second.
 */
export function EffortMeter({ value, history }: { value: number; history: number[] }) {
  const absent = value < 0;
  const v = absent ? 0 : Math.max(0, Math.min(1, value));
  return (
    <View>
      <View style={st.effortHead}>
        <Label>Effort</Label>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
          <Mono size={30} weight="500" color={absent ? C.ink3 : C.ink}>
            {absent ? '–––' : v.toFixed(2)}
          </Mono>
          <Mono size={11} color={C.ink3}>EMG</Mono>
        </View>
      </View>
      <View style={st.emgTrack}>
        <View style={[st.emgFill, { width: `${v * 100}%` }]} />
      </View>
      <Sparkline values={history} />
    </View>
  );
}

/** History as a bar field: no drawing library, and it reads at a glance. */
export function Sparkline({ values, height = 30 }: { values: number[]; height?: number }) {
  const n = 56;
  const pad = Math.max(0, n - values.length);
  const shown = [...Array(pad).fill(0), ...values.slice(-n)];
  return (
    <View style={[st.spark, { height }]}>
      {shown.map((v, i) => {
        const h = Math.max(1, Math.min(1, Math.max(0, v)) * height);
        const recent = i > n - 8;
        return (
          <View key={i} style={{
            flex: 1, height: h, borderRadius: 1,
            backgroundColor: recent ? C.accent : 'rgba(23,22,20,0.17)',
          }} />
        );
      })}
    </View>
  );
}

/** transparent <-> assist, the one continuous scalar the whole system shares */
export function BlendBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <View>
      <View style={st.effortHead}>
        <Label>Assist blend</Label>
        <Mono size={13} color={C.ink2}>
          {v < 0.15 ? 'TRANSPARENT' : v > 0.85 ? 'ASSISTED' : 'BLENDED'}
        </Mono>
      </View>
      <View style={st.blendTrack}>
        <View style={[st.blendKnob, { left: `${v * 100}%` }]} />
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', marginBottom: S.s2 },
  row: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: S.s3 },
  rowLabel: { width: 34 },
  cell: { flex: 1, alignItems: 'center' },
  track: {
    height: 3, width: '72%', backgroundColor: 'rgba(23,22,20,0.09)',
    borderRadius: 2, overflow: 'hidden',
  },
  fill: { height: 3, borderRadius: 2 },
  effortHead: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-end', marginBottom: S.s2,
  },
  emgTrack: {
    height: 6, backgroundColor: 'rgba(23,22,20,0.08)',
    borderRadius: 3, overflow: 'hidden', marginBottom: S.s3,
  },
  emgFill: { height: 6, backgroundColor: C.accent, borderRadius: 3 },
  spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5 },
  blendTrack: {
    height: 2, backgroundColor: 'rgba(23,22,20,0.12)', marginTop: 10,
    marginBottom: 10, borderRadius: 1,
  },
  blendKnob: {
    position: 'absolute', top: -5, width: 2, height: 12,
    backgroundColor: C.ink, marginLeft: -1,
  },
});
