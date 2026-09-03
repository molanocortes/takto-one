// primitives.tsx - the small set of shapes every screen is built from.
import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { C, F, fontFor } from './tokens';

type TW = TextStyle['fontWeight'];

/** Words and numerals, in Inter. */
export function T({ children, size = 14, weight = '400', color = C.ink, style, tracking = 0, lineHeight, numberOfLines }: {
  children: React.ReactNode; size?: number; weight?: TW; color?: string; style?: StyleProp<TextStyle>;
  tracking?: number; lineHeight?: number; numberOfLines?: number;
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[{
      fontFamily: fontFor(weight), fontSize: size, color, letterSpacing: tracking,
      lineHeight: lineHeight ?? Math.round(size * 1.25),
    }, style]}>{children}</Text>
  );
}

/** A label: monospaced capitals, tracked. Never a sentence. */
export function M({ children, size = 11, color = C.ink2, style, tracking, weight = '400', upper = true }: {
  children: React.ReactNode; size?: number; color?: string; style?: StyleProp<TextStyle>;
  tracking?: number; weight?: '400' | '500'; upper?: boolean;
}) {
  return (
    <Text style={[{
      fontFamily: weight === '500' ? F.monoMed : F.mono, fontSize: size, color,
      letterSpacing: tracking ?? size * 0.12, lineHeight: Math.round(size * 1.3),
      textTransform: upper ? 'uppercase' : 'none',
    }, style]}>{children}</Text>
  );
}

/** A numeral: tabular, so columns hold still. */
export function Num({ children, size = 15, weight = '400', color = C.ink, style, tracking }: {
  children: React.ReactNode; size?: number; weight?: TW; color?: string; style?: StyleProp<TextStyle>; tracking?: number;
}) {
  return (
    <T size={size} weight={weight} color={color} tracking={tracking ?? (size >= 40 ? -size * 0.03 : 0)}
      style={[{ fontVariant: ['tabular-nums'] }, style]}>{children}</T>
  );
}

export function Hairline({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: 1, backgroundColor: C.line }, style]} />;
}

/** A trace: a smooth line through the values, drawn thin, optionally dashed. */
export function Trace({ values, width, height, color, dashed = false, stroke = 1.5 }: {
  values: number[]; width: number; height: number; color: string; dashed?: boolean; stroke?: number;
}) {
  if (!values.length || width <= 0) return <View style={{ width, height }} />;
  const n = values.length;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [
    (i / Math.max(1, n - 1)) * width,
    height - ((v - lo) / span) * (height - stroke * 2) - stroke,
  ]);
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < n; i++) {
    const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C ${cx.toFixed(1)} ${y0.toFixed(1)}, ${cx.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return (
    <Svg width={width} height={height}>
      <Path d={d} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={dashed ? '2.5 2.5' : undefined} />
    </Svg>
  );
}

/** A ring gauge with a two-tone arc: green for the charge, grey for the rest. */
export function Ring({ value, size, stroke, color = C.green, track = C.line, children }: {
  value: number; size: number; stroke: number; color?: string; track?: string; children?: React.ReactNode;
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
