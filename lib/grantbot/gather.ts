import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  buildContextPack,
  type ContextPack,
  type PackAlert,
  type PackCard,
  type PackChange,
  type PackClient,
  type PackConcept,
  type PackDocument,
  type PackDraft,
  type PackEvent,
} from "@/lib/grantbot/context-pack";

// The reads behind the context pack. I/O only -- every rule about what a pack SAYS lives in
// lib/grantbot/context-pack.ts, which is pure and asserted offline.
//
// ── EXPLICIT COLUMN LISTS, NOT `select *` ──
//
// `grants` carries `raw_text` (the full NOFO -- routinely hundreds of KB, sometimes megabytes)
// plus `ideal_applicant_profile` and `allowable_uses`. A `select *` across a client's cards
// would pull all of that to render four lines per grant. Every select below names its columns,
// and the Pack* types in the pure module are Picks of the same names so the two cannot drift.
//
// ── ACTOR SCOPING ──
//
// Documents and their commit history are read under the CALLER's RLS, so what a pack contains
// follows the same policies the document routes enforce: an admin sees the client's org-level
// shelf, a contractor sees only draft-level rows (0075/0077). That is scoping by construction
// rather than a second copy of the rules here.
//
// Everything else is service-role, because the pack is a staff-only surface and the
// commercial/billing exclusion is applied by NOT SELECTING those columns at all -- so there is
// no admin-vs-contractor difference left to enforce outside the document set. Nothing below
// reads engagement_tier, retainer_hours, contract dates, Stripe ids, invoices, or time
// entries; the exclusion is a property of the query, not a filter over a wider read.

const CLIENT_COLUMNS = [
  "id", "name", "status", "org_type", "pipeline_stage", "account_managed",
  "primary_contact_name", "primary_contact_email", "primary_contact_phone", "website",
  "location_street", "location_city", "location_county", "location_state", "location_zip",
  "service_area", "rucc_codes", "ein", "uei", "annual_budget",
  "sam_registration_status", "sam_expiration_date", "sam_checked_at", "sam_matched_name",
  "nonprofit_finance", "nonprofit_finance_checked_at",
  "federal_grant_history", "federal_history_verified", "usaspending_checked_at",
  "primary_funding_needs", "project_stage", "match_cost_share_capacity",
  "known_constraints", "hard_constraints", "matching_rules", "notes", "next_step",
  "intake_data", "client_profile", "profile_confirmed_at", "created_at", "updated_at",
].join(", ");

const CARD_COLUMNS =
  "id, grant_id, fit_score, proposed_role, recommended_prime, why_this_org, concept_synopsis, " +
  "before_you_approve, decision, decided_at, decision_reason, hold_reason, interested_at, " +
  "sent_at, pursuit_path, created_at, " +
  "grants(title, funder, fon, submission_deadline, award_range_min, award_range_max, " +
  "award_range_is_estimate, description_brief)";

export interface GatherResult {
  pack: ContextPack;
  clientName: string;
}

// Returns null when the client does not exist. Authorisation for the SURFACE is the page's job
// (staff-only via requireUser); this function decides what a given actor may see WITHIN it.
export async function gatherContextPack(opts: {
  clientId: string;
  generatedBy: string;
  actorRole: string;
  generatedAt: string;
}): Promise<GatherResult | null> {
  const svc = createServiceClient();
  const rls = createClient();

  const { data: client } = await svc
    .from("clients")
    .select(CLIENT_COLUMNS)
    .eq("id", opts.clientId)
    .maybeSingle<PackClient>();
  if (!client) return null;

  // CONCURRENT: none of these depends on another's result -- they all key off the client id.
  // Sequential awaits would make the page cost the sum of six round trips instead of the
  // slowest one, which is the finding review raised on the assimilation page (#340).
  const [docsRes, changesRes, cardsRes, draftsRes, alertsRes, eventsRes] = await Promise.all([
    rls
      .from("client_documents")
      .select(
        "id, title, kind, content_type, created_at, client_visible, intellengine_draft_id, extraction_status, extracted, extracted_at, extraction_error, review_note",
      )
      .eq("client_id", opts.clientId)
      .order("created_at", { ascending: false }),
    rls
      .from("client_profile_changes")
      .select("field, old_value, new_value, committed_at, committed_by_email, note, commit_id")
      .eq("client_id", opts.clientId)
      .order("committed_at", { ascending: false }),
    // `any` on the builder, then narrowed on the result: the joined select sends the Supabase
    // generic into "type instantiation is excessively deep", the same reason the roadmap page
    // does this.
    (svc.from("review_cards") as any)
      .select(CARD_COLUMNS)
      .eq("client_id", opts.clientId)
      .neq("card_type", "prospect")
      .order("created_at", { ascending: false }),
    svc
      .from("intellengine_drafts")
      .select("id, title, status, content, card_id")
      .eq("client_id", opts.clientId)
      .order("created_at", { ascending: false }),
    svc
      .from("grant_alerts")
      .select("subject, status, created_at, grant_id")
      .eq("client_id", opts.clientId)
      .order("created_at", { ascending: false }),
    svc
      .from("pipeline_events")
      .select("event_type, occurred_at, grant_id")
      .eq("client_id", opts.clientId)
      .order("occurred_at", { ascending: false }),
  ]);

  const cards = (cardsRes.data ?? []) as PackCard[];

  // Concept proposals hang off cards, so this one read has to wait for the card ids. Skipped
  // entirely when there are no cards rather than issuing an `in ()` against an empty list.
  let concepts: PackConcept[] = [];
  if (cards.length) {
    const { data } = await svc
      .from("concept_proposals")
      .select("card_id, status, proposal_data, generated_at, edited_at")
      .in(
        "card_id",
        cards.map((c) => c.id),
      );
    concepts = (data ?? []) as PackConcept[];
  }

  const pack = buildContextPack({
    generatedAt: opts.generatedAt,
    generatedBy: opts.generatedBy,
    actorRole: opts.actorRole,
    client,
    documents: (docsRes.data ?? []) as PackDocument[],
    changes: (changesRes.data ?? []) as PackChange[],
    cards,
    concepts,
    drafts: (draftsRes.data ?? []) as PackDraft[],
    alerts: (alertsRes.data ?? []) as PackAlert[],
    events: (eventsRes.data ?? []) as PackEvent[],
  });

  return { pack, clientName: client.name };
}
