import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { deriveEnrichmentSteps, allSettled } from "@/lib/clients/enrichment-status";
import { enrichClient } from "@/lib/clients/enrich";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Enrichment status for the post-create ceremony + the API-data view.
//
//   GET  -> derived per-step status (polled while the background chain runs)
//   POST -> re-run the chain synchronously, then return the fresh status
//
// GET is a pure read: status is DERIVED from the artifacts on the client row (see
// lib/clients/enrichment-status.ts), never from a progress record that could
// disagree with what actually landed.
//
// POST exists because enrichClient runs fire-and-forget in a waitUntil, so a step
// that failed leaves no artifact and no error anyone can see. Re-running it in the
// request (rather than another waitUntil) is the point: the caller gets the REAL
// outcome back instead of a hopeful "retrying…". enrichClient guards every step
// internally and never throws, so a still-broken step simply comes back unchanged.

// ANY STAFF, not admin-only -- deliberately matched to the /api-data page, which
// gates with requireUser (a profiles row). An admin-only endpoint behind a
// staff-visible page would let a contractor/AM open the ceremony and watch it never
// update, because every poll would 403 with nothing on screen to say why. A client
// portal member has no profiles row and is rejected here.
async function requireStaff() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile) return { error: NextResponse.json({ error: "Staff only" }, { status: 403 }) };
  return { error: null as null };
}

async function loadStatus(id: string) {
  const db = createServiceClient();
  const { data } = await db.from("clients").select("*").eq("id", id).single();
  if (!data) return null;
  const steps = deriveEnrichmentSteps(data as Client);
  return { steps, settled: allSettled(steps) };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireStaff();
  if (gate.error) return gate.error;

  const status = await loadStatus(params.id);
  if (!status) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  return NextResponse.json(status);
}

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireStaff();
  if (gate.error) return gate.error;

  const db = createServiceClient();
  const { data } = await db.from("clients").select("id").eq("id", params.id).single();
  if (!data) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Awaited on purpose -- the caller is a human watching a retry button.
  await enrichClient(db, params.id);

  const status = await loadStatus(params.id);
  return NextResponse.json(status ?? { error: "Client not found" }, { status: status ? 200 : 404 });
}
