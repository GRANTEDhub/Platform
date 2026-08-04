import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { markCardsUnread } from "@/lib/report/read-state";

// Return Grant Report rows to unread (migration 0070). Serves both console controls: the
// single-card button on the grant review screen and the report's bulk checkbox action.
//
// STAFF ONLY, AND STAFF'S COLUMN ONLY. Read state is per-side by design -- the console and
// the portal each own one column and neither renders the other's -- so this clears
// staff_read_at and never client_read_at. Marking something unread on the client's behalf
// would be editing what THEY have seen, which is not ours to rewrite; the client side is
// automatic (it stamps when they open the grant) and has no manual control at all.
//
// The 0070 guard trigger does not stop a staff session from writing client_read_at -- staff
// own this table and carry no column lock -- so that restriction lives here, in the only
// route that clears read state. It is a deliberate asymmetry, noted in the migration too.
const MAX_BATCH = 200;

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Same staff gate as archive-closed: a portal member has no profiles row, and could not
  // read one under RLS regardless.
  const { data: prof } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!prof) return NextResponse.json({ error: "Staff only" }, { status: 403 });

  let body: { cardIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const raw = Array.isArray(body.cardIds) ? body.cardIds : [];
  const cardIds = [...new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0))];
  if (cardIds.length === 0) return NextResponse.json({ error: "No cards given" }, { status: 400 });
  if (cardIds.length > MAX_BATCH) {
    return NextResponse.json({ error: `Too many cards (max ${MAX_BATCH})` }, { status: 400 });
  }

  // No ownership check beyond RLS, and none is needed: review_write scopes writes to staff,
  // who can see every client's cards anyway. An id that does not exist simply matches no
  // row -- clearing a timestamp is idempotent and carries no decision, so a stale id is a
  // no-op rather than something to reject the whole batch over.
  const { error } = await markCardsUnread(supabase, cardIds, ["staff"]);
  if (error) return NextResponse.json({ error }, { status: 500 });

  return NextResponse.json({ ok: true, count: cardIds.length });
}
