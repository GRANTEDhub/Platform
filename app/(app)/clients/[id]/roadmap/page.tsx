import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { GrantReportConsole } from "@/components/report/grant-report-console";
import { buildQueue } from "@/lib/report/report-queue";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// Staff's view of a client's Grant Report — the queue of matched grants awaiting review,
// and the entry point into the review loop.
//
// THIS IS NOT THE CLIENT'S LIST. app/portal/grants renders GrantReport for the client's
// own view of the same cards. The two were one component; they are deliberately not any
// more, for the same reason the grant review split: every staff control here would
// otherwise have to be suppressed there.
//
// For a STANDARD client there is no release gate — their queue is theirs the moment it is
// scored, so the "awaiting release" bucket is empty by construction and the useful view is
// what is with the client. For an ACCOUNT-MANAGED client (0059) or an un-converted lead,
// staff hold every card before the client sees it, and that bucket is the job.
//
// The client-decision activity feed that used to sit above this list is gone: the client
// dashboard's activity card carries client-side decisions now, and two places showing the
// same facts is one too many on a screen built to fit nine rows.

// The engine's own check-this-first list. Non-empty means the card carries a concern,
// which drives the row's left-edge accent — the only per-row status signal, and
// deliberately not a chip (an earlier pass carried per-row flag chips; they were removed).
type ConcernRow = { id: string; before_you_approve: string[] | null };

export default async function ClientRoadmapPage({ params }: { params: { id: string } }) {
  await requireUser();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, account_managed, pipeline_stage")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "account_managed" | "pipeline_stage">>();
  if (!client) notFound();

  const managed = !!client.account_managed;
  const isLead = isUnconvertedLead(client.pipeline_stage);
  const gate = managed || isLead;

  // Typed `any`: the two branches chain a different shape of filters (two calls vs one),
  // which sends the Supabase query builder's generic into a "type instantiation is
  // excessively deep" error if left inferred.
  let query: any = supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, qa_fit_score, qa_factor_scores, qa_sources, qa_status, qa_engine_fit_score, sme_released_at, before_you_approve, staff_read_at, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas)",
    )
    .eq("client_id", params.id)
    .neq("card_type", "prospect");
  // Managed client and lead/prospect: staff's whole queue. Standard client: the client's
  // Grant Alerts gate (0057), promoted-only. Passed cards are kept either way — they
  // populate the Rejected bucket rather than vanishing.
  query = gate ? query : query.not("interested_at", "is", null);
  const { data } = await query;

  const rowsRaw = (data ?? []) as unknown as (ReportCardRow & ConcernRow)[];
  const items = toReportItems(rowsRaw, "staff");
  const concernIds = new Set(rowsRaw.filter((r) => (r.before_you_approve ?? []).length > 0).map((r) => r.id));

  // When matching last produced a card for this client — the header's "last refreshed".
  // review_cards has no created_at, so a carded match_attempt is the only record of it.
  const { data: attemptRows } = await supabase
    .from("match_attempts")
    .select("created_at")
    .eq("client_id", params.id)
    .eq("outcome", "carded")
    .order("created_at", { ascending: false })
    .limit(1);
  const lastCarded = ((attemptRows ?? []) as { created_at: string }[])[0]?.created_at ?? null;

  return (
    <GrantReportConsole
      clientName={client.name}
      clientHref={`/clients/${client.id}`}
      basePath={`/clients/${client.id}/roadmap`}
      rows={buildQueue(items, { hasReleaseGate: gate, concernIds })}
      refreshedLabel={lastCarded ? agoLabel(lastCarded, Date.now()) : null}
      // Bulk-archiving writes a decision on every card it touches. Offered only where
      // staff hold the queue in the first place — on a standard client these cards are
      // the client's, and their deadlines passing is not ours to close out. Everyone who
      // reaches this route is staff (requireUser + the (app) segment), so the gate is the
      // release gate, not the role.
      canArchive={gate}
    />
  );
}

// Deliberately coarse: the point is "is this list current", and a minute-precise figure
// on a page that does not live-update would be its own small lie.
function agoLabel(iso: string, now: number): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > now) return null;
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
