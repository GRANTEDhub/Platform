import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendOutreachEmail, isDeliverableEmail } from "@/lib/email/send";
import type { Client } from "@/types/database";

export const maxDuration = 60;

// Admin-only: APPROVE + SEND the (human-reviewed) outreach draft. Routes through
// the same gate/identity as alerts. On a real send: persist the confirmed
// recipient onto the lead, log an outreach_sent event, and advance the lead from
// outbound_new -> contacted. Never auto-sends: the caller reached this only via
// an explicit human "Approve & send".
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    to?: string;
    subject?: string;
    body?: string;
    grantId?: string;
  };
  const to = (body.to ?? "").trim();
  if (!isDeliverableEmail(to)) {
    return NextResponse.json(
      { error: "Add a valid recipient email before sending." },
      { status: 400 },
    );
  }
  if (!body.body || !body.body.trim()) {
    return NextResponse.json({ error: "The email body is empty." }, { status: 400 });
  }

  // Gate first, recipient-aware. On preview / when sending is disabled, or when
  // the testing-mode allowlist blocks this recipient, do NOT send and do NOT
  // apply any side effect (no Resend call, no outreach_sent event, no stage
  // advance) -- report the reason so the UI is honest.
  const gate = canSendOutreach(to);
  if (!gate.ok) {
    return NextResponse.json({ sent: false, reason: gate.reason });
  }

  const db = createServiceClient();
  const { data: lead } = await db
    .from("clients")
    .select("id, name, primary_contact_name, primary_contact_email, pipeline_stage")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "primary_contact_name" | "primary_contact_email" | "pipeline_stage">>();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  let grantTitle: string | null = null;
  if (body.grantId) {
    const { data: g } = await db.from("grants").select("title").eq("id", body.grantId).maybeSingle();
    grantTitle = (g as { title: string | null } | null)?.title ?? null;
  }

  try {
    await sendOutreachEmail({
      to,
      subject: body.subject ?? "",
      body: body.body,
      contactName: lead.primary_contact_name,
    });
  } catch (err) {
    return NextResponse.json(
      { sent: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // Persist the confirmed recipient onto the lead (grant-matched leads usually
  // arrive with no email; confirming one here enriches the record).
  if (lead.primary_contact_email !== to) {
    await db.from("clients").update({ primary_contact_email: to }).eq("id", params.id);
  }

  await db.from("pipeline_events").insert({
    event_type: "outreach_sent",
    client_id: params.id,
    grant_id: body.grantId ?? null,
    subject_snapshot: { name: lead.name },
    metadata: { to, subject: body.subject ?? null, grant_title: grantTitle },
  });

  // Advance outbound_new -> contacted (same stored-stage transition P2-core uses);
  // never regress a further-along lead.
  let stageAdvanced = false;
  if (lead.pipeline_stage === "outbound_new") {
    await db.from("clients").update({ pipeline_stage: "contacted" }).eq("id", params.id);
    await db.from("pipeline_events").insert({
      event_type: "stage_change",
      client_id: params.id,
      metadata: { from: "outbound_new", to: "contacted", reason: "outreach sent" },
    });
    stageAdvanced = true;
  }

  return NextResponse.json({ sent: true, to, stageAdvanced });
}
