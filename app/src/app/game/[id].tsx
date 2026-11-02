import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { GameCard } from '@/components/game-card';
import { Button, Empty } from '@/components/ui';
import { useApproxLocation } from '@/hooks/use-location';
import { useUserId } from '@/hooks/use-session';
import { supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';
import type { FeedGame } from '@/lib/types';

/** What a shared link opens: one game, live, even if it's far away or already over. */
export default function GamePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const myId = useUserId();
  const { coords, permission } = useApproxLocation();
  const [game, setGame] = useState<FeedGame | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!myId) return;
    const located = permission === 'granted';
    const { data } = await supabase.rpc('get_game', {
      p_game_id: id, p_lat: located ? coords.lat : null, p_lng: located ? coords.lng : null,
    });
    setGame(((data ?? []) as FeedGame[])[0] ?? null);
  }, [id, coords.lat, coords.lng, permission, myId]);

  useEffect(() => {
    if (!myId) return;
    const t = setTimeout(load, 0);
    const channel = supabase.channel(`game-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${id}` }, () => { load(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rsvps', filter: `game_id=eq.${id}` }, () => { load(); })
      .subscribe();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearTimeout(t); supabase.removeChannel(channel); clearInterval(tick); };
  }, [id, load, myId]);

  return (
    <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={s.wrap}>
      <Stack.Screen options={{ title: game ? `${game.sport} at ${game.location_name}` : 'Game' }} />
      {game === undefined ? <ActivityIndicator color={C.orange} style={{ marginTop: 40 }} /> : null}
      {game === null ? (
        <View>
          <Empty icon="🤷" title="This game isn’t available." sub="It may have been removed." />
          <Button label="See what’s live" onPress={() => router.replace('/')} />
        </View>
      ) : null}
      {game ? (
        <>
          <GameCard game={game} now={now} myId={myId} onChanged={load} defaultOpen onGamePage />
          {game.status === 'ended' || game.status === 'cancelled'
            ? <Button label="See what’s live now" onPress={() => router.replace('/')} />
            : <Text style={s.tip}>Share this page’s link in your group chats to fill the game faster.</Text>}
        </>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 16, paddingBottom: 40, maxWidth: 640, width: '100%', alignSelf: 'center' },
  tip: { color: C.textFaint, fontSize: 12, textAlign: 'center', marginTop: 4 },
});
