import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { Client, ConceptProposal, Grant, IntellEngineDraft } from "@/types/database";

// Resolve everything the IntellEngine scope + compliance steps need for a draft:
// the matched grant, the client, and the released concept proposal (when the
// client is entitled to see it).
//
// TWO-STAGE READ, on purpose:
//   1. The draft is read under the CALLER's RLS. That is the ownership proof -- a
//      client can only ever read their own org's draft (0062 RLS); a staff-admin
//      preview has no client draft and gets null (generic shell, no per-client
//      data). No service role is trusted to authorize here.
//   2. The related grant / client / concept are then read via the SERVICE ROLE,
//      scoped to the card_id/client_id from that RLS-verified draft. This is
//      required for concept_proposals (admin-only RLS -- the client's own RLS
//      client can't see it) and mirrors the portal grant-detail page, which reads
//      the same artifact via the service role after confirming card ownership.
//
// The concept proposal is exposed to the client on the SAME gate as the portal
// grant detail (app/portal/grants/[id]): premium (account_managed) AND the AM has
// released the card (sme_released_at) AND the proposal is ready.

export interface IntellEngineDraftContext {
  // `content` (0074) carries the client's saved scope + section drafts. Included here so the
  // scope and build pages read it through the SAME RLS-verified draft they already resolve,
  // rather than issuing a second read of their own.
  draft: Pick<IntellEngineDraft, "id" | "card_id" | "client_id" | "title" | "status" | "content">;
  grant: Grant | null; // the matched grant; null for a from-scratch draft
  client: Client | null;
  concept: ConceptProposal | null; // only when entitled + released + ready
  entitled: boolean; // account_managed (premium)
}

export async function resolveIntellEngineContext(
  draftId?: string,
): Promise<IntellEngineDraftContext | null> {
  if (!draftId) return null;

  // Stage 1 -- ownership via the caller's RLS.
  const rls = createClient();
  const { data: draft } = await rls
    .from("intellengine_drafts")
    .select("id, card_id, client_id, title, status, content")
    .eq("id", draftId)
    .maybeSingle<Pick<IntellEngineDraft, "id" | "card_id" | "client_id" | "title" | "status" | "content">>();
  if (!draft) return null; // not the caller's draft (or a staff preview with no client draft)

  // Stage 2 -- related rows via the service role, scoped to the verified draft.
  const svc = createServiceClient();
  const { data: client } = await svc
    .from("clients")
    .select("*")
    .eq("id", draft.client_id)
    .maybeSingle<Client>();
  const entitled = !!client?.account_managed;

  if (!draft.card_id) {
    // From scratch -- no matched grant, so no grant read and no concept.
    return { draft, grant: null, client: client ?? null, concept: null, entitled };
  }

  const { data: card } = await svc
    .from("review_cards")
    .select("grant_id, sme_released_at")
    .eq("id", draft.card_id)
    .maybeSingle<{ grant_id: string | null; sme_released_at: string | null }>();

  const grant = card?.grant_id
    ? (await svc.from("grants").select("*").eq("id", card.grant_id).maybeSingle<Grant>()).data ?? null
    : null;

  let concept: ConceptProposal | null = null;
  if (entitled && card?.sme_released_at) {
    const { data: cp } = await svc
      .from("concept_proposals")
      .select("status, proposal_data")
      .eq("card_id", draft.card_id)
      .maybeSingle<{ status: string; proposal_data: ConceptProposal | null }>();
    if (cp?.status === "ready" && cp.proposal_data) concept = cp.proposal_data;
  }

  return { draft, grant, client: client ?? null, concept, entitled };
}
