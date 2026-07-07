import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/site-url";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mintAccessToken } from "@/lib/tokens";

// Admin-only: mint a tokenized outbound-door scheduling link for a (prospect,
// grant) pair. Returns the raw link ONCE (we store only its hash) for the analyst
// to paste into an outreach email. Automated prospect email is a later step.
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

  const body = (await req.json().catch(() => ({}))) as { grantId?: string };

  const db = createServiceClient();
  const minted = await mintAccessToken(db, {
    actionType: "prospect_schedule_call",
    prospectId: params.id,
    grantId: body.grantId ?? null,
    createdBy: user.id,
  });
  if (!minted) {
    return NextResponse.json({ error: "Failed to mint link" }, { status: 500 });
  }

  const origin = appBaseUrl(req);
  return NextResponse.json({ url: `${origin}/go/${minted.rawToken}` });
}
