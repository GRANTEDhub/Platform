import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Staff "re-run finished" feed (PR 2) — the data behind the nav-bar bell (components/layout/top-nav.tsx).
// Returns the recent staff-triggered FULL re-runs that have FINISHED (done or error), newest first, so the
// bell can light up when a background re-run a staffer kicked off completes and they can walk away from the
// card page. It EXCLUDES the automatic auto-QA drain jobs (kind='auto'): those run constantly and would
// drown the bell. Staff-GLOBAL in v1 — no requester is recorded on the queue row, and for this team size a
// global feed is effectively per-user. Admin-only, READ-ONLY (no writes), reads only staff-readable tables.

const WINDOW_MS = 24 * 60 * 60 * 1000; // a "recent" feed — only the last day's completions
const LIMIT = 25;

type FeedRow = {
  grant_id: string;
  client_id: string;
  status: string;
  finished_at: string | null;
  grants: { title: string | null } | null;
  clients: { name: string | null } | null;
};

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  // full_rerun is an admin action, so the feed that reports on it is admin-only too. A contractor's bell
  // simply never polls (the client gates on role) and this is the backstop.
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  // Admin-gated above, so read with the service client (the queue's RLS is is_staff()-only; embeds of
  // grants/clients then need no per-table policy juggling — the same pattern the /rematch + /rerun routes use).
  const db = createServiceClient();
  const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: rows } = await db
    .from("intel_review_queue")
    .select("grant_id, client_id, status, finished_at, grants(title), clients(name)")
    .eq("kind", "full_rerun")
    .in("status", ["done", "error"])
    .gte("finished_at", sinceIso)
    .order("finished_at", { ascending: false })
    .limit(LIMIT)
    .returns<FeedRow[]>();

  const completions = rows ?? [];

  // Resolve the current pending card for each pair in ONE query so each item deep-links to the exact card.
  // If the re-match DROPPED the card (or it was since decided/released) there is no pending card — the item
  // then links to the client's roadmap list, which never 404s (unlike the specific-card page, PR1 finding).
  const grantIds = [...new Set(completions.map((r) => r.grant_id))];
  const clientIds = [...new Set(completions.map((r) => r.client_id))];
  const cardByPair = new Map<string, string>();
  if (grantIds.length && clientIds.length) {
    const { data: cards } = await db
      .from("review_cards")
      .select("id, grant_id, client_id")
      .in("grant_id", grantIds)
      .in("client_id", clientIds)
      .eq("decision", "pending")
      .is("sme_released_at", null)
      .eq("card_type", "client")
      .returns<{ id: string; grant_id: string; client_id: string }[]>();
    // Keyed on the EXACT pair, so the cross-product over-fetch (grantIds × clientIds) never mis-links a card
    // from a different pair that happens to share one id.
    for (const c of cards ?? []) cardByPair.set(`${c.grant_id}:${c.client_id}`, c.id);
  }

  const items = completions.map((r) => {
    const cardId = cardByPair.get(`${r.grant_id}:${r.client_id}`) ?? null;
    return {
      grantId: r.grant_id,
      clientId: r.client_id,
      grantTitle: r.grants?.title ?? "Untitled grant",
      clientName: r.clients?.name ?? "Client",
      status: r.status === "error" ? "error" : "done",
      finishedAt: r.finished_at,
      href: cardId ? `/clients/${r.client_id}/roadmap/${cardId}` : `/clients/${r.client_id}/roadmap`,
      cardPresent: cardId !== null,
    };
  });

  return NextResponse.json({ items });
}
