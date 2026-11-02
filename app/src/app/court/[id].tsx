import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { GameCard } from '@/components/game-card';
import { TrendsList } from '@/components/trends-list';
import { Button, Empty } from '@/components/ui';
import { useFeed } from '@/hooks/use-feed';
import { useApproxLocation } from '@/hooks/use-location';
import { useUserId } from '@/hooks/use-session';
import { alert } from '@/lib/alert';
import { courtUrl, openDirections, shareLink } from '@/lib/share';
import { supabase } from '@/lib/supabase';
import { C, sportIcon } from '@/lib/theme';
import type { Location } from '@/lib/types';

/**
 * One court's page — what a QR sign at the court would open:
 * who's playing here now, when it's usually busy, and one tap to post a game here.
 */
export default function CourtPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const myId = useUserId();
  const { coords, permission } = useApproxLocation();
  const { games, now, reload } = useFeed(coords, 'All');
  const [court, setCourt] = useState<Location | null | undefined>(undefined);

  useEffect(() => {
    if (!myId) return;
    supabase.from('locations').select('id, name, lat, lng, sport_types, is_indoor').eq('id', id).maybeSingle()
      .then(({ data }) => setCourt((data as Location | null) ?? null));
  }, [id, myId]);

  const here = games.filter((g) => g.location_id === id);
  if (court === null) return <Empty icon="🤷" title="Court not found." />;
  if (!court) return null;

  const share = async () => {
    const r = await shareLink({ title: court.name, text: `Who’s playing at ${court.name}?`, url: courtUrl(court.id) });
    if (r === 'copied') alert('Link copied');
  };

  return (
    <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={s.wrap}>
      <Stack.Screen options={{ title: court.name }} />
      <Text style={s.title}>{court.name}</Text>
      <Text style={s.sub}>{court.sport_types.map((x) => `${sportIcon(x)} ${x}`).join('  ')}{court.is_indoor ? '  · Indoor' : ''}</Text>
      <View style={s.row}>
        <Button style={{ flex: 1 }} label="Post a game here" onPress={() => router.push({ pathname: '/post', params: { court: court.id } })} />
      </View>
      <View style={s.row}>
        <Button style={{ flex: 1 }} variant="secondary" label="Directions" onPress={() => openDirections(court.lat, court.lng, court.name)} />
        <Button style={{ flex: 1 }} variant="secondary" label="Share court" onPress={share} />
      </View>

      <Text style={s.h}>{here.length ? `Happening here (${here.length})` : 'Nothing posted here right now'}</Text>
      {here.map((g) => <GameCard key={g.id} game={g} now={now} myId={myId} onChanged={reload} fromCampus={permission !== 'granted'} />)}
      {!here.length ? <Empty icon="🏟️" title="Be the first — post a game here." /> : null}
      <TrendsList sport="All" locationId={court.id} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 16, paddingBottom: 40, maxWidth: 640, width: '100%', alignSelf: 'center' },
  title: { color: C.text, fontSize: 24, fontWeight: '800' },
  sub: { color: C.textMuted, fontSize: 13, marginTop: 4, marginBottom: 14 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  h: { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 18, marginBottom: 10 },
});
