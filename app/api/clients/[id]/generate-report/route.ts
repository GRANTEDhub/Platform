import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { drainClientMatchQueue } from "@/lib/clients/match-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Admin-only, on-demand "Generate report": (re-)run the one-time match for ONE
// prospect/client against the current grant pool, landing the results in the
// dashboard's Grant activity. This is the client->pool mirror of the grant->roster
// "Re-match" button (app/api/grants/[id]/rematch). It ONLY flips the record to
// 'queued' and kicks the SAME drainClientMatchQueue the cron runs -- no matching
// logic lives here. The drain is incremental (scores only pool grants not yet
// attempted for this record) and resumable, so a re-click on an already-matched
// record scores just the grants added since the last run (usually zero -> a
// near-instant no-op with no LLM spend).
//
// POST (state-changing, admin-gated because it can trigger paid LLM work).
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
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
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const db = createServiceClient();
  const { data: client } = await db
    .from("clients")
    .select("id, initial_match_status")
    .eq("id", params.id)
    .single();
  if (!client) return NextResponse.json({ error: "Record not found" }, { status: 404 });

  // Server-side backstop for the 2x-spend hole: if a drain is already working this
  // record ('queued' = a prior kick is pending, 'running' = actively scoring), a
  // drain is already in flight -- do NOT start a second one over the same
  // not-yet-attempted pool. The primary guard is the button's disable-on-submit;
  // this covers a duplicate/crafted request. A record genuinely stuck 'running'
  // (a killed invocation) is still finished by the cron, which is self-healing.
  const alreadyInFlight =
    client.initial_match_status === "queued" || client.initial_match_status === "running";
  if (alreadyInFlight) {
    return NextResponse.json({ ok: true, status: "already_in_progress" }, { status: 202 });
  }

  // Enqueue THIS record, then kick the global drain immediately -- the click expects
  // matching to start now, not on the next cron tick. drainClientMatchQueue picks the
  // oldest queued/running record first and is self-healing, so whatever doesn't fit
  // this invocation's budget is finished by the cron.
  await db.from("clients").update({ initial_match_status: "queued" }).eq("id", params.id);

  waitUntil(
    drainClientMatchQueue(db).catch((err) => {
      console.error(`Generate-report drain error for client ${params.id}:`, err);
    }),
  );

  return NextResponse.json({ ok: true, status: "queued" }, { status: 202 });
}
