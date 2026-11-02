import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { useUserId } from './use-session';

/** Unread inbox count for the bell — updates live when an invite or RSVP lands. */
export function useUnreadCount() {
  const uid = useUserId();
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!uid) return;
    const { count: n } = await supabase.from('notifications')
      .select('id', { count: 'exact', head: true }).eq('recipient_id', uid).eq('is_read', false);
    setCount(n ?? 0);
  }, [uid]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (!uid) return;
    const channel = supabase.channel(`inbox-${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${uid}` }, () => { load(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [uid, load]);

  return count;
}
