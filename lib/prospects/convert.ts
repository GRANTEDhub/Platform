import "server-only";
import { mintAccessToken } from "@/lib/tokens";
import { normalizeOrgName } from "@/lib/grants/discover";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { createServiceClient } from "@/lib/supabase/server";
import type { Prospect } from "@/types/database";

// Promote a scored Track-2 prospect into a tracked lead carrying its grant-match
// context, so outreach (a booking link or an emailed grant one-pager) is grounded
// in the fit we already scored. Shared by "Start outreach" (POST /api/prospects/
// [id]/start-outreach) and the prospect grant-alert send, so both land the
// prospect in the pipeline through ONE implementation.
//
// Dedup by normalized org name gives idempotency for free -- three outcomes:
//   - routed_to_client : org is already a NON-lead client -> attach the grant as a
//                        hook + routed_to_client event, do NOT create a lead.
//   - attached_to_lead : an un-converted lead exists -> attach a hook (+ token if
//                        requested); fill its contact email if it has none.
//   - lead_created     : no match -> create the lead (with the prospect's contact
//                        email/name if provided) + hook (+ token if requested).
//
// contactEmail/contactName (from the prospect card) are carried onto the lead
// fill-if-empty -- never overwriting an existing contact. mintScheduleToken mints
// a lead-bound /go token for the booking-link flow; the alert send skips it.

type Db = ReturnType<typeof createServiceClient>;

export type ConvertOutcome = {
  outcome: "routed_to_client" | "attached_to_lead" | "lead_created";
  clientId: string;
  name: string;
  accountManagerId?: string | null;
  scheduleUrl?: string | null;
};

export async function convertProspectToLead(
  db: Db,
  opts: {
    prospect: Prospect;
    grantId: string;
    userId: string;
    origin?: string;
    contactEmail?: string | null;
    contactName?: string | null;
    mintScheduleToken?: boolean;
  },
): Promise<ConvertOutcome> {
  const { prospect, grantId, userId } = opts;
  const email = opts.contactEmail?.trim() || null;
  const name = opts.contactName?.trim() || null;

  // The scored card for this (grant, prospect) is the snapshot source. Snapshot
  // onto the hook so the grounding survives prospect-row cleanup.
  const { data: card } = await db
    .from("review_cards")
    .select("id, fit_score, proposed_role, recommended_prime, why_this_org, concept_synopsis")
    .eq("grant_id", grantId)
    .eq("prospect_id", prospect.id)
    .eq("card_type", "prospect")
    .maybeSingle();

  const hookFields = {
    grant_id: grantId,
    prospect_id: prospect.id,
    review_card_id: card?.id ?? null,
    fit_score: card?.fit_score ?? null,
    proposed_role: card?.proposed_role ?? null,
    recommended_prime: card?.recommended_prime ?? null,
    why_snapshot: card?.why_this_org ?? null,
    concept_snapshot: card?.concept_synopsis ?? null,
  };
  const eventMeta = {
    fit_score: card?.fit_score ?? null,
    proposed_role: card?.proposed_role ?? null,
    recommended_prime: card?.recommended_prime ?? null,
    source_url: prospect.source_url,
  };

  const attachHook = (clientId: string) =>
    db
      .from("lead_grant_hooks")
      .upsert({ client_id: clientId, ...hookFields }, { onConflict: "client_id,grant_id", ignoreDuplicates: true });

  // Fill the lead's contact email/name only if it has none -- never overwrite.
  const fillContactIfEmpty = async (clientId: string) => {
    if (!email && !name) return;
    const patch: Record<string, string> = {};
    if (email) patch.primary_contact_email = email;
    if (name) patch.primary_contact_name = name;
    // Fill only when the lead has no email on file -- never overwrite a real
    // contact. (Freshly created leads and grant-match leads carry null here.)
    await db
      .from("clients")
      .update(patch)
      .eq("id", clientId)
      .is("primary_contact_email", null);
  };

  // Dedup by normalized org name across ALL client rows (leads included --
  // service-role read, so RLS does not hide leads here, which is what we want).
  const { data: allClients } = await db
    .from("clients")
    .select("id, name, status, pipeline_stage, account_manager_id");
  const target = normalizeOrgName(prospect.name);
  const match = (allClients ?? []).find((c) => normalizeOrgName(c.name) === target) as
    | { id: string; name: string; status: string; pipeline_stage: string | null; account_manager_id: string | null }
    | undefined;

  // ── Existing non-lead client: route to their account manager, no new lead ──
  if (match && !isUnconvertedLead(match.pipeline_stage)) {
    await attachHook(match.id);
    await db.from("pipeline_events").insert({
      event_type: "routed_to_client",
      client_id: match.id,
      prospect_id: prospect.id,
      grant_id: grantId,
      subject_snapshot: { name: prospect.name },
      metadata: { ...eventMeta, account_manager_id: match.account_manager_id },
    });
    return { outcome: "routed_to_client", clientId: match.id, name: match.name, accountManagerId: match.account_manager_id };
  }

  // ── Existing un-converted lead: attach hook (+ optional token), fill contact ──
  if (match) {
    await attachHook(match.id);
    await fillContactIfEmpty(match.id);
    const minted = opts.mintScheduleToken
      ? await mintAccessToken(db, { actionType: "lead_schedule_call", clientId: match.id, grantId, createdBy: userId })
      : null;
    await db.from("pipeline_events").insert({
      event_type: "hook_attached",
      client_id: match.id,
      prospect_id: prospect.id,
      grant_id: grantId,
      token_id: minted?.id ?? null,
      subject_snapshot: { name: prospect.name },
      metadata: eventMeta,
    });
    return {
      outcome: "attached_to_lead",
      clientId: match.id,
      name: match.name,
      scheduleUrl: minted && opts.origin ? `${opts.origin}/go/${minted.rawToken}` : null,
    };
  }

  // ── No match: create the lead (with contact if provided), hook (+ token) ──
  const { data: lead, error: leadErr } = await db
    .from("clients")
    .insert({
      name: prospect.name,
      org_type: prospect.org_type,
      status: "lead", // non-active so the matcher never scores it (mirrors isUnconvertedLead)
      pipeline_stage: "discovery_pending", // entry stage; intake is a flag, not a gate
      lead_source: "grant_match",
      location_state: prospect.location_state,
      location_county: prospect.location_county,
      primary_contact_email: email,
      primary_contact_name: name,
      notes: prospect.capability_summary ? `Capability (from discovery): ${prospect.capability_summary}` : null,
    })
    .select("id, name")
    .single();
  if (leadErr || !lead) {
    throw new Error(`Failed to create the lead: ${leadErr?.message ?? "unknown"}`);
  }

  await attachHook(lead.id);
  const minted = opts.mintScheduleToken
    ? await mintAccessToken(db, { actionType: "lead_schedule_call", clientId: lead.id, grantId, createdBy: userId })
    : null;
  await db.from("pipeline_events").insert({
    event_type: "lead_created",
    client_id: lead.id,
    prospect_id: prospect.id,
    grant_id: grantId,
    token_id: minted?.id ?? null,
    subject_snapshot: { name: prospect.name },
    metadata: eventMeta,
  });

  return {
    outcome: "lead_created",
    clientId: lead.id,
    name: lead.name,
    scheduleUrl: minted && opts.origin ? `${opts.origin}/go/${minted.rawToken}` : null,
  };
}
