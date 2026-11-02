import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { alert } from '@/lib/alert';
import { formatStart, glow, timerBar } from '@/lib/game-time';
import { gameUrl, openDirections, shareLink } from '@/lib/share';
import { friendlyError, supabase } from '@/lib/supabase';
import { C, sportIcon } from '@/lib/theme';
import type { FeedGame } from '@/lib/types';
import { formatMiles } from '@/lib/units';
import { PlayersList } from './players-list';
import { Button, Tag } from './ui';

const ETAS = [
  { label: 'I’m here', min: 0 },
  { label: '~5 min', min: 5 },
  { label: '~15 min', min: 15 },
  { label: '~30 min', min: 30 },
];

export function GameCard({ game: g, now, myId, onChanged, defaultOpen = false, onGamePage = false, fromCampus = false }: {
  game: FeedGame; now: number; myId: string | null; onChanged: () => void; defaultOpen?: boolean; onGamePage?: boolean;
  /** No location permission → distances are measured from OSU, so say so */
  fromCampus?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [askEta, setAskEta] = useState(false);
  const [bump, setBump] = useState(0);
  const mine = g.creator_id === myId;
  const active = g.status === 'upcoming' || g.status === 'live' || g.status === 'check';
  const bar = timerBar(g, now);
  const gl = glow(g.checkin_count);
  const inGame = g.my_rsvp === 'confirmed' || g.my_rsvp === 'waitlisted';
  const dist = formatMiles(g.distance_km);
  const miles = dist && fromCampus ? `${dist} from campus` : dist;
  const checkInOpen = active && (g.status !== 'upcoming' || new Date(g.game_start_time).getTime() - now < 30 * 60_000);

  const statusLine = {
    upcoming: { color: C.blue, text: formatStart(g.game_start_time) },
    live: { color: C.green, text: 'Happening now' },
    check: { color: C.amber, text: 'Still going?' },
    ended: { color: C.textFaint, text: 'Ended' },
    cancelled: { color: C.textFaint, text: 'Cancelled' },
  }[g.status];

  async function run(key: string, fn: () => PromiseLike<{ data: unknown; error: unknown }>, success?: (d: any) => string | null) {
    setBusy(key);
    const { data, error } = await fn();
    setBusy(null);
    if (error) return alert('Hmm', friendlyError(error));
    const msg = success?.(data);
    if (msg) alert(msg);
    setBump((b) => b + 1);
    onChanged();
  }

  const join = (eta: number | null) => {
    setAskEta(false);
    return run('join', () => supabase.rpc('rsvp_join', eta === null ? { p_game_id: g.id } : { p_game_id: g.id, p_eta_minutes: eta }),
      (d) => d?.status === 'waitlisted' ? 'Game’s full — you’re on the waitlist. You’ll get a notification if a spot opens.' : null);
  };
  // Live games ask "when will you get there?"; games that haven't started just need a yes
  const tapIn = () => (g.status === 'upcoming' ? join(null) : setAskEta(true));
  const leave = () => run('leave', () => supabase.rpc('rsvp_cancel', { p_game_id: g.id }));
  const end = () => alert(g.status === 'upcoming' ? 'Cancel this game?' : 'End this game?',
    'It comes off the feed for everyone.', [
      { text: 'Keep it', style: 'cancel' },
      { text: g.status === 'upcoming' ? 'Cancel game' : 'End game', style: 'destructive',
        onPress: () => run('end', () => supabase.rpc('end_game', { p_game_id: g.id })) },
    ]);
  const share = async () => {
    const when = g.status === 'upcoming' ? formatStart(g.game_start_time) : 'right now';
    const need = g.spots_open > 0 ? `need ${g.spots_open}` : 'full';
    const r = await shareLink({
      title: `${g.sport} at ${g.location_name}`,
      text: `${g.sport} at ${g.location_name}, ${when} — ${need}. Tap to join:`,
      url: gameUrl(g.id),
    });
    if (r === 'copied') alert('Link copied', 'Paste it in any chat.');
    if (r === 'failed') alert('Couldn’t share', gameUrl(g.id));
  };

  return (
    <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}
      style={[s.card, { borderColor: open ? C.orange : gl.borderColor, shadowOpacity: gl.shadowOpacity, shadowRadius: gl.shadowRadius, elevation: gl.elevation }, !active && { opacity: 0.7 }]}>
      <View style={s.row}>
        <View style={s.icon}><Text style={{ fontSize: 22 }}>{sportIcon(g.sport)}</Text></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Pressable onPress={() => g.location_id && router.push({ pathname: '/court/[id]', params: { id: g.location_id } })} hitSlop={4}>
            <Text style={s.loc} numberOfLines={1}>{g.location_name}</Text>
          </Pressable>
          <View style={[s.row, { marginTop: 2, flexWrap: 'wrap' }]}>
            <View style={[s.dot, { backgroundColor: statusLine.color }]} />
            <Text style={{ color: statusLine.color, fontSize: 12, fontWeight: g.status === 'check' ? '700' : '500' }}>{statusLine.text}</Text>
            {miles ? <Text style={s.meta}> · {miles}</Text> : null}
            <Text style={s.meta}> · </Text>
            <Pressable onPress={() => router.push({ pathname: '/profile/[id]', params: { id: g.creator_id } })} hitSlop={6}
              accessibilityRole="link" accessibilityLabel={`Posted by ${mine ? 'you' : g.creator_name}. View profile`}>
              <Text style={[s.meta, s.who]}>{mine ? 'you' : g.creator_name}</Text>
            </Pressable>
          </View>
        </View>
        <Text style={[s.need, g.spots_open > 0 ? { backgroundColor: C.orangeTint, color: C.orange } : { backgroundColor: C.redTint, color: C.red }]}>
          {g.spots_open > 0 ? `Need ${g.spots_open}` : 'Full'}
        </Text>
      </View>

      <Text style={s.note}>“{g.note}”</Text>
      {g.extend_reason ? <Text style={s.ext}>Extended: {g.extend_reason}</Text> : null}

      <View style={s.tags}>
        <Tag text={g.skill_level} />
        <Tag text={g.current_rsvps > 0 ? `${g.total_players} there · ${g.current_rsvps} joined` : `${g.total_players} there`} />
        {g.is_verified ? <Tag text="✓ Verified" tone="green" /> : null}
        {g.checkin_count >= 3 ? <Tag text={`🔥 ${g.checkin_count} check-ins`} tone="indigo" /> : null}
        {g.friend_involved ? <Tag text="👥 Crew’s in" tone="orange" /> : null}
        {g.my_rsvp === 'confirmed' ? <Tag text="You’re in" tone="green" /> : null}
        {g.my_rsvp === 'waitlisted' ? <Tag text="Waitlisted" /> : null}
      </View>

      {bar ? (
        <View style={[s.row, { marginTop: 10, paddingLeft: 54 }]}>
          <View style={s.track}><View style={{ width: `${Math.round(bar.pct * 100)}%`, height: '100%', backgroundColor: bar.color, borderRadius: 2 }} /></View>
          <Text style={[s.meta, { marginLeft: 8, color: g.status === 'upcoming' ? C.blue : C.textFaint }]}>{bar.label}</Text>
        </View>
      ) : null}

      {open ? (
        <View>
          {askEta ? (
            <View style={s.etaBox}>
              <Text style={s.etaQ}>When will you get there?</Text>
              <View style={s.etaRow}>
                {ETAS.map((e) => (
                  <Pressable key={e.min} style={s.etaChip} onPress={() => join(e.min)} accessibilityRole="button">
                    <Text style={s.etaText}>{e.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable onPress={() => setAskEta(false)} hitSlop={8}><Text style={s.linkTxt}>Cancel</Text></Pressable>
            </View>
          ) : active ? (
            <View style={s.actions}>
              {!mine && !inGame ? <Button style={s.full} variant={g.status === 'upcoming' ? 'blue' : 'primary'}
                label={g.spots_open > 0 ? (g.status === 'upcoming' ? 'I’m down' : 'I’m in') : 'Join waitlist'} loading={busy === 'join'} onPress={tapIn} /> : null}
              {checkInOpen ? <Button style={s.half} variant="secondary" label="📍 Check in" onPress={() => router.push({ pathname: '/check-in', params: { gameId: g.id } })} /> : null}
              <Button style={s.half} variant="secondary" label="Directions" onPress={() => openDirections(g.location_lat, g.location_lng, g.location_name)} />
              <Button style={s.half} variant="secondary" label="Share link" onPress={share} />
              <Button style={s.half} variant="secondary" label="Invite crew" onPress={() => router.push({ pathname: '/invite', params: { gameId: g.id } })} />
              {!mine && inGame && g.status !== 'upcoming' ? <Button style={s.half} variant="secondary" label="Update ETA" onPress={() => setAskEta(true)} /> : null}
              {!mine && inGame ? <Button style={s.half} variant="danger" label="Leave" loading={busy === 'leave'} onPress={leave} /> : null}
              {mine ? <Button style={s.half} variant="danger" label={g.status === 'upcoming' ? 'Cancel game' : 'End game'} loading={busy === 'end'} onPress={end} /> : null}
            </View>
          ) : (
            <Text style={[s.meta, { marginTop: 12 }]}>This game is over.</Text>
          )}

          <PlayersList gameId={g.id} gameStatus={g.status} now={now} myId={myId}
            version={`${g.current_rsvps}-${g.checkin_count}-${g.status}-${bump}`} />

          <View style={s.footer}>
            {!onGamePage ? (
              <Pressable onPress={() => router.push({ pathname: '/game/[id]', params: { id: g.id } })} hitSlop={8}><Text style={s.linkTxt}>Game page</Text></Pressable>
            ) : <View />}
            {!mine ? (
              <Pressable onPress={() => router.push({ pathname: '/report', params: { gameId: g.id, userId: g.creator_id } })} hitSlop={8}>
                <Text style={s.linkTxt}>Report</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 12, shadowColor: C.orange, shadowOffset: { width: 0, height: 0 } },
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(255,107,53,0.08)', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  loc: { color: C.text, fontSize: 15, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  meta: { color: C.textMuted, fontSize: 12 },
  who: { textDecorationLine: 'underline', color: C.textDim },
  need: { fontSize: 12, fontWeight: '700', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, overflow: 'hidden', marginLeft: 8 },
  note: { color: '#ccc', fontSize: 14, lineHeight: 21, marginTop: 12, paddingLeft: 54 },
  ext: { color: C.amber, fontSize: 12, fontStyle: 'italic', marginTop: 6, paddingLeft: 54 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, paddingLeft: 54 },
  track: { flex: 1, height: 3, borderRadius: 2, backgroundColor: '#1a1a1a', overflow: 'hidden' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border },
  full: { flexBasis: '100%' },
  half: { flexGrow: 1, flexBasis: '45%' },
  etaBox: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border, gap: 10 },
  etaQ: { color: C.text, fontSize: 15, fontWeight: '700' },
  etaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  etaChip: { flexGrow: 1, flexBasis: '45%', minHeight: 44, borderRadius: 12, backgroundColor: C.orange, alignItems: 'center', justifyContent: 'center' },
  etaText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  linkTxt: { color: C.textMuted, fontSize: 13, textDecorationLine: 'underline', paddingVertical: 4 },
});
