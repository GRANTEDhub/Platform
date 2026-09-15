import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runFitAnalysisForCard } from "@/lib/grants/fit-analysis";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// On-demand fit-analysis narrative for ONE card (admin-only). Two uses:
//   - the LOOK-BEFORE-MERGE (generate a strong / conditional / sparse-data card and view the rendered box
//     on the preview deploy before the cron flag is flipped);
//   - a staffer about to forward a card who wants its "why this client fits" paragraph filled now.
//
// DELIBERATELY NOT gated on FIT_ANALYSIS_ENABLED — that flag gates the automatic CRON (mass generation); this
// is a single-card action a human explicitly triggers (mirrors the allowable-uses admin re-extract route).
// It writes ONLY the fit_narrative* columns via the same path the drain uses. A GET is unsupported (the write
// is POST-only, so a link scanner / prefetch can never trigger a generation + spend).

async function requireAdmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { error: null as null };
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { cardId?: string };
  const cardId = typeof body.cardId === "string" && body.cardId ? body.cardId : undefined;
  if (!cardId) return NextResponse.json({ error: "cardId is required" }, { status: 400 });

  const db = createServiceClient();
  const result = await runFitAnalysisForCard(db, cardId);
  return NextResponse.json(result);
}
