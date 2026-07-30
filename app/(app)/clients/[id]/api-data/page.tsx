import { notFound } from "next/navigation";
import Link from "next/link";
import { format, parseISO } from "date-fns";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { WizardProgress } from "@/components/clients/wizard-progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EnrichmentPanel } from "@/components/clients/enrichment-panel";
import { SamRegistration } from "../../sam-registration";
import { deriveEnrichmentSteps } from "@/lib/clients/enrichment-status";
import { samExpiryFlag } from "@/lib/sam/expiry";
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
function fmtWhen(d: string | null) {
  return d ? format(parseISO(d), "MMM d, yyyy · h:mm a") : "never";
}

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

  // active / expired / unregistered, derived at read time rather than stored -- an
  // "active" flag written last year would still read active today.
  const samFlag = samExpiryFlag(client.sam_expiration_date);
  const samLabel = !client.uei && !client.sam_registration_status
    ? "Unregistered"
    : samFlag?.level === "expired"
      ? "Expired"
      : client.sam_registration_status || "Registered";

  const RAIL = "rounded-2xl border-0 bg-white shadow-[0_1px_3px_rgba(11,30,58,0.05)] ring-1 ring-brand-navy/[0.06]";

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
      <div className="max-w-3xl space-y-8 p-8">
        {isNew && (
          <WizardProgress
            step={isProspect ? 4 : 6}
            total={isProspect ? 4 : 7}
            title="Public data"
            kindLabel={kindLabel}
          />
        )}
        <EnrichmentPanel
          clientId={client.id}
          kindLabel={kindLabel}
          initialSteps={steps}
          mode={isNew ? "ceremony" : "tab"}
          editHref={editHref}
          dashboardHref={continueHref}
          continueLabel={isNew && !isProspect ? "Next: engagement" : undefined}
        />

        {/* Provenance. Every value here is a citation with a date, never a matcher
            input -- the same flag-not-hide rule the matcher change established. */}
        <Card className={RAIL}>
          <CardHeader>
            <CardTitle>What&apos;s on file</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="IRS EIN" value={client.ein || "—"} note="Staff-entered, or resolved by name lookup." />
            <Row
              label="Annual budget"
              value={client.annual_budget || "—"}
              note="Hand-entered. The IRS 990 figures below are the sourced version."
            />
            <Row
              label="Latest IRS 990"
              value={
                client.nonprofit_finance?.verified && client.nonprofit_finance.total_revenue != null
                  ? `${client.nonprofit_finance.fiscal_year ? `FY${client.nonprofit_finance.fiscal_year} · ` : ""}revenue $${client.nonprofit_finance.total_revenue.toLocaleString("en-US")}${
                      client.nonprofit_finance.total_expenses != null
                        ? ` · expenses $${client.nonprofit_finance.total_expenses.toLocaleString("en-US")}`
                        : ""
                    }`
                  : "—"
              }
              note={`ProPublica Nonprofit Explorer · checked ${fmtWhen(client.nonprofit_finance_checked_at)}`}
            />
            <Row
              label="Federal award history"
              value={client.federal_history_verified ? "Self-reported (verified)" : client.usaspending_checked_at ? "Pulled" : "—"}
              note={`USASpending.gov · checked ${fmtWhen(client.usaspending_checked_at)}`}
            />
            <Row
              label="SAM.gov registration"
              value={samLabel}
              note={
                client.uei
                  ? `UEI ${client.uei}${client.sam_matched_name ? ` · ${client.sam_matched_name}` : ""} · checked ${fmtWhen(client.sam_checked_at)}`
                  : "Required before any federal submission. Resolve it below."
              }
            />
            <Row label="RUCC codes" value={client.rucc_codes || "—"} note="Derived from county + state (USDA ERS 2023)." />
            <Row label="County" value={client.location_county || "—"} note="Drives the RUCC lookup." />
            <Row
              label="Profile distillation"
              value={client.client_profile ? "Built" : "—"}
              note="Narrative context for matching. Never affects occupancy."
            />
          </CardContent>
        </Card>

        {/* SAM.gov is resolved HERE, not on the edit form. Binding a UEI is a
            human decision (two orgs can share a name), and this component already
            owns that resolve/confirm flow and persists independently of any form --
            so it belongs on the screen where the gap is reported. */}
        <Card className={RAIL} id="sam-registration">
          <CardHeader>
            <CardTitle>SAM.gov registration</CardTitle>
          </CardHeader>
          <CardContent>
            <SamRegistration client={client} />
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          These are citations, not gates. Nothing on this page hides a grant or lowers a score — a
          missing value means a caveat on the match, not a filtered result.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-brand-navy/[0.06] pb-2 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="font-medium text-brand-navy">{label}</p>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      <p className="shrink-0 text-right tabular-nums">{value}</p>
    </div>
  );
}
