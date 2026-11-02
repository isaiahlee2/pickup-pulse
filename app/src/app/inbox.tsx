import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Empty } from '@/components/ui';
import { useUserId } from '@/hooks/use-session';
import { timeAgo } from '@/lib/game-time';
import { supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';
import type { InboxItem, NotificationType } from '@/lib/types';

const ICON: Record<NotificationType, string> = {
  nearby_game: '📍', friend_invite: '👀', friend_request: '👥', friend_accepted: '🤝', still_going_ping: '⏰',
  rsvp_update: '🙌', game_starting: '🟢', game_verified: '✓', game_full: '🔥', game_ended: '✕',
};

/** Everything that was "sent" to you: crew invites, RSVPs on your games, nearby games, requests. */
export default function Inbox() {
  const uid = useUserId();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.rpc('get_inbox', { p_limit: 60 });
    setItems((data ?? []) as InboxItem[]);
    setNow(Date.now());
    setLoading(false);
    // Opening the inbox counts as reading it (the dots stay until you leave)
    if (uid) await supabase.from('notifications').update({ is_read: true }).eq('recipient_id', uid).eq('is_read', false);
  }, [uid]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const open = (n: InboxItem) => {
    if (n.game_id) router.push({ pathname: '/game/[id]', params: { id: n.game_id } });
    else if (n.type === 'friend_request' || n.type === 'friend_accepted') router.push('/crew');
  };

  return (
    <FlatList
      style={{ backgroundColor: C.bg }}
      data={items ?? []}
      keyExtractor={(n) => n.id}
      contentContainerStyle={{ padding: 16, paddingBottom: 40, maxWidth: 640, width: '100%', alignSelf: 'center' }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.orange} />}
      ListEmptyComponent={items ? <Empty icon="📭" title="Nothing yet." sub="Crew invites, players joining your games, and games near you show up here." /> : null}
      renderItem={({ item: n }) => {
        const over = n.game_status === 'ended' || n.game_status === 'cancelled';
        return (
          <Pressable onPress={() => open(n)} style={[s.row, !n.is_read && s.unread]} accessibilityRole="button">
            <Text style={s.icon}>{ICON[n.type] ?? '•'}</Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.title} numberOfLines={2}>{n.title}</Text>
              <Text style={s.body} numberOfLines={2}>{n.body}{over ? ' · game over' : ''}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              <Text style={s.time}>{timeAgo(n.created_at, now)}</Text>
              {!n.is_read ? <View style={s.dot} /> : null}
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 8, minHeight: 56 },
  unread: { borderColor: 'rgba(255,107,53,0.35)' },
  icon: { fontSize: 20, width: 28, textAlign: 'center', color: C.green },
  title: { color: C.text, fontSize: 14, fontWeight: '600' },
  body: { color: C.textMuted, fontSize: 13, marginTop: 2 },
  time: { color: C.textFaint, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.orange },
});
