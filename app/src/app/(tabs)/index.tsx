import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GameCard } from '@/components/game-card';
import { HomeScreenHint } from '@/components/home-screen-hint';
import { StillGoingSheet } from '@/components/still-going-sheet';
import { TrendsList } from '@/components/trends-list';
import { Empty, Pill } from '@/components/ui';
import { useFeed } from '@/hooks/use-feed';
import { useApproxLocation } from '@/hooks/use-location';
import { useUserId } from '@/hooks/use-session';
import { useUnreadCount } from '@/hooks/use-unread';
import { alert } from '@/lib/alert';
import { C, SPORTS, sportIcon } from '@/lib/theme';
import type { FeedGame } from '@/lib/types';

export default function Feed() {
  const [sport, setSport] = useState('All');
  const { coords, permission, refresh } = useApproxLocation();
  const located = permission === 'granted';
  const { games, loading, error, now, reload } = useFeed(coords, sport);
  const myId = useUserId();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const unread = useUnreadCount();

  // One of MY games is waiting on "still going?" → pop the sheet
  const needsAnswer: FeedGame | null = useMemo(
    () => games.find((g) => g.creator_id === myId && g.status === 'check' && g.id !== dismissed) ?? null,
    [games, myId, dismissed]);

  const live = games.filter((g) => g.status === 'live').length;

  async function askForLocation() {
    const ok = await refresh().catch(() => false);
    // Browsers don't re-ask once someone has said no — point them to the setting instead
    if (!ok) {
      alert('Location is off', Platform.OS === 'web'
        ? 'Allow location for this site in your browser settings (on iPhone: Settings → Privacy & Security → Location Services → Safari Websites), then reload.'
        : 'Turn on location for Pickup Pulse in your phone’s Settings.');
    }
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={s.header}>
        <View>
          <Text style={s.brand}>PICKUP PULSE</Text>
          <Text style={s.tagline}>{located ? 'Live games near you' : 'Live games near OSU'}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={s.liveBadge}><View style={s.liveDot} /><Text style={s.liveText}>{live} Live</Text></View>
          <Pressable onPress={() => router.push('/inbox')} style={s.bell} hitSlop={6}
            accessibilityRole="button" accessibilityLabel={unread ? `Inbox, ${unread} unread` : 'Inbox'}>
            <Text style={{ fontSize: 20 }}>🔔</Text>
            {unread ? <View style={s.badge}><Text style={s.badgeText}>{unread > 9 ? '9+' : unread}</Text></View> : null}
          </Pressable>
        </View>
      </View>
      <HomeScreenHint />
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          {['All', ...SPORTS, 'Other'].map((sp) => (
            <Pill key={sp} label={sp === 'All' ? 'All' : `${sportIcon(sp)} ${sp}`} active={sport === sp} onPress={() => setSport(sp)} />
          ))}
        </ScrollView>
      </View>

      {!located && permission !== 'unknown' ? (
        <Pressable onPress={askForLocation} style={s.locRow} accessibilityRole="button">
          <Text style={s.locText}>📍 Distances are from campus. <Text style={s.locLink}>Use my location</Text></Text>
        </Pressable>
      ) : null}
      <FlatList
        data={games}
        keyExtractor={(g) => g.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.orange} />}
        renderItem={({ item }) => <GameCard game={item} now={now} myId={myId} onChanged={reload} fromCampus={!located} />}
        ListHeaderComponent={error ? <Text style={s.error}>{error}</Text> : null}
        ListEmptyComponent={loading ? null : (
          <View>
            <Empty icon="🏟️" title={`No active ${sport === 'All' ? '' : sport + ' '}games right now.`} sub="Post one — up to 2 days out." />
            <TrendsList sport={sport} />
          </View>
        )}
      />
      <StillGoingSheet key={needsAnswer?.id ?? 'none'} game={needsAnswer} onDone={() => { if (needsAnswer) setDismissed(needsAnswer.id); reload(); }} />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8 },
  brand: { color: C.orange, fontSize: 24, fontWeight: '800', letterSpacing: -1 },
  tagline: { color: C.textMuted, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 },
  locRow: { paddingHorizontal: 20, paddingBottom: 8, marginTop: -4 },
  locText: { color: C.textFaint, fontSize: 12 },
  locLink: { color: C.orange, textDecorationLine: 'underline' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a1a', borderColor: C.borderStrong, borderWidth: 1, borderRadius: 12, paddingVertical: 6, paddingHorizontal: 12 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.green, marginRight: 6 },
  liveText: { color: C.green, fontSize: 12, fontWeight: '600' },
  bell: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: C.orange, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  error: { color: C.red, backgroundColor: C.redTint, padding: 12, borderRadius: 10, marginBottom: 12 },
});
