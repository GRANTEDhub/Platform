import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSentAlertForCard } from "@/lib/alerts/sent-status";

// Recall a released card: pull it back out of the client's portal and return it to the
// staff queue as an undecided match.
//
// THE EMAIL CANNOT BE RECALLED, and this route does not pretend otherwise. It clears the
// card's own state and leaves grant_alerts COMPLETELY UNTOUCHED -- that table is the
// durable send record (status='sent' + sent_to + sent_at per card) and is already what
// getSentAlertForCard reads for the "Alerted" badge. So the history survives a recall in
// the place that owns it, and the response hands the caller the surviving record so the
// UI can say "recalled, client was emailed Jul 17" rather than implying nothing was sent.
//
// The card's sent_at/sent_to ARE cleared, and that is not a contradiction: they are the
// card's denormalised copy, and leaving them set would put the card in two different
// stages on two different screens. stageOf (lib/clients/pipeline.ts) treats sent_at as
// "alerted" and would keep the dashboard pipeline reading "With client", while the Grant
// Report's staffBucket keys on sme_released_at alone and would read "Awaiting release".
// One of those has to be wrong, so the copy goes and the record stays.
//
// IT REFUSES WHEN AN INTELLENGINE DRAFT EXISTS. Clearing pursuit_path while a draft is
// attached produces the mirror image of the hazard the draft-delete route already guards
// ("routed to IntellEngine, but no draft"): a draft whose card is back in triage. That is
// recoverable but it is not something to do silently, and a COMPLETE draft is real work.
// Deleting the draft through the UI un-routes the card itself, which is the ordered way
// to get to the same place.
//
// Staff only, and deliberately via the USER client rather than the service role: the
// guard_card_approval trigger reads auth.uid(), so a service-role write would look like
// an anonymous caller and be refused outright. Setting decision back to 'pending' never
// trips the trigger's admin gate, which only fires on a transition INTO 'approved'.

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: "Staff only" }, { status: 403 });

  const { data: card } = await supabase
    .from("review_cards")
    .select("id, decision, pursuit_path, sme_released_at, sent_at, interested_at, card_type")
    .eq("id", params.id)
    .maybeSingle<{
      id: string;
      decision: string;
      pursuit_path: string | null;
      sme_released_at: string | null;
      sent_at: string | null;
      interested_at: string | null;
      card_type: string | null;
    }>();
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });

  // Nothing to pull back. Reported rather than written, so a double-click doesn't clear a
  // decision somebody made in another tab between the two presses.
  const advanced =
    card.sme_released_at !== null ||
    card.sent_at !== null ||
    card.interested_at !== null ||
    card.decision !== "pending" ||
    card.pursuit_path !== null;
  if (!advanced) {
    return NextResponse.json({ error: "This card is already awaiting release — nothing to recall." }, { status: 409 });
  }

  const { data: draft } = await supabase
    .from("intellengine_drafts")
    .select("id, status")
    .eq("card_id", params.id)
    .maybeSingle<{ id: string; status: string }>();
  if (draft) {
    return NextResponse.json(
      {
        error:
          "A proposal draft is attached to this grant in IntellEngine. Delete it there first — that returns this card on its own — or leave the card routed.",
        draftId: draft.id,
        draftStatus: draft.status,
      },
      { status: 409 },
    );
  }

  // One write, every field that the stage cascades read. stageOf runs
  // passed -> pursuit/approved -> client -> triage and treats interested_at OR sent_at OR
  // sme_released_at as "with client", so a partial clear leaves the card stranded at a
  // stage nobody chose. The interest fields are the CLIENT's own signal; a recall takes
  // the card out of their hands, so their answer to a question we withdrew goes with it.
  const { error } = await supabase
    .from("review_cards")
    .update({
      decision: "pending",
      decision_reason: null,
      decided_by: null,
      decided_at: null,
      decided_by_actor: null,
      pursuit_path: null,
      interested_at: null,
      interested_by: null,
      interested_by_actor: null,
      sme_interested_at: null,
      sme_interested_by: null,
      sme_released_at: null,
      sme_released_by: null,
      sent_at: null,
      sent_to: null,
    })
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // The surviving send record, read AFTER the write from the table the write never
  // touched -- so this is the proof the history outlived the recall, not a value carried
  // over from before it.
  const sent = await getSentAlertForCard(params.id);

  return NextResponse.json({
    recalled: true,
    // Null when the client was never actually emailed (released but the send was gated
    // off, which is every preview deploy). The UI must not claim an email that never went.
    emailedAt: sent?.sentAt ?? null,
    emailedTo: sent?.sentTo ?? null,
  });
}
