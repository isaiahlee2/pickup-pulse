import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';

import { Button } from '@/components/ui';
import { useUserId } from '@/hooks/use-session';
import { friendlyError, supabase } from '@/lib/supabase';
import { alert } from '@/lib/alert';
import { copyText, shareLink, siteOrigin } from '@/lib/share';
import { C } from '@/lib/theme';
import type { Conversation, CrewMember } from '@/lib/types';

export default function Crew() {
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [chats, setChats] = useState<Record<string, Conversation>>({});
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const uid = useUserId();
  const [me, setMe] = useState<string | null>(null);   // my own @username, for sharing

  useEffect(() => {
    if (!uid) return;
    supabase.from('users').select('username').eq('id', uid).single()
      .then(({ data }) => setMe((data as { username: string } | null)?.username ?? null));
  }, [uid]);

  async function shareMe() {
    if (!me) return;
    const r = await shareLink({ title: 'Pickup Pulse', text: `Add me on Pickup Pulse — I'm @${me}. We can see each other's games.`, url: siteOrigin() });
    if (r === 'copied') alert('Link copied', 'Paste it in your group chat.');
  }
  async function copyMe() {
    if (!me) return;
    const r = await copyText(`@${me}`);
    alert(r === 'copied' ? 'Copied' : 'Your username', `@${me}`);
  }

  const load = useCallback(async () => {
    const [{ data, error }, convos] = await Promise.all([supabase.rpc('get_crew'), supabase.rpc('get_conversations')]);
    if (!error) setCrew((data ?? []) as CrewMember[]);
    if (!convos.error) setChats(Object.fromEntries(((convos.data ?? []) as Conversation[]).map((c) => [c.friend_id, c])));
    setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // A new message to me → refresh previews/unread
  useEffect(() => {
    if (!uid) return;
    const channel = supabase.channel(`crew-dms-${uid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${uid}` }, () => { load(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [uid, load]);

  async function add() {
    const { data, error } = await supabase.rpc('send_friend_request', { p_username: username.trim().replace(/^@/, '') });
    if (error) return alert('Hmm', friendlyError(error));
    alert(data?.status === 'accepted' ? 'You\'re now crew 🤝' : 'Request sent');
    setUsername(''); load();
  }
  async function respond(m: CrewMember, accept: boolean) {
    const { error } = await supabase.rpc('respond_friend_request', { p_friendship_id: m.friendship_id, p_accept: accept });
    if (error) alert('Hmm', friendlyError(error));
    load();
  }
  function manage(m: CrewMember) {
    alert(m.display_name, `@${m.username}`, [
      { text: 'Remove from crew', onPress: async () => { await supabase.rpc('remove_or_block_friend', { p_user_id: m.user_id, p_block: false }); load(); } },
      { text: 'Block', style: 'destructive', onPress: async () => { await supabase.rpc('remove_or_block_friend', { p_user_id: m.user_id, p_block: true }); load(); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ padding: 16 }}>
        <Text style={s.title}>Your crew</Text>
        <View style={s.addRow}>
          <TextInput style={s.input} placeholder="Add by @username" placeholderTextColor={C.textFaint}
            autoCapitalize="none" value={username} onChangeText={setUsername} onSubmitEditing={add} />
          <Button label="Add" onPress={add} disabled={username.trim().length < 2} style={{ paddingHorizontal: 18 }} />
        </View>
      </View>
      <FlatList
        data={crew}
        keyExtractor={(m) => m.friendship_id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.orange} />}
        ListEmptyComponent={loading ? null : (
          <View style={s.empty}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>👥</Text>
            <Text style={s.emptyTitle}>No crew yet.</Text>
            <Text style={s.emptySub}>Your crew sees when you post or join a game. Send friends your link and have them add you.</Text>
            {me ? (
              <View style={{ width: '100%', gap: 8, marginTop: 18 }}>
                <Button label="Share my invite link" onPress={shareMe} />
                <Button label={`Copy my username · @${me}`} variant="secondary" onPress={copyMe} />
              </View>
            ) : null}
          </View>
        )}
        renderItem={({ item: m }) => {
          const chat = chats[m.user_id];
          const friends = m.status === 'accepted';
          const sub = m.incoming ? 'Wants to join your crew' : m.status === 'pending' ? 'Request sent'
            : chat ? `${chat.last_from_me ? 'You: ' : ''}${chat.last_body}` : m.active_game_label ?? `@${m.username}`;
          return (
            <Pressable
              onPress={() => friends ? router.push({ pathname: '/chat/[id]', params: { id: m.user_id } }) : router.push({ pathname: '/profile/[id]', params: { id: m.user_id } })}
              onLongPress={() => friends && manage(m)}
              style={[s.card, m.status === 'pending' && !m.incoming && { opacity: 0.6 }]}
              accessibilityRole="button" accessibilityLabel={friends ? `Message ${m.display_name}${chat?.unread ? `, ${chat.unread} unread` : ''}` : m.display_name}>
              <Pressable onPress={() => router.push({ pathname: '/profile/[id]', params: { id: m.user_id } })} hitSlop={4}
                accessibilityRole="button" accessibilityLabel={`${m.display_name}'s profile`}>
                <View style={[s.avatar, m.active_game_id && { backgroundColor: 'rgba(255,107,53,0.12)' }]}>
                  <Text style={{ color: m.active_game_id ? C.orange : C.textMuted, fontWeight: '700' }}>{initials(m.display_name)}</Text>
                  {m.active_game_id ? <View style={s.onDot} /> : null}
                </View>
              </Pressable>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.name} numberOfLines={1}>{m.display_name}</Text>
                <Text style={[s.status, chat?.unread ? { color: C.text, fontWeight: '600' } : m.active_game_label && !chat ? { color: C.green } : null]} numberOfLines={1}>
                  {sub}
                </Text>
              </View>
              {m.incoming ? (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Button label="✓" onPress={() => respond(m, true)} style={{ paddingHorizontal: 14 }} />
                  <Button label="✕" variant="secondary" onPress={() => respond(m, false)} style={{ paddingHorizontal: 14 }} />
                </View>
              ) : friends ? (
                chat?.unread ? <View style={s.unread}><Text style={s.unreadText}>{chat.unread > 9 ? '9+' : chat.unread}</Text></View>
                  : <Text style={{ fontSize: 18, opacity: 0.6 }}>💬</Text>
              ) : null}
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  title: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 12 },
  addRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, backgroundColor: C.card, borderWidth: 1.5, borderColor: '#252525', borderRadius: 12, color: C.text, paddingHorizontal: 14, fontSize: 15 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 8 },
  avatar: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  onDot: { position: 'absolute', bottom: -2, right: -2, width: 12, height: 12, borderRadius: 6, backgroundColor: C.green, borderWidth: 2.5, borderColor: C.card },
  name: { color: C.text, fontSize: 15, fontWeight: '600' },
  status: { color: C.textFaint, fontSize: 12, marginTop: 2 },
  unread: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: C.orange, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  unreadText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 12 },
  emptyTitle: { color: C.textDim, fontSize: 15, textAlign: 'center' },
  emptySub: { color: C.textFaint, fontSize: 13, marginTop: 6, textAlign: 'center', lineHeight: 19 },
});
