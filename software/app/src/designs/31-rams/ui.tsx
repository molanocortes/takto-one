// 31-rams ui - the panel's parts: printed type, keys, LEDs, scales, dials.
import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, PanResponder, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { C, F, KEY_UP, KEY_DOWN, KEY_DARK_UP } from './tokens';

/** Printed type. Small, tracked, mostly upper case: the panel's silkscreen. */
export function P({ children, size = 12, weight = 'ui', color = C.ink, caps = false, tracking, style, align, tabular }: {
  children: React.ReactNode; size?: number; weight?: keyof typeof F; color?: string; caps?: boolean;
  tracking?: number; style?: StyleProp<TextStyle>; align?: 'left' | 'center' | 'right'; tabular?: boolean;
}) {
  return (
    <Text style={[{
      fontFamily: F[weight], fontSize: size, color, lineHeight: Math.round(size * 1.25),
      letterSpacing: tracking ?? (caps ? size * 0.09 : 0), textTransform: caps ? 'uppercase' : 'none', textAlign: align,
      fontVariant: tabular ? ['tabular-nums'] : undefined,
    }, style]}>{children}</Text>
  );
}

/** An LED: a dot with a glow when lit. */
export function Led({ on, color = C.green, size = 7 }: { on: boolean; color?: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: on ? color : C.rule,
      ...(on ? { boxShadow: `0 0 6px 1px ${color}66` } as any : {}) }} />
  );
}

/**
 * A physical key. It has a face, a side and a fall; pressing it takes the
 * side away and pushes the face down, which is what a key does.
 */
export function Key({ label, sub, onPress, dark = false, led, ledColor, style, wide = false, tall = false, disabled = false }: {
  label: string; sub?: string; onPress?: () => void; dark?: boolean; led?: boolean; ledColor?: string;
  style?: StyleProp<ViewStyle>; wide?: boolean; tall?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [
      st.key, dark && st.keyDark, wide && { flex: 1 }, tall && { height: 64 },
      pressed ? [st.keyPressed, KEY_DOWN as object] : (dark ? KEY_DARK_UP : KEY_UP) as object, style,
    ]}>
      {led !== undefined && <View style={st.keyLed}><Led on={led} color={ledColor} size={6} /></View>}
      <P size={11} weight="semi" caps color={dark ? C.white : C.ink} align="center">{label}</P>
      {sub && <P size={9} color={dark ? 'rgba(255,255,255,0.55)' : C.ink3} caps align="center" style={{ marginTop: 2 }}>{sub}</P>}
    </Pressable>
  );
}

/** A tiny value key: a number printed on a key, for the joint matrix. */
export function ValueTile({ label, value, hot, absent }: { label: string; value: string; hot?: boolean; absent?: boolean }) {
  return (
    <View style={[st.tile, KEY_UP as object]}>
      <P size={9} caps color={C.ink3}>{label}</P>
      <P size={17} weight="medium" tabular color={absent ? C.ink3 : hot ? C.red : C.ink} style={{ marginTop: 1 }}>{value}</P>
    </View>
  );
}

/** Smooth a number the panel way: a needle has mass. */
export function useNeedle(value: number, speed = 18, bounciness = 3) {
  const v = useRef(new Animated.Value(value)).current;
  useEffect(() => {
    Animated.spring(v, { toValue: value, useNativeDriver: false, speed, bounciness }).start();
  }, [value]);
  return v;
}

/**
 * The tuning scale: a printed band of ticks with a red needle. Value in the
 * unit of the scale, max at the right end.
 */
export function Scale({ value, max, width, minor = 5, major = 30, height = 44, hot = false, unit = '°', absent = false }: {
  value: number; max: number; width: number; minor?: number; major?: number; height?: number; hot?: boolean; unit?: string; absent?: boolean;
}) {
  const needle = useNeedle(Math.max(0, Math.min(max, value)));
  const ticks: React.ReactNode[] = [];
  for (let t = 0; t <= max; t += minor) {
    const x = (t / max) * width;
    const isMajor = t % major === 0;
    ticks.push(<View key={t} style={{ position: 'absolute', left: x, top: 0, width: 1, height: isMajor ? 14 : 7, backgroundColor: isMajor ? C.ink : C.ink3 }} />);
    if (isMajor) ticks.push(<P key={`l${t}`} size={9} tabular color={C.ink2} style={{ position: 'absolute', left: x - 12, top: 17, width: 24, textAlign: 'center' }}>{t}{t === max ? unit : ''}</P>);
  }
  const x = needle.interpolate({ inputRange: [0, max], outputRange: [0, width] });
  return (
    <View style={{ width, height }}>
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, backgroundColor: C.ink }} />
      {ticks}
      {!absent && (
        <Animated.View style={{ position: 'absolute', top: -6, bottom: 0, left: -1, width: 2, backgroundColor: hot ? C.red : C.red,
          transform: [{ translateX: x }] }} />
      )}
    </View>
  );
}

/** A segmented level meter, as on a tape deck: n cells, the lit ones dark, the last band red. */
export function Meter({ value, cells = 24, hot = 0.82, absent = false, height = 10 }: { value: number; cells?: number; hot?: number; absent?: boolean; height?: number }) {
  const lit = absent ? 0 : Math.round(Math.max(0, Math.min(1, value)) * cells);
  return (
    <View style={{ flexDirection: 'row', gap: 2, height }}>
      {Array.from({ length: cells }, (_, i) => {
        const on = i < lit;
        const red = i / cells >= hot;
        return <View key={i} style={{ flex: 1, backgroundColor: on ? (red ? C.red : C.ink) : (red ? C.redSoft : C.ruleSoft), borderRadius: 1 }} />;
      })}
    </View>
  );
}

