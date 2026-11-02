import { useCallback, useEffect, useRef, useState } from 'react';

import { friendlyError, supabase } from '@/lib/supabase';
import { isListedSport } from '@/lib/theme';
import { useUserId } from './use-session';
import type { FeedGame } from '@/lib/types';
import type { Coords } from './use-location';

/**
 * Ranked feed that stays live: any change to games or RSVPs (from anyone)
 * triggers a quiet refetch, and a 30-second tick keeps countdowns moving.
 */
export function useFeed(coords: Coords, sport: string) {
  const [games, setGames] = useState<FeedGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useUserId();

  const load = useCallback(async () => {
    if (!uid) return;   // signed-out visitors are on their way to sign-in; don't fire requests that get rejected
    // "Other" = anything typed in that isn't one of the listed sports, so filter that one here
    const { data, error } = await supabase.rpc('get_feed', {
      p_lat: coords.lat, p_lng: coords.lng, p_sport: sport === 'All' || sport === 'Other' ? null : sport,
    });
    if (error) setError(friendlyError(error));
    else {
      const rows = (data ?? []) as FeedGame[];
      setGames(sport === 'Other' ? rows.filter((g) => !isListedSport(g.sport)) : rows);
      setError(null);
    }
    setLoading(false);
  }, [coords.lat, coords.lng, sport, uid]);

  useEffect(() => {
    const t = setTimeout(load, 0);   // after mount, so the first fetch doesn't trigger a cascading render
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!uid) return;
    const refetchSoon = () => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(load, 400);   // batch bursts of changes into one refetch
    };
    const channel = supabase
      .channel('feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, refetchSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rsvps' }, refetchSoon)
      .subscribe();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { supabase.removeChannel(channel); clearInterval(tick); if (debounce.current) clearTimeout(debounce.current); };
  }, [load, uid]);

  return { games, loading, error, now, reload: load };
}
