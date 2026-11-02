// supabase/functions/send-push/index.ts
// ============================================================
// The only Edge Function Pickup Pulse needs.
// pg_cron calls it every minute. It:
//   1. claims pending notifications (DB applies prefs + do-not-disturb)
//   2. sends them through Expo's push service (handles iOS + Android)
//   3. marks failures and forgets dead tokens (uninstalled apps)
//
// Deploy:  supabase functions deploy send-push --no-verify-jwt
// Secrets: supabase secrets set CRON_SECRET=<long random string>
//          supabase secrets set EXPO_ACCESS_TOKEN=<optional, only if you enable
//                                 "enhanced push security" in your Expo account>
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

type Claimed = { notification_id: string; push_token: string; title: string; body: string; data: Record<string, unknown> };
type Ticket = { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } };

const EXPO_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK = 100; // Expo's max messages per request

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await sb.rpc("claim_push_batch", { p_limit: 500 });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const batch = (data ?? []) as Claimed[];
  const failedIds: string[] = [];
  const deadTokens: string[] = [];
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const expoToken = Deno.env.get("EXPO_ACCESS_TOKEN");
  if (expoToken) headers.Authorization = `Bearer ${expoToken}`;

  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK);
    const messages = chunk.map((n) => ({
      to: n.push_token,
      title: n.title,
      body: n.body,
      data: n.data,          // app uses data.game_id / data.type to open the right screen
      sound: "default",
      priority: "high",
      channelId: "default",  // must match the Android channel the app creates
    }));
    try {
      const res = await fetch(EXPO_URL, { method: "POST", headers, body: JSON.stringify(messages) });
      const json = await res.json();
      const tickets: Ticket[] = json.data ?? [];
      tickets.forEach((t, idx) => {
        if (t.status === "error") {
          failedIds.push(chunk[idx].notification_id);
          if (t.details?.error === "DeviceNotRegistered") deadTokens.push(chunk[idx].push_token);
        }
      });
      if (!res.ok && tickets.length === 0) chunk.forEach((n) => failedIds.push(n.notification_id));
    } catch (_e) {
      chunk.forEach((n) => failedIds.push(n.notification_id));
    }
  }

  if (failedIds.length) await sb.rpc("mark_push_failed", { p_ids: failedIds });
  if (deadTokens.length) await sb.rpc("clear_push_tokens", { p_tokens: [...new Set(deadTokens)] });

  return Response.json({ claimed: batch.length, failed: failedIds.length, dead_tokens: deadTokens.length });
});
