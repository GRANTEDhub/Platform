import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runMatching } from "@/lib/grants/pipeline";

export const maxDuration = 300;

// Admin-only: re-run client matching for a single grant. Idempotent — only
// scores clients that don't already have a card for this grant. Per-grant by
// design so it can't run up an unexpected matching bill.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
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
  const { data: grant } = await db
    .from("grants")
    .select("id, is_domestic")
    .eq("id", params.id)
    .single();
  if (!grant) {
    return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  }
  if (!grant.is_domestic) {
    return NextResponse.json(
      { error: "International grant — excluded from matching by policy" },
      { status: 400 },
    );
  }

  await db.from("grants").update({ status: "processing" }).eq("id", params.id);

  waitUntil(
    runMatching(params.id, db).catch(async (err) => {
      console.error("Re-match error for grant", params.id, err);
      await db
        .from("grants")
        .update({ status: "error", error_detail: String(err?.message ?? err).slice(0, 600) })
        .eq("id", params.id);
    }),
  );

  return NextResponse.json({ ok: true }, { status: 202 });
}