/** A small arc dial for one joint: 240 degrees of sweep, a needle, a printed limit. */
export function Dial({ value, max, size = 64, signed = false, absent = false, hot = false }: {
  value: number; max: number; size?: number; signed?: boolean; absent?: boolean; hot?: boolean;
}) {
  const r = size / 2 - 4;
  const cx = size / 2, cy = size / 2;
  const a0 = -210, a1 = 30;                 // degrees, sweeping clockwise
  const frac = signed ? (Math.max(-max, Math.min(max, value)) + max) / (2 * max) : Math.max(0, Math.min(1, value / max));
  const needle = useNeedle(frac);
  const rot = needle.interpolate({ inputRange: [0, 1], outputRange: [`${a0 + 90}deg`, `${a1 + 90}deg`] });
  const arc = (a: number) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [sx, sy] = arc(a0), [ex, ey] = arc(a1);
  const ticks = [];
  for (let i = 0; i <= 8; i++) {
    const a = a0 + ((a1 - a0) * i) / 8;
    const [x1, y1] = arc(a);
    const inner = r - (i % 4 === 0 ? 7 : 4);
    const x2 = cx + inner * Math.cos((a * Math.PI) / 180), y2 = cy + inner * Math.sin((a * Math.PI) / 180);
    ticks.push(<Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={i >= 7 ? C.red : C.ink} strokeWidth={i % 4 === 0 ? 1.4 : 1} />);
  }
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Path d={`M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`} stroke={C.ink3} strokeWidth={1} fill="none" />
        {ticks}
        <Circle cx={cx} cy={cy} r={3} fill={C.ink} />
      </Svg>
      {!absent && (
        <Animated.View style={{ position: 'absolute', left: cx - 1, top: cy - r + 2, width: 2, height: r - 2,
          backgroundColor: hot ? C.red : C.ink, transformOrigin: '50% 100%', transform: [{ rotate: rot }] } as any} />
      )}
    </View>
  );
}

/** A rotary knob with detents. Drag around it, or tap either side. */
export function Rotary({ value, options, onChange, size = 72, label }: {
  value: number; options: readonly { key: number; label: string }[]; onChange: (k: number) => void; size?: number; label?: string;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.key === value));
  const n = options.length;
  const span = 120;                                   // degrees of travel
  const angle = useNeedle(-span / 2 + (n > 1 ? (idx / (n - 1)) * span : 0), 20, 4);
  const startIdx = useRef(idx);
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 4,
    onPanResponderGrant: () => { startIdx.current = idx; },
    onPanResponderMove: (_, g) => {
      const step = Math.round(g.dx / 36);
      const next = Math.max(0, Math.min(n - 1, startIdx.current + step));
      if (options[next].key !== value) onChange(options[next].key);
    },
  })).current;
  const rot = angle.interpolate({ inputRange: [-180, 180], outputRange: ['-180deg', '180deg'] });
  const r = size / 2;
  const ridges = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    ridges.push(<Line key={i} x1={r + (r - 2) * Math.cos(a)} y1={r + (r - 2) * Math.sin(a)} x2={r + (r - 7) * Math.cos(a)} y2={r + (r - 7) * Math.sin(a)} stroke="#B9B6AE" strokeWidth={1.2} />);
  }
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: size + 40, height: size + 16 }}>
        {options.map((o, i) => {
          const a = ((-span / 2 + (n > 1 ? (i / (n - 1)) * span : 0) - 90) * Math.PI) / 180;
          const rr = r + 14;
          return (
            <Pressable key={o.key} onPress={() => onChange(o.key)} hitSlop={8} style={{ position: 'absolute', left: size / 2 + 20 + rr * Math.cos(a) - 14, top: r + 8 + rr * Math.sin(a) - 7, width: 28, alignItems: 'center' }}>
              <P size={9} weight={o.key === value ? 'semi' : 'ui'} color={o.key === value ? C.ink : C.ink3}>{o.label}</P>
            </Pressable>
          );
        })}
        <View {...pan.panHandlers} style={[{ position: 'absolute', left: 20, top: 8, width: size, height: size, borderRadius: r, backgroundColor: C.key }, KEY_UP as object]}>
          <Svg width={size} height={size} style={StyleSheet.absoluteFill}>{ridges}</Svg>
          <View style={{ position: 'absolute', left: 9, top: 9, right: 9, bottom: 9, borderRadius: r - 9, backgroundColor: '#E4E2DD', borderWidth: 1, borderColor: '#CFCCC5' }} />
          <Animated.View style={{ position: 'absolute', left: r - 1.5, top: 12, width: 3, height: r - 12, transform: [{ translateY: (r - 12) / 2 }, { rotate: rot }, { translateY: -(r - 12) / 2 }] }}>
            <View style={{ width: 3, height: 14, backgroundColor: C.red, borderRadius: 1 }} />
          </Animated.View>
        </View>
      </View>
      {label && <P size={9} caps color={C.ink3} style={{ marginTop: 2 }}>{label}</P>}
    </View>
  );
}

export function Rule({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: 1, backgroundColor: C.rule }, style]} />;
}

const st = StyleSheet.create({
  key: {
    height: 46, minWidth: 64, paddingHorizontal: 14, borderRadius: 6, backgroundColor: C.key,
    alignItems: 'center', justifyContent: 'center',
  },
  keyDark: { backgroundColor: C.keyDark },
  keyPressed: { transform: [{ translateY: 2 }] },
  keyLed: { position: 'absolute', top: 6, left: 7 },
  tile: { flex: 1, height: 54, borderRadius: 5, backgroundColor: C.key, paddingHorizontal: 9, paddingTop: 7 },
});
