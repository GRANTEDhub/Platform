import Link from "next/link";
import { format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { CONTRACT_TEMPLATES, formatAmount, type TemplateKey } from "@/lib/contracts/template";

export const dynamic = "force-dynamic";

// Live invoices list -- same status-cards-reveal-table pattern as /contracts and
// /leads. Read-only: admin RLS already covers this select; creation stays on the
// lead detail page's InvoicePanel. Payment link opens Stripe's hosted page
// directly -- no PDF/document of our own is generated for invoices.

type InvoiceRow = {
  id: string;
  client_id: string;
  contract_id: string | null;
  amount_cents: number;
  status: string; // draft | sent | paid | void
  issued_date: string | null;
  due_date: string | null;
  paid_date: string | null;
  hosted_invoice_url: string | null;
  created_at: string;
};

type Status = "draft" | "sent" | "paid" | "void";
const STATUSES: Status[] = ["draft", "sent", "paid", "void"];

const STATUS_META: Record<Status, { label: string; dot: string }> = {
  draft: { label: "Draft", dot: "bg-slate-400" },
  sent: { label: "Sent", dot: "bg-amber-400" },
  paid: { label: "Paid", dot: "bg-emerald-500" },
  void: { label: "Void", dot: "bg-red-400" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "MMM d, yyyy");
  } catch {
    return iso;
  }
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  await requireAdmin();
  const supabase = createClient();

  const { data: invoiceRows } = await supabase
    .from("invoices")
    .select(
      "id, client_id, contract_id, amount_cents, status, issued_date, due_date, paid_date, hosted_invoice_url, created_at",
    )
    .order("created_at", { ascending: false });
  const rows = (invoiceRows ?? []) as InvoiceRow[];

  const clientIds = [...new Set(rows.map((r) => r.client_id))];
  const clientById = new Map<string, { name: string }>();
  if (clientIds.length > 0) {
    const { data: clientRows } = await supabase.from("clients").select("id, name").in("id", clientIds);
    for (const c of (clientRows ?? []) as { id: string; name: string }[]) {
      clientById.set(c.id, { name: c.name });
    }
  }

  const contractIds = [...new Set(rows.map((r) => r.contract_id).filter((id): id is string => !!id))];
  const templateKeyByContractId = new Map<string, string>();
  if (contractIds.length > 0) {
    const { data: contractRows } = await supabase.from("contracts").select("id, template_key").in("id", contractIds);
    for (const c of (contractRows ?? []) as { id: string; template_key: string }[]) {
      templateKeyByContractId.set(c.id, c.template_key);
    }
  }

  const selectedStatus = STATUSES.includes(searchParams.status as Status)
    ? (searchParams.status as Status)
    : null;

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of rows) if (STATUSES.includes(r.status as Status)) counts[r.status as Status] += 1;

  const filtered = selectedStatus ? rows.filter((r) => r.status === selectedStatus) : [];

  const cardHref = (s: Status) => (selectedStatus === s ? "/invoices" : `/invoices?status=${s}`);

  return (
    <div className="min-h-full bg-brand-cream">
      <PageHeader title="Invoicing" description="What's billed, what's paid. Stripe-backed." />

      <div className="space-y-6 p-8">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {STATUSES.map((s) => (
            <CountCard key={s} status={s} count={counts[s]} selected={selectedStatus === s} href={cardHref(s)} />
          ))}
        </div>

        {!selectedStatus ? (
          <p className="pt-2 text-sm text-muted-foreground">Select a status above to view its invoices.</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-brand-navy/[0.08] bg-white">
            <div className="flex items-center gap-2 border-b border-brand-navy/[0.08] px-4 py-3">
              <span className={`h-2.5 w-2.5 rounded-full ${STATUS_META[selectedStatus].dot}`} />
              <span className="font-medium text-brand-navy">{STATUS_META[selectedStatus].label}</span>
              <span className="text-muted-foreground">({filtered.length})</span>
            </div>
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No {STATUS_META[selectedStatus].label.toLowerCase()} invoices.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-brand-navy/[0.06] text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Client</th>
                    <th className="px-4 py-3 font-medium">Package</th>
                    <th className="px-4 py-3 font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">Issued</th>
                    <th className="px-4 py-3 font-medium">Due</th>
                    <th className="px-4 py-3 font-medium">Paid</th>
                    <th className="px-4 py-3 font-medium">Payment link</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-navy/[0.06]">
                  {filtered.map((r) => {
                    const templateKey = r.contract_id ? templateKeyByContractId.get(r.contract_id) : null;
                    return (
                      <tr key={r.id} className="hover:bg-brand-cream/60">
                        <td className="px-4 py-3">
                          <Link href={`/clients/${r.client_id}`} className="font-medium text-brand-navy hover:underline">
                            {clientById.get(r.client_id)?.name ?? "—"}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {templateKey ? CONTRACT_TEMPLATES[templateKey as TemplateKey]?.name ?? templateKey : "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{formatAmount(r.amount_cents)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(r.issued_date)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(r.due_date)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(r.paid_date)}</td>
                        <td className="px-4 py-3">
                          {r.hosted_invoice_url ? (
                            <a
                              href={r.hosted_invoice_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              Stripe ↗
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CountCard({
  status,
  count,
  selected,
  href,
}: {
  status: Status;
  count: number;
  selected: boolean;
  href: string;
}) {
  const meta = STATUS_META[status];
  return (
    <Link
      href={href}
      className={`block rounded-2xl bg-white p-4 shadow-[0_1px_3px_rgba(11,30,58,0.05)] ring-1 transition-shadow hover:shadow-[0_2px_8px_rgba(11,30,58,0.10)] ${
        selected ? "ring-2 ring-brand-navy" : "ring-brand-navy/[0.06]"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
        <span className="text-xs font-medium text-muted-foreground">{meta.label}</span>
      </div>
      <p className="mt-1.5 font-serif text-2xl font-semibold leading-none text-brand-navy">{count}</p>
    </Link>
  );
}
