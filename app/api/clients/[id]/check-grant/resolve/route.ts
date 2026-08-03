import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { extractSimplerGovOpportunityId } from "@/lib/grants/engine";
import { loadOpenGrantPool, rankGrantsForNeed } from "@/lib/grants/need-search";
import { resolveCheckGrantAccess } from "@/lib/clients/check-grant-access";

// The described-need path runs one cheap LLM rerank over the open pool, so give the
// route headroom beyond the default.
export const maxDuration = 60;

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
//
// OPEN TO A PORTAL MEMBER for their own org (resolveCheckGrantAccess), so the client
// dashboard's "Score a grant" reaches the same resolver staff use. What it returns is
// ledger rows for PUBLIC federal opportunities — nothing client-owned — and the one
// client-scoped field on them, `onRoadmap`, is already keyed to params.id, which access
// control has pinned to the caller's own org. Staff stay admin-only, as before.

const CANDIDATE_COLS = "id, title, funder, submission_deadline, status, source_url";

type Candidate = {
  grantId: string;
  title: string | null;
  funder: string | null;
  submission_deadline: string | null;
  status: string;
  ready: boolean; // status === 'complete' -> fully shredded, safe to score cleanly
  reason?: string | null; // why this matched the described need (need-out path only)
  onRoadmap?: boolean; // already matched to THIS client (a review_card exists)
};

type DB = ReturnType<typeof createServiceClient>;

// Flag candidates already on THIS client's roadmap so staff see "we've already matched
// this one" instead of re-checking a known match. Best-effort; never throws.
//
// `releasedOnly` is the 0059 gate, and it applies when the CLIENT is the one searching: an
// "On roadmap" chip against an unreleased card would announce a match their account manager
// has not released yet — the same leak the scorer's existing-card short-circuit guards, in
// a badge instead of a verdict. Staff see every card, as before.
async function flagOnRoadmap(
  db: DB,
  clientId: string,
  candidates: Candidate[],
  releasedOnly: boolean,
): Promise<void> {
  const ids = candidates.map((c) => c.grantId);
  if (ids.length === 0) return;
  let q: any = db
    .from("review_cards")
    .select("grant_id")
    .eq("client_id", clientId)
    .neq("card_type", "prospect")
    .in("grant_id", ids);
  if (releasedOnly) q = q.not("sme_released_at", "is", null);
  const { data } = await q;
  const matched = new Set((data ?? []).map((r: { grant_id: string }) => r.grant_id));
  for (const c of candidates) if (matched.has(c.grantId)) c.onRoadmap = true;
}

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

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await resolveCheckGrantAccess(params.id, { staffRole: "admin" });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = (await req.json().catch(() => ({}))) as { query?: string };
  const query = (body.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "Enter a grant name, keyword, or link." }, { status: 400 });

  const db = createServiceClient();
  // The 0059 release gate applies to the roadmap chip when the client is searching — see
  // flagOnRoadmap. Read once, up front, so both exit paths below honour it.
  let releasedOnly = false;
  if (access.actor === "client") {
    const { data: c } = await db.from("clients").select("account_managed").eq("id", params.id).maybeSingle();
    releasedOnly = !!(c as { account_managed?: boolean } | null)?.account_managed;
  }
  const looksLikeUrl = /^https?:\/\//i.test(query) || /grants\.gov/i.test(query);

  // ── URL path: map a Simpler/Grants.gov link to the ledger row by opportunity id ──
  if (looksLikeUrl) {
    const oppId = extractSimplerGovOpportunityId(query);
    if (oppId) {
      const { data } = await db.from("grants").select(CANDIDATE_COLS).ilike("source_url", `%${oppId}%`).limit(1);
      const row = (data ?? [])[0];
      if (row) {
        const cands = [toCandidate(row)];
        await flagOnRoadmap(db, params.id, cands, releasedOnly);
        return NextResponse.json({ kind: "url", candidates: cands });
      }
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

  // ── Name / need path: direct ledger match + conceptual need-rank, merged ─────────
  // A short exact-ish query (grant name / funder / FON) resolves DIRECTLY (guaranteed,
  // regardless of the need-pool cap); a described NEED is matched conceptually by the
  // cheap LLM reranker over the open pool. Both feed the same confirm -> score flow.
  const safe = query.replace(/[%*(),:\\]/g, " ").trim();

  const direct: Candidate[] = [];
  if (safe) {
    const { data } = await db
      .from("grants")
      .select(CANDIDATE_COLS)
      .or(`title.ilike.*${safe}*,funder.ilike.*${safe}*,fon.ilike.*${safe}*`)
      .or("is_domestic.is.null,is_domestic.eq.true")
      .order("ingested_at", { ascending: false })
      .limit(6);
    direct.push(...(data ?? []).map(toCandidate));
  }

  // Conceptual need match over the open pool. Client context grounds eligibility /
  // tie-breaks; the need text leads. Fail-safe (rankGrantsForNeed never throws).
  const { data: clientRow } = await db
    .from("clients")
    .select("name, org_type, location_city, location_county, location_state, service_area, primary_funding_needs")
    .eq("id", params.id)
    .maybeSingle();
  const pool = await loadOpenGrantPool(db);
  const needMatches = await rankGrantsForNeed(query, orgContext(clientRow), pool, 8);
  const poolById = new Map(pool.map((g) => [g.id, g]));

  // Merge: direct hits first (exact), then need matches not already present; if the
  // reranker also surfaced a direct hit, borrow its reason.
  const merged: Candidate[] = [...direct];
  const seen = new Set(direct.map((c) => c.grantId));
  for (const m of needMatches) {
    if (seen.has(m.grantId)) {
      const hit = merged.find((c) => c.grantId === m.grantId);
      if (hit && !hit.reason) hit.reason = m.reason;
      continue;
    }
    const g = poolById.get(m.grantId);
    if (!g) continue;
    seen.add(m.grantId);
    merged.push({ ...toCandidate(g as unknown as Record<string, unknown>), reason: m.reason });
  }
  const candidates = merged.slice(0, 8);
  await flagOnRoadmap(db, params.id, candidates, releasedOnly);
  return NextResponse.json({
    kind: "name",
    candidates,
    ...(candidates.length === 0
      ? { message: "No ledger match — try different wording, the funder, or paste the Grants.gov / Simpler.gov link." }
      : {}),
  });
}

// Compact, public-safe org context for the need reranker (name/type/location/service
// area/stated priorities). The need text is the primary signal; this only grounds
// eligibility and tie-breaks.
function orgContext(c: Record<string, unknown> | null): string {
  if (!c) return "(no organization context available)";
  const arr = (v: unknown): string[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : []);
  const parts = [
    c.name ? `Organization: ${String(c.name)}` : "",
    c.org_type ? `Type: ${String(c.org_type).replace(/_/g, " ")}` : "",
    c.location_city || c.location_county || c.location_state
      ? `Location: ${[c.location_city, c.location_county, c.location_state].filter(Boolean).join(", ")}`
      : "",
    arr(c.service_area).length ? `Service area: ${arr(c.service_area).join("; ")}` : "",
    arr(c.primary_funding_needs).length ? `Stated funding priorities: ${arr(c.primary_funding_needs).join("; ")}` : "",
  ].filter(Boolean);
  return parts.join("\n") || "(no organization context available)";
}
