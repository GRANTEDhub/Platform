import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { firmGrantbotEnabled } from "@/lib/grantbot/firm-turn";
import { mergeRecentThreads, type RecentThread } from "@/lib/grantbot/switcher";

// The Switcher's S3 "Recent" view: the staffer's recent GrantBot conversations across scopes — firm
// threads (admins only, matching the picker's Firm gate) plus client threads for every client in
// their RLS-scoped roster — merged most-recent-first. A discovery/history surface, like the roster
// route; clicking a row jumps into that conversation.
//
// STAFF-ONLY and per-actor SCOPED:
//   • getProfile() is null for a client-portal member (no profiles row) → 401, the same staff gate as
//     the roster/turn routes.
//   • grantbot_conversations' SELECT policy is is_staff(), so the SESSION client sees EVERY staffer's
//     rows — the per-actor boundary is therefore in CODE: client threads are filtered to the client
//     ids this actor can see (client_overview under RLS, the SAME source as the roster/Portfolio), and
//     firm threads are returned only to admins. A contractor thus sees only their clients' threads and
//     no firm threads, exactly like what the picker offers them.
//
// No archived/rejected filter on the name map: a thread on an archived client is still real history
// and should show its name. A thread whose client this actor can't see (not in the map) is dropped.
export async function GET() {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const isAdmin = profile.role === "admin";

  const supabase = createClient();

  // The clients this actor can see (RLS) → id→name, and the id set to scope client threads to.
  const { data: clientRows } = await supabase.from("client_overview").select("id, name");
  const nameById = new Map<string, string>();
  for (const c of clientRows ?? []) {
    if (c && typeof c.id === "string" && typeof c.name === "string" && c.name.length > 0) {
      nameById.set(c.id, c.name);
    }
  }
  const visibleIds = [...nameById.keys()];

  const LIMIT = 30;

  // Client threads for visible clients only (is_staff() RLS returns all rows, so the .in() is the
  // per-actor boundary). Drop any thread whose client we can't name (belt — shouldn't happen given
  // the .in()).
  let clientThreads: RecentThread[] = [];
  if (visibleIds.length > 0) {
    const { data } = await supabase
      .from("grantbot_conversations")
      .select("id, title, client_id, last_message_at")
      .eq("scope", "client")
      .in("client_id", visibleIds)
      .order("last_message_at", { ascending: false })
      .limit(LIMIT);
    clientThreads = (data ?? []).flatMap((r) => {
      const clientId = typeof r.client_id === "string" ? r.client_id : null;
      const clientName = clientId ? nameById.get(clientId) ?? null : null;
      if (!clientId || !clientName) return [];
      return [
        {
          id: String(r.id),
          scope: "client" as const,
          clientId,
          clientName,
          title: (r.title as string | null) ?? null,
          lastMessageAt: String(r.last_message_at ?? ""),
        },
      ];
    });
  }

  // Firm threads — admins only AND only when the firm bot is enabled (matching the picker's Firm
  // option, which needs both). Off ⟹ no firm rows, so Recent never offers a firm thread the
  // flag-gated firm routes would 404 on.
  let firmThreads: RecentThread[] = [];
  if (isAdmin && firmGrantbotEnabled()) {
    const { data } = await supabase
      .from("grantbot_conversations")
      .select("id, title, last_message_at")
      .eq("scope", "firm")
      .order("last_message_at", { ascending: false })
      .limit(LIMIT);
    firmThreads = (data ?? []).map((r) => ({
      id: String(r.id),
      scope: "firm" as const,
      clientId: null,
      clientName: null,
      title: (r.title as string | null) ?? null,
      lastMessageAt: String(r.last_message_at ?? ""),
    }));
  }

  return NextResponse.json({ threads: mergeRecentThreads(firmThreads, clientThreads, LIMIT) });
}
