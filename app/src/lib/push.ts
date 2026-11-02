import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from './supabase';

if (Platform.OS !== 'web') Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

/**
 * Registers this phone for push and saves the token to the player's private settings.
 * Remote push does NOT work inside Expo Go (SDK 53+) — it needs a development build.
 * In Expo Go this quietly does nothing, so the rest of the app still runs.
 */
export async function registerForPush(userId: string): Promise<'registered' | 'expo-go' | 'simulator' | 'denied' | 'error' | 'web'> {
  if (Platform.OS === 'web') return 'web';
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return 'expo-go';
  if (!Device.isDevice) return 'simulator';
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Games near you', importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return 'denied';

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await supabase.from('user_settings')
      .update({ push_token: token, platform: Platform.OS === 'ios' ? 'ios' : 'android' })
      .eq('user_id', userId);
    return 'registered';
  } catch {
    return 'error';
  }
}
