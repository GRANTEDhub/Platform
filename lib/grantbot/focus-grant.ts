import type { SupabaseClient } from "@supabase/supabase-js";
import type { PromptBlock } from "@/lib/grantbot/prompt";

// The GRANT ANCHOR for a per-client GrantBot conversation ("Ask GrantBot" from a grant's IntellEngine
// tile). A conversation opened from a grant card stores that grant's id (grantbot_conversations.
// focus_grant_id, migration 0098); this module turns that id into a grounding block so every turn in
// the thread knows it is about THIS grant for THIS client — the staffer just asks, without re-pasting
// which grant they mean (the MS County retyping this feature exists to kill).
//
// WHY A BLOCK, NOT A CLIENT MESSAGE: the anchor is a STORED id (set server-side from the grant card),
// and the block TEXT is composed here from the grant's own PUBLIC row (title, funder, CFDA, deadline)
// — never from the request body. So this respects the turn's "no browser-supplied prompt text"
// invariant exactly: the client supplies a pointer (an id), the server supplies the words. The grant
// corpus is not client-private, so a pointer at the wrong grant only mis-focuses the thread; it leaks
// nothing (the client_id boundary on the conversation is unchanged).
//
// The loader takes the db as a param (no server-only import) so the pure block builder + the mapping
// are unit-testable with an injected fake, the data-tools seam pattern.

export interface FocusGrant {
  id: string;
  title: string;
  funder: string | null;
  cfda: string | null;
  deadline: string | null; // submission_deadline, as stored (text/date); shown verbatim
  fon: string | null; // opportunity number
}

// Read the anchored grant's public facts. Returns null when the id resolves to no grant — the turn
// then proceeds ungrounded (fail-open), never a crash. Errors (incl. a missing column before 0098 is
// applied) leave `data` null, so this is resilient to the migration not being applied yet.
export async function loadFocusGrant(db: SupabaseClient, grantId: string): Promise<FocusGrant | null> {
  try {
    const { data } = await db
      .from("grants")
      .select("id, title, funder, fon, assistance_listings, submission_deadline")
      .eq("id", grantId)
      .maybeSingle();
    if (!data) return null;
    const g = data as {
      id: string;
      title: string | null;
      funder: string | null;
      fon: string | null;
      assistance_listings: { number?: string | null }[] | null;
      submission_deadline: string | null;
    };
    const cfda = Array.isArray(g.assistance_listings)
      ? g.assistance_listings.map((a) => a?.number).filter(Boolean).join(", ") || null
      : null;
    return {
      id: String(g.id),
      title: (g.title ?? "").trim() || "this grant",
      funder: g.funder?.trim() || null,
      cfda,
      deadline: g.submission_deadline?.trim() || null,
      fon: g.fon?.trim() || null,
    };
  } catch {
    // A THROWN read (a genuine network-level Supabase failure, not the ordinary {data,error} result) must
    // NOT propagate: runTurn awaits loadFocusGrant AFTER appendUser has durably written the user turn but
    // BEFORE the try/catch that guarantees a paired assistant row, so a throw here would orphan the user
    // row (the exact firm-turn.ts-hardened window). Fail soft to null → an ungrounded turn, which is what
    // this function's contract above already promises ("Errors … leave `data` null … never a crash").
    return null;
  }
}

// The grounding block. cacheable:false + appended AFTER the cache breakpoint (like every other
// per-turn block), so a thread with no anchor is byte-identical to before and existing prompt caches
// are never busted. Present ONLY when a conversation actually has a focus grant.
export function buildFocusGrantBlock(grant: FocusGrant): PromptBlock {
  const facts = [
    `Grant: ${grant.title}`,
    grant.funder ? `Funder: ${grant.funder}` : null,
    grant.cfda ? `CFDA: ${grant.cfda}` : null,
    grant.fon ? `Opportunity number: ${grant.fon}` : null,
    grant.deadline ? `Submission deadline: ${grant.deadline}` : null,
  ]
    .filter(Boolean)
    .map((l) => `  • ${l}`)
    .join("\n");
  return {
    kind: "focus-grant",
    source: "lib/grantbot/focus-grant.ts",
    version: "2026-09-14.1",
    cacheable: false,
    text: [
      "THIS CONVERSATION IS ANCHORED TO ONE GRANT",
      "The staffer opened this thread from a specific grant's card, so treat every question here as being about THIS grant for THIS client unless they clearly say otherwise:",
      "",
      facts,
      "",
      "Answer as if the staffer had named this grant — do NOT ask which grant they mean or make them re-establish the context. This client's full profile and its matched-grant details are already in your context above; use them to reason about this grant specifically (eligibility as prime vs. partner/sub, who actually wins it, whether the deadline is realistic, real fit). If the staffer clearly shifts to a different grant or a general question, follow them there.",
    ].join("\n"),
  };
}
