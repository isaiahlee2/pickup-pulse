import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';

import { goBackOr } from '@/lib/nav';
import { Button } from '@/components/ui';
import { useUserId } from '@/hooks/use-session';
import { alert } from '@/lib/alert';
import { friendlyError, supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';

const REASONS = [
  ['fake_game', 'Fake or misleading game'],
  ['wrong_location', 'Wrong location'],
  ['spam', 'Spam'],
  ['harassment', 'Harassment or threats'],
  ['inappropriate_content', 'Inappropriate content'],
  ['fake_checkin', 'Faking check-ins'],
  ['other', 'Something else'],
] as const;

/** Reports land in the database's reports table for review (Supabase → Table Editor → reports). */
export default function Report() {
  const { gameId, userId } = useLocalSearchParams<{ gameId?: string; userId?: string }>();
  const uid = useUserId();
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!uid || !reason) return;
    setBusy(true);
    const { error } = await supabase.from('reports').insert({
      reporter_id: uid, reported_user_id: userId ?? null, reported_game_id: gameId ?? null,
      reason, description: details.trim() || null,
    });
    setBusy(false);
    if (error) return alert('Couldn’t send', friendlyError(error));
    alert('Report sent', 'Thanks — it’ll be reviewed. You can also block this player from their profile.');
    goBackOr();
  }

  return (
    <ScrollView style={{ backgroundColor: C.card }} contentContainerStyle={s.wrap}>
      <Text style={s.q}>What’s wrong?</Text>
      {REASONS.map(([key, label]) => (
        <Pressable key={key} onPress={() => setReason(key)} style={[s.opt, reason === key && s.on]}
          accessibilityRole="radio" accessibilityState={{ checked: reason === key }}>
          <Text style={{ color: reason === key ? C.orange : C.textDim, fontSize: 15 }}>{label}</Text>
        </Pressable>
      ))}
      <TextInput style={s.input} value={details} onChangeText={setDetails} maxLength={500} multiline
        placeholder="Anything else? (optional)" placeholderTextColor={C.textFaint} accessibilityLabel="Details" />
      <Button label="Send report" onPress={send} disabled={!reason} loading={busy} />
      <Text style={s.fine}>If someone is in danger, call 911.</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 20, paddingBottom: 40, maxWidth: 520, width: '100%', alignSelf: 'center' },
  q: { color: C.text, fontSize: 18, fontWeight: '700', marginBottom: 12 },
  opt: { padding: 14, minHeight: 48, borderRadius: 12, backgroundColor: C.cardAlt, borderWidth: 1.5, borderColor: C.border, marginBottom: 6, justifyContent: 'center' },
  on: { borderColor: C.orange, backgroundColor: 'rgba(255,107,53,0.08)' },
  input: { backgroundColor: C.cardAlt, borderWidth: 1.5, borderColor: C.border, borderRadius: 10, color: C.text, padding: 12, fontSize: 14, marginVertical: 12, minHeight: 72, textAlignVertical: 'top' },
  fine: { color: C.textFaint, fontSize: 12, textAlign: 'center', marginTop: 12 },
});
