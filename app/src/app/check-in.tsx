import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { goBackOr } from '@/lib/nav';
import { Button } from '@/components/ui';
import { getPreciseFix } from '@/hooks/use-location';
import { useLocations } from '@/hooks/use-locations';
import { metersBetween } from '@/lib/geo';
import { friendlyError, supabase } from '@/lib/supabase';
import { C } from '@/lib/theme';
import { formatFeet } from '@/lib/units';

type Result = { verified: boolean; distance_m: number; radius_m: number; message: string };

/** Server answers in meters; say it in feet. (The server's own wording is kept for flagged/odd cases.) */
function messageFor(r: Result) {
  if (r.verified || r.distance_m <= r.radius_m) return r.message;
  return `You’re ${formatFeet(r.distance_m)} away — get within ${formatFeet(r.radius_m)} of the court.`;
}

/**
 * Opened from a game card (gameId) or on its own (pick the court).
 * The phone only sends raw GPS — the server decides if you're close enough.
 */
export default function CheckIn() {
  const { gameId } = useLocalSearchParams<{ gameId?: string }>();
  const locations = useLocations();
  const [fix, setFix] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [phase, setPhase] = useState<'locating' | 'ready' | 'sending' | 'done' | 'error'>('locating');
  const [pick, setPick] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const runFix = () => getPreciseFix()
    .then((f) => { setFix(f); setPhase('ready'); })
    .catch((e) => { setErr(friendlyError(e)); setPhase('error'); });
  const locate = () => { setPhase('locating'); setErr(null); runFix(); };
  useEffect(() => { runFix(); }, []);

  const nearby = useMemo(() => fix ? locations
    .map((l) => ({ ...l, dist: metersBetween(fix, l) })).sort((a, b) => a.dist - b.dist).slice(0, 6) : [], [fix, locations]);
  const chosen = pick ?? (!gameId ? nearby[0]?.id ?? null : null);  // default to the closest court

  async function submit() {
    if (!fix) return;
    setPhase('sending');
    const { data, error } = await supabase.rpc('check_in', {
      p_lat: fix.lat, p_lng: fix.lng, p_location_id: gameId ? null : chosen, p_game_id: gameId ?? null,
    });
    if (error) { setErr(friendlyError(error)); setPhase('error'); return; }
    setResult(data as Result); setPhase('done');
  }

  return (
    <ScrollView style={{ backgroundColor: C.card }} contentContainerStyle={{ padding: 20 }}>
      <Text style={s.sub}>Verify you’re at the court. Posts with 3+ verified check-ins earn the ✓ badge.</Text>

      {phase === 'locating' ? <Status icon="📡" text="Getting a precise GPS fix…" sub="Stepping outside helps" /> : null}
      {fix && phase !== 'locating' ? <Text style={s.acc}>GPS accuracy ±{formatFeet(fix.accuracy)}{fix.accuracy > 60 ? ' — weak signal, results may be off' : ''}</Text> : null}

      {phase === 'ready' && !gameId ? (
        <View style={{ marginVertical: 12 }}>
          {nearby.map((l) => (
            <Pressable key={l.id} onPress={() => setPick(l.id)} style={[s.loc, chosen === l.id && s.locOn]}>
              <Text style={{ color: chosen === l.id ? C.orange : C.textDim, fontSize: 14 }}>{l.name}</Text>
              <Text style={{ color: C.textFaint, fontSize: 12 }}>{formatFeet(l.dist)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {phase === 'sending' ? <Status icon="📡" text="Verifying…" /> : null}
      {phase === 'done' && result ? (
        <Status icon={result.verified ? '✅' : '❌'} text={messageFor(result)} color={result.verified ? C.green : C.red} />
      ) : null}
      {phase === 'error' ? <Status icon="⚠️" text={err ?? 'Something went wrong'} color={C.red} /> : null}

      <View style={{ gap: 8, marginTop: 12 }}>
        {phase === 'ready' ? <Button label="Verify my location" onPress={submit} disabled={!gameId && !chosen} /> : null}
        {phase === 'done' && result?.verified ? <Button label="Done" onPress={() => goBackOr()} /> : null}
        {(phase === 'error' || (phase === 'done' && !result?.verified)) ? <Button variant="secondary" label="Try again" onPress={locate} /> : null}
      </View>
    </ScrollView>
  );
}

function Status({ icon, text, sub, color = C.textDim }: { icon: string; text: string; sub?: string; color?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 20 }}>
      <Text style={{ fontSize: 40 }}>{icon}</Text>
      <Text style={{ color, fontSize: 15, fontWeight: '600', marginTop: 8, textAlign: 'center' }}>{text}</Text>
      {sub ? <Text style={{ color: C.textFaint, fontSize: 12, marginTop: 4 }}>{sub}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  sub: { color: C.textMuted, fontSize: 13, marginBottom: 8 },
  acc: { color: C.textFaint, fontSize: 12, marginTop: 4 },
  loc: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, borderRadius: 12, backgroundColor: C.cardAlt, borderWidth: 1.5, borderColor: C.border, marginBottom: 6 },
  locOn: { borderColor: C.orange, backgroundColor: 'rgba(255,107,53,0.08)' },
});
