import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { FileCheck2, DollarSign, Clock, CalendarClock, AlertTriangle, Loader2 } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { interTight, sourceSerif } from "@/lib/fonts";
import { ClientHero } from "@/components/clients/client-snapshot-header";
import { StatCard } from "@/components/clients/stat-card";
import { ClientMatchChart } from "@/components/clients/client-match-chart";
import { ClientGrantTracking, type TrackedGrant } from "@/components/clients/client-grant-tracking";
import { ClientActionItems } from "@/components/clients/client-action-items";
import { samExpiryFlag } from "@/lib/sam/expiry";
import { ClientRepository } from "@/components/clients/client-repository";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { signedUrl } from "@/lib/storage";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { BRAND } from "@/lib/brand";
import type { Client, Invoice, Grant, ClientOverview, CardDecision } from "@/types/database";

export const dynamic = "force-dynamic";

// The per-client dashboard: the "what's happening with this client" surface,
// downstream of the Matches decision. Modern-SaaS layout -- hero, floating stat
// tiles, a simple chart, distinct main/rail zones -- on the GRANTED brand (scoped
// here via the font-var wrapper). All data is real; the pursuit lifecycle (stages)
// is still a deferred v2 and the grant-tracking component is shaped for it.
type ClientCardRow = {
  id: string;
  decision: CardDecision;
  sent_at: string | null;
  grants:
    | Pick<Grant, "id" | "title" | "funder" | "submission_deadline">
    | { id: string; title: string | null; funder: string | null; submission_deadline: string | null }[]
    | null;
};

// Floating-card looks: main cards sit high with a soft navy-tinted shadow; rail
// cards are visually quieter (lighter elevation + a hairline ring) so the two
// zones read as distinct.
const CARD_MAIN =
  "rounded-2xl border-0 bg-white shadow-[0_2px_8px_rgba(11,30,58,0.06),0_16px_38px_-18px_rgba(11,30,58,0.20)]";
const CARD_RAIL =
  "rounded-2xl border-0 bg-white shadow-[0_1px_3px_rgba(11,30,58,0.05)] ring-1 ring-brand-navy/[0.06]";

function fmtDate(d: string | null) {
  return d ? format(parseISO(d), "MMM d, yyyy") : "—";
}

