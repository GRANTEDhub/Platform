import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getForecastHorizon, loadForecastCandidates } from "@/lib/grants/forecast-relevance";
import type { Client } from "@/types/database";

// TEMPORARY admin-gated, READ-ONLY debug endpoint for the Stage-1 forecasted
// "on the horizon" relevance gate. Runs the real Haiku relevance rank for one
// client/lead against the live (NIH-excluded) forecasted pool and returns the
// ranked shortlist as JSON, so the relevance quality can be reviewed on a preview
// deploy (which has ANTHROPIC_API_KEY) before the Stage-2 render is built. The
// sandbox has no API key, hence a browser-triggerable route rather than a shell.
//
// Read-only: reads clients + the forecasted candidate pool, makes ONE cheap LLM
// call, and mints/writes NOTHING. It calls lib/grants/forecast-relevance only --
// it does NOT touch the occupancy scorer/pool/drain/flip (engine.ts / pipeline.ts /
// match-queue.ts / queue.ts / gate.ts / cron/ingest), so the active-path-unchanged
// guarantee holds. Remove or fold behind Stage 2 once the gate is reviewed.
//
//   GET /api/clients/<id>/forecast-horizon          (research funders excluded -- default)
//   GET /api/clients/<id>/forecast-horizon?researchOptIn=1   (include NIH -- the opt-in case)
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // Admin gate (mirrors the alert draft/send routes): user client for auth, service
  // client for the reads.
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const db = createServiceClient();
  const { data: client } = await db.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const researchOptIn = req.nextUrl.searchParams.get("researchOptIn") === "1";

  try {
    // Pool size (post-exclusion) for context, then the ranked shortlist.
    const candidates = await loadForecastCandidates(db, { researchOptIn });
    const started = Date.now();
    const horizon = await getForecastHorizon(db, client, { researchOptIn });
    return NextResponse.json({
      client: { id: client.id, name: client.name, orgType: client.org_type, pipelineStage: client.pipeline_stage },
      researchOptIn,
      candidatePoolSize: candidates.length,
      horizonCount: horizon.length,
      elapsedMs: Date.now() - started,
      horizon,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Horizon rank failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
