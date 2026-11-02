import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Empty } from '@/components/ui';
import { alert } from '@/lib/alert';
import { friendlyError, supabase } from '@/lib/supabase';
import { C, sportIcon } from '@/lib/theme';
import type { PlayerProfile } from '@/lib/types';

/**
 * Enough to judge "is this a real player?" — how long they've been around, games posted and
 * joined, verified check-ins. Never shown: where they live, which courts they go to, or when.
 */
export default function Profile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [p, setP] = useState<PlayerProfile | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('get_profile', { p_user_id: id });
    setP(((data ?? []) as PlayerProfile[])[0] ?? null);
  }, [id]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  if (p === undefined) return <ActivityIndicator color={C.orange} style={{ marginTop: 40 }} />;
  if (p === null) return <Empty icon="🤷" title="Player not found." />;

  const act = async (fn: () => PromiseLike<{ error: unknown }>) => {
    setBusy(true); const { error } = await fn(); setBusy(false);
    if (error) alert('Hmm', friendlyError(error)); else load();
  };
  const addOrAccept = () => act(() => supabase.rpc('send_friend_request', { p_username: p.username }));
  const block = () => alert(`Block ${p.display_name}?`, 'You won’t see their games, and they can’t add you.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Block', style: 'destructive', onPress: () => act(() => supabase.rpc('remove_or_block_friend', { p_user_id: p.user_id, p_block: true })) },
  ]);
  const unblock = () => act(() => supabase.rpc('remove_or_block_friend', { p_user_id: p.user_id, p_block: false }));

  const since = new Date(p.member_since).toLocaleDateString([], { month: 'short', year: 'numeric' });
  const stats: [string, number][] = [['Games posted', p.games_posted], ['Games joined', p.games_joined], ['Verified check-ins', p.verified_checkins]];

  return (
    <ScrollView style={{ backgroundColor: C.card }} contentContainerStyle={s.wrap}>
      <View style={s.avatar}><Text style={s.initials}>{p.display_name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</Text></View>
      <Text style={s.name}>{p.display_name}</Text>
      <Text style={s.dim}>@{p.username} · on Pickup Pulse since {since}</Text>
      {p.preferred_sports.length ? <Text style={s.sports}>{p.preferred_sports.map((x) => `${sportIcon(x)} ${x}`).join('  ')}</Text> : null}

      <View style={s.stats}>
        {stats.map(([k, v]) => <View key={k} style={s.stat}><Text style={s.statV}>{v}</Text><Text style={s.statK}>{k}</Text></View>)}
      </View>
      <Text style={s.note}>Verified check-ins mean they were actually at the court (GPS-checked). New accounts start at zero.</Text>

      {p.relation === 'me' ? <Button variant="secondary" label="Edit my profile" onPress={() => router.push('/me')} /> : null}
      {p.relation === 'none' ? <Button label="Add to crew" onPress={addOrAccept} loading={busy} /> : null}
      {p.relation === 'incoming' ? <Button label="Accept crew request" onPress={addOrAccept} loading={busy} /> : null}
      {p.relation === 'requested' ? <Button variant="secondary" label="Request sent" onPress={() => {}} disabled /> : null}
      {p.relation === 'friends' ? <Text style={s.crew}>🤝 In your crew</Text> : null}
      {p.relation === 'friends' ? <Button label="Message" onPress={() => router.push({ pathname: '/chat/[id]', params: { id: p.user_id } })} /> : null}
      {p.relation === 'blocked' ? <Button variant="secondary" label="Unblock" onPress={unblock} loading={busy} /> : null}

      {p.relation !== 'me' ? (
        <View style={s.row}>
          {p.relation !== 'blocked' ? <Button style={{ flex: 1 }} variant="danger" label="Block" onPress={block} /> : null}
          <Button style={{ flex: 1 }} variant="danger" label="Report" onPress={() => router.push({ pathname: '/report', params: { userId: p.user_id } })} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 20, paddingBottom: 40, alignItems: 'stretch', maxWidth: 520, width: '100%', alignSelf: 'center' },
  avatar: { width: 72, height: 72, borderRadius: 20, backgroundColor: 'rgba(255,107,53,0.12)', alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  initials: { color: C.orange, fontSize: 26, fontWeight: '800' },
  name: { color: C.text, fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 10 },
  dim: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 2 },
  sports: { color: C.textDim, fontSize: 13, textAlign: 'center', marginTop: 8 },
  stats: { flexDirection: 'row', gap: 8, marginTop: 18 },
  stat: { flex: 1, backgroundColor: C.cardAlt, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 12, alignItems: 'center' },
  statV: { color: C.orange, fontSize: 22, fontWeight: '800' },
  statK: { color: C.textMuted, fontSize: 11, textAlign: 'center', marginTop: 2 },
  note: { color: C.textFaint, fontSize: 12, marginTop: 10, marginBottom: 16, textAlign: 'center' },
  crew: { color: C.green, fontSize: 15, fontWeight: '700', textAlign: 'center', paddingVertical: 10 },
  row: { flexDirection: 'row', gap: 8, marginTop: 10 },
});
