import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { lookupByUei, isValidUei, SamError } from "@/lib/sam/client";

// Admin-only SAM.gov bind. Persists the registration for a client -- the only
// path that writes. Takes ONLY a UEI (from a confirmed candidate OR a manual
// paste) and re-resolves it against SAM here, so the stored fields are always
// SAM's authoritative values, never client-posted ones. Idempotent: re-binding
// a UEI refreshes the record + sam_checked_at.
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

  const body = (await req.json().catch(() => ({}))) as { uei?: string };
  if (!body.uei || !isValidUei(body.uei)) {
    return NextResponse.json(
      { error: "A UEI is 12 letters/numbers (no I or O)." },
      { status: 400 },
    );
  }

  let entity;
  try {
    entity = await lookupByUei(body.uei);
  } catch (err) {
    if (err instanceof SamError) {
      const status = err.code === "rate_limit" ? 429 : err.code === "bad_request" ? 400 : 502;
      return NextResponse.json({ error: err.message }, { status });
    }
    return NextResponse.json({ error: "SAM lookup failed." }, { status: 502 });
  }
  if (!entity) {
    return NextResponse.json({ error: "No SAM registration found for that UEI." }, { status: 404 });
  }

  const db = createServiceClient();
  const { error } = await db
    .from("clients")
    .update({
      uei: entity.uei,
      sam_matched_name: entity.legalName,
      sam_registration_status: entity.status,
      sam_expiration_date: entity.expirationDate,
      sam_checked_at: new Date().toISOString(),
    })
    .eq("id", params.id);
  if (error) {
    console.error("SAM bind update failed:", error);
    return NextResponse.json({ error: "Could not save the registration." }, { status: 500 });
  }

  return NextResponse.json({ bound: entity });
}
