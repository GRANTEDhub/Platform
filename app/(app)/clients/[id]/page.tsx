import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { Client, TimeEntry, Invoice } from "@/types/database";

export const dynamic = "force-dynamic";

function fmtDate(d: string | null) {
  return d ? format(parseISO(d), "MMM d, yyyy") : "—";
}

export default async function ClientDetailPage({
  params,
}: {
  params: { id: string };
}) {
  await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", params.id)
    .single<Client>();

  if (!client) notFound();

  const [{ data: time }, { data: invoices }] = await Promise.all([
    supabase
      .from("time_entries")
      .select("*")
      .eq("client_id", params.id)
      .order("work_date", { ascending: false })
      .limit(10),
    supabase
      .from("invoices")
      .select("*")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const entries = (time ?? []) as TimeEntry[];
  const bills = (invoices ?? []) as Invoice[];
  const hoursLogged = entries
    .filter((e) => e.billable)
    .reduce((s, e) => s + Number(e.hours), 0);
  const owed = bills
    .filter((i) => i.status === "sent")
    .reduce((s, i) => s + i.amount_cents, 0);

  return (
    <div>
      <PageHeader
        title={client.name}
        description={[client.org_type?.replace(/_/g, " "), client.location_city, client.location_state]
          .filter(Boolean)
          .join(" · ")}
        action={
          <Link href={`/clients/${client.id}/edit`}>
            <Button variant="outline">Edit</Button>
          </Link>
        }
      />

      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Engagement</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <Detail label="Status" value={<Badge variant="secondary">{client.status}</Badge>} />
              <Detail label="Tier" value={client.engagement_tier || "—"} />
              <Detail label="Contract start" value={fmtDate(client.contract_start)} />
              <Detail label="Contract end" value={fmtDate(client.contract_end)} />
              <Detail label="Retainer hours" value={String(client.retainer_hours ?? 0)} />
              <Detail
                label="Hours remaining"
                value={(Number(client.retainer_hours ?? 0) - hoursLogged).toFixed(1)}
              />
            </CardContent>
          </Card>

          {client.next_step && (
            <Card>
              <CardHeader>
                <CardTitle>Next step</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">{client.next_step}</CardContent>
            </Card>
          )}

          {client.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">
                {client.notes}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Recent time</CardTitle>
            </CardHeader>
            <CardContent>
              {entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No time logged yet. (Time tracking ships in a later phase.)
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {entries.map((e) => (
                    <li key={e.id} className="flex justify-between py-2">
                      <span>{e.description || "—"}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {Number(e.hours).toFixed(1)}h · {fmtDate(e.work_date)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Name" value={client.primary_contact_name || "—"} />
              <Detail label="Email" value={client.primary_contact_email || "—"} />
              <Detail label="Phone" value={client.primary_contact_phone || "—"} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Billing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Outstanding" value={formatCurrency(owed / 100)} />
              {bills.length === 0 ? (
                <p className="text-muted-foreground">
                  No invoices yet. (Invoicing ships in a later phase.)
                </p>
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
