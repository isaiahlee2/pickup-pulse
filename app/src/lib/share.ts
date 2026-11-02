import { Linking, Platform, Share } from 'react-native';

/** The site's own address — follows the Netlify domain automatically if it's renamed. */
export function siteOrigin(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.origin;
  return process.env.EXPO_PUBLIC_SITE_URL ?? 'https://peppy-rolypoly-743940.netlify.app';
}
export const gameUrl = (id: string) => `${siteOrigin()}/game/${id}`;
export const courtUrl = (id: string) => `${siteOrigin()}/court/${id}`;

export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

/**
 * Opens the phone's share sheet (Messages, Instagram, Snapchat, Copy…) like sharing a video.
 * Browsers without a share sheet get the link copied instead.
 */
export async function shareLink(opts: { title: string; text: string; url: string }): Promise<ShareResult> {
  if (Platform.OS === 'web') {
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> };
    if (typeof nav.share === 'function') {
      try { await nav.share(opts); return 'shared'; } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
      }
    }
    return copyText(`${opts.text} ${opts.url}`);
  }
  try {
    const r = await Share.share({ title: opts.title, message: `${opts.text} ${opts.url}`, url: opts.url });
    return r.action === Share.dismissedAction ? 'cancelled' : 'shared';
  } catch { return 'failed'; }
}

export async function copyText(text: string): Promise<ShareResult> {
  if (Platform.OS === 'web') {
    try { await navigator.clipboard.writeText(text); return 'copied'; } catch { return 'failed'; }
  }
  // Native has no clipboard module installed; the share sheet has "Copy"
  try { await Share.share({ message: text }); return 'shared'; } catch { return 'failed'; }
}

/** Google Maps directions on every device (opens the Google Maps app if it's installed). */
export function openDirections(lat: number, lng: number, _name?: string) {
  Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`);
}
