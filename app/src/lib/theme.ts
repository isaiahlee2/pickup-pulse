// Carried over from the web prototype so the app looks the same.
export const C = {
  bg: '#0a0a0a',
  card: '#141414',
  cardAlt: '#0e0e0e',
  border: '#1e1e1e',
  borderStrong: '#2a2a2a',
  text: '#f0f0f0',
  textDim: '#aaaaaa',
  textMuted: '#777777',
  textFaint: '#555555',
  orange: '#ff6b35',
  orangeDeep: '#e85d26',
  gold: '#f7c948',
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#3b82f6',
  indigo: '#818cf8',
  orangeTint: 'rgba(255,107,53,0.10)',
  greenTint: 'rgba(34,197,94,0.08)',
  blueTint: 'rgba(59,130,246,0.10)',
  redTint: 'rgba(239,68,68,0.10)',
} as const;

export const SPORTS = ['Basketball', 'Soccer', 'Volleyball', 'Pickleball', 'Football', 'Tennis', 'Ultimate', 'Softball'] as const;
export const SPORT_ICONS: Record<string, string> = {
  Basketball: '🏀', Soccer: '⚽', Volleyball: '🏐', Pickleball: '🏓', Football: '🏈', Tennis: '🎾', Ultimate: '🥏', Softball: '🥎',
};
/** Anything typed into "Other" (Spikeball, hockey, …) gets the medal */
export const sportIcon = (sport: string) => SPORT_ICONS[sport] ?? '🏅';
export const isListedSport = (sport: string) => (SPORTS as readonly string[]).includes(sport);
export const SKILL_LEVELS = ['Any', 'Casual', 'Intermediate', 'Competitive'] as const;
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Fallback when location permission is denied: OSU campus */
export const OSU = { lat: 44.5638, lng: -123.2794 };
