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
// A card the client had already SEEN before the deadline passed. Nobody failed to review
// it, so the sweep's reason would be a false account of what happened.
const REASON_RELEASED = "Deadline passed after release";
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
  // still re-derived server-side below.
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

  type Row = {
    id: string;
    decision: string;
    sme_released_at: string | null;
    grants: { submission_deadline: string | null } | { submission_deadline: string | null }[] | null;
  };

  const includeReleased = body.include_released === true;

  const eligible = ((cards ?? []) as Row[]).filter((c) => {
    const g = Array.isArray(c.grants) ? c.grants[0] : c.grants;
    const days = deadlineDaysLeft(g?.submission_deadline);
    // Exactly the page's `closedUnreviewed`: deadline in the past and still undecided. A
    // closed grant that was already rejected is history, not a miss.
    //
    // STILL `< 0`, NOT `<= 0`. A grant due TODAY is not closed -- federal deadlines carry
    // a cut-off time we do not store, so it is live until the day is gone. The review
    // screen's overdue WARNING fires a day earlier on purpose, and deliberately does not
    // offer archiving on that day.
    if (days === null || days >= 0 || c.decision !== "pending") return false;
    return includeReleased || c.sme_released_at === null;
  });

  if (eligible.length === 0) {
    return NextResponse.json({ archived: 0, skipped: ids.length });
  }

  // Two writes, because the two groups get DIFFERENT reasons and the reason is the
  // record of what happened. "Closed before review" on a card the client had already
  // seen would be a false account: somebody did review it, and released it, and then the
  // deadline ran out. Grouped rather than per-row so this is still at most two statements
  // however large the batch.
  const decidedAt = new Date().toISOString();
  const groups: { ids: string[]; reason: string }[] = [
    { ids: eligible.filter((c) => c.sme_released_at === null).map((c) => c.id), reason: REASON },
    { ids: eligible.filter((c) => c.sme_released_at !== null).map((c) => c.id), reason: REASON_RELEASED },
  ];

  for (const g of groups) {
    if (g.ids.length === 0) continue;
    const { error } = await supabase
      .from("review_cards")
      .update({
        decision: "passed",
        decision_reason: g.reason,
        decided_by: user.id,
        decided_by_actor: "staff",
        decided_at: decidedAt,
      })
      .in("id", g.ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Deliberately NO match_feedback row. The per-card Reject records one because a human
  // judged the match wrong, and that is calibration signal. "Nobody got to it in time" is
  // a fact about our capacity, not about the scorer, and feeding it in as a negative would
  // teach the engine to stop surfacing grants it was right to surface.
  return NextResponse.json({ archived: eligible.length, skipped: ids.length - eligible.length });
}
