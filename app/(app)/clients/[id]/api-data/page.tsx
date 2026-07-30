import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { WizardProgress } from "@/components/clients/wizard-progress";
import { EnrichmentPanel } from "@/components/clients/enrichment-panel";
import { deriveEnrichmentSteps } from "@/lib/clients/enrichment-status";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// The API-data surface, in two modes off one route:
//
//   ?new=1  the post-create CONFIRM step. The create action lands here instead of
//           dropping straight onto an empty dashboard, so the pulls are reviewed by
//           a human before the record goes into matching.
//   (bare)  the persistent "API data" view: what each source gave us, when, and a
//           re-run.
//
// Same view either way, deliberately -- the confirm screen and the tab answer the
// same question ("what did the APIs actually give us?"), so they should not be two
// implementations that can drift apart.
export default async function ClientApiDataPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { new?: string };
}) {
  await requireUser();
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();

  const isNew = searchParams.new === "1";
  const kindLabel = isUnconvertedLead(client.pipeline_stage) ? "prospect" : "client";
  const steps = deriveEnrichmentSteps(client);
  const dashboardHref = `/clients/${client.id}`;
  const editHref = `/clients/${client.id}/edit`;
  const isProspect = kindLabel === "prospect";
  // Where "continue" goes from the confirm step: a client still owes engagement
  // terms (step 7); a prospect has none, so its intake ends here at the dashboard.
  const continueHref = isNew && !isProspect ? `/clients/${client.id}/finish` : dashboardHref;

  return (
    <div>
      {!isNew && (
        <div className="px-8 pt-6">
          <Link href={dashboardHref} className="text-sm text-muted-foreground underline">
            ← Back to profile
          </Link>
        </div>
      )}
      <PageHeader title={isNew ? client.name : `${client.name} — API data`} />
      <div className="max-w-5xl space-y-8 p-8">
        {isNew && (
          <WizardProgress
            step={isProspect ? 4 : 6}
            total={isProspect ? 4 : 7}
            title="Public data"
            kindLabel={kindLabel}
          />
        )}
        <EnrichmentPanel
          client={client}
          clientId={client.id}
          kindLabel={kindLabel}
          initialSteps={steps}
          mode={isNew ? "ceremony" : "tab"}
          editHref={editHref}
          dashboardHref={continueHref}
          continueLabel={isNew ? "Next" : undefined}
        />

        <p className="text-xs text-muted-foreground">
          These are citations, not gates. Nothing on this page hides a grant or lowers a score — a
          missing value means a caveat on the match, not a filtered result.
        </p>
      </div>
    </div>
  );
}
