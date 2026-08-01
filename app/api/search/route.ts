import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// Global search behind the command band's ⌘K palette.
//
// SCOPE IS DELIBERATELY TWO THINGS: clients and ledger grants, both by name. Those are
// the two entities staff navigate to by name all day, and both are already readable
// under the staff RLS policies — so this is a navigation aid over data we have, not a
// new capability. It is NOT a content search: it does not look inside NOFO text,
// review cards, drafts, or notes. A search box that silently covers some of the
// product and not the rest is worse than one with a stated scope, so the palette
// labels its two groups rather than implying it searched everything.
//
// Domestic-only, matching the Ledger. GRANTED does not work international programs, so
// surfacing one in a jump-to palette would be offering a destination we would never
// pursue. Legacy rows with is_domestic NULL are treated as domestic, the same `?? true`
// convention used everywhere else.
export const dynamic = "force-dynamic";

const LIMIT = 6;

export async function GET(req: Request) {
  await requireUser();
  const supabase = createClient();

  const raw = (new URL(req.url).searchParams.get("q") ?? "").trim();
  // Strip the characters that carry meaning in PostgREST's filter grammar. Same guard
  // the Ledger and the check-grant resolver use: unescaped, a stray comma or paren
  // breaks the `.or()` expression rather than returning nothing, so it has to go before
  // interpolation and not after.
  const safe = raw.replace(/[%*(),:\\]/g, " ").trim();
  if (safe.length < 2) return NextResponse.json({ clients: [], grants: [] });

  const [clientRes, grantRes] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, org_type, location_city, location_state, pipeline_stage")
      .ilike("name", `%${safe}%`)
      .order("name")
      .limit(LIMIT),
    supabase
      .from("grants")
      .select("id, title, funder, submission_deadline")
      .or(`title.ilike.*${safe}*,funder.ilike.*${safe}*,fon.ilike.*${safe}*`)
      // Separate .or() group: multiple groups are AND-ed, so this narrows the search
      // above rather than widening it.
      .or("is_domestic.is.null,is_domestic.eq.true")
      .order("ingested_at", { ascending: false })
      .limit(LIMIT),
  ]);

  return NextResponse.json({
    clients: clientRes.data ?? [],
    grants: grantRes.data ?? [],
  });
}
