import { router, type Href } from 'expo-router';

/**
 * Back if there's somewhere to go back to; otherwise to the feed. A page opened straight
 * from a shared link or the home-screen icon has no history, and plain back() leaves people stuck.
 */
export function goBackOr(fallback: Href = '/') {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
