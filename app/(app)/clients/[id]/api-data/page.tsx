import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { WizardProgress } from "@/components/clients/wizard-progress";
import { EnrichmentPanel } from "@/components/clients/enrichment-panel";
import { deriveEnrichmentSteps } from "@/lib/clients/enrichment-status";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// The post-create CONFIRM step (step 6 of intake), and ONLY that. The create action
// lands here instead of dropping straight onto an empty dashboard, so the pulls are
// reviewed by a human before the record goes into matching.
//
// The persistent "API data" view used to live on this same route (bare, no ?new=1),
// reached by its own button beside "Edit profile". It is a section of Edit profile now
// -- same question as the rest of the profile, so it belongs in the same place rather
// than being a second destination. A bare hit here redirects there, so old links and
// bookmarks still land on the right thing.
export default async function ClientApiDataPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { new?: string };
}) {
  await requireUser();
  const isNew = searchParams.new === "1";
  if (!isNew) redirect(`/clients/${params.id}/edit?section=api`);

  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();
  const kindLabel = isUnconvertedLead(client.pipeline_stage) ? "prospect" : "client";
  const isProspect = kindLabel === "prospect";
  // Where "continue" goes from the confirm step: a client still owes engagement
  // terms (step 7); a prospect has none, so its intake ends here at the dashboard.
  const continueHref = isProspect ? `/clients/${client.id}` : `/clients/${client.id}/finish`;

  return (
    <div>
      <PageHeader title={client.name} />
      <div className="max-w-5xl space-y-8 p-8">
        <WizardProgress
          step={isProspect ? 4 : 6}
          total={isProspect ? 4 : 7}
          title="Public data"
          kindLabel={kindLabel}
        />
        <EnrichmentPanel
          client={client}
          clientId={client.id}
          kindLabel={kindLabel}
          initialSteps={deriveEnrichmentSteps(client)}
          mode="ceremony"
          // The county resolve link opens the General section of the profile, where
          // that field actually is.
          editHref={`/clients/${client.id}/edit?section=general`}
          dashboardHref={continueHref}
          continueLabel="Next"
        />

        <p className="text-xs text-muted-foreground">
          These are citations, not gates. Nothing on this page hides a grant or lowers a score — a
          missing value means a caveat on the match, not a filtered result.
        </p>
      </div>
    </div>
  );
}
