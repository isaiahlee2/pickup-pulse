import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TimeField } from '@/components/time-field';
import { Button, Label, NumberField, Pill } from '@/components/ui';
import { useApproxLocation } from '@/hooks/use-location';
import { useLocations } from '@/hooks/use-locations';
import { useUserId } from '@/hooks/use-session';
import { alert } from '@/lib/alert';
import { metersBetween } from '@/lib/geo';
import { friendlyError, supabase } from '@/lib/supabase';
import { C, SKILL_LEVELS, SPORTS, sportIcon } from '@/lib/theme';
import { formatMiles } from '@/lib/units';

type When = 'now' | 'today' | 'tomorrow' | 'day2';
const NEARBY_KM = 5;   // only pre-pick a court if you're actually near it

function nextQuarterHour(offsetMin = 60) {
  const d = new Date(Date.now() + offsetMin * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return d.getHours() * 60 + d.getMinutes();
}
const dayName = (offset: number) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toLocaleDateString([], { weekday: 'long' });
};

export default function Post() {
  const uid = useUserId();
  const locations = useLocations();
  const { coords, permission } = useApproxLocation();
  const { court } = useLocalSearchParams<{ court?: string }>();
  const [sport, setSport] = useState<string>('Basketball');
  const [otherSport, setOtherSport] = useState('');
  const [pickedLoc, setPickedLoc] = useState<string | null>(null);
  const [showAllCourts, setShowAllCourts] = useState(false);
  const [when, setWhen] = useState<When>('now');
  const [minuteOfDay, setMinuteOfDay] = useState(nextQuarterHour());
  const [have, setHave] = useState(2);
  const [need, setNeed] = useState(3);
  const [skill, setSkill] = useState<string>('Any');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  const sportName = sport === 'Other' ? otherSport.trim().replace(/^\w/, (c) => c.toUpperCase()) : sport;

  // Courts nearest you first; courts that list this sport win ties
  const courts = useMemo(() => locations
    .map((l) => ({ ...l, km: metersBetween(coords, l) / 1000, fits: l.sport_types.includes(sport) }))
    .sort((a, b) => Number(b.fits) - Number(a.fits) || a.km - b.km), [locations, coords, sport]);
  const nearestFit = courts.find((c) => c.km <= NEARBY_KM)?.id ?? null;
  // A "Post a game here" link wins, then your own tap, then the nearest court (if you're close)
  const locId = court ?? pickedLoc ?? nearestFit;
  const loc = locations.find((l) => l.id === locId) ?? null;
  const visibleCourts = showAllCourts ? courts : courts.filter((c, i) => i < 3 || c.id === locId);

  const dayOffset = { now: 0, today: 0, tomorrow: 1, day2: 2 }[when];
  const startTime = useMemo(() => {
    const d = new Date(now);
    if (when === 'now') return d;
    d.setDate(d.getDate() + dayOffset);
    d.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
    return d;
  }, [when, minuteOfDay, now, dayOffset]);
  const timeLabel = startTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const inPast = when === 'today' && startTime.getTime() < now;
  const whenLabel = when === 'now' ? 'Now' : `${when === 'today' ? 'Today' : when === 'tomorrow' ? 'Tomorrow' : dayName(2)} ${timeLabel}`;

  const blocker = !loc ? 'Pick a court' : sport === 'Other' && sportName.length < 2 ? 'Type the sport'
    : inPast ? 'That time already passed' : null;

  async function submit() {
    if (!uid || !loc || blocker) return;
    setBusy(true);
    const text = note.trim() || (need > 0 ? `Need ${need} for ${sportName.toLowerCase()}` : `${sportName} — come through`);
    const { data, error } = await supabase.from('games').insert({
      creator_id: uid, location_id: loc.id, location_name: loc.name, location_lat: loc.lat, location_lng: loc.lng,
      sport: sportName, skill_level: skill, note: text, total_players: have, spots_needed: need,
      game_start_time: (when === 'now' ? new Date() : startTime).toISOString(),
    }).select('id').single();
    setBusy(false);
    if (error) return alert('Couldn’t post', friendlyError(error));
    setNote(''); setOtherSport(''); setPickedLoc(null);
    if (court) router.setParams({ court: undefined });
    alert('Posted 🔥', 'Share the link in your group chats to fill it faster.');
    router.push({ pathname: '/game/[id]', params: { id: (data as { id: string }).id } });
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: C.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
          <Text style={s.title}>Post a game</Text>

          <Label>Sport</Label>
          <View style={s.wrap}>
            {SPORTS.map((sp) => <Pill key={sp} label={`${sportIcon(sp)} ${sp}`} active={sport === sp} onPress={() => setSport(sp)} />)}
            <Pill label="🏅 Other" active={sport === 'Other'} onPress={() => setSport('Other')} />
          </View>
          {sport === 'Other' ? (
            <TextInput style={[s.input, { marginTop: -6 }]} value={otherSport} onChangeText={setOtherSport} maxLength={24}
              placeholder="Spikeball, hockey, cricket…" placeholderTextColor={C.textFaint} autoFocus accessibilityLabel="Sport name" />
          ) : null}

          <Label>Where</Label>
          {permission !== 'granted' ? <Text style={[s.dim, { marginTop: -4, marginBottom: 8 }]}>Distances are from campus — turn on location to sort by where you are.</Text> : null}
          <View style={{ marginBottom: 18 }}>
            {visibleCourts.map((l) => (
              <Pressable key={l.id} onPress={() => { setPickedLoc(l.id); if (court) router.setParams({ court: undefined }); }}
                style={[s.loc, locId === l.id && s.on]} accessibilityRole="radio" accessibilityState={{ checked: locId === l.id }}>
                <Text style={{ color: locId === l.id ? C.orange : C.textDim, fontSize: 14, fontWeight: '600', flex: 1 }} numberOfLines={1}>{l.name}</Text>
                <Text style={s.dim}>{l.sport_types.map(sportIcon).join(' ')} · {formatMiles(l.km)}</Text>
              </Pressable>
            ))}
            {courts.length > 3 ? (
              <Pressable onPress={() => setShowAllCourts(!showAllCourts)} hitSlop={8} style={{ paddingVertical: 6 }}>
                <Text style={s.link}>{showAllCourts ? 'Show fewer' : `Show all ${courts.length} courts`}</Text>
              </Pressable>
            ) : null}
          </View>

          <Label>When</Label>
          <View style={s.grid}>
            {([['now', '🟢 Right now'], ['today', 'Later today'], ['tomorrow', 'Tomorrow'], ['day2', dayName(2)]] as [When, string][]).map(([id, text]) => (
              <Pressable key={id} onPress={() => setWhen(id)} style={[s.whenBtn, when === id && s.on]} accessibilityRole="radio" accessibilityState={{ checked: when === id }}>
                <Text style={{ color: when === id ? C.orange : '#888', fontWeight: '600', fontSize: 13 }}>{text}</Text>
              </Pressable>
            ))}
          </View>
          {when !== 'now' ? (
            <View style={{ marginTop: 10 }}>
              <TimeField minuteOfDay={minuteOfDay} onChange={setMinuteOfDay} invalid={inPast} />
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 12, marginVertical: 18 }}>
            <NumberField label="Players there" value={have} onChange={setHave} min={1} hint="Including you" />
            <NumberField label="Players needed" value={need} onChange={setNeed} min={0} />
          </View>

          <Label>Skill level</Label>
          <View style={s.wrap}>{SKILL_LEVELS.map((sk) => <Pill key={sk} label={sk} active={skill === sk} onPress={() => setSkill(sk)} />)}</View>

          <Label>Note (optional)</Label>
          <TextInput style={[s.input, s.note]} multiline maxLength={300} value={note} onChangeText={setNote}
            placeholder="Running 5s, winners stay. Bring a dark shirt." placeholderTextColor={C.textFaint} accessibilityLabel="Note" />
        </ScrollView>

        {/* Always-visible post bar: no scrolling to the bottom to find the button */}
        <View style={s.bar}>
          <Text style={s.summary} numberOfLines={1}>
            {sportIcon(sportName || 'Other')} {sportName || 'Other'} · {loc?.name ?? 'no court yet'} · {whenLabel} · need {need}
          </Text>
          <Button label={blocker ?? 'Post game'} onPress={submit} loading={busy} disabled={!!blocker} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  title: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 16 },
  dim: { color: C.textFaint, fontSize: 12 },
  link: { color: C.textMuted, fontSize: 13, textDecorationLine: 'underline' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, marginBottom: 18 },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, minHeight: 48, borderRadius: 12, backgroundColor: C.cardAlt, borderWidth: 1.5, borderColor: C.border, marginBottom: 6 },
  on: { borderColor: C.orange, backgroundColor: 'rgba(255,107,53,0.08)' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  whenBtn: { flexBasis: '45%', flexGrow: 1, padding: 12, minHeight: 44, borderRadius: 10, borderWidth: 1.5, borderColor: '#252525', backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  input: { backgroundColor: C.card, borderWidth: 1.5, borderColor: '#252525', borderRadius: 10, color: C.text, fontSize: 15, padding: 12, marginBottom: 18 },
  note: { minHeight: 72, textAlignVertical: 'top' },
  bar: { borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, gap: 8 },
  summary: { color: C.textMuted, fontSize: 12, textAlign: 'center' },
});
