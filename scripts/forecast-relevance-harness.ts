/**
 * Stage-1 verification harness for the forecasted "On the horizon" relevance rank.
 * Loads one client/lead by id, runs getForecastHorizon against the live forecasted
 * candidate pool, and prints the ranked shortlist + rationales.
 *
 * This is a manual, read-only harness -- it mints nothing, writes nothing, and never
 * touches the occupancy pool. Run it in an environment that has ANTHROPIC_API_KEY +
 * the Supabase service key (e.g. a preview shell); the sandbox has neither.
 *
 *   npx tsx scripts/forecast-relevance-harness.ts <clientId>
 *
 * (server-only is aliased by Next; to run under tsx, stub node_modules/server-only
 * with an empty module first, then remove it -- node_modules is gitignored.)
 */
import { createServiceClient } from "@/lib/supabase/server";
import { getForecastHorizon, loadForecastCandidates } from "@/lib/grants/forecast-relevance";
import type { Client } from "@/types/database";

async function main() {
  const clientId = process.argv[2];
  if (!clientId) {
    console.error("Usage: npx tsx scripts/forecast-relevance-harness.ts <clientId>");
    process.exit(1);
  }
  const db = createServiceClient();

  const { data: client, error } = await db.from("clients").select("*").eq("id", clientId).single<Client>();
  if (error || !client) {
    console.error(`Client ${clientId} not found: ${error?.message ?? "no row"}`);
    process.exit(1);
  }

  const candidates = await loadForecastCandidates(db);
  console.log(`\nClient: ${client.name} (${client.org_type ?? "?"}, ${client.location_state ?? "?"})`);
  console.log(`Forecasted candidate pool: ${candidates.length} field-bearing domestic grants\n`);

  const started = Date.now();
  const horizon = await getForecastHorizon(db, client);
  const ms = Date.now() - started;

  console.log(`── On the horizon for ${client.name} (${horizon.length} of ${candidates.length}, ${ms}ms) ──\n`);
  horizon.forEach((h, i) => {
    console.log(`${i + 1}. ${h.title}${h.funder ? ` — ${h.funder}` : ""}`);
    console.log(`   ${h.rationale}\n`);
  });
  if (horizon.length === 0) console.log("(no forecasted grants cleared the relevance bar for this org)\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
