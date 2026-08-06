import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pursuitApiDenied } from "@/lib/pursuit/access";
import { STEP_ORDER, furthestStatus } from "@/lib/intellengine/drafts";
import type { IntellEngineDraft, IntellEngineDraftStatus } from "@/types/database";

// Advance an IntellEngine draft's status (as the client moves scope -> compliance
// -> build -> complete) or rename it. RLS scopes every read/write to the caller's
// own org. Status only ever moves FORWARD -- re-opening an earlier step never
// knocks progress backward (see furthestStatus).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Pursuit is gated off for clients (lib/pursuit/access.ts). This route advances a
  // draft's status as the wizard is walked, so leaving it open would let a client drive
  // progress through steps they cannot load. Staff are unaffected.
  if (await pursuitApiDenied()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { status?: IntellEngineDraftStatus; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.status && !STEP_ORDER.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Current row (RLS pins it to the caller's org; absent -> not theirs / gone).
  const { data: current } = await supabase
    .from("intellengine_drafts")
    .select("*")
    .eq("id", params.id)
    .maybeSingle<IntellEngineDraft>();
  if (!current) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const update: { status?: IntellEngineDraftStatus; title?: string } = {};
  if (body.status) update.status = furthestStatus(current.status, body.status);
  if (typeof body.title === "string" && body.title.trim()) update.title = body.title.trim().slice(0, 200);
  if (Object.keys(update).length === 0) return NextResponse.json({ draft: current });

  const { data, error } = await supabase
    .from("intellengine_drafts")
    .update(update)
    .eq("id", params.id)
    .select()
    .single<IntellEngineDraft>();
  if (error) return NextResponse.json({ error: "Couldn't save" }, { status: 500 });
  return NextResponse.json({ draft: data });
}

// Delete an IntellEngine proposal draft. RLS scopes the delete to the caller's
// own org (staff: any); a draft the caller can't see resolves to null -> 404.
//
// When the draft was developing a matched grant (card_id set) that is still
// routed to IntellEngine, return that grant to the client's Grant Report as an
// undecided match -- pursuit_path back to null + decision back to 'pending',
// mirroring the review route's "clear pursuit" write. Otherwise deleting the
// proposal would strand the card as "routed to IntellEngine, but no draft".
// Both columns are client-permitted (guard_card_approval's client branch
// whitelists decision + pursuit_path), so this works for a client member too.
// Best-effort: the draft is already gone, so a hiccup there must not fail the
// delete the user asked for.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: draft } = await supabase
    .from("intellengine_drafts")
    .select("id, card_id")
    .eq("id", params.id)
    .maybeSingle<Pick<IntellEngineDraft, "id" | "card_id">>();
  if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const { error: delErr } = await supabase.from("intellengine_drafts").delete().eq("id", params.id);
  if (delErr) return NextResponse.json({ error: "Couldn't delete this proposal" }, { status: 500 });

  if (draft.card_id) {
    const { error: resetErr } = await supabase
      .from("review_cards")
      .update({ pursuit_path: null, decision: "pending", decided_at: null, decided_by: null, decided_by_actor: null })
      .eq("id", draft.card_id)
      .eq("pursuit_path", "intellengine");
    if (resetErr) {
      // Non-fatal: the draft is deleted; the grant just keeps its routing and can
      // be re-cleared later. Log for visibility rather than failing the request.
      console.error(`[intellengine-draft-delete] card un-route failed card=${draft.card_id}:`, resetErr.message);
    }
  }

  return NextResponse.json({ ok: true });
}
