import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { Location } from '@/lib/types';
import { useUserId } from './use-session';

export function useLocations() {
  const [locations, setLocations] = useState<Location[]>([]);
  const uid = useUserId();
  useEffect(() => {
    if (!uid) return;
    supabase.from('locations').select('id, name, lat, lng, sport_types, is_indoor').order('name')
      .then(({ data }) => setLocations((data ?? []) as Location[]));
  }, [uid]);
  return locations;
}
