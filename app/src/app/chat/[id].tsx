import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Empty } from '@/components/ui';
import { useUserId } from '@/hooks/use-session';
import { alert } from '@/lib/alert';
import { timeAgo } from '@/lib/game-time';
import { friendlyError, supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';
import type { ChatMessage, PlayerProfile } from '@/lib/types';

const PAGE = 50;

/** A DM thread with one crew member. Friends only — the database enforces it, this screen just explains it. */
export default function Chat() {
  const { id: friendId } = useLocalSearchParams<{ id: string }>();
  const myId = useUserId();
  const [friend, setFriend] = useState<PlayerProfile | null | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);   // newest first (list is inverted)
  const [more, setMore] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const loadingOlder = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  const loadLatest = useCallback(async () => {
    if (!myId || !friendId) return;
    const { data } = await supabase.rpc('get_messages', { p_friend: friendId, p_limit: PAGE });
    const rows = (data ?? []) as ChatMessage[];
    // Keep any older pages already loaded; replace the newest page
    setMessages((prev) => {
      if (!prev || prev.length <= PAGE) return rows;
      const ids = new Set(rows.map((m) => m.id));
      return [...rows, ...prev.filter((m) => !ids.has(m.id))];
    });
    if (rows.some((m) => !m.from_me && !m.read_at)) supabase.rpc('mark_messages_read', { p_friend: friendId }).then(() => {});
  }, [myId, friendId]);

  useEffect(() => {
    if (!myId || !friendId) return;
    supabase.rpc('get_profile', { p_user_id: friendId })
      .then(({ data }) => setFriend(((data ?? []) as PlayerProfile[])[0] ?? null));
    const t = setTimeout(loadLatest, 0);
    // Their new messages arrive live (only the two people in a chat can receive its messages)
    const channel = supabase.channel(`dm-${myId}-${friendId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${myId}` },
        (payload) => { if ((payload.new as { sender_id?: string }).sender_id === friendId) loadLatest(); })
      .subscribe();
    return () => { clearTimeout(t); supabase.removeChannel(channel); };
  }, [myId, friendId, loadLatest]);

  async function loadOlder() {
    if (!messages?.length || !more || loadingOlder.current) return;
    loadingOlder.current = true;
    const before = messages[messages.length - 1].created_at;
    const { data } = await supabase.rpc('get_messages', { p_friend: friendId, p_before: before, p_limit: PAGE });
    const rows = (data ?? []) as ChatMessage[];
    setMessages((prev) => { const ids = new Set((prev ?? []).map((m) => m.id)); return [...(prev ?? []), ...rows.filter((m) => !ids.has(m.id))]; });
    if (rows.length < PAGE) setMore(false);
    loadingOlder.current = false;
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const { error } = await supabase.rpc('send_message', { p_to: friendId, p_body: body });
    setSending(false);
    if (error) return alert('Couldn’t send', friendlyError(error));
    setText('');
    loadLatest();
  }

  if (friend === null) return <Empty icon="🤷" title="This player isn’t available." />;
  const canSend = friend?.relation === 'friends';

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{
        title: friend?.display_name ?? 'Chat',
        headerRight: () => friend ? (
          <Pressable onPress={() => router.push({ pathname: '/profile/[id]', params: { id: friend.user_id } })} hitSlop={10}
            style={{ paddingHorizontal: 12 }} accessibilityRole="button" accessibilityLabel={`${friend.display_name}'s profile`}>
            <Text style={{ color: C.textMuted, fontSize: 14 }}>Profile</Text>
          </Pressable>
        ) : null,
      }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90} style={{ flex: 1 }}>
        {messages === null ? <ActivityIndicator color={C.orange} style={{ marginTop: 40 }} /> : (
          <FlatList
            inverted
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ padding: 16, gap: 6, flexGrow: 1 }}
            onEndReached={loadOlder}
            onEndReachedThreshold={0.3}
            ListEmptyComponent={
              <View style={{ transform: [{ scaleY: -1 }] }}>
                <Empty icon="💬" title={`Say what’s up to ${friend?.display_name ?? 'your friend'}.`}
                  sub="Only the two of you can see this chat." />
              </View>
            }
            renderItem={({ item: m, index }) => {
              // Show a timestamp under the last message of a run from the same person
              const newer = messages[index - 1];
              const showTime = !newer || newer.from_me !== m.from_me
                || new Date(newer.created_at).getTime() - new Date(m.created_at).getTime() > 10 * 60_000;
              return (
                <View style={{ alignItems: m.from_me ? 'flex-end' : 'flex-start' }}>
                  <View style={[s.bubble, m.from_me ? s.mine : s.theirs]}>
                    <Text style={{ color: m.from_me ? '#fff' : C.text, fontSize: 15, lineHeight: 20 }}>{m.body}</Text>
                  </View>
                  {showTime ? (
                    <Text style={s.time}>{timeAgo(m.created_at, now)}{m.from_me && newer === undefined && m.read_at ? ' · Seen' : ''}</Text>
                  ) : null}
                </View>
              );
            }}
          />
        )}

        {canSend ? (
          <View style={s.bar}>
            <TextInput style={s.input} value={text} onChangeText={setText} placeholder="Message" placeholderTextColor={C.textFaint}
              multiline maxLength={1000} accessibilityLabel="Message"
              onKeyPress={(e) => {
                // Laptop: Enter sends, Shift+Enter adds a line
                const ev = e.nativeEvent as { key: string; shiftKey?: boolean };
                if (Platform.OS === 'web' && ev.key === 'Enter' && !ev.shiftKey) { (e as unknown as { preventDefault?: () => void }).preventDefault?.(); send(); }
              }} />
            <Pressable onPress={send} disabled={!text.trim() || sending} style={[s.send, (!text.trim() || sending) && { opacity: 0.4 }]}
              accessibilityRole="button" accessibilityLabel="Send">
              {sending ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>Send</Text>}
            </Pressable>
          </View>
        ) : friend ? (
          <Text style={s.closed}>
            {friend.relation === 'blocked' ? 'You blocked this player.' : 'You can message people once you’re in each other’s crew.'}
          </Text>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  bubble: { maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18 },
  mine: { backgroundColor: C.orange, borderBottomRightRadius: 6 },
  theirs: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderBottomLeftRadius: 6 },
  time: { color: C.textFaint, fontSize: 11, marginTop: 3, marginHorizontal: 6 },
  bar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },
  input: { flex: 1, minHeight: 42, maxHeight: 120, backgroundColor: C.card, borderWidth: 1.5, borderColor: '#252525', borderRadius: 21,
    color: C.text, fontSize: 16, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10 },
  send: { height: 42, paddingHorizontal: 18, borderRadius: 21, backgroundColor: C.orange, alignItems: 'center', justifyContent: 'center' },
  closed: { color: C.textMuted, fontSize: 13, textAlign: 'center', padding: 16, borderTopWidth: 1, borderTopColor: C.border },
});
