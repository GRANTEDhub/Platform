import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mintAccessToken } from "@/lib/tokens";
import { normalizeOrgName } from "@/lib/grants/discover";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Prospect } from "@/types/database";

// Admin-only "Start outreach" (P2.5): promote a scored Track-2 prospect into a
// tracked lead carrying its grant-match context, so warm outreach is grounded in
// the fit we already scored. Eager promotion (at outreach-decision time), since
// our outbound is curated/warm, not spray-and-pray.
//
// Three identity outcomes, resolved by normalized org name (dedup first):
//   - existing NON-LEAD client (active/paused/closed/converted): do NOT create a
//     lead. Attach the grant as a hook on that client + a routed_to_client event
//     so their account manager can pursue it. (Discovery already excludes current
//     clients, so this is the rare become-a-client-since-discovery case.)
//   - existing un-converted lead: attach a hook to it (a lead accrues hooks as
//     more grants fit) + mint a fresh lead-bound scheduling token.
//   - no match: create a clients row (pipeline_stage='outbound_new',
//     lead_source='grant_match', status='lead') + hook + lead-bound token.
//
// Writes run under the service role (bypasses RLS) after an in-route admin gate,
// consistent with the other admin mutation routes. The P0 lead RLS governs
// contractor reads, not these writes.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { grantId?: string };
  if (!body.grantId) {
    return NextResponse.json({ error: "grantId is required" }, { status: 400 });
  }
  const grantId = body.grantId;

  const db = createServiceClient();

  const { data: prospect } = await db
    .from("prospects")
    .select("*")
    .eq("id", params.id)
    .single<Prospect>();
  if (!prospect) return NextResponse.json({ error: "Prospect not found" }, { status: 404 });

  // The scored card for this (grant, prospect) is the snapshot source. Snapshot
  // onto the hook so the grounding survives prospect-row cleanup.
  const { data: card } = await db
    .from("review_cards")
    .select("id, fit_score, proposed_role, recommended_prime, why_this_org, concept_synopsis")
    .eq("grant_id", grantId)
    .eq("prospect_id", params.id)
    .eq("card_type", "prospect")
    .maybeSingle();

  const hookFields = {
    grant_id: grantId,
    prospect_id: params.id,
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

  // Idempotent: unique (client_id, grant_id) means re-running "Start outreach"
  // for the same grant never duplicates the hook.
  const attachHook = (clientId: string) =>
    db
      .from("lead_grant_hooks")
      .upsert({ client_id: clientId, ...hookFields }, { onConflict: "client_id,grant_id", ignoreDuplicates: true });

  // Dedup by normalized org name across ALL client rows (leads included -- this
  // is a service-role read, so RLS does not hide leads here, which is what we want).
  const { data: allClients } = await db
    .from("clients")
    .select("id, name, status, pipeline_stage, account_manager_id");
  const target = normalizeOrgName(prospect.name);
  const match = (allClients ?? []).find((c) => normalizeOrgName(c.name) === target) as
    | { id: string; name: string; status: string; pipeline_stage: string | null; account_manager_id: string | null }
    | undefined;

  const origin = new URL(req.url).origin;

  // ── Existing non-lead client: route to their account manager, no new lead ──
  if (match && !isUnconvertedLead(match.pipeline_stage)) {
    await attachHook(match.id);
    await db.from("pipeline_events").insert({
      event_type: "routed_to_client",
      client_id: match.id,
      prospect_id: params.id,
      grant_id: grantId,
      subject_snapshot: { name: prospect.name },
      metadata: { ...eventMeta, account_manager_id: match.account_manager_id },
    });
    return NextResponse.json({
      outcome: "routed_to_client",
      clientId: match.id,
      clientName: match.name,
      accountManagerId: match.account_manager_id,
    });
  }

  // ── Existing un-converted lead: attach hook + fresh lead-bound token ──
  if (match) {
    await attachHook(match.id);
    const minted = await mintAccessToken(db, {
      actionType: "lead_schedule_call",
      clientId: match.id,
      grantId,
      createdBy: user.id,
    });
    await db.from("pipeline_events").insert({
      event_type: "hook_attached",
      client_id: match.id,
      prospect_id: params.id,
      grant_id: grantId,
      token_id: minted?.id ?? null,
      subject_snapshot: { name: prospect.name },
      metadata: eventMeta,
    });
    return NextResponse.json({
      outcome: "attached_to_lead",
      clientId: match.id,
      leadName: match.name,
      url: minted ? `${origin}/go/${minted.rawToken}` : null,
    });
  }

  // ── No match: create the lead, snapshot the hook, mint the token ──
  const { data: lead, error: leadErr } = await db
    .from("clients")
    .insert({
      name: prospect.name,
      org_type: prospect.org_type,
      status: "lead", // non-active so the matcher never scores it (mirrors isUnconvertedLead)
      pipeline_stage: "discovery_pending", // entry stage (was outbound_new); intake is a flag, not a gate
      lead_source: "grant_match",
      location_state: prospect.location_state,
      location_county: prospect.location_county,
      notes: prospect.capability_summary
        ? `Capability (from discovery): ${prospect.capability_summary}`
        : null,
    })
    .select("id, name")
    .single();
  if (leadErr || !lead) {
    console.error("Start-outreach: lead insert failed", leadErr);
    return NextResponse.json({ error: "Failed to create the lead." }, { status: 500 });
  }

  await attachHook(lead.id);
  const minted = await mintAccessToken(db, {
    actionType: "lead_schedule_call",
    clientId: lead.id,
    grantId,
    createdBy: user.id,
  });
  await db.from("pipeline_events").insert({
    event_type: "lead_created",
    client_id: lead.id,
    prospect_id: params.id,
    grant_id: grantId,
    token_id: minted?.id ?? null,
    subject_snapshot: { name: prospect.name },
    metadata: eventMeta,
  });

  return NextResponse.json({
    outcome: "lead_created",
    clientId: lead.id,
    leadName: lead.name,
    url: minted ? `${origin}/go/${minted.rawToken}` : null,
  });
}
