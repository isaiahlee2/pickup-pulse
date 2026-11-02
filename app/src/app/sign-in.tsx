import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { alert } from '@/lib/alert';
import { friendlyError, supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';

/** "lebron james" → "lebronjames_482" (fits the username rule: 2–30 of a-z 0-9 _ .) */
function makeUsername(name: string) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '').slice(0, 20) || 'player';
  return `${base}_${Math.floor(100 + Math.random() * 900)}`;
}

/**
 * Beta sign-in: type a name, confirm 18+, and you're in — no email round-trip between a
 * flyer scan and the feed. Uses Supabase anonymous accounts; the account lives on this device.
 * The database refuses any sign-up that didn't confirm 18+ (see 03_v2_1_features.sql).
 */
export default function SignIn() {
  const [name, setName] = useState('');
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const clean = name.trim().replace(/\s+/g, ' ');

  async function start() {
    if (!adult || clean.length < 2) return;
    setBusy(true);
    const { data, error } = await supabase.auth.signInAnonymously({
      options: { data: { full_name: clean, adult_confirmed: true } },
    });
    if (error || !data.user) {
      setBusy(false);
      return alert('Couldn’t get you in', friendlyError(error ?? 'Unknown error'));
    }
    // Give them a readable @username friends can add (they can change it on the Me tab)
    for (let i = 0; i < 3; i++) {
      const { error: uerr } = await supabase.from('users')
        .update({ username: makeUsername(clean), display_name: clean }).eq('id', data.user.id);
      if (!uerr) break;
    }
    setBusy(false);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.wrap}>
        <Text style={s.brand}>PICKUP PULSE</Text>
        <Text style={s.tag}>Live pickup games near OSU</Text>
        <View style={{ height: 40 }} />
        <Text style={s.label}>What should players call you?</Text>
        <TextInput style={s.input} placeholder="First name or nickname" placeholderTextColor={C.textFaint}
          autoCapitalize="words" autoComplete="name" maxLength={40} value={name} onChangeText={setName}
          onSubmitEditing={start} returnKeyType="go" accessibilityLabel="Your name" />

        <Pressable onPress={() => setAdult(!adult)} style={s.check} accessibilityRole="checkbox"
          accessibilityState={{ checked: adult }} accessibilityLabel="I'm 18 or older">
          <View style={[s.box, adult && s.boxOn]}>{adult ? <Text style={s.tick}>✓</Text> : null}</View>
          <Text style={s.checkText}>I’m 18 or older</Text>
        </Pressable>

        <Button label="Let’s play" onPress={start} loading={busy} disabled={clean.length < 2 || !adult} />
        <Text style={s.fine}>Pickup Pulse is for adults 18+. No email or password — your account stays on this device.</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 24, maxWidth: 480, width: '100%', alignSelf: 'center' },
  brand: { color: C.orange, fontSize: 32, fontWeight: '800', letterSpacing: -1, textAlign: 'center' },
  tag: { color: C.textMuted, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', textAlign: 'center', marginTop: 4 },
  label: { color: C.textDim, fontSize: 14, marginBottom: 8 },
  input: { backgroundColor: C.card, borderWidth: 1.5, borderColor: '#252525', borderRadius: 12, color: C.text, fontSize: 16, padding: 14, marginBottom: 12 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, marginBottom: 12 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#444', alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: C.orange, borderColor: C.orange },
  tick: { color: '#fff', fontSize: 14, fontWeight: '800' },
  checkText: { color: C.text, fontSize: 15 },
  fine: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 14, lineHeight: 18 },
});
