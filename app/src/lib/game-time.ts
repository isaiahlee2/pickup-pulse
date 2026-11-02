import type { FeedGame } from './types';

const MIN = 60_000;

export function minutesUntilStart(g: Pick<FeedGame, 'game_start_time'>, now = Date.now()) {
  return Math.max(0, Math.round((new Date(g.game_start_time).getTime() - now) / MIN));
}

export function minutesLeft(g: Pick<FeedGame, 'game_start_time' | 'window_minutes' | 'extended_minutes'>, now = Date.now()) {
  const end = new Date(g.game_start_time).getTime() + (g.window_minutes + g.extended_minutes) * MIN;
  return Math.max(0, Math.round((end - now) / MIN));
}

export function formatDuration(mins: number) {
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

export function formatStart(iso: string, now = new Date()) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Progress bar: fraction remaining (1 → 0) plus the color the prototype used */
export function timerBar(g: FeedGame, now = Date.now()): { pct: number; color: string; label: string } | null {
  if (g.status === 'upcoming') {
    const total = new Date(g.game_start_time).getTime() - new Date(g.created_at).getTime();
    const elapsed = now - new Date(g.created_at).getTime();
    const pct = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 1;
    return { pct, color: '#3b82f6', label: `${formatDuration(minutesUntilStart(g, now))} to start` };
  }
  if (g.status === 'live' || g.status === 'check') {
    const total = g.window_minutes + g.extended_minutes;
    const left = minutesLeft(g, now);
    const color = left <= 15 ? '#ef4444' : left <= 40 ? '#f59e0b' : '#22c55e';
    return { pct: total ? left / total : 0, color, label: `${left}m left${g.extended_minutes ? ' (ext)' : ''}` };
  }
  return null;
}

/** More verified check-ins = brighter card (the "trust glow") */
export function glow(checkins: number): { borderColor: string; shadowOpacity: number; shadowRadius: number; elevation: number } {
  if (checkins >= 8) return { borderColor: 'rgba(255,107,53,0.55)', shadowOpacity: 0.45, shadowRadius: 14, elevation: 10 };
  if (checkins >= 5) return { borderColor: 'rgba(255,107,53,0.35)', shadowOpacity: 0.25, shadowRadius: 9, elevation: 6 };
  if (checkins >= 3) return { borderColor: 'rgba(255,107,53,0.20)', shadowOpacity: 0.1, shadowRadius: 4, elevation: 2 };
  return { borderColor: '#1e1e1e', shadowOpacity: 0, shadowRadius: 0, elevation: 0 };
}

/** "just now", "5m", "3h", "2d" */
export function timeAgo(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / MIN));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}
