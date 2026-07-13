"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { validateConstraint } from "@/lib/grants/constraints";
import { enrichClient } from "@/lib/clients/enrich";
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
    federal_grant_history: get("federal_grant_history"),
    sam_uei_status: get("sam_uei_status"),
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

export async function createClientAction(formData: FormData) {
  await requireAdmin();
  const supabase = createClient();
  const { payload, narrative } = parse(formData);
  if (!payload.name) throw new Error("Client name is required");

  const { data, error } = await supabase
    .from("clients")
    .insert({ ...payload, intake_data: narrativeToIntakeData(narrative) })
    .select("id")
    .single();

  const friendly = friendlyClientError(error, payload.name);
  if (friendly) throw new Error(friendly);
  if (!data) throw new Error("Client insert returned no row");

  // Enrich in the background (USASpending cache, then the client-profile refine)
  // so both are ready before the first match run -- never blocks the save (must be
  // kicked before redirect throws). A failed refine leaves client_profile null.
  waitUntil(enrichClient(createServiceClient(), data.id));

  revalidatePath("/clients");
  revalidatePath("/dashboard");
  redirect(`/clients/${data.id}`);
}

export async function updateClientAction(id: string, formData: FormData) {
  await requireAdmin();
  const supabase = createClient();
  const { payload, narrative, kind } = parse(formData);
  if (!payload.name) throw new Error("Client name is required");

  // Merge the narrative into existing intake_data -- never clobber non-narrative
  // keys (phone, org_type_code, referral_source, submitted_at from a public intake).
  // pipeline_stage rides along for the kind-flip audit (client<->prospect).
  const { data: existing } = await supabase
    .from("clients")
    .select("intake_data, pipeline_stage")
    .eq("id", id)
    .single();
  const mergedIntake = {
    ...((existing?.intake_data as Record<string, unknown> | null) ?? {}),
    ...narrativeToIntakeData(narrative),
  };
  const oldKind = isUnconvertedLead(existing?.pipeline_stage as string | null) ? "prospect" : "client";

  const { error } = await supabase
    .from("clients")
    .update({ ...payload, intake_data: mergedIntake })
    .eq("id", id);
  const friendly = friendlyClientError(error, payload.name);
  if (friendly) throw new Error(friendly);

  // Audit a client<->prospect flip (a promote/demote outside the normal convert
  // flow). Service role: mirrors the public-intake pipeline_events write.
  if (oldKind !== kind) {
    await createServiceClient()
      .from("pipeline_events")
      .insert({
        event_type: "kind_changed",
        client_id: id,
        subject_snapshot: { name: payload.name },
        metadata: { from: oldKind, to: kind },
      });
  }

  // Re-enrich in the background: re-cache USASpending (name / search-name may have
  // changed) then re-refine the client profile (inputs changed on edit).
  waitUntil(enrichClient(createServiceClient(), id));

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${id}`);
}
