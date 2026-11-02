export type GameStatus = 'upcoming' | 'live' | 'check' | 'ended' | 'cancelled';
export type RsvpStatus = 'confirmed' | 'waitlisted' | 'cancelled';

/** One row from the get_feed() RPC */
export interface FeedGame {
  id: string;
  creator_id: string;
  creator_name: string;
  sport: string;
  location_id: string | null;
  location_name: string;
  location_lat: number;
  location_lng: number;
  skill_level: string;
  note: string;
  total_players: number;
  spots_needed: number;
  spots_open: number;
  current_rsvps: number;
  game_start_time: string;
  window_minutes: number;
  extended_minutes: number;
  extend_reason: string | null;
  status: GameStatus;
  is_verified: boolean;
  checkin_count: number;
  created_at: string;
  distance_km: number;
  friend_involved: boolean;
  my_rsvp: RsvpStatus | null;
  score: number;
}

export interface Location {
  id: string;
  name: string;
  lat: number;
  lng: number;
  sport_types: string[];
  is_indoor: boolean;
}

/** One row from get_crew() */
export interface CrewMember {
  friendship_id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  preferred_sports: string[];
  status: 'pending' | 'accepted' | 'blocked';
  incoming: boolean;
  active_game_id: string | null;
  active_game_label: string | null;
  last_active_at: string | null;
}

export interface Trend {
  location_id: string;
  location_name: string;
  sport: string;
  day_of_week: number;
  hour_of_day: number;
  avg_players: number;
  confidence: number;
}

/** One row from get_game_players() */
export interface Player {
  user_id: string;
  display_name: string;
  username: string;
  role: 'host' | 'confirmed' | 'waitlisted';
  eta_at: string | null;
  arrived: boolean;
  joined_at: string;
}

/** get_profile(): reputation only — never location or activity history */
export interface PlayerProfile {
  user_id: string;
  username: string;
  display_name: string;
  preferred_sports: string[];
  member_since: string;
  games_posted: number;
  verified_checkins: number;
  games_joined: number;
  relation: 'me' | 'none' | 'requested' | 'incoming' | 'friends' | 'blocked';
}

export type NotificationType =
  | 'nearby_game' | 'friend_invite' | 'friend_request' | 'friend_accepted' | 'still_going_ping'
  | 'rsvp_update' | 'game_starting' | 'game_verified' | 'game_full' | 'game_ended';

/** get_inbox() */
export interface InboxItem {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  game_id: string | null;
  game_status: GameStatus | null;
  sender_id: string | null;
  sender_name: string | null;
  is_read: boolean;
  created_at: string;
}

/** One DM (from get_messages) */
export interface ChatMessage {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  from_me: boolean;
}

/** Last message + unread count per friend (from get_conversations) */
export interface Conversation {
  friend_id: string;
  last_body: string;
  last_at: string;
  last_from_me: boolean;
  unread: number;
}
