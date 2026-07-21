import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Horizon Reject gate (migration 0053). Per-(client, grant) forecast rejections for
// the "On the horizon" shortlist:
//   POST   -> reject this forecast for this client (idempotent upsert-ignore)
//   DELETE -> undo the reject (admin Undo, mirroring reversible prospecting_closed_at)
// The forecasted render path (loadForecastCandidates) reads this table to hide
// rejected forecasts BEFORE ranking/capping, so the next-best candidate refills. This
// is NEVER a review_cards decision -- once a grant flips forecast->posted it drops out
// of the forecast query and the reject is never consulted, so it gets a fresh
// active-match look. `params.id` is the client id.

async function requireAuth() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

function parseGrantId(body: unknown): string {
  const g = (body as { grantId?: unknown })?.grantId;
  return typeof g === "string" ? g.trim() : "";
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { supabase, user } = await requireAuth();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { grantId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const grantId = parseGrantId(body);
  if (!grantId) return NextResponse.json({ error: "grantId required" }, { status: 400 });

  // Stamp fon from the grant itself (forensic backstop) -- never trust the client for
  // it. A missing grant is a 404 (nothing to reject).
  const { data: grant } = await supabase
    .from("grants")
    .select("fon")
    .eq("id", grantId)
    .maybeSingle<{ fon: string | null }>();
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  const reason =
    typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  // Idempotent: a repeat reject of the same (client, grant) is a no-op (first wins).
  const { error } = await supabase.from("forecast_rejections").upsert(
    {
      client_id: params.id,
      grant_id: grantId,
      fon: grant.fon,
      reason,
      rejected_by: user.id,
    },
    { onConflict: "client_id,grant_id", ignoreDuplicates: true },
  );
  if (error) return NextResponse.json({ error: "Failed to record rejection" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { supabase, user } = await requireAuth();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { grantId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const grantId = parseGrantId(body);
  if (!grantId) return NextResponse.json({ error: "grantId required" }, { status: 400 });

  const { error } = await supabase
    .from("forecast_rejections")
    .delete()
    .eq("client_id", params.id)
    .eq("grant_id", grantId);
  if (error) return NextResponse.json({ error: "Failed to undo rejection" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
