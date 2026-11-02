import { useCallback, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';

import { Button, Label, Pill } from '@/components/ui';
import { getPreciseFix } from '@/hooks/use-location';
import { useUserId } from '@/hooks/use-session';
import { friendlyError, supabase } from '@/lib/supabase';
import { alert } from '@/lib/alert';
import { C, SPORTS, sportIcon } from '@/lib/theme';
import { kmToMi, miToKm } from '@/lib/units';

type Profile = { username: string; display_name: string; preferred_sports: string[]; total_checkins: number; total_games_posted: number };
type Settings = { home_lat: number | null; home_lng: number | null; notify_nearby_games: boolean; notify_friends: boolean; notify_still_going: boolean; notify_radius_km: number; push_token: string | null };

export default function Me() {
  const uid = useUserId();
  const [p, setP] = useState<Profile | null>(null);
  const [st, setSt] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!uid) return;
    const [{ data: prof }, { data: set }] = await Promise.all([
      supabase.from('users').select('username, display_name, preferred_sports, total_checkins, total_games_posted').eq('id', uid).single(),
      supabase.from('user_settings').select('home_lat, home_lng, notify_nearby_games, notify_friends, notify_still_going, notify_radius_km, push_token').eq('user_id', uid).single(),
    ]);
    setP(prof as Profile); setSt(set as Settings);
  }, [uid]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function saveProfile() {
    if (!p || !uid) return;
    setSaving(true);
    const { error } = await supabase.from('users')
      .update({ username: p.username.trim(), display_name: p.display_name.trim(), preferred_sports: p.preferred_sports }).eq('id', uid);
    setSaving(false);
    if (error) alert('Couldn\'t save', error.message.includes('users_username_key') ? 'That username is taken.' : friendlyError(error));
    else alert('Saved');
  }
  async function setSetting(patch: Partial<Settings>) {
    if (!uid || !st) return;
    setSt({ ...st, ...patch });
    const { error } = await supabase.from('user_settings').update(patch).eq('user_id', uid);
    if (error) { alert('Couldn\'t save', friendlyError(error)); load(); }
  }
  async function setHome() {
    try {
      const fix = await getPreciseFix();
      await setSetting({ home_lat: fix.lat, home_lng: fix.lng });
      alert('Home area set', 'You\'ll hear about games near here. (Only you can see this.)');
    } catch (e) { alert('Location needed', friendlyError(e)); }
  }

  if (!p || !st) return <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} />;
  const toggleSport = (sp: string) => setP({ ...p, preferred_sports: p.preferred_sports.includes(sp) ? p.preferred_sports.filter((x) => x !== sp) : [...p.preferred_sports, sp] });

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={s.title}>{p.display_name}</Text>
        <Text style={s.dim}>@{p.username}</Text>
        <View style={s.stats}>
          {[['Verified check-ins', p.total_checkins], ['Games posted', p.total_games_posted]].map(([k, v]) => (
            <View key={k} style={s.stat}><Text style={s.statV}>{v}</Text><Text style={s.dim}>{k}</Text></View>
          ))}
        </View>

        <Label>Name</Label>
        <TextInput style={s.input} value={p.display_name} onChangeText={(t) => setP({ ...p, display_name: t })} />
        <Label>Username (friends add you with this)</Label>
        <TextInput style={s.input} value={p.username} autoCapitalize="none" onChangeText={(t) => setP({ ...p, username: t })} />
        <Label>Your sports</Label>
        <View style={s.wrap}>{SPORTS.map((sp) => <Pill key={sp} label={`${sportIcon(sp)} ${sp}`} active={p.preferred_sports.includes(sp)} onPress={() => toggleSport(sp)} />)}</View>
        <Button label="Save profile" onPress={saveProfile} loading={saving} />

        <View style={{ height: 28 }} />
        <Label>Notifications</Label>
        {!st.push_token ? <Text style={s.warn}>{Platform.OS === 'web' ? 'Phone notifications come with the App Store version. For now, alerts land in your Inbox — the 🔔 on the Feed.' : 'Push isn’t active on this build yet (Expo Go can’t receive push). In-app alerts still work.'}</Text> : null}
        {([['notify_nearby_games', 'Games posted near me'], ['notify_friends', 'Crew invites & requests'], ['notify_still_going', '"Still going?" for my games']] as const).map(([key, label]) => (
          <View key={key} style={s.switchRow}>
            <Text style={{ color: C.textDim, fontSize: 15 }}>{label}</Text>
            <Switch value={st[key]} onValueChange={(v) => setSetting({ [key]: v })} trackColor={{ true: C.orange, false: '#333' }} thumbColor="#ffffff" {...({ activeThumbColor: '#ffffff' } as object)} />
          </View>
        ))}
        <View style={s.switchRow}>
          <Text style={{ color: C.textDim, fontSize: 15 }}>Alert radius: {kmToMi(st.notify_radius_km)} mi</Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Button label="−" variant="secondary" style={{ paddingHorizontal: 14 }} onPress={() => setSetting({ notify_radius_km: miToKm(Math.max(1, kmToMi(st.notify_radius_km) - 1)) })} />
            <Button label="+" variant="secondary" style={{ paddingHorizontal: 14 }} onPress={() => setSetting({ notify_radius_km: miToKm(Math.min(30, kmToMi(st.notify_radius_km) + 1)) })} />
          </View>
        </View>
        <Button variant="secondary" label={st.home_lat ? '📍 Update my home area' : '📍 Set my home area (for nearby alerts)'} onPress={setHome} />

        <View style={{ height: 28 }} />
        <Button variant="danger" label="Sign out" onPress={() => alert(
          'Sign out?',
          'Your account has no email or password, so signing out means you can\'t get back into it. Your games and crew stay behind.',
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out anyway', style: 'destructive', onPress: () => { supabase.auth.signOut(); } }],
        )} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  title: { color: C.text, fontSize: 22, fontWeight: '700' },
  dim: { color: C.textFaint, fontSize: 12 },
  stats: { flexDirection: 'row', gap: 8, marginVertical: 18 },
  stat: { flex: 1, backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 12, alignItems: 'center' },
  statV: { color: C.orange, fontSize: 20, fontWeight: '800' },
  input: { backgroundColor: C.card, borderWidth: 1.5, borderColor: '#252525', borderRadius: 10, color: C.text, padding: 12, fontSize: 15, marginBottom: 16 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, marginBottom: 16 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  warn: { color: C.amber, fontSize: 12, marginBottom: 8 },
});
