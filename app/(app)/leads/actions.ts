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

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
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
