import { createServiceClient } from "@/lib/supabase/server";
import { buildClientProfileInput, constructClientProfile } from "@/lib/clients/profile";
import type { Client, ClientProfile } from "@/types/database";

// Prime-capacity backfill -- the one-time re-distill sweep that heals stored client_profile rows carrying
// the OLD conservative default (can_prime = false) into the THREE-STATE derivation (CAN / CANNOT / UNKNOWN).
//
// THE PROBLEM. The client-profile distiller (lib/clients/profile.ts) used to DEFAULT can_prime = false on a
// thin intake. The direct-align scorer (MATCH_DIRECT_ALIGN_ENABLED, live) reads can_prime=false as "this org
// can NEVER be an implementation prime, full stop" -- so every thin-intake but prime-CAPABLE client (a county,
// an operating nonprofit) was silently locked out of the Prime role across the whole roster. The distiller is
// now fixed to emit null (UNKNOWN) on absence-of-evidence and RESERVE false for a positive money-mover finding
// (a funder / grantmaker / fiscal sponsor -- the AGFF archetype). But the LOGIC change heals nothing already
// stored: a client_profile written under the old default keeps can_prime=false until it is re-distilled.
//
// THE FIX. Re-run the (now three-state) distiller for each client whose stored can_prime === false and write
// the result. A genuine funder re-distills to false (CANNOT -- stays locked out of Prime, which is correct);
// a wrongly-defaulted implementer re-distills to null (UNKNOWN) or true (CAN) and is released. The dry-run
// shows this split BEFORE any write, so a distiller that wrongly demoted a funder to UNKNOWN would be caught
// as "AGFF: false -> null" in the preview, not in production.
//
// SCOPE = the false bucket only. TRUE and UNKNOWN clients were never wrongly locked out, so they are left
// untouched (no cost, no churn, no risk of a re-distill drifting a correct value). Forward-only, idempotent
// (a client already re-distilled away from false drops out of the bucket), capped + resumable (POST again for
// the remainder). Admin-only, NOT flag-gated -- this is a manual heal tool, run once after the fix ships.
//
// COST. Each processed client is ONE model call (the distiller). The false bucket may be most of the roster
// (the old default was false), so this is a real, bounded LLM job -- hence the per-run cap + wall-clock guard.
// The dry-run is the same per-client cost (it re-distills read-only to show old->new), so preview a SAMPLE
// (?limit / ?name) rather than the whole bucket at once.
//
// The SELECT is non-cached (a stable-URL service-role query -- the 2026-07-21 drain-cache hazard);
// createServiceClient already sets cache:"no-store", and the admin route passes that client.

type DB = ReturnType<typeof createServiceClient>;

// The re-distill seam (default = the real distiller). Injected in the unit test so the plumbing (bucket
// selection, dry-run vs apply, flip accounting, cap, resume) is proven with no model call / no network.
export type Redistill = (client: Client) => Promise<ClientProfile>;
const realRedistill: Redistill = (client) => constructClientProfile(buildClientProfileInput(client));

export type FlipKind = "to_unknown" | "to_can" | "stay_cannot" | "error";

// One client the sweep looked at: its stored can_prime (always false -- it's the bucket) and the re-distilled
// value. `kind` classifies the move for the report; `error` is set (and nothing is written) when the distill
// threw, so a single bad row never aborts the batch.
export interface PrimeBackfillPreview {
  id: string;
  name: string;
  orgType: string | null;
  oldCanPrime: false; // the bucket is can_prime === false by definition
  newCanPrime: boolean | null;
  newRationale: string | null;
  kind: FlipKind;
  written: boolean; // true only on an apply run that actually wrote this row
  error?: string;
}

export interface PrimeBackfillResult {
  scanned: number; // clients with a distilled profile that were read
  falseBucket: number; // TOTAL still can_prime === false (informational; funders keep it > 0 forever)
  processed: number; // how many were re-distilled this run (cap / deadline bound the rest)
  remaining: number; // eligible (past the cursor) not processed this run -- 0 means this cursor is exhausted
  nextCursor: string | null; // pass as afterId to the next run to advance past what was just processed
  flips: { toUnknown: number; toCan: number; stayCannot: number; errors: number };
  written: number; // 0 on a dry run
  results: PrimeBackfillPreview[]; // every processed client, old -> new (the "look" for the dry-run)
}

const CLIENT_PAGE = 1000;

