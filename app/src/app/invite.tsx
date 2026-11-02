import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { goBackOr } from '@/lib/nav';
import { Button, Label } from '@/components/ui';
import { alert } from '@/lib/alert';
import { copyText, gameUrl, shareLink } from '@/lib/share';
import { friendlyError, supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';
import type { CrewMember } from '@/lib/types';

/**
 * Two ways to get people out:
 *  1. Send the link anywhere (iMessage, Instagram, Snap, group chats) — works for people not on the app yet.
 *  2. Ping your crew inside the app — it lands in their Inbox (the bell on the Feed).
 */
export default function Invite() {
  const { gameId } = useLocalSearchParams<{ gameId: string }>();
  const [crew, setCrew] = useState<CrewMember[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('Pickup game');

  useEffect(() => {
    supabase.rpc('get_crew').then(({ data }) =>
      setCrew(((data ?? []) as CrewMember[]).filter((m) => m.status === 'accepted')));
    supabase.rpc('get_game', { p_game_id: gameId }).then(({ data }) => {
      const g = (data as { sport: string; location_name: string; spots_open: number }[] | null)?.[0];
      if (g) setTitle(`${g.sport} at ${g.location_name}${g.spots_open > 0 ? ` — need ${g.spots_open}` : ''}`);
    });
  }, [gameId]);

  const url = gameUrl(gameId);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function share() {
    const r = await shareLink({ title, text: `${title}. Tap to join:`, url });
    if (r === 'copied') alert('Link copied', 'Paste it in any chat.');
  }
  async function copy() {
    const r = await copyText(url);
    if (r === 'copied') alert('Link copied');
    else if (r === 'failed') alert('Copy this link', url);
  }
  async function send() {
    setBusy(true);
    const { data, error } = await supabase.rpc('invite_friends', { p_game_id: gameId, p_friend_ids: picked, p_message: msg || null });
    setBusy(false);
    if (error) return alert('Hmm', friendlyError(error));
    alert('Invite sent', `${data} friend${data === 1 ? '' : 's'} will see it in their Inbox (the 🔔 on the Feed).`);
    goBackOr();
  }

  return (
    <ScrollView style={{ backgroundColor: C.card }} contentContainerStyle={{ padding: 20, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <Label>Send the link anywhere</Label>
      <Text style={s.url} numberOfLines={1} selectable>{url}</Text>
      <View style={s.row}>
        <Button style={{ flex: 1 }} label="Share…" onPress={share} />
        <Button style={{ flex: 1 }} variant="secondary" label="Copy link" onPress={copy} />
      </View>
      <Text style={s.hint}>Works in iMessage, Instagram, Snapchat, group chats — even for people who aren’t on the app yet.</Text>

      <View style={{ height: 24 }} />
      <Label>Or ping your crew in the app</Label>
      {crew && crew.length === 0 ? <Text style={s.hint}>No crew yet — add friends on the Crew tab, or just share the link above.</Text> : null}
      {(crew ?? []).map((m) => (
        <Pressable key={m.user_id} onPress={() => toggle(m.user_id)} style={[s.friend, picked.includes(m.user_id) && s.on]}
          accessibilityRole="checkbox" accessibilityState={{ checked: picked.includes(m.user_id) }}>
          <Text style={{ color: picked.includes(m.user_id) ? C.text : C.textDim, fontSize: 15, fontWeight: '600' }}>{m.display_name}</Text>
          <Text style={{ color: picked.includes(m.user_id) ? C.orange : C.textFaint }}>{picked.includes(m.user_id) ? '✓' : '○'}</Text>
        </Pressable>
      ))}
      {crew && crew.length > 0 ? (
        <>
          <TextInput style={s.input} placeholder="Tryna run? Pull up…" placeholderTextColor={C.textFaint}
            value={msg} onChangeText={setMsg} maxLength={140} multiline accessibilityLabel="Message" />
          <Button label={picked.length ? `Send to ${picked.length}` : 'Pick friends'} onPress={send} disabled={!picked.length} loading={busy} />
          <Text style={s.hint}>Invites show up in their Inbox — the 🔔 at the top of the Feed.</Text>
        </>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  url: { color: C.textMuted, fontSize: 13, backgroundColor: C.cardAlt, borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: C.border },
  row: { flexDirection: 'row', gap: 8 },
  hint: { color: C.textFaint, fontSize: 12, marginTop: 8 },
  friend: { flexDirection: 'row', justifyContent: 'space-between', padding: 14, minHeight: 48, borderRadius: 12, backgroundColor: C.cardAlt, borderWidth: 1.5, borderColor: C.border, marginBottom: 6 },
  on: { borderColor: C.orange, backgroundColor: 'rgba(255,107,53,0.08)' },
  input: { backgroundColor: C.cardAlt, borderWidth: 1.5, borderColor: C.border, borderRadius: 10, color: C.text, padding: 12, fontSize: 14, marginVertical: 12, minHeight: 60 },
});
