import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { PortalAccess, type PortalMember } from "@/components/clients/portal-access";
import { ClientRepository } from "@/components/clients/client-repository";
import { FormExitGuard } from "@/components/clients/form-exit-guard";
import { DeleteClient } from "@/components/clients/delete-client";
import { signedUrl } from "@/lib/storage";
import { ClientForm } from "../../client-form";
import { SamRegistration } from "../../sam-registration";
import { updateClientAction, deleteClientAction } from "../../actions";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client, Invoice, ClientOverview } from "@/types/database";

export const dynamic = "force-dynamic";

// Edit profile — now also the home for the client's staff-internal detail that used
// to clutter the dashboard: contact, engagement/billing, portal access, repository,
// notes. (The whole page is due a proper redesign later; this relocation keeps
// everything accessible in the meantime so the dashboard stays client-clean.)
function fmtDate(d: string | null) {
  return d ? format(parseISO(d), "MMM d, yyyy") : "—";
}

// Blast radius for the delete confirmation: what actually hangs off this record.
// Counted with head:true so nothing is transferred -- these are shown to make a
// mis-selected record obvious, not to gate the delete.
async function deleteCounts(
  supabase: ReturnType<typeof createClient>,
  id: string,
  includeEngagement: boolean,
): Promise<{ label: string; n: number }[]> {
  const count = async (table: string) => {
    const { count: n } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("client_id", id);
    return n ?? 0;
  };
  const [cards, alerts, concepts, docs] = await Promise.all([
    count("review_cards"),
    count("grant_alerts"),
    count("concept_proposals"),
    count("client_documents"),
  ]);
  const rows = [
    { label: "matched grant", n: cards },
    { label: "generated grant alert", n: alerts },
    { label: "concept proposal", n: concepts },
    { label: "stored document", n: docs },
  ];
  if (!includeEngagement) return rows;
  const [members, bills] = await Promise.all([count("client_members"), count("invoices")]);
  return [...rows, { label: "portal member", n: members }, { label: "invoice", n: bills }];
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}

