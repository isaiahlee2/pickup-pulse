import type { CSSProperties } from 'react';

import { C } from '@/lib/theme';

const pad = (n: number) => String(n).padStart(2, '0');

/** Browser version: the phone's own time picker (the iPhone wheel), and typeable on a laptop. */
export function TimeField({ minuteOfDay, onChange, invalid }: {
  minuteOfDay: number; onChange: (m: number) => void; invalid?: boolean;
}) {
  const value = `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;
  const style: CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: C.card, color: invalid ? C.red : C.text,
    border: `1.5px solid ${invalid ? C.red : '#252525'}`, borderRadius: 10, padding: '12px 14px',
    fontSize: 20, fontWeight: 700, fontFamily: 'inherit', colorScheme: 'dark', minHeight: 48,
  };
  return (
    <input type="time" aria-label="Game time" value={value} step={300} style={style}
      onChange={(e) => {
        const [h, m] = e.target.value.split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) onChange(h * 60 + m);
      }} />
  );
}
