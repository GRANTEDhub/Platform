import Link from "next/link";
import { format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { CONTRACT_TEMPLATES, formatAmount, type TemplateKey } from "@/lib/contracts/template";
import { signedUrl, CONTRACTS_BUCKET } from "@/lib/storage";

export const dynamic = "force-dynamic";

// Live contracts list -- status cards (matches the /leads pipeline pattern) that
// reveal a filtered table on click. Read-only: admin RLS (contracts_admin) already
// covers this select; generation/signing stays on the lead detail page's
// ContractPanel. Signed PDFs are downloaded via short-lived signed URLs -- the
// contracts bucket is private, pdf_url is only ever a storage object path.

type ContractRow = {
  id: string;
  client_id: string;
  template_key: string;
  amount_cents: number | null;
  status: string; // draft | sent | signed | void
  signer_name: string | null;
  signed_at: string | null;
  pdf_url: string | null;
  created_at: string;
};

type Status = "draft" | "sent" | "signed" | "void";
const STATUSES: Status[] = ["draft", "sent", "signed", "void"];

const STATUS_META: Record<Status, { label: string; dot: string }> = {
  draft: { label: "Draft", dot: "bg-slate-400" },
  sent: { label: "Sent", dot: "bg-amber-400" },
  signed: { label: "Signed", dot: "bg-emerald-500" },
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

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  await requireAdmin();
  const supabase = createClient();

  const { data: contractRows } = await supabase
    .from("contracts")
    .select("id, client_id, template_key, amount_cents, status, signer_name, signed_at, pdf_url, created_at")
    .order("created_at", { ascending: false });
  const rows = (contractRows ?? []) as ContractRow[];

  const clientIds = [...new Set(rows.map((r) => r.client_id))];
  const clientById = new Map<string, { name: string }>();
  if (clientIds.length > 0) {
    const { data: clientRows } = await supabase.from("clients").select("id, name").in("id", clientIds);
    for (const c of (clientRows ?? []) as { id: string; name: string }[]) {
      clientById.set(c.id, { name: c.name });
    }
  }

  const selectedStatus = STATUSES.includes(searchParams.status as Status)
    ? (searchParams.status as Status)
    : null;

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of rows) if (STATUSES.includes(r.status as Status)) counts[r.status as Status] += 1;

  const filtered = selectedStatus ? rows.filter((r) => r.status === selectedStatus) : [];

  // Short-lived signed URLs, generated only for the rows actually being shown.
  const pdfLinks = new Map<string, string>();
  const withPdf = filtered.filter((r) => r.status === "signed" && r.pdf_url);
  if (withPdf.length > 0) {
    const links = await Promise.all(withPdf.map((r) => signedUrl(CONTRACTS_BUCKET, r.pdf_url!)));
    withPdf.forEach((r, i) => {
      const link = links[i];
      if (link) pdfLinks.set(r.id, link);
    });
  }

  const cardHref = (s: Status) => (selectedStatus === s ? "/contracts" : `/contracts?status=${s}`);

  return (
    <div className="min-h-full bg-brand-cream">
      <PageHeader
        title="Contracts"
        description="Engagement letters and the signing lifecycle for each client."
      />

      <div className="space-y-6 p-8">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {STATUSES.map((s) => (
            <CountCard key={s} status={s} count={counts[s]} selected={selectedStatus === s} href={cardHref(s)} />
          ))}
        </div>

        {!selectedStatus ? (
          <p className="pt-2 text-sm text-muted-foreground">Select a status above to view its contracts.</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-brand-navy/[0.08] bg-white">
            <div className="flex items-center gap-2 border-b border-brand-navy/[0.08] px-4 py-3">
              <span className={`h-2.5 w-2.5 rounded-full ${STATUS_META[selectedStatus].dot}`} />
              <span className="font-medium text-brand-navy">{STATUS_META[selectedStatus].label}</span>
              <span className="text-muted-foreground">({filtered.length})</span>
            </div>
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No {STATUS_META[selectedStatus].label.toLowerCase()} contracts.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-brand-navy/[0.06] text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Client</th>
                    <th className="px-4 py-3 font-medium">Package</th>
                    <th className="px-4 py-3 font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">Signed by</th>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">PDF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-navy/[0.06]">
                  {filtered.map((r) => (
                    <tr key={r.id} className="hover:bg-brand-cream/60">
                      <td className="px-4 py-3">
                        <Link href={`/clients/${r.client_id}`} className="font-medium text-brand-navy hover:underline">
                          {clientById.get(r.client_id)?.name ?? "—"}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {CONTRACT_TEMPLATES[r.template_key as TemplateKey]?.name ?? r.template_key}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatAmount(r.amount_cents)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.signer_name ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {r.status === "signed" ? fmtDate(r.signed_at) : fmtDate(r.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        {pdfLinks.has(r.id) ? (
                          <a
                            href={pdfLinks.get(r.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-medium text-primary hover:underline"
                          >
                            Download ↗
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
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
