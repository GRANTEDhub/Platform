import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { discoverProspects } from "@/lib/grants/discover";

export const maxDuration = 300;

// Admin-only: run Track 2 discovery on a single grant. Reads the grant's
// existing ideal applicant profile, runs one Brave search, extracts grounded
// candidate orgs, scores them with the existing engine, and writes prospects +
// prospect cards for qualifiers. Synchronous (one search + one extraction + a
// bounded number of scoring calls); the caller shows a spinner and refreshes.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const db = createServiceClient();
  const result = await discoverProspects(params.id, db);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason ?? "Discovery failed" }, { status: 400 });
  }
  return NextResponse.json(result);
}
