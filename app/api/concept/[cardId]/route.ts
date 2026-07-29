import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  getConceptProposal,
  markConceptProposalGenerating,
  runConceptProposalGeneration,
  saveConceptProposalEdits,
} from "@/lib/concept/store";
import { normalizeConceptProposal } from "@/lib/concept/generate";

// Concept-proposal read + (re)generate. ANY staff (admin OR contractor) -- the
// concept proposal is core account-manager work, and our contractor IS the AM. All
// reads/writes here go through the service role anyway (concept_proposals is
// admin-only RLS, but nothing queries it as the caller), so the gate is purely
// "is this a staff user". GET returns the current row (or null); POST kicks off
// generation/retry non-blocking; PUT saves manual edits.

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

export async function GET(_req: NextRequest, { params }: { params: { cardId: string } }) {
  const auth = await requireStaffUser();
  if (auth instanceof NextResponse) return auth;
  const proposal = await getConceptProposal(params.cardId);
  return NextResponse.json({ proposal });
}

// Save an account manager's manual edits to the generated proposal.
export async function PUT(req: NextRequest, { params }: { params: { cardId: string } }) {
  const auth = await requireStaffUser();
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const proposal = normalizeConceptProposal(body);
  const { error } = await saveConceptProposalEdits(params.cardId, proposal, auth.userId);
  if (error) return NextResponse.json({ error: `Couldn't save: ${error}` }, { status: 500 });

  const row = await getConceptProposal(params.cardId);
  return NextResponse.json({ proposal: row });
}

export async function POST(_req: NextRequest, { params }: { params: { cardId: string } }) {
  const auth = await requireStaffUser();
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

  // Surface a failure to even start (most commonly: the concept_proposals table
  // does not exist yet because migration 0060 has not been applied) instead of
  // returning a false "generating" that would spin forever.
  const { error } = await markConceptProposalGenerating(params.cardId, card.grant_id, card.client_id, auth.userId);
  if (error) {
    const missingTable = /concept_proposals/.test(error) && /exist|relation/i.test(error);
    return NextResponse.json(
      {
        error: missingTable
          ? "Concept-proposal storage isn't set up yet — the database step (migration 0060) hasn't been applied."
          : `Couldn't start generation: ${error}`,
      },
      { status: 503 },
    );
  }
  waitUntil(runConceptProposalGeneration(params.cardId, auth.userId));
  return NextResponse.json({ status: "generating" });
}
