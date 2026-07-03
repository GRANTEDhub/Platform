"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { validateConstraint } from "@/lib/grants/constraints";
import { refreshClientUSASpendingById } from "@/lib/grants/usaspending-refresh";
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
  const csv = (k: string) =>
    get(k)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  return {
    name: get("name"),
    org_type: get("org_type"),
    status: get("status") || "active",
    engagement_tier: get("engagement_tier"),
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
    primary_funding_needs: csv("primary_funding_needs"),
    project_stage: get("project_stage"),
    match_cost_share_capacity: get("match_cost_share_capacity"),
    federal_grant_history: get("federal_grant_history"),
    sam_uei_status: get("sam_uei_status"),
    known_constraints: get("known_constraints"),
    // Matching configuration (matcher-consumed, previously editable nowhere).
    service_area: csv("service_area"),
    matching_rules: get("matching_rules"),
    hard_constraints: parseConstraints(get("hard_constraints")),
  };
}

export async function createClientAction(formData: FormData) {
  await requireAdmin();
  const supabase = createClient();
  const payload = parse(formData);
  if (!payload.name) throw new Error("Client name is required");

  const { data, error } = await supabase
    .from("clients")
    .insert(payload)
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  // Cache USASpending history in the background so it's ready before the first
  // match run -- never blocks the save (must be kicked before redirect throws).
  waitUntil(refreshClientUSASpendingById(createServiceClient(), data.id));

  revalidatePath("/clients");
  revalidatePath("/dashboard");
  redirect(`/clients/${data.id}`);
}

export async function updateClientAction(id: string, formData: FormData) {
  await requireAdmin();
  const supabase = createClient();
  const payload = parse(formData);
  if (!payload.name) throw new Error("Client name is required");

  const { error } = await supabase.from("clients").update(payload).eq("id", id);
  if (error) throw new Error(error.message);

  // Re-cache USASpending in the background (name / search-name may have changed).
  waitUntil(refreshClientUSASpendingById(createServiceClient(), id));

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${id}`);
}
