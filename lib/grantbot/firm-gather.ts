import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { NON_LEAD_OR_FILTER } from "@/lib/leads/stage";
import {
  buildFirmContextPack,
  FIRM_COLUMNS,
  type FirmContextPack,
  type FirmPackClient,
} from "@/lib/grantbot/firm-context-pack";

// The ONE read behind the firm roster pack. I/O only — every rule about what the roster SAYS lives in
// the pure firm-context-pack.ts, asserted offline.
//
// ── ONE QUERY, ONE TABLE, PROFILE COLUMNS ONLY ──
//
// The per-client pack fans seven tables per client; doing that across ~40 clients is the "firehose"
// this bot is designed NOT to be. The profiles-only cut collapses to a SINGLE select over `clients`.
// Explicit column list (never `select *`): keeps intake_data/client_profile in but never pulls a
// commercial, billing, PII, or eligibility-registry column — those are deliberately absent from a
// profiles-only roster (a strategist, not an eligibility determiner). The list is the one-to-one
// match of firm-context-pack.ts's FirmPackClient Pick, so the two cannot drift.
//
// ── ROSTER = THE MATCHER'S ROSTER ──
//
// NON_LEAD_OR_FILTER (pipeline_stage null OR 'converted') AND match_active=true is the EXACT predicate
// runMatching uses to load the scoring roster (lib/grants/pipeline.ts). So the firm bot reasons over
// precisely the clients the platform actively matches — un-converted leads and paused clients are out.
//
// ── SERVICE-ROLE, STAFF-ONLY SURFACE ──
//
// Same as gather.ts: the roster aggregates internal profile fields, so it is staff-only at the route
// (Brick 1 gates it admin-only) and read service-role. The commercial/billing/PII exclusion is a
// property of the SELECT (those columns are never named), not a filter over a wider read.

export interface FirmGatherResult {
  pack: FirmContextPack;
}

// Returns the roster pack (never null — an empty roster is a valid, if unusual, result the gaps list
// reports). Authorisation for the SURFACE is the route's job (admin-only in Brick 1).
export async function gatherFirmPack(opts: {
  generatedBy: string;
  actorRole: string;
  generatedAt: string;
}): Promise<FirmGatherResult> {
  const svc = createServiceClient();
  const { data } = await svc
    .from("clients")
    .select(FIRM_COLUMNS)
    .or(NON_LEAD_OR_FILTER)
    .eq("match_active", true)
    .order("name", { ascending: true });

  // Cast through unknown: a string-list select sends the Supabase generic into a GenericStringError
  // union, the same reason gather.ts narrows on the result rather than the builder.
  const clients = (data ?? []) as unknown as FirmPackClient[];
  const pack = buildFirmContextPack({
    generatedAt: opts.generatedAt,
    generatedBy: opts.generatedBy,
    actorRole: opts.actorRole,
    clients,
  });
  return { pack };
}
