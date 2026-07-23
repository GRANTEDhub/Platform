import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { PortalAccess, type PortalMember } from "@/components/clients/portal-access";
import { ClientRepository } from "@/components/clients/client-repository";
import { signedUrl } from "@/lib/storage";
import { ClientForm } from "../../client-form";
import { SamRegistration } from "../../sam-registration";
import { updateClientAction } from "../../actions";
import type { Client, Invoice, ClientOverview } from "@/types/database";

export const dynamic = "force-dynamic";

// Edit profile — now also the home for the client's staff-internal detail that used
// to clutter the dashboard: contact, engagement/billing, portal access, repository,
// notes. (The whole page is due a proper redesign later; this relocation keeps
// everything accessible in the meantime so the dashboard stays client-clean.)
function fmtDate(d: string | null) {
  return d ? format(parseISO(d), "MMM d, yyyy") : "—";
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
  await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();

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
            </CardContent>
          </Card>

          <Card className={RAIL}>
            <CardHeader><CardTitle>Portal access</CardTitle></CardHeader>
            <CardContent>
              <PortalAccess clientId={client.id} seatLimit={client.seat_limit ?? 1} members={members} />
            </CardContent>
          </Card>

          <Card className={RAIL}>
            <CardHeader><CardTitle>Repository</CardTitle></CardHeader>
            <CardContent>
              <ClientRepository documents={documents} />
            </CardContent>
          </Card>

          {client.notes && (
            <Card className={RAIL}>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{client.notes}</CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
