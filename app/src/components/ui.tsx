import type { ReactNode } from 'react';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { C } from '@/lib/theme';

export function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.pill, active && s.pillActive]}
      accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={label}>
      <Text style={[s.pillText, active && { color: C.orange }]}>{label}</Text>
    </Pressable>
  );
}

export function Button({ label, onPress, variant = 'primary', loading, disabled, style }: {
  label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'blue';
  loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const bg = { primary: C.orange, secondary: '#1a1a1a', danger: '#1a1a1a', blue: C.blue }[variant];
  const color = { primary: '#fff', secondary: C.textDim, danger: C.red, blue: '#fff' }[variant];
  const off = disabled || loading;
  return (
    <Pressable onPress={onPress} disabled={off}
      style={({ pressed }) => [s.btn, { backgroundColor: off ? '#1a1a1a' : bg, opacity: pressed ? 0.8 : 1 },
        variant !== 'primary' && variant !== 'blue' && s.btnOutline, style]}>
      {loading ? <ActivityIndicator color={color} /> : <Text style={[s.btnText, { color: off ? C.textFaint : color }]}>{label}</Text>}
    </Pressable>
  );
}

export function Stepper({ label, value, onChange, min = 0, max = 30 }: {
  label: string; value: number; onChange: (n: number) => void; min?: number; max?: number;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Label>{label}</Label>
      <View style={s.stepRow}>
        <Pressable style={s.stepBtn} onPress={() => onChange(Math.max(min, value - 1))}><Text style={s.stepSign}>−</Text></Pressable>
        <Text style={s.stepVal}>{value}</Text>
        <Pressable style={s.stepBtn} onPress={() => onChange(Math.min(max, value + 1))}><Text style={s.stepSign}>+</Text></Pressable>
      </View>
    </View>
  );
}

/** Type the number (numeric keypad on phones). Clamped to min–max when you leave the field. */
export function NumberField({ label, value, onChange, min = 0, max = 60, hint }: {
  label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; hint?: string;
}) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Math.min(max, Math.max(min, parseInt(text, 10) || min));
    setText(String(n)); onChange(n);
  };
  return (
    <View style={{ flex: 1 }}>
      <Label>{label}</Label>
      <TextInput style={s.num} value={text} keyboardType="number-pad" inputMode="numeric" maxLength={2}
        selectTextOnFocus accessibilityLabel={label}
        onChangeText={(t) => { const d = t.replace(/[^0-9]/g, ''); setText(d); const n = parseInt(d, 10); if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n))); }}
        onBlur={commit} />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

export const Label = ({ children }: { children: ReactNode }) => <Text style={s.label}>{children}</Text>;

export function Tag({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'green' | 'indigo' | 'orange' }) {
  const t = {
    neutral: { bg: '#1a1a1a', fg: '#888', bd: '#252525' },
    green: { bg: C.greenTint, fg: C.green, bd: 'rgba(34,197,94,0.2)' },
    indigo: { bg: 'rgba(99,102,241,0.08)', fg: C.indigo, bd: 'rgba(99,102,241,0.2)' },
    orange: { bg: C.orangeTint, fg: C.orange, bd: 'rgba(255,107,53,0.25)' },
  }[tone];
  return <Text style={[s.tag, { backgroundColor: t.bg, color: t.fg, borderColor: t.bd }]}>{text}</Text>;
}

export function Empty({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 }}>
      <Text style={{ fontSize: 40, marginBottom: 12 }}>{icon}</Text>
      <Text style={{ color: C.textDim, fontSize: 15, textAlign: 'center' }}>{title}</Text>
      {sub ? <Text style={{ color: C.textFaint, fontSize: 13, marginTop: 6, textAlign: 'center' }}>{sub}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  pill: { paddingVertical: 7, paddingHorizontal: 16, borderRadius: 20, borderWidth: 1.5, borderColor: C.borderStrong, backgroundColor: C.card, marginRight: 8 },
  pillActive: { borderColor: C.orange, backgroundColor: 'rgba(255,107,53,0.12)' },
  pillText: { color: '#888', fontSize: 13, fontWeight: '600' },
  btn: { paddingVertical: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  btnOutline: { borderWidth: 1, borderColor: C.borderStrong },
  btnText: { fontSize: 14, fontWeight: '700' },
  label: { fontSize: 11, color: C.textFaint, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { width: 38, height: 38, borderRadius: 10, backgroundColor: C.card, borderWidth: 1.5, borderColor: '#252525', alignItems: 'center', justifyContent: 'center' },
  stepSign: { color: '#888', fontSize: 18 },
  stepVal: { color: C.text, fontSize: 20, fontWeight: '700', minWidth: 26, textAlign: 'center' },
  num: { backgroundColor: C.card, borderWidth: 1.5, borderColor: '#252525', borderRadius: 10, color: C.text, fontSize: 22, fontWeight: '700', paddingVertical: 10, paddingHorizontal: 14, minHeight: 48 },
  hint: { color: C.textFaint, fontSize: 12, marginTop: 6 },
  tag: { fontSize: 11, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, overflow: 'hidden', marginRight: 6, marginTop: 6 },
});
