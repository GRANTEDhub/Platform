import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/site-url";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { convertProspectToLead } from "@/lib/prospects/convert";
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

  const origin = appBaseUrl(req);
  let result;
  try {
    result = await convertProspectToLead(db, {
      prospect,
      grantId,
      userId: user.id,
      origin,
      mintScheduleToken: true,
    });
  } catch (err) {
    console.error("Start-outreach: conversion failed", err);
    return NextResponse.json({ error: "Failed to create the lead." }, { status: 500 });
  }

  // Preserve the prior response shape (clientName vs leadName per outcome).
  if (result.outcome === "routed_to_client") {
    return NextResponse.json({
      outcome: result.outcome,
      clientId: result.clientId,
      clientName: result.name,
      accountManagerId: result.accountManagerId ?? null,
    });
  }
  return NextResponse.json({
    outcome: result.outcome,
    clientId: result.clientId,
    leadName: result.name,
    url: result.scheduleUrl ?? null,
  });
}
