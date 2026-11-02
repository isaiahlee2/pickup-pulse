import { Alert, Platform, type AlertButton } from 'react-native';

/** Alert.alert does nothing in a browser, so fall back to the browser's own dialogs there. */
export function alert(title: string, message?: string, buttons?: AlertButton[]) {
  if (Platform.OS !== 'web') return Alert.alert(title, message, buttons);
  const text = message ? `${title}\n\n${message}` : title;
  const actionable = (buttons ?? []).filter((b) => b.style !== 'cancel' && b.onPress);
  if (actionable.length === 0) { window.alert(text); return; }
  if (actionable.length === 1) { if (window.confirm(`${text}\n\n${actionable[0].text}?`)) actionable[0].onPress?.(); return; }
  for (const b of actionable) { if (window.confirm(`${text}\n\n${b.text}?`)) { b.onPress?.(); return; } }
}