// Fetch every client carrying a distilled profile, paginated to completeness (PostgREST caps rows/request, so
// an unpaginated SELECT silently returns only the first page). The false-bucket filter runs in JS -- a jsonb
// path filter is fragile and the clients table is small, so fetch + filter (the deadline-backfill idiom).
async function fetchProfiledClients(db: DB, nameLike: string | undefined, pageSize: number): Promise<Client[]> {
  const all: Client[] = [];
  for (let from = 0; ; from += pageSize) {
    let q = db
      .from("clients")
      .select("*")
      .not("client_profile", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (nameLike) q = q.ilike("name", nameLike);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Client[];
    all.push(...page);
    if (page.length < pageSize) break; // a short page is the last page
  }
  return all;
}

// Is this client in the heal bucket? STRICT === false: a null (UNKNOWN) or true (CAN) profile was never
// wrongly locked out, so it is not a candidate. Undefined (no prime_capacity) is also excluded.
export function isFalseBucket(client: Client): boolean {
  return client.client_profile?.prime_capacity?.can_prime === false;
}

function classify(newCanPrime: boolean | null): Exclude<FlipKind, "error"> {
  if (newCanPrime === false) return "stay_cannot";
  if (newCanPrime === true) return "to_can";
  return "to_unknown"; // null / undefined -> UNKNOWN
}

// Re-distill ONE bucketed client and (on apply) write the healed profile. Constructs the profile ONCE so the
// dry-run preview and the write share the single model call. On apply this mirrors refreshClientProfileById's
// write (stamp client_profile_generated_at) but CARRIES OVER the existing community_context instead of
// re-fetching it from Census -- the sweep only heals can_prime, and dropping a present community_context would
// be a silent regression. re-asserts can_prime IS still false in the WHERE so a concurrent live re-distill
// (an edit/backfill that already healed the row) is never clobbered.
async function processOne(
  db: DB,
  client: Client,
  apply: boolean,
  redistill: Redistill,
): Promise<PrimeBackfillPreview> {
  const base = {
    id: client.id,
    name: client.name,
    orgType: (client.org_type as string | null) ?? null,
    oldCanPrime: false as const,
  };
  try {
    const profile = await redistill(client);
    const newCanPrime = (profile.prime_capacity?.can_prime ?? null) as boolean | null;
    const newRationale = profile.prime_capacity?.rationale?.trim() || null;
    const kind = classify(newCanPrime);

    let written = false;
    if (apply) {
      // Carry over the existing community_context (a separate enrichment the distiller does not produce);
      // omitting it would overwrite the profile with one that drops it.
      const existingCommunity = client.client_profile?.community_context;
      if (existingCommunity) profile.community_context = existingCommunity;
      const { data, error } = await db
        .from("clients")
        .update({ client_profile: profile, client_profile_generated_at: new Date().toISOString() })
        .eq("id", client.id)
        // fill-false-bucket guard: never overwrite a row that was healed off `false` since the scan.
        .eq("client_profile->prime_capacity->>can_prime", "false")
        .select("id");
      if (error) return { ...base, newCanPrime, newRationale, kind, written: false, error: error.message };
      written = Array.isArray(data) && data.length > 0;
    }
    return { ...base, newCanPrime, newRationale, kind, written };
  } catch (err) {
    return {
      ...base,
      newCanPrime: false, // unchanged: nothing was written
      newRationale: null,
      kind: "error",
      written: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// The driver. Reads the profiled clients, filters to the false bucket, and re-distills up to `limit` of them
// (also bounded by an optional wall-clock deadline so a large bucket cannot overrun the route's maxDuration).
// apply:false is a pure read that writes nothing -- the dry-run behind the admin GET. Ordered by id so a
// capped run + a resume (POST again) march deterministically through the bucket.
export async function runPrimeCapacityBackfill(
  db: DB,
  opts: {
    apply: boolean;
    limit?: number; // max clients to re-distill this run; undefined = all
    afterId?: string; // resume cursor: process only bucket rows with id > afterId (see below)
    nameLike?: string; // optional ilike filter (e.g. "%mississippi%") to spot-check specific clients
    deadlineMs?: number; // stop starting new distills after this many ms (route budget guard)
    pageSize?: number; // client scan page size (overridable so a test proves paging)
  } = { apply: false },
  deps: { redistill?: Redistill; now?: () => number } = {},
): Promise<PrimeBackfillResult> {
  const redistill = deps.redistill ?? realRedistill;
  const now = deps.now ?? (() => Date.now());
  const start = now();
  const clients = await fetchProfiledClients(db, opts.nameLike, opts.pageSize ?? CLIENT_PAGE);
  const bucket = clients.filter(isFalseBucket);

  // Cursor by id (the scan is id-asc): a resumed run starts AFTER the last row processed last time. Genuine
  // funders and errored rows legitimately STAY can_prime=false, so they never leave the bucket -- without a
  // cursor a capped/resumed POST would re-distill them from the front every run, burning the cap on rows that
  // will never change and never terminating (#587 Codex P1). The cursor advances monotonically past every
  // ATTEMPTED row (healed, stay-CANNOT, or errored), so repeated POSTs reach the whole bucket and reach a
  // clean done (nextCursor null / remaining 0). falseBucket stays the TOTAL still-false count (it never hits
  // 0 because funders keep it positive) -- terminate on nextCursor/remaining, not falseBucket.
  const eligible = opts.afterId ? bucket.filter((c) => c.id > (opts.afterId as string)) : bucket;

  const cap = typeof opts.limit === "number" ? Math.max(0, Math.floor(opts.limit)) : eligible.length;
  const results: PrimeBackfillPreview[] = [];
  for (const client of eligible) {
    if (results.length >= cap) break;
    if (opts.deadlineMs !== undefined && now() - start >= opts.deadlineMs) break; // budget exhausted -> resume next run
    results.push(await processOne(db, client, opts.apply, redistill));
  }

  const flips = {
    toUnknown: results.filter((r) => r.kind === "to_unknown").length,
    toCan: results.filter((r) => r.kind === "to_can").length,
    stayCannot: results.filter((r) => r.kind === "stay_cannot").length,
    errors: results.filter((r) => r.kind === "error").length,
  };
  return {
    scanned: clients.length,
    falseBucket: bucket.length,
    processed: results.length,
    remaining: eligible.length - results.length,
    nextCursor: results.length ? results[results.length - 1].id : null,
    flips,
    written: results.filter((r) => r.written).length,
    results,
  };
}
