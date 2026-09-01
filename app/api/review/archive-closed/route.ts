import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { closedSweepEligible, applyClosedSweep, type SweepCardRow } from "@/lib/report/closed-sweep";

// Archive grants whose deadline passed before anyone reviewed them.
//
// The Grant Report surfaces "N closed before review" as a finding; this is what the
// finding leads to. A prompt that only points at the problem is the dead affordance this
// redesign keeps removing, and the count in the page header already points at it.
//
// IT RE-DERIVES "CLOSED" SERVER-SIDE rather than trusting the ids it was handed. The
// caller sends a list because it knows which rows it drew, but "this deadline has passed
// and nobody decided" is a fact about the record, not about the page — so a stale tab, a
// hand-crafted request, or a race against a decision made in another window cannot archive
// something that is still live. Ids that no longer qualify are skipped and counted, not
// rejected: a partial success is the honest outcome when the list moved underneath you.
//
// Reversible. It records decision='passed' with a reason, which is the same terminal state
// the per-card Reject writes and can be changed later.
//
// The eligibility (strict `< 0`, fail-open) and the two-reason write live in the shared
// lib/report/closed-sweep core, so this manual staff path and the automatic cron sweep
// share ONE definition of "closed" and ONE write shape — and neither writes match_feedback.

const MAX_BATCH = 100;

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Staff only. A client portal member has no profiles row (and could not read one under
  // RLS anyway) — bulk-archiving another party's queue is not theirs to do.
  const { data: prof } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!prof) return NextResponse.json({ error: "Staff only" }, { status: 403 });

  // include_released: the single-card, human-acknowledged path (the overdue gate on the
  // grant review screen). The BULK sweep must never touch a card the client has already
  // seen -- mass-archiving what someone is holding is exactly what that guard is for --
  // but a reviewer looking at one closed card, having acknowledged the date, is the case
  // the guard was protecting against. It relaxes ONLY the release check; the deadline is
  // still re-derived server-side below (in closedSweepEligible).
  let body: { card_ids?: unknown; include_released?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = Array.isArray(body.card_ids) ? body.card_ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return NextResponse.json({ error: "card_ids (string[]) is required" }, { status: 400 });
  if (ids.length > MAX_BATCH) {
    return NextResponse.json({ error: `Too many cards — ${MAX_BATCH} at a time` }, { status: 400 });
  }

  const { data: cards, error: readErr } = await supabase
    .from("review_cards")
    .select("id, decision, sme_released_at, grants(submission_deadline)")
    .in("id", ids)
    .neq("card_type", "prospect");
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

  const includeReleased = body.include_released === true;
  // Re-derive which of the handed rows are genuinely closed + still pending (+ unreleased,
  // unless include_released). Skipped-and-counted rather than rejected when the list moved.
  const eligible = closedSweepEligible((cards ?? []) as unknown as SweepCardRow[], { includeReleased });

  if (eligible.length === 0) {
    return NextResponse.json({ archived: 0, skipped: ids.length });
  }

  // The staffer who clicked owns the decision. The two reasons ("Closed before review" vs
  // "Deadline passed after release") are chosen inside the core by the release state, and NO
  // match_feedback row is written — a missed deadline is capacity, not a scorer error.
  let archived: number;
  try {
    archived = await applyClosedSweep(supabase, eligible, { decidedBy: user.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Archive failed" }, { status: 500 });
  }
  return NextResponse.json({ archived, skipped: ids.length - archived });
}
