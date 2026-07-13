"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { validateConstraint } from "@/lib/grants/constraints";
import { enrichClient } from "@/lib/clients/enrich";
import { runInitialMatchForClient } from "@/lib/grants/initial-match";
import { parseNarrative, narrativeToIntakeData, parseChipList } from "@/lib/intake/narrative";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { HardConstraint } from "@/types/database";

// Parse + validate the hard_constraints hidden field (JSON from the picker).
// Reject-on-save: a malformed constraint throws with a specific message rather
// than being silently dropped, so the admin learns the gate is invalid now
// instead of discovering later that it never fired. `action` is ignored here --
// validateConstraint derives it from type.
function parseConstraints(json: string | null): HardConstraint[] | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Matching constraints are malformed (invalid JSON).");
  }
  if (!Array.isArray(parsed)) throw new Error("Matching constraints must be a list.");
  const valid: HardConstraint[] = [];
  parsed.forEach((entry, i) => {
    const v = validateConstraint(entry);
    if (!v.ok) throw new Error(`Constraint #${i + 1}: ${v.error}`);
    valid.push(v.constraint);
  });
  return valid.length ? valid : null;
}

function parse(formData: FormData) {
  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  // Narrative (shared component -> hidden `intake_narrative` JSON). Its checked
  // priority areas are the single source for the primary_funding_needs column
  // (the matcher reads that column); the full narrative goes to intake_data.
  const narrative = parseNarrative(get("intake_narrative"));

  // Kind drives the prospect-safe write, SERVER-AUTHORITATIVELY (the client only
  // hides the engagement fields). THE invariant: runMatching scores a row iff
  // pipeline_stage IS NULL or 'converted'. So a prospect MUST get a non-null,
  // non-'converted' stage ('discovery_pending') or it would be scored as a live
  // client. A client gets pipeline_stage=null (scored) -- set explicitly so an
  // edit-time prospect->client flip resets it.
  const kind: "client" | "prospect" = get("kind") === "prospect" ? "prospect" : "client";
  const isProspect = kind === "prospect";

  const payload = {
    name: get("name"),
    org_type: get("org_type"),
    status: isProspect ? "lead" : get("status") || "active",
    engagement_tier: isProspect ? null : get("engagement_tier"),
    pipeline_stage: isProspect ? "discovery_pending" : null,
    lead_source: isProspect ? "outbound" : null,
    primary_contact_name: get("primary_contact_name"),
    primary_contact_email: get("primary_contact_email"),
    primary_contact_phone: get("primary_contact_phone"),
    location_city: get("location_city"),
    location_county: get("location_county"),
    location_state: get("location_state") || "AR",
    retainer_hours: get("retainer_hours") ? Number(get("retainer_hours")) : 0,
    contract_start: get("contract_start"),
    contract_end: get("contract_end"),
    next_step: get("next_step"),
    notes: get("notes"),
    // Grant-matching profile
    rucc_codes: get("rucc_codes"),
    annual_budget: get("annual_budget"),
    primary_funding_needs: narrative.priority_areas.length ? narrative.priority_areas : null,
    project_stage: get("project_stage"),
    match_cost_share_capacity: get("match_cost_share_capacity"),
    // federal_grant_history + sam_uei_status are no longer hand-entered on the
    // admin form: USASpending auto-pulls history (enrichClient) and the SAM.gov
    // bind tool owns registration. Omitted from the payload so a save PRESERVES
    // any existing stored value rather than nulling it.
    known_constraints: get("known_constraints"),
    // Matching configuration (matcher-consumed, previously editable nowhere).
    service_area: parseChipList(get("service_area")),
    matching_rules: get("matching_rules"),
    hard_constraints: parseConstraints(get("hard_constraints")),
  };
  return { payload, narrative, kind };
}

// A duplicate org name trips the clients_name_uniq constraint (Postgres 23505).
// Surface a friendly message instead of the raw DB error.
function friendlyClientError(
  error: { code?: string; message: string } | null,
  name: string | null,
): string | null {
  if (!error) return null;
  if (error.code === "23505") {
    return `An organization named "${name ?? ""}" already exists — edit that record instead.`;
  }
  return error.message;
}

// Expected validation failures return this to the form (rendered inline by
// ClientForm) instead of throwing -- a thrown error in a server action renders as
// a 500 "Application error" page, not a form error. Success paths call redirect()
// (return type never), so a normal completion never returns a value. NOT exported:
// a "use server" module may only export async functions, so ClientForm mirrors
// this shape in its own prop type.
type ClientActionResult = { error: string } | undefined;

