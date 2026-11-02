import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';
import type { GameStatus, Player } from '@/lib/types';

const MIN = 60_000;

/**
 * Who's in and where they are: "Here ✓" needs a verified GPS check-in, "~4 min" is what
 * they said when joining, and "Late" means that time passed 10+ min ago with no check-in.
 * No live location tracking — the ETA is self-reported, the check-in is what's verified.
 */
function statusFor(p: Player, gameStatus: GameStatus, now: number): { text: string; color: string } {
  if (p.arrived) return { text: 'Here ✓', color: C.green };
  if (p.role === 'waitlisted') return { text: 'Waitlist', color: C.textMuted };
  if (p.role === 'host') return { text: 'Host', color: C.orange };
  if (gameStatus === 'upcoming') return { text: 'In', color: C.textDim };
  if (!p.eta_at) return { text: 'Coming', color: C.textDim };
  const left = Math.round((new Date(p.eta_at).getTime() - now) / MIN);
  if (left > 0) return { text: `~${left} min away`, color: C.blue };
  if (left > -10) return { text: 'Should be there', color: C.blue };
  return { text: 'Late', color: C.amber };
}

export function PlayersList({ gameId, gameStatus, version, now, myId }: {
  gameId: string; gameStatus: GameStatus; version: string; now: number; myId: string | null;
}) {
  const [players, setPlayers] = useState<Player[] | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('get_game_players', { p_game_id: gameId });
    setPlayers((data ?? []) as Player[]);
  }, [gameId]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load, version]);

  if (!players) return null;
  const here = players.filter((p) => p.arrived).length;
  return (
    <View style={s.box}>
      <Text style={s.head}>
        On the app · {players.length}{here ? ` · ${here} checked in` : ''}
      </Text>
      {players.map((p) => {
        const st = statusFor(p, gameStatus, now);
        return (
          <Pressable key={p.user_id} style={s.row} onPress={() => router.push({ pathname: '/profile/[id]', params: { id: p.user_id } })}
            accessibilityRole="button" accessibilityLabel={`${p.display_name}, ${st.text}. View profile`}>
            <Text style={s.name} numberOfLines={1}>{p.display_name}{p.user_id === myId ? ' (you)' : ''}</Text>
            <Text style={[s.status, { color: st.color }]}>{st.text}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  box: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  head: { color: C.textFaint, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, minHeight: 36, gap: 12 },
  name: { color: C.textDim, fontSize: 14, flex: 1 },
  status: { fontSize: 13, fontWeight: '600' },
});
