import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

// Put these in a .env file at the project root (see .env.example).
// The anon key is safe to ship in the app — the database rules are what protect data.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY — copy .env.example to .env');
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: Platform.OS === 'web' ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Only refresh the login token while the app is on screen (Supabase's recommended RN pattern)
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});

/** Turn a Supabase/Postgres error into a sentence a player can read. */
export function friendlyError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (msg.includes('Failed to fetch') || msg.includes('Network request failed')) return 'No connection. Check your signal and try again.';
  if (msg.includes('JWT') || msg.includes('Not signed in')) return 'Your session expired. Sign in again.';
  return msg;
}
