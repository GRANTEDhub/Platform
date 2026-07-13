// One-time, client-centric match: score ONE org against the whole current grant
// pool. The matcher is otherwise grant-centric (runMatching = one grant -> the
// roster); this is the mirror orientation, added for the prospect tool. Adding a
// prospect via the client form fires this once in the background so its dashboard
// fills with scored cards without waiting on the next daily batch.
//
// It reuses scoreGrantClientPair -- the SAME per-pair path runMatching uses -- so
// a card minted here is indistinguishable from one the batch would mint. It does
// NOT touch grants.status (that is the per-grant batch's signal); progress for
// this run lives on clients.initial_match_status (migration 0045).

import type { createServiceClient } from "@/lib/supabase/server";
import { scoreGrantClientPair } from "@/lib/grants/pipeline";

type DB = ReturnType<typeof createServiceClient>;

// Match one org against every scorable grant, concurrently. Mirrors runMatching's
// rolling pool at the same CONCURRENCY (each pair is a token-heavy Sonnet call).
const CONCURRENCY = 8;

/**
 * Score `clientId` against the current grant pool once and stamp the outcome on
 * clients.initial_match_status ('complete' / 'error'). Best-effort: a single
 * pair failing is swallowed inside scoreGrantClientPair (logged as an error
 * attempt), so one bad grant never aborts the run; only a load/setup failure
 * marks the whole run 'error'. Intended to run in a background waitUntil after
 * enrichClient, with the caller having already set status='running'.
 *
 * Loads the org by id directly (NOT via NON_LEAD_OR_FILTER) -- a prospect is an
 * un-converted lead by design, so the roster filter would exclude it. The
 * client-centric card render (/clients/[id]) shows cards by client_id regardless
 * of pipeline_stage, so the prospect sees them.
 */
export async function runInitialMatchForClient(db: DB, clientId: string): Promise<void> {
  try {
    const { data: client, error: clientErr } = await db
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .single();
    if (clientErr || !client) {
      throw new Error(clientErr?.message ?? "Client row not found for initial match");
    }

    // The scorable pool: grants that reached Stage A (an ideal_applicant_profile
    // was built). A grant with no profile was grant-level-skipped / international /
    // hard-disqualified / forecasted and is never scored by the batch either, so
    // scoring it here would only waste calls and mint nothing. Mirrors willScore.
    const { data: grants, error: grantsErr } = await db
      .from("grants")
      .select("*")
      .not("ideal_applicant_profile", "is", null);
    if (grantsErr) throw new Error(grantsErr.message);

    const pool = grants ?? [];
    if (pool.length > 0) {
      let nextIdx = 0;
      const worker = async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= pool.length) return;
          await scoreGrantClientPair(pool[i], client, db);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, pool.length) }, worker),
      );
    }

    await db.from("clients").update({ initial_match_status: "complete" }).eq("id", clientId);
  } catch (err) {
    console.error("Initial match failed for client", clientId, err);
    // Retryable: 'error' surfaces on the dashboard; the run can be re-fired.
    await db.from("clients").update({ initial_match_status: "error" }).eq("id", clientId);
  }
}
