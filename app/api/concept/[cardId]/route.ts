import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  getConceptProposal,
  markConceptProposalGenerating,
  runConceptProposalGeneration,
} from "@/lib/concept/store";

// Concept-proposal read + (re)generate. Staff-admin only -- the concept proposal is
// an internal artifact (concept_proposals is admin-only RLS). GET returns the
// current row (or null); POST kicks off generation/retry non-blocking (used by the
// panel's Generate/Retry buttons) and returns immediately with status 'generating'.

async function requireAdminUser(): Promise<{ userId: string } | NextResponse> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: prof } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!prof || prof.role !== "admin") return NextResponse.json({ error: "Staff only" }, { status: 403 });
  return { userId: user.id };
}

export async function GET(_req: NextRequest, { params }: { params: { cardId: string } }) {
  const auth = await requireAdminUser();
  if (auth instanceof NextResponse) return auth;
  const proposal = await getConceptProposal(params.cardId);
  return NextResponse.json({ proposal });
}

export async function POST(_req: NextRequest, { params }: { params: { cardId: string } }) {
  const auth = await requireAdminUser();
  if (auth instanceof NextResponse) return auth;

  // Resolve the card's grant/client so a manual generate (no row yet) can create one.
  const db = createServiceClient();
  const { data: card } = await db
    .from("review_cards")
    .select("grant_id, client_id, card_type")
    .eq("id", params.cardId)
    .maybeSingle<{ grant_id: string | null; client_id: string | null; card_type: string }>();
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if (!card.grant_id || !card.client_id || card.card_type === "prospect") {
    return NextResponse.json({ error: "Concept proposals require a client grant card" }, { status: 400 });
  }

  await markConceptProposalGenerating(params.cardId, card.grant_id, card.client_id, auth.userId);
  waitUntil(runConceptProposalGeneration(params.cardId, auth.userId));
  return NextResponse.json({ status: "generating" });
}
