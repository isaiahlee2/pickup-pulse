import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { useUserId } from './use-session';

/** Unread DMs for the Crew tab badge — updates live when a message lands or a chat is read. */
export function useUnreadMessages() {
  const uid = useUserId();
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!uid) return;
    const { data, error } = await supabase.rpc('unread_message_count');
    if (!error) setCount((data as number) ?? 0);
  }, [uid]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (!uid) return;
    // New messages to me, and my own "read" updates, both change the count
    const channel = supabase.channel(`dm-badge-${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `recipient_id=eq.${uid}` }, () => { load(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [uid, load]);

  return count;
}
