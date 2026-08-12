import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import {
  generateApplicationRequirements,
  saveApplicationRequirements,
  recordFailedRequirementsAttempt,
  readApplicationRequirements,
  MAX_REQUIREMENTS_ATTEMPTS,
} from "@/lib/grants/requirements";
import type { Grant } from "@/types/database";

// Derive-and-cache the NOFO application requirements for the grant behind an IntellEngine draft
// (migration 0081). Called lazily from the compliance step when no artifact is cached yet.
//
// STAFF-ONLY FOR THE MVP, BY THE AUTH GATE, NOT A FLAG. This is the only user-reachable LLM call in
// the product, and the whole point of gating it to staff is that the "reachable from a user
// request" risk class does not exist until APPLICATION_REQUIREMENTS_CLIENT_VISIBLE is deliberately
// flipped on for clients. During the flag-off observation window only staff reach the compliance
// step anyway (clients are behind PURSUIT_CLIENT_ACCESS_ENABLED), so requiring a profiles row here
// -- the same is_staff() population the 0062 draft RLS and the drafts route key on -- converts the
// call to "reachable from a staff request." A client hitting this raw endpoint gets 404 (the route
// looks absent, matching the drafts route), NOT 403. The staff gate is the request-rate bound; the
// attempts counter (<3) is only a per-grant retry ceiling, never a rate guard.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Staff = has a profiles row (admin or contractor). A client portal member has none. 404 so the
  // route reads as absent to a non-staff caller rather than advertising a forbidden endpoint.
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { draftId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.draftId) return NextResponse.json({ error: "draftId required" }, { status: 400 });

  // Ownership + grant resolution in one: resolveIntellEngineContext reads the draft under the
  // caller's RLS (staff have full access via is_staff()) and service-roles the related grant. A
  // draft the caller cannot see resolves to null.
  const ctx = await resolveIntellEngineContext(body.draftId);
  if (!ctx) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const grant = ctx.grant as Grant | null;
  // From-scratch draft, or a card with no grant: nothing to derive against.
  if (!grant) return NextResponse.json({ requirements: null });

  // Already cached (another open won the race, or a prior derive succeeded): return it, no second
  // LLM call. The read-before-write is what makes two staff opening the same grant idempotent.
  const cached = readApplicationRequirements(grant.application_requirements);
  if (cached) return NextResponse.json({ requirements: cached });

  // Retry ceiling reached: a grant whose text has failed generation MAX times is parked. Report it
  // as unavailable rather than spending another call. (A not-retrievable grant never bumps the
  // counter, so it can't be parked here -- it falls through to the sentinel below.)
  if ((grant.application_requirements_attempts ?? 0) >= MAX_REQUIREMENTS_ATTEMPTS) {
    return NextResponse.json({ requirements: null, parked: true });
  }

  const svc = createServiceClient();

  // generateApplicationRequirements owns the retrievability gate: for a non-retrievable grant it
  // returns the nofo_not_retrievable sentinel WITHOUT a model call (a real, terminal value, not
  // null), so that path costs nothing and stores the sentinel exactly like a real result. null is
  // reserved for a transient failure that should retry.
  let result: Awaited<ReturnType<typeof generateApplicationRequirements>> = null;
  try {
    result = await generateApplicationRequirements(grant);
  } catch (e) {
    console.error(`[requirements] generation threw grant=${grant.id}:`, e instanceof Error ? e.message : e);
  }

  // Transient failure (API error / malformed tool output): costs an attempt, writes no artifact,
  // and the client may retry.
  if (!result) {
    await recordFailedRequirementsAttempt(svc, grant.id, grant.application_requirements_attempts ?? null);
    return NextResponse.json({ error: "Couldn't derive requirements right now" }, { status: 503 });
  }

  try {
    await saveApplicationRequirements(svc, grant.id, result.value);
  } catch (e) {
    console.error(`[requirements] save failed grant=${grant.id}:`, e instanceof Error ? e.message : e);
    // The value was produced; a write error is a real fault, not a retryable generation miss, so it
    // does not spend an attempt. Return the value so the caller still renders it this open.
  }

  if (result.audit) {
    console.log(
      `[requirements] grant=${grant.id} returned=${result.audit.returned} kept=${result.audit.kept} dropped=${result.audit.dropped}`,
    );
  }

  return NextResponse.json({ requirements: result.value });
}