function grantOf(r: ClientCardRow) {
  const g = r.grants;
  if (!g) return null;
  return Array.isArray(g) ? g[0] ?? null : g;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default async function ClientDashboardPage({ params }: { params: { id: string } }) {
  await requireAdmin(); // internal-only for now; client-facing view is a later pass
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", params.id)
    .single<Client>();

  if (!client) notFound();

  const [{ data: overviewData }, { data: cardRows }, { data: invoices }, { data: docRows }] = await Promise.all([
    supabase.from("client_overview").select("*").eq("id", params.id).single(),
    supabase
      .from("review_cards")
      .select("id, decision, sent_at, grants(id, title, funder, submission_deadline)")
      .eq("client_id", params.id)
      .neq("card_type", "prospect"),
    supabase
      .from("invoices")
      .select("*")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("client_documents")
      .select("id, kind, title, created_at, storage_bucket, storage_path")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false }),
  ]);

  // Repository: mint short-lived signed URLs for each stored document (private
  // buckets). Reusable for any doc kind, not just contracts.
  const docRowList = (docRows ?? []) as {
    id: string; kind: string; title: string; created_at: string; storage_bucket: string; storage_path: string;
  }[];
  const documents = await Promise.all(
    docRowList.map(async (d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      createdAt: d.created_at,
      url: await signedUrl(d.storage_bucket, d.storage_path),
    })),
  );

  const overview = overviewData as ClientOverview | null;
  const bills = (invoices ?? []) as Invoice[];
  const cards = (cardRows ?? []) as ClientCardRow[];

  // One-time prospect match (initial_match_status). While queued/running the pool
  // is still being scored, so every card-derived surface below MUST read as
  // in-progress -- partial cards presented as a finished result is the exact
  // failure mode to prevent. "scored X of Y" is derived: distinct grants attempted
  // for this client (match_attempts) over the scorable pool. Only queried while a
  // match is actually in flight (skipped for real clients / completed prospects).
  const matchStatus = client.initial_match_status;
  const matchInProgress = matchStatus === "queued" || matchStatus === "running";
  let matchProgress: { scored: number; total: number } | null = null;
  if (matchInProgress) {
    const [{ data: attemptRows }, { count: poolCount }] = await Promise.all([
      supabase.from("match_attempts").select("grant_id").eq("client_id", params.id),
      supabase
        .from("grants")
        .select("id", { count: "exact", head: true })
        .not("ideal_applicant_profile", "is", null),
    ]);
    const scored = new Set((attemptRows ?? []).map((r) => (r as { grant_id: string }).grant_id)).size;
    matchProgress = { scored, total: poolCount ?? 0 };
  }

  // Alerted grants = approved client cards; the grant-tracking list + chart both
  // read from the same fetch.
  const tracked: TrackedGrant[] = cards
    .filter((c) => c.decision === "approved")
    .map((r) => {
      const g = grantOf(r);
      return {
        cardId: r.id,
        grantId: g?.id ?? null,
        title: g?.title ?? null,
        funder: g?.funder ?? null,
        deadline: g?.submission_deadline ?? null,
        sentAt: r.sent_at,
      };
    });

  const counts = {
    pending: cards.filter((c) => c.decision === "pending").length,
    approved: cards.filter((c) => c.decision === "approved").length,
    passed: cards.filter((c) => c.decision === "passed").length,
  };

  const owedCents = overview?.owed_cents ?? 0;
  const hoursRemaining = overview?.hours_remaining ?? null;

  // Read-time SAM registration expiry flag (null date or >30 days out -> null).
  const samFlag = samExpiryFlag(client.sam_expiration_date);

  const humanLine =
    [client.status ? `${cap(client.status)} client` : null, client.engagement_tier ? `${client.engagement_tier} tier` : null]
      .filter(Boolean)
      .join(" · ") || null;
  const subLine =
    [client.org_type?.replace(/_/g, " "), client.location_city, client.location_state]
      .filter(Boolean)
      .join(" · ") || null;

  // An unconverted lead (prospect) lives in the Pipeline (/leads); a client/converted
  // record lives in /clients (which filters leads OUT). Point "up" to whichever list
  // actually contains this record, so the back link never dead-ends.
  const isProspect = isUnconvertedLead(client.pipeline_stage);

  return (
    <div className={`${interTight.variable} ${sourceSerif.variable} min-h-full bg-brand-cream pb-10 font-tight`}>
      <ClientHero
        name={client.name}
        humanLine={humanLine}
        subLine={subLine}
        editHref={`/clients/${client.id}/edit`}
        backHref={isProspect ? "/leads" : "/clients"}
        backLabel={isProspect ? "Pipeline" : "Clients/Prospects"}
      />

      {/* Stat tiles float over the hero's lower edge -- the visual anchor. */}
      <div className="relative z-10 -mt-12 grid grid-cols-2 gap-4 px-8 lg:grid-cols-4">
        <StatCard icon={FileCheck2} value={String(tracked.length)} label={tracked.length === 1 ? "alerted grant" : "alerted grants"} />
        <StatCard icon={DollarSign} value={formatCurrency(owedCents / 100)} label="outstanding" />
        <StatCard icon={Clock} value={hoursRemaining !== null ? `${Number(hoursRemaining).toFixed(1)}h` : "—"} label="hours remaining" />
        <StatCard icon={CalendarClock} value={overview?.next_deadline ? format(parseISO(overview.next_deadline), "MMM d") : "—"} label="next deadline" />
      </div>

      {/* One-time prospect match progress. Shown for 'queued' AND 'running' with a
          live "scored X of Y" count; AutoRefresh polls so the count advances and
          the whole in-progress framing drops the moment status flips to 'complete'.
          'error' surfaces a hard failure rather than looking like "no matches". */}
      {matchInProgress && (
        <div className="px-8 pt-6">
          <div className="flex items-center gap-2 rounded-xl bg-brand-orange/10 px-4 py-3 text-sm font-medium text-brand-navy ring-1 ring-brand-orange/30">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-orange" />
            <span>
              Initial grant matching in progress
              {matchProgress ? ` — scored ${matchProgress.scored} of ${matchProgress.total} grants` : ""}. Results
              appear here when it finishes.
            </span>
          </div>
          <AutoRefresh enabled />
        </div>
      )}
      {matchStatus === "error" && (
        <div className="px-8 pt-6">
          <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 ring-1 ring-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Initial grant matching didn&apos;t finish — results below may be incomplete.
          </div>
        </div>
      )}

      {samFlag && (
        <div className="px-8 pt-6">
          <div
            className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium ${
              samFlag.level === "expired"
                ? "bg-red-50 text-red-800 ring-1 ring-red-200"
                : "bg-amber-50 text-amber-900 ring-1 ring-amber-200"
            }`}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {samFlag.label}
          </div>
        </div>
      )}

      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className={CARD_MAIN}>
            <CardHeader><CardTitle>Grant activity</CardTitle></CardHeader>
            <CardContent>
              {matchInProgress ? (
                // Suppress the counts chart while matching is still running -- a
                // partial "In review: N" would read as a finished tally. The full
                // chart returns once initial_match_status flips to 'complete'.
                <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-orange" />
                  <span>
                    Matching this prospect against the grant pool
                    {matchProgress ? ` (${matchProgress.scored} of ${matchProgress.total} scored)` : ""}. The full
                    result appears once matching completes — partial matches aren&apos;t shown as a finished list.
                  </span>
                </div>
              ) : (
                <ClientMatchChart
                  data={[
                    { label: "In review", count: counts.pending, color: BRAND.slate },
                    { label: "Alerted", count: counts.approved, color: BRAND.orange },
                    { label: "Passed", count: counts.passed, color: BRAND.taupe },
                  ]}
                />
              )}
            </CardContent>
          </Card>

          <Card className={CARD_MAIN}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Grant tracking</CardTitle>
              <Link href={`/clients/${client.id}/grants`} className="text-sm text-brand-orange hover:underline">
                View all activity →
              </Link>
            </CardHeader>
            <CardContent>
              <ClientGrantTracking grants={tracked} />
            </CardContent>
          </Card>

          <Card className={CARD_MAIN}>
            <CardHeader><CardTitle>Action items</CardTitle></CardHeader>
            <CardContent>
              <ClientActionItems forUs={client.next_step} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className={CARD_RAIL}>
            <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Name" value={client.primary_contact_name || "—"} />
              <Detail label="Email" value={client.primary_contact_email || "—"} />
              <Detail label="Phone" value={client.primary_contact_phone || "—"} />
            </CardContent>
          </Card>

          <Card className={CARD_RAIL}>
            <CardHeader><CardTitle>Billing</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Outstanding" value={formatCurrency(owedCents / 100)} />
              {bills.length === 0 ? (
                <p className="text-muted-foreground">No invoices yet.</p>
              ) : (
                <ul className="divide-y">
                  {bills.map((i) => (
                    <li key={i.id} className="flex justify-between py-2">
                      <Badge variant="secondary">{i.status}</Badge>
                      <span className="tabular-nums">{formatCurrency(i.amount_cents / 100)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className={CARD_RAIL}>
            <CardHeader><CardTitle>Engagement</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <Detail label="Status" value={<Badge variant="secondary">{client.status}</Badge>} />
              <Detail label="Tier" value={client.engagement_tier || "—"} />
              <Detail label="Contract start" value={fmtDate(client.contract_start)} />
              <Detail label="Contract end" value={fmtDate(client.contract_end)} />
              <Detail label="Retainer hours" value={String(client.retainer_hours ?? 0)} />
              <Detail
                label="Hours remaining"
                value={hoursRemaining !== null ? Number(hoursRemaining).toFixed(1) : "—"}
              />
            </CardContent>
          </Card>

          <Card className={CARD_RAIL}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Repository</CardTitle>
              <span className="rounded-full bg-brand-navy/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-navy">
                Internal
              </span>
            </CardHeader>
            <CardContent>
              <ClientRepository documents={documents} />
            </CardContent>
          </Card>

          {/* Internal-only: the future client-facing view simply hides this card. */}
          {client.notes && (
            <Card className={CARD_RAIL}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Notes</CardTitle>
                <span className="rounded-full bg-brand-navy/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-navy">
                  Internal
                </span>
              </CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">
                {client.notes}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}
