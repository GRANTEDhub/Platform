import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// The client portal's jump-to search — the counterpart of /api/search behind the console
// command band, scoped to what a client actually has.
//
// SCOPE IS THEIR OWN RECORD, AND RLS IS WHAT ENFORCES IT, not this code. Under 0055 a
// portal member can SELECT a grants row only if a review_card exists linking that grant to
// an org they belong to — so "grants matched to them at some point or actively matched" is
// not a filter written here, it is the definition of what the caller can see. Every
// decision counts: a grant they passed on months ago is still theirs to find. Plus their
// IntellEngine drafts, matched by title.
//
// TWO EXTRA FILTERS ON TOP OF RLS, both because RLS is coarser than the portal's UI rules:
//   - card_type != 'prospect' — a prospect card is not part of a client's book.
//   - the 0059 release gate — for an account-managed client an UNRELEASED card is
//     deliberately invisible in the portal, and RLS does not know about that gate. Without
//     this filter the search box would be the one place a client could discover a match
//     their account manager has not released yet, which is the whole point of the gate.
//     Same predicate as /portal/grants/[id] and the dashboard.
//
// NOT A CONTENT SEARCH, same as the console's: titles and funders, never NOFO body text,
// draft content or notes. The dropdown labels its groups so the scope is on screen rather
// than implied.
export const dynamic = "force-dynamic";

const LIMIT = 6;
const GRANT_SCAN = 24; // RLS-visible title matches to consider before the card join

type CardRow = {
  id: string;
  grant_id: string;
  decision: string;
  interested_at: string | null;
  sme_released_at: string | null;
};

export async function GET(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // JSON, not a redirect: this is fetched from a client component, and a 307 to /login
  // would arrive as an opaque HTML body the dropdown cannot report.
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: membership } = await supabase
    .from("client_members")
    .select("client_id")
    .eq("user_id", user.id)
    .not("activated_at", "is", null)
    .order("invited_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  // Staff previewing the portal have no membership; they get an empty result rather than
  // an error, so the field simply finds nothing instead of showing them a failure.
  if (!membership) return NextResponse.json({ grants: [], drafts: [] });
  const clientId = (membership as { client_id: string }).client_id;

  const raw = (new URL(req.url).searchParams.get("q") ?? "").trim();
  // Strip what carries meaning in PostgREST's filter grammar before interpolating — an
  // unescaped comma or paren breaks the .or() expression rather than matching nothing.
  const safe = raw.replace(/[%*(),:\\]/g, " ").trim();
  if (safe.length < 2) return NextResponse.json({ grants: [], drafts: [] });

  const [clientRes, grantRes, draftRes] = await Promise.all([
    supabase.from("clients").select("account_managed").eq("id", clientId).maybeSingle(),
    supabase
      .from("grants")
      .select("id, title, funder, submission_deadline")
      .or(`title.ilike.*${safe}*,funder.ilike.*${safe}*,fon.ilike.*${safe}*`)
      .order("ingested_at", { ascending: false })
      .limit(GRANT_SCAN),
    supabase
      .from("intellengine_drafts")
      .select("id, title, status, updated_at")
      .eq("client_id", clientId)
      .ilike("title", `%${safe}%`)
      .order("updated_at", { ascending: false })
      .limit(LIMIT),
  ]);

  const managed = !!(clientRes.data as { account_managed?: boolean } | null)?.account_managed;
  const grantHits = (grantRes.data ?? []) as { id: string; title: string | null; funder: string | null; submission_deadline: string | null }[];

  // The card is what a result LINKS to — /portal/grants/[cardId], not the grant id — so
  // this join is not a filter bolted on afterwards, it is how the href gets built.
  let cards: CardRow[] = [];
  if (grantHits.length > 0) {
    let q: any = supabase
      .from("review_cards")
      .select("id, grant_id, decision, interested_at, sme_released_at")
      .eq("client_id", clientId)
      .neq("card_type", "prospect")
      .in(
        "grant_id",
        grantHits.map((g) => g.id),
      );
    if (managed) q = q.not("sme_released_at", "is", null);
    const { data } = await q;
    cards = (data ?? []) as CardRow[];
  }

  const byGrant = new Map(cards.map((c) => [c.grant_id, c]));
  const grants = grantHits
    .map((g) => {
      const card = byGrant.get(g.id);
      if (!card) return null; // no visible card of theirs -> not theirs to find here
      return {
        cardId: card.id,
        title: g.title,
        funder: g.funder,
        submission_deadline: g.submission_deadline,
        // Where it sits in THEIR process. "Matched at some point" includes grants they
        // passed on, and a jump-to that lands you on a closed decision without saying so
        // reads as a bug in the search rather than a fact about the grant.
        state: stateOf(card),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .slice(0, LIMIT);

  return NextResponse.json({ grants, drafts: draftRes.data ?? [] });
}

// The client's own four states, in the same cascade the portal dashboard reads: a decision
// is terminal, then interest moves a grant out of Alerts into the Report, then it is still
// an alert waiting on them.
function stateOf(c: CardRow): string {
  if (c.decision === "approved") return "Approved";
  if (c.decision === "passed") return "Passed";
  if (c.interested_at !== null) return "In your Grant Report";
  return "Awaiting your review";
}
