"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireUser } from "@/lib/auth";
import { validateConstraint } from "@/lib/grants/constraints";
import { enrichClient } from "@/lib/clients/enrich";
import { parseNarrative, narrativeToIntakeData, parseChipList } from "@/lib/intake/narrative";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { removeObjects } from "@/lib/storage";
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
    website: get("website"),
    location_street: get("location_street"),
    location_city: get("location_city"),
    location_county: get("location_county"),
    location_state: get("location_state") || "AR",
    location_zip: get("location_zip"),
    retainer_hours: get("retainer_hours") ? Number(get("retainer_hours")) : 0,
    contract_start: get("contract_start"),
    contract_end: get("contract_end"),
    next_step: get("next_step"),
    notes: get("notes"),
    // Grant-matching profile
    rucc_codes: get("rucc_codes"),
    annual_budget: get("annual_budget"),
    // Staff-entered EIN drives the IRS-990 budget pull (enrichClient). The cached
    // nonprofit_finance + checked_at are auto-pulled and deliberately omitted from
    // the payload so a save PRESERVES them (never hand-entered, like usaspending).
    ein: get("ein"),
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
    // Research-grants opt-in (migration 0051). Checkbox shown only for small_business /
    // higher_education; an unchecked/hidden box submits nothing -> false. Default off.
    research_opt_in: get("research_opt_in") === "true",
    // Premium tier gate (migration 0059): an account manager reviews + releases each
    // match before the client sees it. Prospects can't be account-managed.
    account_managed: isProspect ? false : get("account_managed") === "true",
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

  // Record type must be an EXPLICIT choice on CREATE. The UI gates the form on it;
  // this backstops any submit that arrives without it (JS disabled, a crafted
  // request) rather than parse() silently coercing a missing kind to 'client'.
  // Scoped to create only -- parse()/updateClientAction and the direct-insert paths
  // (public intake, prospect convert) never rely on the kind default, so they are
  // untouched.
  const rawKind = formData.get("kind");
  if (rawKind !== "client" && rawKind !== "prospect") {
    return { error: "Choose a record type (client or prospect)." };
  }

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
  const { payload, narrative } = parsed;
  if (!payload.name) return { error: "Client name is required." };

  // Match generation is MANUAL-ONLY: a new record is created with
  // initial_match_status = null (the column default) and is NEVER auto-enqueued.
  // The one-time match runs only when someone clicks "Generate report" on the
  // dashboard, which flips the record to 'queued' and kicks drainClientMatchQueue
  // immediately (POST /api/clients/[id]/generate-report). Auto-enqueuing on create
  // left the record stuck behind the 10-min cron AND disabled the manual button
  // (disabled-while-queued), so no match could start at all -- hence it's gone.
  const { data, error } = await supabase
    .from("clients")
    .insert({
      ...payload,
      intake_data: narrativeToIntakeData(narrative),
    })
    .select("id")
    .single();

  // Duplicate name (23505) and any other insert error come back as a friendly
  // message the form shows inline -- never a thrown 500.
  const friendly = friendlyClientError(error, payload.name);
  if (friendly) return { error: friendly };
  if (!data) return { error: "Could not create the record — please try again." };

  // Enrich in the background (USASpending cache, then the client-profile refine),
  // kicked before redirect throws so it never blocks the save. Matching does NOT
  // run here -- it is drained separately -- so this is bounded work. Occupancy is
  // profile-free, so if the drain scores a pair before this finishes the card just
  // falls back to the Phase-1 narrative; a failed refine leaves client_profile null.
  const bg = createServiceClient();
  const clientId = data.id;
  waitUntil(enrichClient(bg, clientId));

  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/clients");
  // Land on the API-data CONFIRM step rather than the dashboard. The pulls above are
  // fire-and-forget, so this is the one moment a human is present to see what they
  // returned -- and the EIN name lookup deliberately refuses ambiguous matches, so
  // "no result" is a normal outcome that needs a person, not an error to bury. The
  // screen reports observed state only and never blocks: "continue" is always there.
  redirect(`/clients/${clientId}/api-data?new=1`);
}

export async function updateClientAction(
  id: string,
  formData: FormData,
): Promise<ClientActionResult> {
  // Any staff (admin OR contractor/AM) may edit a client or prospect PROFILE. The
  // write runs under the caller's RLS -- the 0066 clients_update policy permits
  // staff -- and the billing tables (invoices/contracts) stay admin-only, so this
  // never exposes what we bill. (createClientAction stays admin-only.)
  await requireUser();
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
  revalidatePath("/clients");
  redirect(`/clients/${id}`);
}

