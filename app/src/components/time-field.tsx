import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';

import { C } from '@/lib/theme';

/** "6:30 pm", "6pm", "18:30" → minutes after midnight, or null */
export function parseTime(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?::?(\d{2}))?\s*(a|p|am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3].startsWith('p') ? 12 : 0); }
  if (h > 23) return null;
  return h * 60 + min;
}

const label = (mod: number) => {
  const h = Math.floor(mod / 60), m = mod % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Phone-app version: type the time ("6:30 pm"). The browser build uses time-field.web.tsx. */
export function TimeField({ minuteOfDay, onChange, invalid }: {
  minuteOfDay: number; onChange: (m: number) => void; invalid?: boolean;
}) {
  const [text, setText] = useState(label(minuteOfDay));
  const parsed = parseTime(text);
  return (
    <TextInput style={[s.input, (invalid || parsed === null) && { borderColor: C.red, color: C.red }]}
      value={text} placeholder="6:30 PM" placeholderTextColor={C.textFaint} accessibilityLabel="Game time"
      onChangeText={(t) => { setText(t); const p = parseTime(t); if (p !== null) onChange(p); }}
      onBlur={() => { if (parsed !== null) setText(label(parsed)); }} />
  );
}

const s = StyleSheet.create({
  input: { backgroundColor: C.card, borderWidth: 1.5, borderColor: '#252525', borderRadius: 10, color: C.text, padding: 12, fontSize: 20, fontWeight: '700' },
});
