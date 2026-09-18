import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runPrimeCapacityBackfill } from "@/lib/clients/prime-capacity-backfill";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Admin trigger for the prime-capacity re-distill backfill -- the "look before you apply" dry-run + the
// controlled, capped apply that heals stored client_profile rows carrying the old can_prime=false default
// into the three-state derivation (CAN / CANNOT / UNKNOWN). See lib/clients/prime-capacity-backfill.ts.
//
//   GET  -> DRY-RUN (read-only): re-distills the false-bucket clients (bounded by ?limit / ?name) and reports
//           the old->new split -- toUnknown / toCan (the released implementers) vs stayCannot (genuine funders
//           that must stay locked out of Prime, e.g. AGFF). Writes nothing. Each row is one model call, so
//           preview a SAMPLE (?limit, default 50) or target names (?name=%mississippi%) rather than the whole
//           bucket at once.
//   POST -> APPLY (capped, resumable): re-distills + writes the healed profile. Body { limit?, name? }. A cap /
//           the route's time budget bounds the batch; POST again for the remainder.
//
// Admin-only. GET (browser-openable) is safe because it only reads + re-distills in memory; the WRITE is
// POST-only so a link scanner / prefetch can never trigger it -- the same GET-is-safe / POST-mutates
// discipline as the closed-sweep, intel, and deadline backfill routes. NOT flag-gated: this is the deliberate
// manual heal tool, run once after the three-state distiller fix ships.

// Leave the route a comfortable margin under maxDuration so a long batch finishes and reports `remaining`
// instead of being killed mid-write.
const DEADLINE_MS = 280_000;
const DRY_RUN_DEFAULT_LIMIT = 50;

async function requireAdmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { error: null as null };
}

// A jsonb ilike operand can carry % and _ (LIKE metacharacters); pass the name straight through -- an admin
// typing "%mississippi%" wants exactly that. Only normalize whitespace so a stray value can't break the query.
function nameParam(raw: string | null): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit =
    limitRaw !== null && limitRaw !== "" && Number.isFinite(Number(limitRaw))
      ? Math.max(0, Math.floor(Number(limitRaw)))
      : DRY_RUN_DEFAULT_LIMIT;

  const result = await runPrimeCapacityBackfill(createServiceClient(), {
    apply: false,
    limit,
    nameLike: nameParam(url.searchParams.get("name")),
    deadlineMs: DEADLINE_MS,
  });
  return NextResponse.json({
    dryRun: true,
    scanned: result.scanned, // clients with a distilled profile
    falseBucket: result.falseBucket, // heal candidates (can_prime === false today)
    previewed: result.processed, // how many were re-distilled in this sample
    remaining: result.remaining, // false-bucket clients NOT previewed this run
    flips: result.flips, // { toUnknown, toCan, stayCannot, errors }
    // Old -> new per client so the split is verifiable (expect MS County / Faulkner in toUnknown/toCan; AGFF
    // in stayCannot). Trimmed to the fields a reviewer needs.
    sample: result.results.map((r) => ({
      name: r.name,
      orgType: r.orgType,
      canPrime: `false -> ${r.newCanPrime === true ? "true (CAN)" : r.newCanPrime === false ? "false (CANNOT)" : "null (UNKNOWN)"}`,
      kind: r.kind,
      newRationale: r.newRationale,
      error: r.error,
    })),
  });
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { limit?: number; name?: string };
  // Distinguish an explicit 0 (write NOTHING) from absent (no cap): a falsy `> 0` check would coerce {limit:0}
  // to undefined -> "no cap" -> the FULL batch, the opposite of the intent.
  const limit = typeof body.limit === "number" && body.limit >= 0 ? Math.floor(body.limit) : undefined;

  const result = await runPrimeCapacityBackfill(createServiceClient(), {
    apply: true,
    limit,
    nameLike: typeof body.name === "string" ? nameParam(body.name) : undefined,
    deadlineMs: DEADLINE_MS,
  });
  return NextResponse.json({
    dryRun: false,
    written: result.written,
    processed: result.processed,
    falseBucket: result.falseBucket,
    remaining: result.remaining,
    flips: result.flips,
    errors: result.results.filter((r) => r.error).map((r) => ({ name: r.name, error: r.error })),
  });
}
