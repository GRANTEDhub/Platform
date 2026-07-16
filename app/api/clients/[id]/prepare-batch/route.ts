import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appBaseUrl } from "@/lib/site-url";
import { prepareClientBatch } from "@/lib/alerts/batch-send";

// Prepare drafts for an aggregate (multi-select) client send. ONE budgeted round:
// renders + saves a draft for each selected card that lacks one (missing-only,
// sequential), then returns { done }. The dashboard loops POST -> (<=75s) -> POST
// until done, so any selection finishes with no synchronous N-render. Mirrors the
// generate-report continuation pattern; kept under Cloudflare's ~100s origin cap.
export const runtime = "nodejs";
export const maxDuration = 300;
// Short round so the dashboard's "Preparing X of N" count visibly increments per
// round (each round renders a draft or two sequentially, then returns and the client
// re-POSTs). A long round would render several under one static count -- reading like
// a hang. Well under Cloudflare's ~100s origin cap; the client loops to completion.
const PREPARE_BUDGET_MS = 25_000;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const input = (await req.json().catch(() => ({}))) as { cardIds?: unknown };
  const cardIds = Array.isArray(input.cardIds) ? input.cardIds.filter((x): x is string => typeof x === "string") : [];

  const { result, status } = await prepareClientBatch({
    clientId: params.id,
    cardIds,
    userId: user.id,
    origin: appBaseUrl(req),
    budgetMs: PREPARE_BUDGET_MS,
  });
  return NextResponse.json(result, { status });
}
