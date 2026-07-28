import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { extractSimplerGovOpportunityId } from "@/lib/grants/engine";

// "Check a grant" — step 1 of 2: RESOLVE a free-text input to candidate grant(s) in
// our ledger, for the user to confirm before we score. No scoring, no persistence.
//
// Per IntellEngine's #1 failure mode ("analyzing a misidentified grant"), confirm the
// right grant BEFORE analyzing. This returns candidates; the client picks one; the
// sibling POST /api/clients/[id]/check-grant then scores that confirmed grant.
//
// v1 (P1) resolves against the already-ingested LEDGER only:
//   - a Simpler/Grants.gov link -> map the opportunity id to the ledger row
//   - a name / keyword / FON -> ilike search over the ledger
// A link or grant we haven't ingested yet returns notInLedger:true — ingesting brand
// -new grants on the fly (shred pipeline) is P2.

const CANDIDATE_COLS = "id, title, funder, submission_deadline, status, source_url";

type Candidate = {
  grantId: string;
  title: string | null;
  funder: string | null;
  submission_deadline: string | null;
  status: string;
  ready: boolean; // status === 'complete' -> fully shredded, safe to score cleanly
};

function toCandidate(row: Record<string, unknown>): Candidate {
  const status = String(row.status ?? "");
  return {
    grantId: String(row.id),
    title: (row.title as string) ?? null,
    funder: (row.funder as string) ?? null,
    submission_deadline: (row.submission_deadline as string) ?? null,
    status,
    ready: status === "complete",
  };
}

export async function POST(req: NextRequest, { params: _params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { query?: string };
  const query = (body.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "Enter a grant name, keyword, or link." }, { status: 400 });

  const db = createServiceClient();
  const looksLikeUrl = /^https?:\/\//i.test(query) || /grants\.gov/i.test(query);

  // ── URL path: map a Simpler/Grants.gov link to the ledger row by opportunity id ──
  if (looksLikeUrl) {
    const oppId = extractSimplerGovOpportunityId(query);
    if (oppId) {
      const { data } = await db.from("grants").select(CANDIDATE_COLS).ilike("source_url", `%${oppId}%`).limit(1);
      const row = (data ?? [])[0];
      if (row) return NextResponse.json({ kind: "url", candidates: [toCandidate(row)] });
      return NextResponse.json({
        kind: "url",
        candidates: [],
        notInLedger: true,
        message:
          "That opportunity isn't in the ledger yet. Dropping in brand-new grants (auto-shred) is coming next — for now, ingest it from the Ledger, then check it here.",
      });
    }
    return NextResponse.json({
      kind: "url",
      candidates: [],
      notInLedger: true,
      message:
        "That link isn't a recognized Grants.gov / Simpler.gov opportunity. Try the grant's name or funding-opportunity number to search the ledger.",
    });
  }

  // ── Name / keyword / FON path: ilike search over the domestic ledger ─────────────
  const safe = query.replace(/[%*(),:\\]/g, " ").trim();
  if (!safe) return NextResponse.json({ kind: "name", candidates: [] });
  const { data } = await db
    .from("grants")
    .select(CANDIDATE_COLS)
    .or(`title.ilike.*${safe}*,funder.ilike.*${safe}*,fon.ilike.*${safe}*`)
    .or("is_domestic.is.null,is_domestic.eq.true")
    .order("ingested_at", { ascending: false })
    .limit(8);
  const candidates = (data ?? []).map(toCandidate);
  return NextResponse.json({
    kind: "name",
    candidates,
    ...(candidates.length === 0
      ? { message: "No ledger match. Check the spelling, try the funder or opportunity number, or paste the Grants.gov / Simpler.gov link." }
      : {}),
  });
}
