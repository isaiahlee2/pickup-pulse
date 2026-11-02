import * as Notifications from 'expo-notifications';
import { DarkTheme, router, Stack, ThemeProvider, useGlobalSearchParams, usePathname, useSegments, type ErrorBoundaryProps, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { SessionProvider, useSession } from '@/hooks/use-session';
import { registerForPush } from '@/lib/push';
import { goBackOr } from '@/lib/nav';
import { supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.bg, card: C.bg, primary: C.orange, text: C.text, border: C.border } };

function Gate() {
  const { session, loading } = useSession();
  const segments = useSegments();
  const pathname = usePathname();
  const { next } = useGlobalSearchParams<{ next?: string }>();

  useEffect(() => { if (!loading) SplashScreen.hideAsync(); }, [loading]);

  // Once signed in: register for push + mark active
  useEffect(() => {
    if (!session) return;
    registerForPush(session.user.id);
    supabase.from('users').update({ last_active_at: new Date().toISOString() }).eq('id', session.user.id).then(() => {});
  }, [session]);

  // Tapping a push notification: everything lives on the feed for now
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Notifications.addNotificationResponseReceivedListener(() => { /* feed is the landing screen */ });
    return () => sub.remove();
  }, []);

  const onSignIn = segments[0] === 'sign-in';
  // Someone opening a shared game link signs in first, then lands on that game (not the feed).
  // Only same-site paths are honored, so ?next= can't bounce people to another website.
  const safeNext = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/sign-in') ? next : null;
  // The navigator stays mounted and we redirect inside it — swapping it out for a <Redirect>
  // dropped the shared-game link on the way through sign-in.
  useEffect(() => {
    if (loading) return;
    if (!session && !onSignIn) {
      router.replace((pathname && pathname !== '/' ? { pathname: '/sign-in', params: { next: pathname } } : '/sign-in') as Href);
    } else if (session && onSignIn) {
      router.replace((safeNext ?? '/') as Href);
    }
  }, [loading, session, onSignIn, pathname, safeNext]);

  if (loading) return null;
  const redirecting = (!session && !onSignIn) || (!!session && onSignIn);
  return (
    <>
    <Stack screenOptions={{ headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text, contentStyle: { backgroundColor: C.bg }, headerLeft: BackOrFeed }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="check-in" options={{ presentation: 'modal', title: 'Check in' }} />
      <Stack.Screen name="invite" options={{ presentation: 'modal', title: 'Invite' }} />
      <Stack.Screen name="game/[id]" options={{ title: 'Game' }} />
      <Stack.Screen name="court/[id]" options={{ title: 'Court' }} />
      <Stack.Screen name="inbox" options={{ title: 'Inbox' }} />
      <Stack.Screen name="chat/[id]" options={{ title: 'Chat' }} />
      <Stack.Screen name="profile/[id]" options={{ presentation: 'modal', title: 'Player' }} />
      <Stack.Screen name="report" options={{ presentation: 'modal', title: 'Report' }} />
    </Stack>
    {/* Blank cover for the split second before a redirect lands */}
    {redirecting ? <View style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]} /> : null}
    </>
  );
}

/** Header button on every non-tab screen: back if there's history, otherwise "Feed" (e.g. opened from a shared link). */
function BackOrFeed({ canGoBack }: { canGoBack?: boolean }) {
  return (
    <Pressable onPress={() => goBackOr()} hitSlop={10} style={{ paddingHorizontal: 12, paddingVertical: 6 }}
      accessibilityRole="button" accessibilityLabel={canGoBack ? 'Back' : 'Go to feed'}>
      <Text style={{ color: C.orange, fontSize: 16, fontWeight: '600' }}>{canGoBack ? '‹ Back' : '‹ Feed'}</Text>
    </Pressable>
  );
}

/**
 * If any screen crashes, show this instead of a blank page — with a way back and a line
 * saying what broke, so a screenshot of it tells us exactly where to look.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 40 }}>😵</Text>
      <Text style={{ color: C.text, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>Something went wrong on this screen.</Text>
      <Text style={{ color: C.textFaint, fontSize: 12, textAlign: 'center' }}>{String(error?.message ?? error).slice(0, 200)}</Text>
      <Pressable onPress={() => { router.replace('/'); retry(); }} style={{ backgroundColor: C.orange, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28, marginTop: 8 }}
        accessibilityRole="button">
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Back to the feed</Text>
      </Pressable>
      <Pressable onPress={() => { if (Platform.OS === 'web') window.location.reload(); else retry(); }} hitSlop={8} accessibilityRole="button">
        <Text style={{ color: C.textMuted, textDecorationLine: 'underline', fontSize: 13 }}>Reload</Text>
      </Pressable>
    </View>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <SessionProvider>
        <StatusBar style="light" />
        <Gate />
      </SessionProvider>
    </ThemeProvider>
  );
}
