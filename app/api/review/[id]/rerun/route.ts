import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mergedRerunEnabled, enqueueFullRerun, getRerunJobStatus } from "@/lib/grants/intel-queue";

export const dynamic = "force-dynamic";

// Merged "Re-run grant match" (PR 1). The ONE staff action that replaces the console's two IntellEngine
// buttons: it re-runs the WHOLE review — engine re-match → QA → uses — in the BACKGROUND.
//
// POST enqueues a full-rerun job for the card's (grant, client) pair and returns IMMEDIATELY (202); the
// existing intel drain (+ its watchdog) runs it and guarantees completion even if the staffer closes the
// tab. GET returns the job status so the button shows a persistent "Running…" that survives navigation and
// can poll for completion.
//
// Admin-only, matching the score-mutating actions (/rematch, /intel, Add to Client): the re-match leg can
// DROP a card. Behind MERGED_RERUN_ENABLED — off → 404, and the console keeps its two separate buttons.

type ResolvedCard = {
  id: string;
  client_id: string | null;
  grant_id: string | null;
  decision: string;
  sme_released_at: string | null;
};

type Resolved =
  | { error: NextResponse }
  | { error?: undefined; db: ReturnType<typeof createServiceClient>; card: ResolvedCard | null };

// Auth (admin) + load the card. Shared by POST and GET so both gate identically.
async function resolve(cardId: string): Promise<Resolved> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };

  const db = createServiceClient();
  const { data: card } = await db
    .from("review_cards")
    .select("id, client_id, grant_id, decision, sme_released_at")
    .eq("id", cardId)
    .maybeSingle<ResolvedCard>();
  return { db, card };
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!mergedRerunEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const r = await resolve(params.id);
  if (r.error) return r.error;
  const { db, card } = r;
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if (!card.client_id || !card.grant_id) {
    return NextResponse.json({ error: "This card has no client/grant pair to re-run." }, { status: 400 });
  }
  // Same guards as /rematch and /intel: a decided card is the human's call, and a released card may already
  // be in front of a client — never re-run either from here (the UI hides the button in those states too).
  if (card.decision !== "pending") {
    return NextResponse.json(
      { error: "This card has already been decided — re-running would not change it." },
      { status: 409 },
    );
  }
  if (card.sme_released_at) {
    return NextResponse.json(
      { error: "This card has been released to the client — not re-running it from here." },
      { status: 409 },
    );
  }

  try {
    await enqueueFullRerun(db, card.grant_id, card.client_id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't queue the re-run" },
      { status: 500 },
    );
  }
  // 202 Accepted: the work is queued, not done. The button flips to "Running…" and polls GET for the finish.
  return NextResponse.json({ ok: true, status: "queued" }, { status: 202 });
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!mergedRerunEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const r = await resolve(params.id);
  if (r.error) return r.error;
  const { db, card } = r;
  if (!card || !card.client_id || !card.grant_id) return NextResponse.json({ status: null });

  const status = await getRerunJobStatus(db, card.grant_id, card.client_id);
  return NextResponse.json({ status });
}
