// primitives.tsx - the small set of shapes every screen is built from.
import React from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator, StyleSheet, type StyleProp, type ViewStyle, type TextStyle, type KeyboardTypeOptions } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Svg, { Circle, Path } from 'react-native-svg';
import { C, F, R, fontFor } from './tokens';

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

/** A button: 'primary' is ink on the page, 'ghost' is a tile, 'danger' is the stop. */
export function Btn({ label, onPress, kind = 'ghost', icon, disabled, busy, style, height = 44 }: {
  label: string; onPress?: () => void; kind?: 'primary' | 'ghost' | 'danger'; icon?: keyof typeof Feather.glyphMap;
  disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>; height?: number;
}) {
  const bg = kind === 'primary' ? C.ink : kind === 'danger' ? C.red : C.tile;
  const fg = kind === 'ghost' ? C.ink : C.white;
  const off = disabled || busy;
  return (
    <Pressable onPress={off ? undefined : onPress} accessibilityRole="button" accessibilityState={{ disabled: !!off }}
      style={({ pressed }) => [{
        height, borderRadius: R.r2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingHorizontal: 14, backgroundColor: bg, borderWidth: 1, borderColor: kind === 'ghost' ? C.tileLine : bg,
        opacity: off ? 0.4 : pressed ? 0.8 : 1,
      }, style]}>
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Feather name={icon} size={14} color={fg} /> : null}
      <M size={10.5} color={fg} weight="500">{label}</M>
    </Pressable>
  );
}

/** A small tag: what a take is, where a number came from. */
export function Pill({ children, color = C.ink2, bg = C.tile }: { children: React.ReactNode; color?: string; bg?: string }) {
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
      <M size={8} color={color} tracking={0.8}>{children}</M>
    </View>
  );
}

/** A labelled text field. */
export function Field({ label, value, onChange, placeholder, keyboardType, onSubmit, mono, icon }: {
  label?: string; value: string; onChange: (v: string) => void; placeholder?: string;
  keyboardType?: KeyboardTypeOptions; onSubmit?: () => void; mono?: boolean; icon?: keyof typeof Feather.glyphMap;
}) {
  return (
    <View style={{ marginTop: 10 }}>
      {label ? <M size={8.5} color={C.ink2} style={{ marginBottom: 6 }}>{label}</M> : null}
      <View style={fieldSt.row}>
        {icon ? <Feather name={icon} size={14} color={C.ink3} /> : null}
        <TextInput value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false}
          keyboardType={keyboardType} returnKeyType={onSubmit ? 'go' : 'done'} onSubmitEditing={onSubmit}
          placeholder={placeholder} placeholderTextColor={C.ink3}
          style={[fieldSt.input, { fontFamily: mono ? F.mono : F.ui }]} />
      </View>
    </View>
  );
}
const fieldSt = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.tile, borderRadius: R.r2, borderWidth: 1, borderColor: C.tileLine, paddingHorizontal: 12, height: 42 },
  input: { flex: 1, fontSize: 13, color: C.ink, minWidth: 0 },
});

/** A thin progress bar, 0..1. */
export function Bar({ value, color = C.ink, height = 4 }: { value: number; color?: string; height?: number }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: C.line, overflow: 'hidden' }}>
      <View style={{ width: `${v * 100}%`, height, backgroundColor: color }} />
    </View>
  );
}