export async function createClientAction(formData: FormData): Promise<ClientActionResult> {
  await requireAdmin();
  const supabase = createClient();

  // parse() throws on a malformed matcher-constraints payload -- an expected
  // validation failure, so surface it inline rather than as a 500. The redirect()
  // on success stays OUTSIDE any try/catch so its NEXT_REDIRECT control-flow is
  // never swallowed and mistaken for an error.
  let parsed;
  try {
    parsed = parse(formData);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not read the form." };
  }
  const { payload, narrative, kind } = parsed;
  if (!payload.name) return { error: "Client name is required." };

  // A new prospect fires a ONE-TIME match against the current grant pool so its
  // dashboard fills without waiting on the daily batch. Stamp 'running' at insert
  // time -- it drives the dashboard "matching in progress" banner AND guards the
  // run from double-firing. Active clients get no one-time run (the daily batch
  // covers them), so their status stays null.
  const isProspect = kind === "prospect";
  const { data, error } = await supabase
    .from("clients")
    .insert({
      ...payload,
      intake_data: narrativeToIntakeData(narrative),
      ...(isProspect ? { initial_match_status: "running" } : {}),
    })
    .select("id")
    .single();

  // Duplicate name (23505) and any other insert error come back as a friendly
  // message the form shows inline -- never a thrown 500.
  const friendly = friendlyClientError(error, payload.name);
  if (friendly) return { error: friendly };
  if (!data) return { error: "Could not create the record — please try again." };

  // Background work, kicked before redirect throws (never blocks the save). Enrich
  // first (USASpending cache, then the client-profile refine) so both are ready
  // before scoring; for a prospect, chain the one-time match after enrich so it
  // reads the enriched org. A failed refine leaves client_profile null but the
  // match still runs. runInitialMatchForClient stamps 'complete'/'error' itself.
  const bg = createServiceClient();
  const clientId = data.id;
  waitUntil(
    isProspect
      ? (async () => {
          await enrichClient(bg, clientId);
          await runInitialMatchForClient(bg, clientId);
        })()
      : enrichClient(bg, clientId),
  );

  revalidatePath("/clients");
  revalidatePath("/dashboard");
  redirect(`/clients/${clientId}`);
}

export async function updateClientAction(
  id: string,
  formData: FormData,
): Promise<ClientActionResult> {
  await requireAdmin();
  const supabase = createClient();

  // Same as createClientAction: expected validation failures return inline; the
  // redirect() on success stays outside any try/catch.
  let parsed;
  try {
    parsed = parse(formData);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not read the form." };
  }
  const { payload, narrative, kind } = parsed;
  if (!payload.name) return { error: "Client name is required." };

  // Merge the narrative into existing intake_data -- never clobber non-narrative
  // keys (phone, org_type_code, referral_source, submitted_at from a public intake).
  // pipeline_stage rides along for the kind-flip audit (client<->prospect).
  const { data: existing } = await supabase
    .from("clients")
    .select("intake_data, pipeline_stage, lead_source")
    .eq("id", id)
    .single();
  const mergedIntake = {
    ...((existing?.intake_data as Record<string, unknown> | null) ?? {}),
    ...narrativeToIntakeData(narrative),
  };
  const oldKind = isUnconvertedLead(existing?.pipeline_stage as string | null) ? "prospect" : "client";
  const flipped = oldKind !== kind;

  // Lifecycle fields (pipeline_stage, lead_source) are rewritten ONLY on a genuine
  // kind FLIP. A non-flip edit PRESERVES the stored lifecycle -- otherwise every
  // edit would reset a 'converted' client to null (orphaning converted_at,
  // dropping it from the Converted card) and resurrect a terminal
  // 'rejected'/'archived' lead to 'discovery_pending'. On a flip, parse()'s
  // kind-derived values apply (client->prospect: discovery_pending/outbound;
  // prospect->client: null/null).
  const lifecycle = flipped
    ? { pipeline_stage: payload.pipeline_stage, lead_source: payload.lead_source }
    : {
        pipeline_stage: (existing?.pipeline_stage as string | null) ?? null,
        lead_source: (existing?.lead_source as string | null) ?? null,
      };

  const { error } = await supabase
    .from("clients")
    .update({ ...payload, ...lifecycle, intake_data: mergedIntake })
    .eq("id", id);
  const friendly = friendlyClientError(error, payload.name);
  if (friendly) return { error: friendly };

  // Audit a client<->prospect flip (a promote/demote outside the normal convert
  // flow). Service role: mirrors the public-intake pipeline_events write.
  if (flipped) {
    const service = createServiceClient();
    await service
      .from("pipeline_events")
      .insert({
        event_type: "kind_changed",
        client_id: id,
        subject_snapshot: { name: payload.name },
        metadata: { from: oldKind, to: kind },
      });

    // Demoting a client -> prospect: it drops out of the daily batch (now an
    // un-converted lead), so its PENDING cards would otherwise sit stale forever
    // with no run to refresh or retire them. Clear the pending ones; PRESERVE any
    // human-decided card (approved / passed) -- those are a record of a real
    // decision, never silently erased. Re-promoting later re-scores from scratch.
    if (kind === "prospect") {
      await service
        .from("review_cards")
        .delete()
        .eq("client_id", id)
        .eq("decision", "pending");
    }
  }

  // Re-enrich in the background: re-cache USASpending (name / search-name may have
  // changed) then re-refine the client profile (inputs changed on edit).
  waitUntil(enrichClient(createServiceClient(), id));

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${id}`);
}
