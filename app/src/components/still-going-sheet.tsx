import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { friendlyError, supabase } from '@/lib/supabase';
import { alert } from '@/lib/alert';
import { C } from '@/lib/theme';
import type { FeedGame } from '@/lib/types';
import { Button } from './ui';

/** Pops up when one of YOUR games hits its window. Reasons come from the server's settings. */
export function StillGoingSheet({ game, onDone }: { game: FeedGame | null; onDone: () => void }) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('app_settings').select('extend_reasons, extend_minutes').single()
      .then(({ data }) => setReasons((data?.extend_reasons as string[]) ?? []));
  }, []);

  async function respond(action: 'extend' | 'end') {
    if (!game) return;
    setBusy(true);
    const { error } = await supabase.rpc('respond_still_going', { p_game_id: game.id, p_action: action, p_reason: pick });
    setBusy(false);
    if (error) alert('Hmm', friendlyError(error));
    onDone();
  }

  return (
    <Modal visible={!!game} transparent animationType="fade" onRequestClose={onDone}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <Text style={{ fontSize: 36, textAlign: 'center' }}>⏰</Text>
          <Text style={s.title}>Still going at {game?.location_name}?</Text>
          <Text style={s.sub}>Your window is up. Keep it on the feed?</Text>
          <Text style={s.label}>QUICK REASON TO EXTEND</Text>
          {reasons.map((r) => (
            <Pressable key={r} onPress={() => setPick(r)} style={[s.reason, pick === r && s.reasonOn]}>
              <Text style={{ color: pick === r ? C.orange : C.textDim, fontSize: 14 }}>{r}</Text>
            </Pressable>
          ))}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <Button style={{ flex: 1 }} variant="secondary" label="It's over" onPress={() => respond('end')} disabled={busy} />
            <Button style={{ flex: 1 }} label="+60 min" onPress={() => respond('extend')} disabled={!pick} loading={busy} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { width: '100%', maxWidth: 380, backgroundColor: C.card, borderRadius: 20, padding: 24 },
  title: { color: C.text, fontSize: 19, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  sub: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: 18 },
  label: { color: C.textFaint, fontSize: 11, letterSpacing: 1, marginBottom: 8 },
  reason: { padding: 12, borderRadius: 10, backgroundColor: C.cardAlt, borderWidth: 1.5, borderColor: C.border, marginBottom: 6 },
  reasonOn: { borderColor: C.orange, backgroundColor: 'rgba(255,107,53,0.08)' },
});
