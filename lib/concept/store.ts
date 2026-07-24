import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { generateConceptProposal, CONCEPT_MODEL } from "./generate";
import type { ConceptCardSignals } from "./schema";
import type { Client, Grant, Prospect, ConceptProposal, ConceptProposalRow, ConceptProposalStatus } from "@/types/database";

// Persistence + orchestration for the concept proposal. One row per review card
// (concept_proposals_one_per_card). All writes are service-role: the table is
// admin-only RLS, and generation runs server-side / in a background waitUntil.
// Mirrors lib/alerts/store.ts. See migration 0060.

export async function getConceptProposal(cardId: string): Promise<ConceptProposalRow | null> {
  const db = createServiceClient();
  const { data } = await db
    .from("concept_proposals")
    .select("*")
    .eq("card_id", cardId)
    .maybeSingle<ConceptProposalRow>();
  return data ?? null;
}

// Batch read for the list surfaces (Grant Alerts + Grant Report): status +
// proposal_data keyed by card id, in one service-role query (the table is
// admin-only RLS, so the portal's own RLS client can't see it). Cards with no
// proposal simply don't appear in the map -- the caller treats absent as "none".
export async function getConceptProposalsByCardIds(
  cardIds: string[],
): Promise<Map<string, { status: ConceptProposalStatus; proposal: ConceptProposal | null }>> {
  const map = new Map<string, { status: ConceptProposalStatus; proposal: ConceptProposal | null }>();
  const ids = Array.from(new Set(cardIds.filter(Boolean)));
  if (!ids.length) return map;
  const db = createServiceClient();
  const { data } = await db
    .from("concept_proposals")
    .select("card_id, status, proposal_data")
    .in("card_id", ids);
  for (const row of (data ?? []) as {
    card_id: string;
    status: ConceptProposalStatus;
    proposal_data: ConceptProposal | null;
  }[]) {
    map.set(row.card_id, { status: row.status, proposal: row.proposal_data });
  }
  return map;
}

// Insert a 'generating' placeholder ONLY if the card has none. `created` is true
// exactly when this call inserted the row -- the sme_interested trigger fires
// generation only on a fresh create, so an existing ready/edited proposal is
// never silently regenerated (a manual staff edit is preserved).
export async function ensureConceptProposalPlaceholder(
  cardId: string,
  grantId: string | null,
  clientId: string | null,
  userId: string | null,
): Promise<{ created: boolean; row: ConceptProposalRow | null }> {
  const db = createServiceClient();
  const existing = await getConceptProposal(cardId);
  if (existing) return { created: false, row: existing };

  const { data, error } = await db
    .from("concept_proposals")
    .insert({ card_id: cardId, grant_id: grantId, client_id: clientId, status: "generating", generated_by: userId })
    .select()
    .single<ConceptProposalRow>();
  if (error) {
    // Unique-violation race (a concurrent insert won): treat as not-created.
    return { created: false, row: await getConceptProposal(cardId) };
  }
  return { created: true, row: data };
}

// Force the card into 'generating' for a manual generate / retry / regenerate,
// creating the row if absent and clearing any prior error. Used by the endpoint;
// the caller then fires runConceptProposalGeneration in the background. Returns
// the DB error message (if any) so the endpoint can surface it instead of failing
// silently -- e.g. "relation concept_proposals does not exist" when migration 0060
// has not been applied yet.
export async function markConceptProposalGenerating(
  cardId: string,
  grantId: string | null,
  clientId: string | null,
  userId: string | null,
): Promise<{ error: string | null }> {
  const db = createServiceClient();
  const existing = await getConceptProposal(cardId);
  if (!existing) {
    const { error } = await db
      .from("concept_proposals")
      .insert({ card_id: cardId, grant_id: grantId, client_id: clientId, status: "generating", generated_by: userId });
    return { error: error?.message ?? null };
  }
  const { error } = await db
    .from("concept_proposals")
    .update({ status: "generating", error: null, generated_by: userId })
    .eq("card_id", cardId);
  return { error: error?.message ?? null };
}

// Save an account manager's manual edits to the generated proposal. Stamps
// edited_at/by so a later Regenerate can warn before overwriting, and keeps
// status='ready'. Returns the DB error (if any) so the endpoint can surface it.
export async function saveConceptProposalEdits(
  cardId: string,
  proposal: ConceptProposal,
  userId: string | null,
): Promise<{ error: string | null }> {
  const db = createServiceClient();
  const { error } = await db
    .from("concept_proposals")
    .update({
      proposal_data: proposal,
      status: "ready",
      error: null,
      edited_at: new Date().toISOString(),
      edited_by: userId,
    })
    .eq("card_id", cardId);
  return { error: error?.message ?? null };
}

// GRANTED-tracked ecosystem orgs in the client's state that could serve as named
// partners (each prospects row has a verified source_url). A simple state-match
// shortlist -- the model judges actual fit and is free to prefer the client's own
// cited partners or an honest org-type instead.
async function loadPartnerCandidates(client: Client): Promise<Prospect[]> {
  const db = createServiceClient();
  const states = [client.location_state].filter((s): s is string => !!s);
  if (!states.length) return [];
  const { data } = await db.from("prospects").select("*").in("location_state", states).limit(15);
  return (data as Prospect[] | null) ?? [];
}

// The background job: load inputs, generate, write ready/error. Never throws (it
// runs in waitUntil); any failure lands as status='error' with the message, which
// the AM can retry. Assumes the row already exists (the trigger/endpoint create it
// first) so a mid-generation failure still has a row to carry the error.
export async function runConceptProposalGeneration(cardId: string, userId: string | null): Promise<void> {
  const db = createServiceClient();
  try {
    const { data: card } = await db
      .from("review_cards")
      .select("grant_id, client_id, fit_score, proposed_role, why_this_org, concept_synopsis")
      .eq("id", cardId)
      .maybeSingle<{
        grant_id: string | null;
        client_id: string | null;
        fit_score: number | null;
        proposed_role: string | null;
        why_this_org: string[] | null;
        concept_synopsis: string | null;
      }>();
    if (!card || !card.grant_id || !card.client_id) {
      throw new Error("Card, grant, or client missing for concept proposal");
    }

    const { data: grant } = await db.from("grants").select("*").eq("id", card.grant_id).maybeSingle<Grant>();
    const { data: client } = await db.from("clients").select("*").eq("id", card.client_id).maybeSingle<Client>();
    if (!grant || !client) throw new Error("Grant or client row not found");

    const prospectCandidates = await loadPartnerCandidates(client);
    const signals: ConceptCardSignals = {
      fit_score: card.fit_score,
      proposed_role: card.proposed_role,
      why_this_org: card.why_this_org,
      concept_synopsis: card.concept_synopsis,
    };

    const proposal = await generateConceptProposal({ grant, client, card: signals, prospectCandidates });

    await db
      .from("concept_proposals")
      .update({
        status: "ready",
        proposal_data: proposal,
        model: CONCEPT_MODEL,
        error: null,
        generated_at: new Date().toISOString(),
        generated_by: userId,
      })
      .eq("card_id", cardId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[concept] generation failed for card ${cardId}:`, message);
    await db.from("concept_proposals").update({ status: "error", error: message }).eq("card_id", cardId);
  }
}
