// Matching-queue drain — runs on a Vercel Cron schedule, and is also
// admin-triggerable on demand (open it in a browser with an admin session) so a
// drain can be kicked immediately -- e.g. to verify a manually-enqueued test grant
// without waiting for the next scheduled tick.
//
// It drains grants parked at status='queued' one at a time, cradle-to-grave
// (shred -> profile -> full-roster match), sequentially until the queue is empty
// or a time budget under the 300s cap is reached. See lib/grants/queue.ts.
//
// Auth: a Vercel cron call carries `Authorization: Bearer <CRON_SECRET>`; an admin
// session is accepted as the fallback so the route is browser-openable on the real
// app. Anything else is rejected -- this triggers paid LLM work. Fails closed: no
// bearer + no admin session = 401.

import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { drainMatchQueue } from "@/lib/grants/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
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
  }

  const db = createServiceClient();
  const result = await drainMatchQueue(db);

  return NextResponse.json({
    drained: result.processed.length,
    errored: result.errored.length,
    processed: result.processed,
    errors: result.errored,
    queueEmpty: result.queueEmpty,
    budgetExhausted: result.budgetExhausted,
  });
}
