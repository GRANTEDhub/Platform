import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendDiscoveryInviteEmail, isDeliverableEmail } from "@/lib/email/send";
import type { Client } from "@/types/database";

export const maxDuration = 60;

// The engagement flyer is a fixed asset for now (A2 -- admin-uploadable later).
// It lives under lib/email/assets and is traced into this route's serverless
// function via next.config.mjs outputFileTracingIncludes, so readFile resolves
// at runtime the same way the sign route reads its embedded fonts.
const FLYER_PATH = path.join(process.cwd(), "lib/email/assets/engagement-flyer.pdf");

// Admin-only: send a lead's contact the standard discovery invite -- the
// engagement flyer attached + the scheduling link in the body, so THEY book.
// Routes through the same recipient-aware gate as every other send: on preview,
// when sending is disabled, or when the testing-mode allowlist blocks this
// recipient, do NOT send and apply NO side effect -- report the reason so the UI
// is honest. On a real send, log a discovery_invite_sent event.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const schedulingUrl = (process.env.NEXT_PUBLIC_BOOKING_URL ?? "").trim();
  if (!schedulingUrl) {
    return NextResponse.json(
      { error: "No scheduling link configured (NEXT_PUBLIC_BOOKING_URL)." },
      { status: 400 },
    );
  }

  const db = createServiceClient();
  const { data: lead } = await db
    .from("clients")
    .select("id, name, primary_contact_name, primary_contact_email")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "primary_contact_name" | "primary_contact_email">>();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const to = (lead.primary_contact_email ?? "").trim();
  if (!isDeliverableEmail(to)) {
    return NextResponse.json(
      { error: "Add a valid contact email before sending the invite." },
      { status: 400 },
    );
  }

  // Gate first, recipient-aware. No send + no event when blocked.
  const gate = canSendOutreach(to);
  if (!gate.ok) {
    return NextResponse.json({ sent: false, reason: gate.reason });
  }

  let flyer: Buffer;
  try {
    flyer = await readFile(FLYER_PATH);
  } catch {
    return NextResponse.json(
      { error: "Engagement flyer asset is missing on the server." },
      { status: 500 },
    );
  }

  try {
    await sendDiscoveryInviteEmail({
      to,
      contactName: lead.primary_contact_name,
      schedulingUrl,
      flyer,
    });
  } catch (err) {
    return NextResponse.json(
      { sent: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  await db.from("pipeline_events").insert({
    event_type: "discovery_invite_sent",
    client_id: params.id,
    subject_snapshot: { name: lead.name },
    metadata: { to },
  });

  return NextResponse.json({ sent: true, to });
}
