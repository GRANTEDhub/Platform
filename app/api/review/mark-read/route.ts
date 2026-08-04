import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { markCardRead } from "@/lib/report/read-state";

// Stamp "this side has read this card". Called once on mount by <MarkRead>, from both the
// console and the portal grant detail.
//
// WHY THIS IS A ROUTE AND NOT A LINE IN THE PAGE RENDER. It was a line in the page render,
// and the row stayed unread until you manually refreshed the report. `export const dynamic
// = "force-dynamic"` governs the SERVER; it does nothing about Next's client-side Router
// Cache, which serves the report's already-fetched RSC payload when you navigate back. So
// the stamp landed in the database and the list you returned to was the one from before it.
// revalidatePath is what invalidates that client cache, and it is only callable from a
// route handler or server action -- never from a render. Moving the write here also gets a
// mutation out of the render path, which it should never have been in.
//
// THE SIDE IS DERIVED FROM THE SESSION, NEVER FROM THE BODY. A profiles row means staff; a
// client member has none. If the body named the side, a portal user could pass "staff" and
// mark rows read on our side -- the exact isolation the 0070 trigger exists to enforce, so
// this route must not undo it above the database. The body carries only a card id.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { cardId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const cardId = typeof body.cardId === "string" ? body.cardId : "";
  if (!cardId) return NextResponse.json({ error: "No card given" }, { status: 400 });

  const { data: prof } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  const side = prof ? "staff" : "client";

  // RLS is the authorisation. Staff may write any card; a client member's write is scoped
  // to their own client by review_select + the 0070 guard branch, so a card id that is not
  // theirs simply matches no row. Nothing here needs to re-check ownership, and a stamp
  // carries no decision, so a miss is a silent no-op rather than an error worth raising.
  await markCardRead(supabase, cardId, side);

  // Both surfaces that render read state, so returning to either shows the new state. Cheap
  // and correct on both sides; the alternative is threading the caller's path through the
  // request and getting it wrong the first time a route moves.
  revalidatePath("/clients/[id]/roadmap", "page");
  revalidatePath("/portal/grants", "page");

  return NextResponse.json({ ok: true });
}
