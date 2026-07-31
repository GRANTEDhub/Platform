import { notFound } from "next/navigation";
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
import { EnrichmentPanel } from "@/components/clients/enrichment-panel";
import { deriveEnrichmentSteps } from "@/lib/clients/enrichment-status";
import { signedUrl } from "@/lib/storage";
import { ClientForm } from "../../client-form";
import { updateClientAction, deleteClientAction } from "../../actions";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client, Invoice, ClientOverview } from "@/types/database";

export const dynamic = "force-dynamic";

// Edit profile — the SAME stepped pages as intake, navigated by clicking the section
// bar at the top rather than walking Back/Next. You come here to change one thing, so
// the bar is the navigation, not a progress read-out. See ClientForm's header comment.
//
// It also hosts the two surfaces that used to be separate destinations:
//   · API data — was its own route plus a hero button next to "Edit profile". Same
//     question ("what did the public sources give us?"), so it is a section here now.
//     The route survives only as the post-create confirm step (?new=1).
//   · Client admin — portal seats, contract repository, notes, delete. Staff-internal,
//     kept off the client-clean dashboard.
//
// Both are passed as `extras`: panes that share the section bar but sit OUTSIDE the
// <form>, because both contain their own <form> elements (portal seats, delete) and a
// nested form is dropped by the browser.

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

const RAIL = "rounded-2xl border-0 bg-white shadow-[0_1px_3px_rgba(11,30,58,0.05)] ring-1 ring-brand-navy/[0.06]";

function DangerZone({
  name,
  kindLabel,
  action,
  counts,
}: {
  name: string;
  kindLabel: string;
  action: (formData: FormData) => Promise<{ error: string } | undefined>;
  counts: { label: string; n: number }[];
}) {
  return (
    <div className="space-y-3 border-t border-brand-navy/[0.08] pt-6">
      <h2 className="font-serif text-lg font-semibold text-brand-navy">Danger zone</h2>
      <DeleteClient name={name} kindLabel={kindLabel} action={action} counts={counts} />
    </div>
  );
}

export default async function EditClientPage({
  params,
  searchParams,
}: {
  params: { id: string };
  // Deep-links AT a section, now that these are panes rather than routes
  // (?section=api from the dashboard's data-source action items).
  searchParams: { section?: string };
}) {
  // Any staff (admin OR contractor/AM) may edit a client/prospect profile. Billing
  // detail (Outstanding + invoices, and the signed-contract Repository) is gated to
  // admins below -- the AM edits the profile but never sees what we bill.
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();

  const action = updateClientAction.bind(null, client.id);
  const isProspect = isUnconvertedLead(client.pipeline_stage);
  const kindLabel = isProspect ? "prospect" : "client";
  // The county resolve link inside the API-data pane. A same-page link rather than a
  // client-side jump, because the pane is server-rendered -- it lands on the General
  // section, which is where the county field is.
  const editHref = `/clients/${client.id}/edit?section=general`;
  const dashboardHref = `/clients/${client.id}`;

  const apiPane = (
    <div className="space-y-6">
      <EnrichmentPanel
        client={client}
        clientId={client.id}
        kindLabel={kindLabel}
        initialSteps={deriveEnrichmentSteps(client)}
        mode="tab"
        editHref={editHref}
        dashboardHref={dashboardHref}
      />
      <p className="text-xs text-muted-foreground">
        These are citations, not gates. Nothing here hides a grant or lowers a score — a missing value
        means a caveat on the match, not a filtered result.
      </p>
    </div>
  );

  // A prospect (un-converted lead) edits through the SAME unified form (which renders
  // its prospect variant — derived from pipeline_stage), without the client-only admin
  // rail (billing / portal / repository don't apply). Early-return so those client-only
  // queries are skipped.
  if (isProspect) {
    const prospectExtras = [
      { key: "api", title: "API data", node: apiPane },
      ...(isAdmin
        ? [
            {
              key: "admin",
              title: "Admin",
              node: (
                <DangerZone
                  name={client.name}
                  kindLabel="prospect"
                  action={deleteClientAction.bind(null, client.id)}
                  counts={await deleteCounts(supabase, client.id, false)}
                />
              ),
            },
          ]
        : []),
    ];
    return (
      <div>
        <div className="px-8 pt-6">
          <FormExitGuard backHref={dashboardHref} backLabel="Back to profile" />
        </div>
        <PageHeader title={`Edit ${client.name}`} />
        <div className="p-8">
          <ClientForm
            client={client}
            action={action}
            submitLabel="Save changes"
            extras={prospectExtras}
            initialSection={searchParams.section}
          />
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

  // The admin pane deliberately does NOT restate contact / status / tier / contract
  // dates: those are editable fields two sections away, and a read-only copy of a
  // field you can edit here is just a second version to disagree with. What survives
  // is what the form does not hold -- derived hours, what we bill, seats, documents.
  const adminPane = (
    <div className="space-y-6">
      <Card className={RAIL}>
        <CardHeader>
          <CardTitle>Retainer &amp; billing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Detail
            label="Hours remaining"
            value={hoursRemaining !== null ? Number(hoursRemaining).toFixed(1) : "—"}
          />
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
        <CardHeader>
          <CardTitle>Portal access</CardTitle>
        </CardHeader>
        <CardContent>
          <PortalAccess clientId={client.id} seatLimit={client.seat_limit ?? 1} members={members} />
        </CardContent>
      </Card>

      {/* Repository holds signed contracts (the amount we charge) -- admin-only. */}
      {isAdmin && (
        <Card className={RAIL}>
          <CardHeader>
            <CardTitle>Repository</CardTitle>
          </CardHeader>
          <CardContent>
            <ClientRepository documents={documents} />
          </CardContent>
        </Card>
      )}

      {client.notes && (
        <Card className={RAIL}>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{client.notes}</CardContent>
        </Card>
      )}

      {/* Admin-only, and last in this pane on purpose -- a destructive control should
          not sit next to the fields you edit routinely. */}
      {isAdmin && (
        <DangerZone
          name={client.name}
          kindLabel="client"
          action={deleteClientAction.bind(null, client.id)}
          counts={await deleteCounts(supabase, client.id, true)}
        />
      )}
    </div>
  );

  return (
    <div>
      <div className="px-8 pt-6">
        <FormExitGuard backHref={dashboardHref} backLabel="Back to profile" />
      </div>
      <PageHeader title={`Edit ${client.name}`} />
      <div className="p-8">
        <ClientForm
          client={client}
          action={action}
          submitLabel="Save changes"
          extras={[
            { key: "api", title: "API data", node: apiPane },
            { key: "admin", title: "Client admin", short: "Admin", node: adminPane },
          ]}
          initialSection={searchParams.section}
        />
      </div>
    </div>
  );
}