// ── Delete a client or prospect, permanently ──────────────────────────────────
//
// Built for TEST-DATA CHURN: creating and discarding throwaway records without
// hand-written SQL. It is a real delete, not an archive flag, so the guardrails are
// the typed-name confirmation and the impact counts shown next to the button.
//
// WHAT THE DATABASE DOES FOR US. 12 client-owned tables declare
// `on delete cascade` (review_cards, match_attempts, match_feedback,
// match_pair_locks, client_members, client_documents, contracts, invoices,
// time_entries, lead_grant_hooks, forecast_rejections, intellengine_drafts), so one
// delete clears them atomically -- no migration, and no hand-maintained list to fall
// out of date as tables are added.
//
// WHAT IT DOESN'T. Three tables are `on delete set null`: grant_alerts,
// concept_proposals and pipeline_events. Those rows SURVIVE with a null client_id.
//   - grant_alerts + concept_proposals are deleted explicitly here. Once the client
//     is gone they are unreachable litter, and grant_alerts also owns a stored PDF.
//     They must go FIRST -- after the client row is deleted, client_id is null and
//     they can no longer be found by it.
//   - pipeline_events is left alone on purpose: it is the audit trail, it carries no
//     storage, and "this record existed and was removed" is worth keeping.
//
// ORDER. Storage paths are collected first, the database delete runs second, and the
// file removal runs last using the already-collected paths. Deleting files first
// would leave rows pointing at missing objects if the delete then failed; deleting
// the rows first without collecting paths would lose the pointers forever (the
// client_documents rows cascade away). This order means a failed delete changes
// nothing, and a failed file cleanup leaks only files -- logged, and recoverable.
export async function deleteClientAction(
  id: string,
  formData: FormData,
): Promise<ClientActionResult> {
  // Admin-only, matching createClientAction. Deleting is strictly more dangerous
  // than creating, so it is never loosened to the contractor/AM role that may edit.
  await requireAdmin();

  const service = createServiceClient();
  const { data: row } = await service
    .from("clients")
    .select("id, name, pipeline_stage")
    .eq("id", id)
    .single<{ id: string; name: string | null; pipeline_stage: string | null }>();
  if (!row) return { error: "That record no longer exists." };

  const kindLabel = isUnconvertedLead(row.pipeline_stage) ? "prospect" : "client";

  // Type-the-name confirmation. Compared case- and whitespace-insensitively: the
  // point is to prove you know WHICH record you are deleting, not to test typing.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const typed = String(formData.get("confirm_name") ?? "");
  if (!norm(typed) || norm(typed) !== norm(row.name ?? "")) {
    return { error: `Type the ${kindLabel}'s exact name to confirm deletion.` };
  }

  // Collect storage objects BEFORE anything is deleted (client_documents cascades,
  // so its pointers vanish with the client row).
  const [{ data: docRows }, { data: alertRows }] = await Promise.all([
    service.from("client_documents").select("storage_bucket, storage_path").eq("client_id", id),
    service.from("grant_alerts").select("storage_bucket, storage_path").eq("client_id", id),
  ]);
  const objects = [...(docRows ?? []), ...(alertRows ?? [])] as {
    storage_bucket: string | null;
    storage_path: string | null;
  }[];

  // The two set-null tables that should not outlive their client.
  await service.from("grant_alerts").delete().eq("client_id", id);
  await service.from("concept_proposals").delete().eq("client_id", id);

  const { error: delErr } = await service.from("clients").delete().eq("id", id);
  if (delErr) {
    console.error(`[client-delete] failed id=${id}:`, delErr.message);
    return { error: `Couldn't delete this ${kindLabel}: ${delErr.message}` };
  }

  // Best-effort file cleanup. The record is already gone, so a storage failure must
  // not surface as "delete failed" -- it is logged and leaves only orphaned bytes.
  const byBucket = new Map<string, string[]>();
  for (const o of objects) {
    if (!o.storage_bucket || !o.storage_path) continue;
    byBucket.set(o.storage_bucket, [...(byBucket.get(o.storage_bucket) ?? []), o.storage_path]);
  }
  for (const [bucket, paths] of byBucket) {
    try {
      await removeObjects(bucket, paths);
    } catch (err) {
      console.error(
        `[client-delete] storage cleanup failed bucket=${bucket} count=${paths.length}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  revalidatePath("/clients");
  revalidatePath("/intel/prospects");
  redirect("/clients");
}
