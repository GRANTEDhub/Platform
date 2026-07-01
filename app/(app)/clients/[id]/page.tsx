import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { interTight, sourceSerif } from "@/lib/fonts";
import { ClientSnapshotHeader, type SnapshotChip } from "@/components/clients/client-snapshot-header";
import { ClientGrantTracking, type TrackedGrant } from "@/components/clients/client-grant-tracking";
import { ClientActionItems } from "@/components/clients/client-action-items";
import type { Client, Invoice, Grant, ClientOverview } from "@/types/database";

export const dynamic = "force-dynamic";

// The per-client dashboard: the "what's happening with this client" surface,
// downstream of the Matches decision. Grants we've alerted land here (approved
// cards); Ledger stays the permanent record. Built on the GRANTED brand (scoped
// here via the font-var wrapper). The pursuit lifecycle (stages) is a deferred
// v2 -- the grant-tracking component is already shaped for it.
type ApprovedCardRow = {
  id: string;
  sent_at: string | null;
  grants: Pick<Grant, "id" | "title" | "funder" | "submission_deadline"> | { id: string; title: string | null; funder: string | null; submission_deadline: string | null }[] | null;
};

function fmtDate(d: string | null) {
  return d ? format(parseISO(d), "MMM d, yyyy") : "—";
}

function grantOf(r: ApprovedCardRow) {
  const g = r.grants;
  if (!g) return null;
  return Array.isArray(g) ? g[0] ?? null : g;
}

export default async function ClientDashboardPage({ params }: { params: { id: string } }) {
  await requireAdmin(); // internal-only for now; client-facing view is a later pass
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", params.id)
    .single<Client>();

  if (!client) notFound();

  const [{ data: overviewData }, { data: approved }, { data: invoices }] = await Promise.all([
    supabase.from("client_overview").select("*").eq("id", params.id).single(),
    supabase
      .from("review_cards")
      .select("id, sent_at, grants(id, title, funder, submission_deadline)")
      .eq("client_id", params.id)
      .eq("decision", "approved")
      .neq("card_type", "prospect"),
    supabase
      .from("invoices")
      .select("*")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const overview = overviewData as ClientOverview | null;
  const bills = (invoices ?? []) as Invoice[];

  const tracked: TrackedGrant[] = ((approved ?? []) as ApprovedCardRow[]).map((r) => {
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

  const owedCents = overview?.owed_cents ?? 0;
  const hoursRemaining = overview?.hours_remaining ?? null;

  const chips: SnapshotChip[] = [
    { value: String(tracked.length), label: tracked.length === 1 ? "alerted grant" : "alerted grants" },
    { value: formatCurrency(owedCents / 100), label: "outstanding" },
  ];
  if (hoursRemaining !== null) {
    chips.push({ value: `${Number(hoursRemaining).toFixed(1)}h`, label: "remaining" });
  }
  if (overview?.next_deadline) {
    chips.push({ value: format(parseISO(overview.next_deadline), "MMM d"), label: "next deadline" });
  }

  const subtitle =
    [client.org_type?.replace(/_/g, " "), client.location_city, client.location_state]
      .filter(Boolean)
      .join(" · ") || null;

  return (
    <div className={`${interTight.variable} ${sourceSerif.variable} min-h-full bg-brand-cream font-tight`}>
      <ClientSnapshotHeader
        name={client.name}
        subtitle={subtitle}
        chips={chips}
        editHref={`/clients/${client.id}/edit`}
      />

      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
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

          <Card>
            <CardHeader><CardTitle>Action items</CardTitle></CardHeader>
            <CardContent>
              <ClientActionItems forUs={client.next_step} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Name" value={client.primary_contact_name || "—"} />
              <Detail label="Email" value={client.primary_contact_email || "—"} />
              <Detail label="Phone" value={client.primary_contact_phone || "—"} />
            </CardContent>
          </Card>

          <Card>
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

          <Card>
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

          {/* Internal-only: the future client-facing view simply hides this card. */}
          {client.notes && (
            <Card className="border-brand-navy/20">
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
