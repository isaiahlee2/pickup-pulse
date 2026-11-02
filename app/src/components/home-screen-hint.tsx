import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { C } from '@/lib/theme';

const KEY = 'pp_home_hint_dismissed';

function shouldShow(): boolean {
  if (Platform.OS !== 'web') return false;
  try {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
    return ios && !standalone && window.localStorage.getItem(KEY) !== '1';
  } catch {
    return false;
  }
}

/** iPhone Safari only: one-time tip to save the site to the home screen so it opens like an app. */
export function HomeScreenHint() {
  const [show, setShow] = useState(shouldShow);

  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try { window.localStorage.setItem(KEY, '1'); } catch { /* storage unavailable — just hide */ }
  };

  return (
    <View style={s.box}>
      <Text style={s.text}>
        <Text style={{ fontWeight: '700', color: C.text }}>Make it an app: </Text>
        tap the Share button below, then <Text style={{ fontWeight: '700', color: C.text }}>Add to Home Screen</Text>.
      </Text>
      <Pressable onPress={dismiss} hitSlop={12}><Text style={s.x}>✕</Text></Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(255,107,53,0.08)', borderColor: 'rgba(255,107,53,0.25)', borderWidth: 1, borderRadius: 12, padding: 12, marginHorizontal: 16, marginBottom: 4 },
  text: { flex: 1, color: C.textDim, fontSize: 13, lineHeight: 19 },
  x: { color: C.textMuted, fontSize: 16 },
});