export default async function EditClientPage({ params }: { params: { id: string } }) {
  // Any staff (admin OR contractor/AM) may edit a client/prospect profile. Billing
  // detail (Outstanding + invoices, and the signed-contract Repository) is gated to
  // admins below -- the AM edits the profile but never sees what we bill.
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();

  // A prospect (un-converted lead) edits through the SAME unified form (which renders
  // its prospect variant — derived from pipeline_stage), without the client-only admin
  // rail (billing / portal / repository don't apply). Early-return so those client-only
  // queries are skipped.
  if (isUnconvertedLead(client.pipeline_stage)) {
    const prospectAction = updateClientAction.bind(null, client.id);
    const prospectDelete = deleteClientAction.bind(null, client.id);
    const prospectCounts = await deleteCounts(supabase, client.id, false);
    return (
      <div>
        <div className="px-8 pt-6">
          <FormExitGuard backHref={`/clients/${client.id}`} backLabel="Back to profile" />
        </div>
        <PageHeader title={`Edit ${client.name}`} />
        <div className="max-w-2xl space-y-8 p-8">
          <ClientForm client={client} action={prospectAction} submitLabel="Save changes" />
          {isAdmin && (
            <div className="space-y-3 border-t border-brand-navy/[0.08] pt-8">
              <h2 className="font-serif text-lg font-semibold text-brand-navy">Danger zone</h2>
              <DeleteClient
                name={client.name}
                kindLabel="prospect"
                action={prospectDelete}
                counts={prospectCounts}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  const [{ data: overviewData }, { data: invoices }, { data: docRows }, { data: memberRows }] = await Promise.all([
    supabase.from("client_overview").select("*").eq("id", params.id).single(),
    supabase.from("invoices").select("*").eq("client_id", params.id).order("created_at", { ascending: false }).limit(10),
    supabase
      .from("client_documents")
      .select("id, kind, title, created_at, storage_bucket, storage_path")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("client_members")
      .select("id, email, role, activated_at")
      .eq("client_id", params.id)
      .order("invited_at", { ascending: true }),
  ]);

  const overview = overviewData as ClientOverview | null;
  const bills = (invoices ?? []) as Invoice[];
  const members = (memberRows ?? []) as PortalMember[];
  const owedCents = overview?.owed_cents ?? 0;
  const hoursRemaining = overview?.hours_remaining ?? null;

  const docRowList = (docRows ?? []) as {
    id: string;
    kind: string;
    title: string;
    created_at: string;
    storage_bucket: string;
    storage_path: string;
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

  const action = updateClientAction.bind(null, client.id);
  const RAIL = "rounded-2xl border-0 bg-white shadow-[0_1px_3px_rgba(11,30,58,0.05)] ring-1 ring-brand-navy/[0.06]";

  return (
    <div>
      <div className="px-8 pt-6">
        <FormExitGuard backHref={`/clients/${client.id}`} backLabel="Back to profile" />
      </div>
      <PageHeader title={`Edit ${client.name}`} />
      <div className="max-w-3xl space-y-8 p-8">
        <ClientForm client={client} action={action} submitLabel="Save changes" />
        <SamRegistration client={client} />

        <div className="space-y-6 border-t border-brand-navy/[0.08] pt-8">
          <h2 className="font-serif text-lg font-semibold text-brand-navy">Client admin</h2>

          <Card className={RAIL}>
            <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Name" value={client.primary_contact_name || "—"} />
              <Detail label="Email" value={client.primary_contact_email || "—"} />
              <Detail label="Phone" value={client.primary_contact_phone || "—"} />
            </CardContent>
          </Card>

          <Card className={RAIL}>
            <CardHeader><CardTitle>Engagement &amp; billing</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <Detail label="Status" value={<Badge variant="secondary">{client.status}</Badge>} />
                <Detail label="Tier" value={client.engagement_tier || "—"} />
                <Detail label="Contract start" value={fmtDate(client.contract_start)} />
                <Detail label="Contract end" value={fmtDate(client.contract_end)} />
                <Detail label="Retainer hours" value={String(client.retainer_hours ?? 0)} />
                <Detail label="Hours remaining" value={hoursRemaining !== null ? Number(hoursRemaining).toFixed(1) : "—"} />
              </div>
              {/* What we bill the client -- admin-only (hidden from the contractor/AM). */}
              {isAdmin && (
                <div className="border-t border-brand-navy/[0.06] pt-4">
                  <Detail label="Outstanding" value={formatCurrency(owedCents / 100)} />
                  {bills.length === 0 ? (
                    <p className="mt-2 text-muted-foreground">No invoices yet.</p>
                  ) : (
                    <ul className="mt-2 divide-y">
                      {bills.map((i) => (
                        <li key={i.id} className="flex justify-between py-2">
                          <Badge variant="secondary">{i.status}</Badge>
                          <span className="tabular-nums">{formatCurrency(i.amount_cents / 100)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className={RAIL}>
            <CardHeader><CardTitle>Portal access</CardTitle></CardHeader>
            <CardContent>
              <PortalAccess clientId={client.id} seatLimit={client.seat_limit ?? 1} members={members} />
            </CardContent>
          </Card>

          {/* Repository holds signed contracts (the amount we charge) -- admin-only. */}
          {isAdmin && (
            <Card className={RAIL}>
              <CardHeader><CardTitle>Repository</CardTitle></CardHeader>
              <CardContent>
                <ClientRepository documents={documents} />
              </CardContent>
            </Card>
          )}

          {client.notes && (
            <Card className={RAIL}>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{client.notes}</CardContent>
            </Card>
          )}

          {/* Admin-only, and last on the page on purpose -- a destructive control
              should not sit next to the fields you edit routinely. */}
          {isAdmin && (
            <div className="space-y-3 border-t border-brand-navy/[0.08] pt-6">
              <h2 className="font-serif text-lg font-semibold text-brand-navy">Danger zone</h2>
              <DeleteClient
                name={client.name}
                kindLabel="client"
                action={deleteClientAction.bind(null, client.id)}
                counts={await deleteCounts(supabase, client.id, true)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
