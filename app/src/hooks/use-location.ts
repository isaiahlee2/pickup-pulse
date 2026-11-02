import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';

import { OSU } from '@/lib/theme';
import { useUserId } from './use-session';

export type Coords = { lat: number; lng: number };

/** Rough location for the feed. Falls back to OSU if permission is denied, so the app still works. */
export function useApproxLocation() {
  const [coords, setCoords] = useState<Coords>(OSU);
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const uid = useUserId();

  const refresh = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') { setPermission('denied'); return false; }
    setPermission('granted');
    const last = await Location.getLastKnownPositionAsync();
    if (last) setCoords({ lat: last.coords.latitude, lng: last.coords.longitude });
    const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    setCoords({ lat: fresh.coords.latitude, lng: fresh.coords.longitude });
    return true;
  }, []);

  useEffect(() => {
    if (!uid) return;   // don't ask for location before they've even signed in
    const t = setTimeout(() => { refresh().catch(() => setPermission('denied')); }, 0);
    return () => clearTimeout(t);
  }, [refresh, uid]);
  return { coords, permission, refresh };
}

/**
 * Precise fix for check-ins. Waits for a reading good to ±50 m (or gives the best one after ~10 s),
 * because a single cold GPS read can be off by hundreds of meters and fail a legit check-in.
 */
export async function getPreciseFix(): Promise<{ lat: number; lng: number; accuracy: number }> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Location permission is needed to check in.');

  let best: Location.LocationObject | null = null;
  const sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Highest, timeInterval: 1000, distanceInterval: 0 },
    (loc) => { if (!best || (loc.coords.accuracy ?? 999) < (best.coords.accuracy ?? 999)) best = loc; },
  );
  const started = Date.now();
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const acc = best?.coords.accuracy ?? 999;
      if (acc <= 50 || Date.now() - started > 10_000) { clearInterval(iv); resolve(); }
    }, 500);
  });
  sub.remove();

  const fix = (best as Location.LocationObject | null) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }));
  return { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: Math.round(fix.coords.accuracy ?? 999) };
}
