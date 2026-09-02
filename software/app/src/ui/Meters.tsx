// Meters.tsx - the read-outs.
//
// The accent is spent only on state, never on routine readings; motion is
// information, never decoration; and a value that is not being measured is
// drawn as ABSENT rather than as zero, because a zero-filled channel and a
// joint resting at zero degrees are not the same claim.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { C, S, R, FINGERS, FINGER_LABEL, type Finger } from './tokens';
import { T, Num, Label } from './primitives';
import type { Frame } from '../data/types';

export const JOINTS = [
  { key: 'ab' as const, label: 'ABD', max: 16, signed: true },
  { key: 'mcp' as const, label: 'MCP', max: 90, signed: false },
  { key: 'pip' as const, label: 'PIP', max: 110, signed: false },
];

/** A thin bar with the value's share lit. Accent past 82 % of range. */
export function Bar({ value, max, live, height = 3 }: { value: number; max: number; live: boolean; height?: number }) {
  const mag = Math.min(1, Math.abs(value) / max);
  const hot = mag > 0.82;
  return (
    <View style={[st.track, { height, borderRadius: height / 2 }]}>
      <View style={{
        width: `${mag * 100}%`, height, borderRadius: height / 2,
        backgroundColor: !live ? 'transparent' : hot ? C.accent : C.white,
      }} />
    </View>
  );
}

/** A finger as a card: its mean flexion as a ring, its three joints beneath. */
export function FingerCard({ finger, frame, width }: { finger: Finger; frame: Frame; width: number }) {
  const p = frame.joints[finger];
  const ok = frame.ok[finger];
  const live = ok.mcp || ok.pip;
  const mean = live ? ((ok.mcp ? p.mcp : 0) + (ok.pip ? p.pip : 0)) / ((ok.mcp ? 1 : 0) + (ok.pip ? 1 : 0)) : 0;
  const share = Math.min(1, mean / 100);
  const hot = share > 0.82;
  return (
    <View style={[st.finger, { width }]}>
      <View style={st.fingerHead}>
        <View>
          <T size={15} weight="600">{FINGER_LABEL[finger]}</T>
          <T size={11.5} color={C.t3} style={{ marginTop: 1 }}>{live ? 'flexion' : 'absent'}</T>
        </View>
        <Ring value={share} size={52} stroke={4} color={hot ? C.accent : C.white}>
          <Num size={14} weight="600" color={live ? C.t1 : C.t3}>{live ? mean.toFixed(0) : '–'}</Num>
        </Ring>
      </View>
      <View style={{ gap: 9, marginTop: S.s4 }}>
        {JOINTS.map((j) => {
          const v = p[j.key]; const on = ok[j.key];
          return (
            <View key={j.key}>
              <View style={st.jointRow}>
                <Label style={{ fontSize: 10 }}>{j.label}</Label>
                <Num size={13} weight="600" color={on ? C.t1 : C.t3}>
                  {on ? `${j.signed && v > 0 ? '+' : ''}${v.toFixed(0)}°` : '–'}
                </Num>
              </View>
              <Bar value={v} max={j.max} live={on} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** A progress ring, drawn with SVG so it is crisp at any scale. */
export function Ring({ value, size = 56, stroke = 4, color = C.white, track = 'rgba(255,255,255,0.10)', children }: {
  value: number; size?: number; stroke?: number; color?: string; track?: string; children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
          strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      {children}
    </View>
  );
}

/** History as a bar field. The newest bars carry the accent. */
export function Sparkline({ values, height = 36, n = 48, recent = 6, dim = false }: {
  values: number[]; height?: number; n?: number; recent?: number; dim?: boolean;
}) {
  const pad = Math.max(0, n - values.length);
  const shown = [...Array(pad).fill(0), ...values.slice(-n)];
  return (
    <View style={[st.spark, { height }]}>
      {shown.map((v, i) => {
        const h = Math.max(2, Math.min(1, Math.max(0, v)) * height);
        const isRecent = i >= n - recent;
        return (
          <View key={i} style={{
            flex: 1, height: h, borderRadius: 2,
            backgroundColor: isRecent && !dim ? C.accent : 'rgba(255,255,255,0.22)',
          }} />
        );
      })}
    </View>
  );
}

/** A smooth trace, for a whole take at once. */
export function Trace({ values, width, height, color = C.white, fill = true }: {
  values: number[]; width: number; height: number; color?: string; fill?: boolean;
}) {
  if (!values.length || width <= 0) return <View style={{ width, height }} />;
  const n = values.length;
  const pts = values.map((v, i) => [
    (i / Math.max(1, n - 1)) * width,
    height - Math.max(0, Math.min(1, v)) * (height - 2) - 1,
  ]);
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < n; i++) {
    const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
  }
  return (
    <Svg width={width} height={height}>
      {fill && <Path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill={color} opacity={0.12} />}
      <Path d={d} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

const st = StyleSheet.create({
  track: { backgroundColor: 'rgba(255,255,255,0.10)', overflow: 'hidden' },
  finger: {
    backgroundColor: C.card, borderRadius: R.r3, padding: S.s4,
    borderWidth: 1, borderColor: C.glassLine,
  },
  fingerHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  jointRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 },
  spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
});
