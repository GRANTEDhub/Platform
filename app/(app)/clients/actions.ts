"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";

function parse(formData: FormData) {
  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
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
    primary_funding_needs: get("primary_funding_needs")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? null,
    project_stage: get("project_stage"),
    match_cost_share_capacity: get("match_cost_share_capacity"),
    federal_grant_history: get("federal_grant_history"),
    sam_uei_status: get("sam_uei_status"),
    known_constraints: get("known_constraints"),
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

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${id}`);
}
