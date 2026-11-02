import { Tabs } from 'expo-router';
import { Text } from 'react-native';

import { useUnreadMessages } from '@/hooks/use-unread-messages';
import { C } from '@/lib/theme';

function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.55 }}>{glyph}</Text>;
}
const icon = (glyph: string) => function Icon({ focused }: { focused: boolean }) { return <TabIcon glyph={glyph} focused={focused} />; };

export default function TabsLayout() {
  const unreadDms = useUnreadMessages();
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: C.orange,
      tabBarInactiveTintColor: C.textFaint,
      tabBarStyle: { backgroundColor: 'rgba(10,10,10,0.96)', borderTopColor: '#1a1a1a' },
      tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Feed', tabBarIcon: icon('📡') }} />
      <Tabs.Screen name="post" options={{ title: 'Post', tabBarIcon: icon('➕') }} />
      <Tabs.Screen name="crew" options={{ title: 'Crew', tabBarIcon: icon('👥'),
        tabBarBadge: unreadDms ? (unreadDms > 9 ? '9+' : unreadDms) : undefined, tabBarBadgeStyle: { backgroundColor: C.orange, color: '#fff', fontSize: 10 } }} />
      <Tabs.Screen name="me" options={{ title: 'Me', tabBarIcon: icon('⚙️') }} />
    </Tabs>
  );
}
