import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deadlineDaysLeft } from "@/lib/report/shape";

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

const REASON = "Closed before review";
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

  let body: { card_ids?: unknown };
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

  type Row = {
    id: string;
    decision: string;
    sme_released_at: string | null;
    grants: { submission_deadline: string | null } | { submission_deadline: string | null }[] | null;
  };

  const eligible = ((cards ?? []) as Row[]).filter((c) => {
    const g = Array.isArray(c.grants) ? c.grants[0] : c.grants;
    const days = deadlineDaysLeft(g?.submission_deadline);
    // Exactly the page's `closedUnreviewed`: deadline in the past, still undecided, never
    // released. A closed grant that was already rejected is history, not a miss.
    return days !== null && days < 0 && c.decision === "pending" && c.sme_released_at === null;
  });

  if (eligible.length === 0) {
    return NextResponse.json({ archived: 0, skipped: ids.length });
  }

  const { error } = await supabase
    .from("review_cards")
    .update({
      decision: "passed",
      decision_reason: REASON,
      decided_by: user.id,
      decided_by_actor: "staff",
      decided_at: new Date().toISOString(),
    })
    .in(
      "id",
      eligible.map((c) => c.id),
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Deliberately NO match_feedback row. The per-card Reject records one because a human
  // judged the match wrong, and that is calibration signal. "Nobody got to it in time" is
  // a fact about our capacity, not about the scorer, and feeding it in as a negative would
  // teach the engine to stop surfacing grants it was right to surface.
  return NextResponse.json({ archived: eligible.length, skipped: ids.length - eligible.length });
}
