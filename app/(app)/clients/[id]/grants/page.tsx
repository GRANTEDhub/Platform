import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/ui/stat";
import { ClientGrantsBatch, type BatchUiCard } from "@/components/clients/client-grants-batch";
import { ClientForecastHorizon } from "@/components/clients/client-forecast-horizon";
import { getForecastHorizon, type ForecastHorizonItem } from "@/lib/grants/forecast-relevance";
import { getSentAlertsByCards, getPriorAlertForEmail } from "@/lib/alerts/sent-status";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { senderFirstName } from "@/lib/alerts/sender";
import type { MatchCard } from "@/lib/grants/grouping";
import type { Client, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

// Surface the client's most actionable matches first: new (pending), then
// held, then decided.
const STATUS_ORDER: Record<string, number> = { pending: 0, hold: 1, approved: 2, passed: 3 };

// Supabase types a to-one embed as object or 1-element array; normalize.
function grantOf(g: MatchCard["grants"]): Pick<Grant, "title" | "funder" | "submission_deadline" | "deadline"> | null {
  if (!g) return null;
  return (Array.isArray(g) ? g[0] : g) ?? null;
}

export default async function ClientGrantsPage({
  params,
}: {
  params: { id: string };
}) {
  const profile = await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, org_type, engagement_tier, primary_contact_email, pipeline_stage")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "org_type" | "engagement_tier" | "primary_contact_email" | "pipeline_stage">>();
  if (!client) notFound();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "*, clients(id, name, org_type, engagement_tier), grants(id, title, funder, submission_deadline, deadline)",
    )
    .eq("client_id", params.id)
    .order("created_at", { ascending: false });

  const cards = ((data ?? []) as MatchCard[]).sort(
    (a, b) =>
      (STATUS_ORDER[a.decision] ?? 9) - (STATUS_ORDER[b.decision] ?? 9) ||
      b.fit_score - a.fit_score,
  );

  const count = (d: string) => cards.filter((c) => c.decision === d).length;

  // "Alerted" state per card (a sent grant_alerts row with a recipient), derived in
  // one batched query -- drives which rows show the alerted badge vs. a checkbox.
  const alerted = await getSentAlertsByCards(cards.map((c) => c.id));
  const alertedCardIds = [...alerted.keys()];

  // A lead (Tara-build manual prospect) batch is a COLD send -> gate a re-contact to
  // an address we've emailed before (leads only; a warm client batch has no gate,
  // unchanged). One small lookup on the client's contact email.
  const isLead = isUnconvertedLead(client.pipeline_stage);
  const priorAlert = isLead && client.primary_contact_email
    ? await getPriorAlertForEmail(client.primary_contact_email)
    : null;

  const uiCards: BatchUiCard[] = cards.map((c) => {
    const g = grantOf(c.grants);
    return {
      id: c.id,
      title: g?.title ?? null,
      funder: g?.funder ?? null,
      deadline: g?.deadline ?? null,
      submission_deadline: g?.submission_deadline ?? null,
      fitScore: c.fit_score,
      decision: c.decision,
    };
  });

  // Forecasted "On the horizon" for this client (Horizon Reject gate). Computed live —
  // no caching, per decision — and reject-filtered inside getForecastHorizon (the
  // service client bypasses RLS, matching how the alert path computes it in store.ts).
  // Guarded so a horizon/LLM failure degrades to an empty section, never 500s the page.
  const svc = createServiceClient();
  let horizon: ForecastHorizonItem[] = [];
  try {
    const { data: fullClient } = await svc.from("clients").select("*").eq("id", params.id).single<Client>();
    if (fullClient) {
      horizon = await getForecastHorizon(svc, fullClient, { researchOptIn: fullClient.research_opt_in });
    }
  } catch (e) {
    console.error(`[horizon] client grants page compute failed for ${params.id}:`, e);
  }

  // The client's current forecast rejects, for the collapsible Undo group. Scoped to
  // STILL-forecasted grants (join on grant_status) so a flipped (now-active) grant's
  // inert reject never shows — it re-surfaces in the Matches table above instead.
  const { data: rejData } = await svc
    .from("forecast_rejections")
    .select("grant_id, grants(title, funder, grant_status, source_url)")
    .eq("client_id", params.id);
  type RejGrant = Pick<Grant, "title" | "funder" | "grant_status" | "source_url">;
  type RejRow = { grant_id: string; grants: RejGrant | RejGrant[] | null };
  const rejectedForecasts = ((rejData ?? []) as RejRow[])
    .map((r) => ({ grantId: r.grant_id, g: Array.isArray(r.grants) ? r.grants[0] : r.grants }))
    .filter((r): r is { grantId: string; g: RejGrant } => !!r.g && r.g.grant_status === "Forecasted")
    .map((r) => ({ grantId: r.grantId, title: r.g.title ?? "Forecasted opportunity", funder: r.g.funder ?? null, sourceUrl: r.g.source_url ?? null }));

  // Simpler.gov opportunity URLs for the active horizon rows ("View on Simpler"). For
  // cron-ingested rows source_url is the full https://simpler.grants.gov/opportunity/
  // <uuid>; null or the 'manual-paste' sentinel otherwise -> the component hides the
  // link unless it's a real http(s) URL.
  const horizonIds = horizon.map((h) => h.grantId);
  const srcById = new Map<string, string | null>();
  if (horizonIds.length > 0) {
    const { data: srcRows } = await svc.from("grants").select("id, source_url").in("id", horizonIds);
    for (const row of (srcRows ?? []) as { id: string; source_url: string | null }[]) {
      srcById.set(row.id, row.source_url);
    }
  }

  const horizonActive = horizon.map((h) => ({
    grantId: h.grantId,
    title: h.title,
    funder: h.funder,
    rationale: h.rationale,
    sourceUrl: srcById.get(h.grantId) ?? null,
  }));

  return (
    <div>
      <PageHeader
        title={client.name}
        description="Grant activity — every match for this client and where it stands. Select pending matches to send as one aggregate alert."
        action={
          <Link href={`/clients/${client.id}`}>
            <Button variant="outline">Client profile</Button>
          </Link>
        }
      />
      <div className="space-y-6 p-8">
        <div className="grid grid-cols-3 gap-4">
          <Stat label="New" value={String(count("pending"))} hint="awaiting review" />
          <Stat label="Approved" value={String(count("approved"))} hint="cleared to send" />
          <Stat label="Rejected" value={String(count("passed"))} hint="passed" />
        </div>

        <ClientGrantsBatch
          clientId={client.id}
          clientName={client.name}
          recipient={client.primary_contact_email ?? ""}
          cards={uiCards}
          alertedCardIds={alertedCardIds}
          isLead={isLead}
          senderName={senderFirstName({ full_name: profile.full_name, email: profile.email })}
          priorEmailedAt={priorAlert?.sentAt ?? null}
          priorCardId={priorAlert?.cardId ?? null}
        />

        <ClientForecastHorizon
          clientId={client.id}
          active={horizonActive}
          rejected={rejectedForecasts}
        />
      </div>
    </div>
  );
}
