import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { GrantReport } from "@/components/report/grant-report";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// Staff account-manager view of a client's Grant Roadmap. Renders the EXACT same
// GrantReport the client sees in their portal — one shared surface, the actor is
// just whoever's signed in (staff here, the client there). Read-only in Slice 1;
// actor-aware decisions + score feedback arrive in Slice 2, at which point this
// begins to supplant the per-client /matches + /review flow.
export default async function ClientRoadmapPage({ params }: { params: { id: string } }) {
  await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name">>();
  if (!client) notFound();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas)",
    )
    .eq("client_id", params.id)
    .neq("card_type", "prospect")
    .neq("decision", "passed");

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[]);
  const subtitle =
    items.length === 0
      ? "No matched opportunities yet — they appear here as the engine surfaces them."
      : `${items.length} matched ${items.length === 1 ? "opportunity" : "opportunities"} · Ranked by fit · The client sees this exact view`;

  return (
    <HubShell variant="crisp" width="7xl">
      <Link
        href={`/clients/${client.id}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        {client.name}
      </Link>
      <GrantReport
        items={items}
        heading={`${client.name} · Grant Roadmap`}
        subtitle={subtitle}
        basePath={`/clients/${client.id}/roadmap`}
        triageHref={`/clients/${client.id}/roadmap/triage`}
      />
    </HubShell>
  );
}
