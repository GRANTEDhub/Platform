import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { GrantReport } from "@/components/report/grant-report";
import { ClientActivity, type ClientActivityItem } from "@/components/report/client-activity";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, staffBucket, type ReportCardRow, type StaffBucket } from "@/lib/report/shape";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client, PursuitPath } from "@/types/database";

export const dynamic = "force-dynamic";

// Staff account-manager view of a client's Grant Roadmap. For a STANDARD client,
// renders the EXACT same GrantReport the client sees in their portal -- one
// shared surface, the actor is just whoever's signed in. For an ACCOUNT-MANAGED
// client (0059), this is instead staff's OWN queue: every card staff has marked
// interested (their own Grant Alerts pass), both still awaiting release AND
// already released -- staff keep read-only visibility into released cards here
// (the "can I still see it as admin" question) rather than needing to sign in
// as the client. The per-row "Released to client" badge (lib/report/shape.ts's
// smeReleased) is what tells the two states apart; released cards are no longer
// actionable here (the client's own Grant Report owns the pursue decision now).
export default async function ClientRoadmapPage({ params }: { params: { id: string } }) {
  await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, account_managed, pipeline_stage")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "account_managed" | "pipeline_stage">>();
  if (!client) notFound();
  const managed = !!client.account_managed;
  // A prospect (un-converted lead, Tara-build) has no portal, so — like a managed
  // client — its whole scored queue is staff's to review here; the per-card action
  // is a cold one-pager send, not a portal release.
  const isLead = isUnconvertedLead(client.pipeline_stage);

  // Typed `any`: the two branches chain a different shape of filters (two calls
  // vs one), which sends the Supabase query builder's generic into a "type
  // instantiation is excessively deep" error if left inferred.
  let query: any = supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, sme_released_at, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas)",
    )
    .eq("client_id", params.id)
    .neq("card_type", "prospect");
  // Managed client (single AM gate) and lead/prospect (no portal): staff's whole
  // queue. Standard client: unchanged -- the client's Grant Alerts gate (0057),
  // promoted-only. Passed cards are now kept (they populate the "Rejected" bucket);
  // the default "Admin" view filters them out client-side.
  query = managed || isLead ? query : query.not("interested_at", "is", null);
  const { data } = await query;

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[]);

  // Client-side decisions (decided_by_actor='client') — the loop signal for the
  // AM. Separate query since it includes passes, which the roadmap list hides.
  const { data: activityRows } = await supabase
    .from("review_cards")
    .select("id, decision, decision_reason, decided_at, pursuit_path, grants(title)")
    .eq("client_id", params.id)
    .eq("decided_by_actor", "client")
    .neq("card_type", "prospect")
    .order("decided_at", { ascending: false })
    .limit(12);

  const activity: ClientActivityItem[] = ((activityRows ?? []) as Array<{
    id: string;
    decision: string;
    decision_reason: string | null;
    decided_at: string | null;
    pursuit_path: PursuitPath | null;
    grants: { title: string | null } | { title: string | null }[] | null;
  }>)
    .filter((r) => r.decision === "approved" || r.decision === "passed")
    .map((r) => {
      const g = Array.isArray(r.grants) ? r.grants[0] : r.grants;
      return {
        cardId: r.id,
        title: g?.title || "Untitled opportunity",
        decision: r.decision as "approved" | "passed",
        reason: r.decision_reason,
        decidedAt: r.decided_at,
        pursuitPath: r.pursuit_path,
      };
    });

  // Lifecycle-bucket counts drive both the header and the chip badges. Managed
  // clients and leads have the AM release gate; standard clients don't.
  const gate = managed || isLead;
  const counts: Record<StaffBucket, number> = { admin: 0, client: 0, pursued: 0, rejected: 0 };
  for (const i of items) counts[staffBucket(i, gate)]++;
  const subtitle = isLead
    ? items.length === 0
      ? "No grants yet — generate this prospect's grant report from their dashboard."
      : `${counts.admin} awaiting your review · send each a one-pager`
    : managed
      ? items.length === 0
        ? "Nothing in your queue right now."
        : `${counts.admin} awaiting your release · ${counts.client} with the client`
      : items.length === 0
        ? "No matched opportunities yet — they appear here as the engine surfaces them."
        : `${items.length} matched ${items.length === 1 ? "opportunity" : "opportunities"} · Ranked by fit · The client sees this exact view`;

  return (
    <HubShell variant="texture" width="7xl">
      <div className="mb-4">
        <Link
          href={`/clients/${client.id}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
        >
          <ArrowLeft className="h-4 w-4" />
          {client.name}
        </Link>
      </div>
      <ClientActivity items={activity} basePath={`/clients/${client.id}/roadmap`} clientName={client.name} />
      <GrantReport
        items={items}
        heading={
          isLead
            ? `${client.name} · Prospect grant report`
            : managed
              ? `${client.name} · Your review queue`
              : `${client.name} · Grant Report`
        }
        subtitle={subtitle}
        basePath={`/clients/${client.id}/roadmap`}
        hasReleaseGate={gate}
      />
    </HubShell>
  );
}
