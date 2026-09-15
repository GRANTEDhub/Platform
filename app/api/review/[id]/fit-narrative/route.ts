import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { resolveFit, type QaOverrideRow } from "@/lib/report/qa-override";
import { stripSeatCodes } from "@/lib/grants/fit-narrative";
import { invalidateDraftAlert } from "@/lib/alerts/store";

// Save a staff edit to the fit-analysis narrative — the client-facing "why this client fits" paragraph
// (the IntellEngine Intel / Grant Intelligence box) written by lib/grants/fit-analysis.ts. A staffer
// corrects it before the alert PDF (which now carries it) goes to a client.
//
// The write sets fit_narrative_edited=true (migration 0100), which LOCKS the paragraph: the fit-analysis
// drain never regenerates it (never clobbers the edit), and resolveFit honors it across a benign band move.
// The unlock is the on-demand regenerate (runFitAnalysisForCard), which clears the flag. This route also
// invalidates any saved alert draft so the next composer open re-renders the PDF with the edit frozen in.
//
// Service-role write (0089's guard_card_approval fast-path permits it), staff-gated — the same shape as
// the concept-proposal edit route. The narrative columns are otherwise machine-written by the drain.

const MAX_NARRATIVE_CHARS = 2000;

async function requireStaffUser(): Promise<{ userId: string } | NextResponse> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: prof } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!prof) return NextResponse.json({ error: "Staff only" }, { status: 403 });
  return { userId: user.id };
}

type CardRow = QaOverrideRow & {
  id: string;
  card_type: string;
  decision: string | null;
  sme_released_at: string | null;
};

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaffUser();
  if (auth instanceof NextResponse) return auth;

  let body: { narrative?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const raw = typeof body.narrative === "string" ? body.narrative : "";
  // stripSeatCodes at the boundary (a hand-typed P0 / S0_2 must never leak to the client). No
  // machinery-null guard here: a human edit is trusted prose, and nulling it on a false positive would be
  // worse than the code strip — this is the deliberate difference from the machine narrative's narrativeGuard.
  const text = stripSeatCodes(raw).trim();
  if (!text) return NextResponse.json({ error: "Narrative cannot be empty" }, { status: 400 });
  if (text.length > MAX_NARRATIVE_CHARS) {
    return NextResponse.json({ error: `Narrative too long (max ${MAX_NARRATIVE_CHARS} characters)` }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: card } = await db
    .from("review_cards")
    .select(
      "id, card_type, decision, sme_released_at, fit_score, factor_scores, qa_fit_score, qa_factor_scores, qa_status, qa_engine_fit_score, fit_narrative, fit_narrative_fit_score, fit_narrative_edited",
    )
    .eq("id", params.id)
    .maybeSingle<CardRow>();
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if (card.card_type !== "client") {
    return NextResponse.json({ error: "The fit narrative is a client-match field" }, { status: 400 });
  }
  // Decision integrity ("preview == sent"): never rewrite a client-visible narrative on a card that is
  // already decided or already released. The conditional UPDATE below enforces it atomically; this is the
  // clear up-front message.
  if (card.decision !== "pending" || card.sme_released_at != null) {
    return NextResponse.json(
      { error: "This card has already been decided or released; its narrative can't be edited." },
      { status: 409 },
    );
  }
  // The narrative only RENDERS on a go/marginal card without an applied QA demote (resolveFit's direction
  // gate). Editing it elsewhere would store text that never shows, so refuse with a clear reason.
  const resolved = resolveFit(card);
  const displayed = resolved.fitScore;
  if (displayed !== 2 && displayed !== 3) {
    return NextResponse.json(
      { error: "The fit narrative only applies to a go or marginal match." },
      { status: 409 },
    );
  }
  if (resolved.qa?.status === "applied") {
    return NextResponse.json(
      { error: "This card carries an applied QA verdict — its narrative is owned by the QA reasoning, not editable here." },
      { status: 409 },
    );
  }

  // Conditional UPDATE scoped to still-pending + unreleased — the atomic decision-integrity guard
  // applyFitPatch uses. A card released/decided between the read and here matches 0 rows and is untouched.
  const { data: updated, error } = await db
    .from("review_cards")
    .update({
      fit_narrative: text,
      fit_narrative_fit_score: displayed,
      fit_narrative_edited: true,
      fit_narrative_model: "human",
      fit_narrative_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("decision", "pending")
    .is("sme_released_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error(`[fit-narrative-edit] card ${params.id}: write failed: ${error.message}`);
    return NextResponse.json({ error: "Failed to save the narrative." }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json(
      { error: "This card has already been decided or released; its narrative can't be edited." },
      { status: 409 },
    );
  }

  // Invalidate any saved alert draft so the next composer open re-renders the PDF with the edit frozen in
  // (the alert is generated once and reused for preview AND send). Best-effort — the edit is committed;
  // a stale draft that fails to delete is logged, not fatal, and a Regenerate would clear it anyway.
  try {
    await invalidateDraftAlert(params.id);
  } catch (e) {
    console.error(`[fit-narrative-edit] card ${params.id}: draft invalidation failed:`, e instanceof Error ? e.message : e);
  }

  return NextResponse.json({ ok: true, narrative: text });
}
