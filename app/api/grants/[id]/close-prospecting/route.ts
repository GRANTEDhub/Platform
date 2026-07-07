import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Admin-only "Close" from the intel prospect pane: mark a grant closed for
// prospecting. It drops out of the prospect feed (getProspectFeed filters
// prospecting_closed_at is null) but persists in the Ledger with its prospect
// history intact. One-directional from this pane -- reopening is a future Ledger
// action that sets prospecting_closed_at back to null.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const db = createServiceClient();
  const { error } = await db
    .from("grants")
    .update({ prospecting_closed_at: new Date().toISOString(), prospecting_closed_by: user.id })
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: "Failed to close prospecting" }, { status: 500 });

  await db.from("pipeline_events").insert({
    event_type: "prospecting_closed",
    grant_id: params.id,
    metadata: { closed_by: user.id },
  });

  return NextResponse.json({ closed: true });
}
