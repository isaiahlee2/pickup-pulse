import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useUserId } from '@/hooks/use-session';
import { supabase } from '@/lib/supabase';
import { C, DAYS, sportIcon } from '@/lib/theme';
import type { Trend } from '@/lib/types';

const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

/** "Usually busy" predictions — shown when the live feed is quiet so the app is never a dead end. */
export function TrendsList({ sport, locationId }: { sport: string; locationId?: string }) {
  const [trends, setTrends] = useState<Trend[] | null>(null);
  const uid = useUserId();
  useEffect(() => {
    if (!uid) return;
    supabase.rpc('get_trends', { p_sport: sport === 'All' ? null : sport })
      .then(({ data }) => setTrends(((data ?? []) as Trend[]).filter((t) => !locationId || t.location_id === locationId).slice(0, 8)));
  }, [sport, locationId, uid]);

  if (!trends || trends.length === 0) return null;
  const today = new Date().getDay();
  const sorted = [...trends].sort((a, b) => ((a.day_of_week - today + 7) % 7) - ((b.day_of_week - today + 7) % 7));

  return (
    <View style={{ marginTop: 8 }}>
      <Text style={s.h}>Usually busy</Text>
      <Text style={s.sub}>From the last 4 weeks of check-ins</Text>
      {sorted.map((t) => (
        <View key={`${t.location_id}-${t.sport}-${t.day_of_week}-${t.hour_of_day}`} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.loc}>{sportIcon(t.sport)} {t.location_name}</Text>
            <Text style={s.when}>{t.day_of_week === today ? 'Today' : DAYS[t.day_of_week]}s around {hourLabel(t.hour_of_day)} · ~{Math.round(Number(t.avg_players))} players</Text>
          </View>
          <Text style={s.conf}>{t.confidence}%</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  h: { color: C.text, fontSize: 17, fontWeight: '700' },
  sub: { color: C.textFaint, fontSize: 12, marginTop: 2, marginBottom: 12 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 8 },
  loc: { color: C.text, fontSize: 14, fontWeight: '600' },
  when: { color: C.gold, fontSize: 12, marginTop: 3 },
  conf: { color: C.gold, fontSize: 12, fontWeight: '700', backgroundColor: 'rgba(247,201,72,0.08)', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8, overflow: 'hidden' },
});
