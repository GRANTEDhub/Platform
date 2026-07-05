"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { SETTABLE_STAGES, type SettableStage } from "@/lib/leads/events";

// Lead pipeline mutations. All admin-gated (requireAdmin) and written via the
// service role, because pipeline_events has no INSERT policy (service-role only,
// like the outbound door) and the lead rows are admin-only. Every mutation logs a
// pipeline_event so the timeline is the single source of truth for what happened.

function isSettable(s: string): s is SettableStage {
  return (SETTABLE_STAGES as readonly string[]).includes(s);
}

// Move a lead to a stored human stage. Derived stages are never hand-set here.
// Archiving requires a reason. Logs a stage_change event with from/to.
export async function setLeadStage(leadId: string, stage: string, reason?: string | null) {
  await requireAdmin();
  if (!isSettable(stage)) throw new Error(`Invalid stage: ${stage}`);
  if (stage === "archived" && !(reason && reason.trim())) {
    throw new Error("Archiving a lead requires a reason.");
  }

  const db = createServiceClient();
  const { data: lead } = await db
    .from("clients")
    .select("pipeline_stage")
    .eq("id", leadId)
    .single<{ pipeline_stage: string | null }>();
  const from = lead?.pipeline_stage ?? null;
  if (from === stage && stage !== "archived") return; // no-op

  const update: Record<string, unknown> = { pipeline_stage: stage };
  if (stage === "archived") update.archived_reason = reason!.trim();
  const { error } = await db.from("clients").update(update).eq("id", leadId);
  if (error) throw new Error(error.message);

  await db.from("pipeline_events").insert({
    event_type: "stage_change",
    client_id: leadId,
    metadata: { from, to: stage, ...(stage === "archived" ? { reason: reason!.trim() } : {}) },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
}

// Set / update a lead's primary contact email. Needed for leads that didn't
// arrive via intake (e.g. grant-matched leads promoted from prospects have no
// email), so an admin can add one before issuing outreach or an invoice. Basic
// shape validation; empty clears it.
export async function setLeadContactEmail(leadId: string, email: string) {
  await requireAdmin();
  const trimmed = (email ?? "").trim();
  if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error("That doesn't look like a valid email.");
  }
  const db = createServiceClient();
  const { error } = await db
    .from("clients")
    .update({ primary_contact_email: trimmed || null })
    .eq("id", leadId);
  if (error) throw new Error(error.message);
  revalidatePath(`/leads/${leadId}`);
}

// Append a free-text note to the lead timeline.
export async function addLeadNote(leadId: string, body: string) {
  await requireAdmin();
  const note = (body ?? "").trim();
  if (!note) throw new Error("Note is empty.");

  const db = createServiceClient();
  const { error } = await db.from("pipeline_events").insert({
    event_type: "note",
    client_id: leadId,
    metadata: { note },
  });
  if (error) throw new Error(error.message);

  revalidatePath(`/leads/${leadId}`);
}

// Mark a discovery call as scheduled. This is the missing PRODUCER for the
// booked_call signal: effectiveStage() promotes a lead to discovery_scheduled
// whenever a booked_call event exists, so we DO NOT hand-set pipeline_stage --
// writing the event drives the stage (two-layer model). The optional meeting
// datetime is stored on the event metadata for the timeline; nothing downstream
// reads it yet (display-only), but later phases (reminders, no-show, convert)
// have a structured field to read instead of a backfill.
export async function markDiscoveryScheduled(leadId: string, scheduledAt?: string | null) {
  await requireAdmin();
  const db = createServiceClient();
  const when = (scheduledAt ?? "").trim() || null;

  const { error } = await db.from("pipeline_events").insert({
    event_type: "booked_call",
    client_id: leadId,
    metadata: { scheduled_at: when },
  });
  if (error) throw new Error(error.message);

  // Discovery-booking is a FLAG (badge), not a stage. Stamp discovery_booked_at on
  // the row so the leads LIST can show "call booked" cheaply without loading
  // pipeline_events per row. Does not change pipeline_stage.
  await db.from("clients").update({ discovery_booked_at: when ?? new Date().toISOString() }).eq("id", leadId);

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
}

// Convert a lead to an active client (P6). Flips the security boundary, so the
// gate is re-checked server-side here (never trust the UI): allow only if the
// client has BOTH a signed contract AND a paid invoice, read live from the
// source-of-truth tables. On convert, on the SAME row, set pipeline_stage=
// 'converted' AND status='active' -- BOTH, because they guard different surfaces
// (pipeline_stage -> matcher/roster/RLS via NON_LEAD_OR_FILTER; status -> the
// grant->client picker + active-count). Stamp converted_at and log a 'converted'
// event with the contract/invoice ids (the permanent reconciliation record).
// Idempotent: a double-click or an already-converted row is a no-op.
export async function convertLead(leadId: string): Promise<void> {
  await requireAdmin();
  const db = createServiceClient();

  const { data: lead } = await db
    .from("clients")
    .select("pipeline_stage")
    .eq("id", leadId)
    .single<{ pipeline_stage: string | null }>();
  if (!lead) throw new Error("Lead not found.");
  if (lead.pipeline_stage === "converted") return; // already converted -> no-op

  // Gate: re-read signed + paid from source of truth. Never gate on a stamp.
  const { data: signedContract } = await db
    .from("contracts")
    .select("id")
    .eq("client_id", leadId)
    .eq("status", "signed")
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!signedContract) throw new Error("Can't convert yet — no signed contract on file.");

  const { data: paidInvoice } = await db
    .from("invoices")
    .select("id")
    .eq("client_id", leadId)
    .eq("status", "paid")
    .order("paid_date", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!paidInvoice) throw new Error("Can't convert yet — no paid invoice on file.");

  // Flip both boundary columns on the same row, guarded on not-already-converted
  // so a concurrent double-click flips (and logs) exactly once.
  const { data: updated } = await db
    .from("clients")
    .update({ pipeline_stage: "converted", status: "active", converted_at: new Date().toISOString() })
    .eq("id", leadId)
    .neq("pipeline_stage", "converted")
    .select("id");
  if (!updated || updated.length === 0) return; // another delivery already converted

  await db.from("pipeline_events").insert({
    event_type: "converted",
    client_id: leadId,
    metadata: { contract_id: signedContract.id, invoice_id: paidInvoice.id },
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/clients");
  revalidatePath("/dashboard");
}

// Assign / change / clear the account manager. Logs am_assigned with the name.
export async function assignAccountManager(leadId: string, profileId: string | null) {
  await requireAdmin();
  const db = createServiceClient();

  let name = "Unassigned";
  if (profileId) {
    const { data: p } = await db
      .from("profiles")
      .select("full_name, email")
      .eq("id", profileId)
      .single<{ full_name: string | null; email: string | null }>();
    name = p?.full_name || p?.email || "Unknown";
  }

  const { error } = await db
    .from("clients")
    .update({ account_manager_id: profileId })
    .eq("id", leadId);
  if (error) throw new Error(error.message);

  await db.from("pipeline_events").insert({
    event_type: "am_assigned",
    client_id: leadId,
    metadata: { account_manager_id: profileId, name },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
}
