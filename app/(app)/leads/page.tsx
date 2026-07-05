import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { effectiveStage, type StoredStage, type EffectiveStage } from "@/lib/leads/stage";
import { contractSignals, invoiceSignals, intakeStatus, type IntakeStatus } from "@/lib/leads/events";
import { PipelineHeaderActions } from "./pipeline-header-actions";
import { format, parseISO } from "date-fns";

function fmtDate(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return iso;
  }
}

export const dynamic = "force-dynamic";

// The lead pipeline board. Visual pattern (clean count-cards -> click to expand a
// filtered table) matches GOH's restraint; the model is Argo's: Incoming/Outgoing
// tabs, effective stages (discovery_pending -> contract_pending -> contract_signed
// -> invoice_paid; contract/invoice derived from their tables) + side states
// (rejected/archived/converted). Intake is a FLAG (badge column), never a stage.
// Progressive disclosure: cards always show; the table appears once a card is
// selected. Server-driven via ?tab=&stage=.

type LeadRow = {
  id: string;
  name: string;
  org_type: string | null;
  pipeline_stage: string | null;
  lead_source: string | null;
  account_manager_id: string | null;
  needs_review: boolean;
  discovery_booked_at: string | null;
  intake_data: Record<string, unknown> | null;
  intake_sent_at: string | null;
  primary_contact_name: string | null;
  created_at: string;
};

type Tab = "incoming" | "outgoing";

const MAIN_STAGES: EffectiveStage[] = ["discovery_pending", "contract_pending", "contract_signed", "invoice_paid"];
const SIDE_STAGES: EffectiveStage[] = ["rejected", "archived", "converted"];

const STAGE_META: Record<EffectiveStage, { label: string; dot: string }> = {
  discovery_pending: { label: "Discovery Pending", dot: "bg-slate-400" },
  contract_pending: { label: "Contract Pending", dot: "bg-amber-400" },
  contract_signed: { label: "Contract Signed", dot: "bg-blue-500" },
  invoice_paid: { label: "Invoice Paid", dot: "bg-emerald-500" },
  converted: { label: "Converted", dot: "bg-brand-navy" },
  rejected: { label: "Rejected", dot: "bg-red-400" },
  archived: { label: "Archived", dot: "bg-neutral-400" },
};

const INTAKE_BADGE: Record<IntakeStatus, { label: string; variant: "success" | "secondary" | "outline" }> = {
  received: { label: "Intake received", variant: "success" },
  sent: { label: "Intake sent", variant: "outline" },
  not_sent: { label: "No intake", variant: "secondary" },
};

function tabOf(row: LeadRow): Tab {
  return row.lead_source === "inbound" ? "incoming" : "outgoing";
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { tab?: string; stage?: string };
}) {
  await requireAdmin();
  const supabase = createClient();

  const tab: Tab = searchParams.tab === "outgoing" ? "outgoing" : "incoming";
  const allStages = [...MAIN_STAGES, ...SIDE_STAGES];
  const selectedStage = allStages.includes(searchParams.stage as EffectiveStage)
    ? (searchParams.stage as EffectiveStage)
    : null;

  // All pipeline rows (incl. converted for the Converted card). Effective stage is
  // derived in-app, so we bucket/filter here rather than in SQL.
  const { data: leadData } = await supabase
    .from("clients")
    .select(
      "id, name, org_type, pipeline_stage, lead_source, account_manager_id, needs_review, discovery_booked_at, intake_data, intake_sent_at, primary_contact_name, created_at",
    )
    .not("pipeline_stage", "is", null)
    .order("created_at", { ascending: false });
  const rows = (leadData ?? []) as LeadRow[];

  const ids = rows.map((r) => r.id);
  const contractsByLead = new Map<string, string[]>();
  const invoicesByLead = new Map<string, string[]>();
  const hookCountByLead = new Map<string, number>();
  const amById = new Map<string, string>();
  if (ids.length > 0) {
    const [{ data: contractRows }, { data: invoiceRows }, { data: hooks }, { data: profiles }] = await Promise.all([
      supabase.from("contracts").select("client_id, status").in("client_id", ids).neq("status", "void"),
      supabase.from("invoices").select("client_id, status").in("client_id", ids),
      supabase.from("lead_grant_hooks").select("client_id").in("client_id", ids),
      supabase.from("profiles").select("id, full_name, email"),
    ]);
    for (const c of (contractRows ?? []) as { client_id: string; status: string }[]) {
      const arr = contractsByLead.get(c.client_id) ?? [];
      arr.push(c.status);
      contractsByLead.set(c.client_id, arr);
    }
    for (const i of (invoiceRows ?? []) as { client_id: string; status: string }[]) {
      const arr = invoicesByLead.get(i.client_id) ?? [];
      arr.push(i.status);
      invoicesByLead.set(i.client_id, arr);
    }
    for (const h of (hooks ?? []) as { client_id: string }[]) {
      hookCountByLead.set(h.client_id, (hookCountByLead.get(h.client_id) ?? 0) + 1);
    }
    for (const p of (profiles ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
      amById.set(p.id, p.full_name || p.email || "Unknown");
    }
  }

  // Effective stage per row + tab bucketing.
  const enriched = rows.map((r) => ({
    row: r,
    tab: tabOf(r),
    eff: effectiveStage(r.pipeline_stage as StoredStage, {
      ...contractSignals(contractsByLead.get(r.id) ?? []),
      ...invoiceSignals(invoicesByLead.get(r.id) ?? []),
    }),
  }));

  const inTab = enriched.filter((e) => e.tab === tab);
  const counts = Object.fromEntries(allStages.map((s) => [s, 0])) as Record<EffectiveStage, number>;
  for (const e of inTab) if (e.eff) counts[e.eff] += 1;

  const tableRows = selectedStage ? inTab.filter((e) => e.eff === selectedStage) : [];

  const tabHref = (t: Tab) => `/leads?tab=${t}`;
  const cardHref = (s: EffectiveStage) =>
    selectedStage === s ? `/leads?tab=${tab}` : `/leads?tab=${tab}&stage=${s}`;

  return (
    <div className="min-h-full bg-brand-cream">
      <PageHeader
        title="Lead pipeline"
        description="Inbound and outbound leads, worked toward becoming clients."
        action={<PipelineHeaderActions />}
      />

      <div className="space-y-6 p-8">
        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-brand-navy/10">
          {(["incoming", "outgoing"] as Tab[]).map((t) => (
            <Link
              key={t}
              href={tabHref(t)}
              className={`-mb-px border-b-2 px-5 py-2 text-sm font-medium transition-colors ${
                tab === t
                  ? "border-brand-navy text-brand-navy"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "incoming" ? "Incoming" : "Outgoing"}
            </Link>
          ))}
        </div>

        {/* Main stage cards */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {MAIN_STAGES.map((s) => (
            <StageCard key={s} stage={s} count={counts[s]} selected={selectedStage === s} href={cardHref(s)} />
          ))}
        </div>

        {/* Side-state cards */}
        <div>
          <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Side states</p>
          <div className="grid grid-cols-3 gap-3">
            {SIDE_STAGES.map((s) => (
              <StageCard key={s} stage={s} count={counts[s]} selected={selectedStage === s} href={cardHref(s)} />
            ))}
          </div>
        </div>

        {/* Revealed table */}
        {!selectedStage ? (
          <p className="pt-2 text-sm text-muted-foreground">Select a stage above to view its leads.</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-brand-navy/[0.08] bg-white">
            <div className="flex items-center gap-2 border-b border-brand-navy/[0.08] px-4 py-3">
              <span className={`h-2.5 w-2.5 rounded-full ${STAGE_META[selectedStage].dot}`} />
              <span className="font-medium text-brand-navy">{STAGE_META[selectedStage].label}</span>
              <span className="text-muted-foreground">({tableRows.length})</span>
            </div>
            {tableRows.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No leads in {STAGE_META[selectedStage].label}.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-brand-navy/[0.06] text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Organization</th>
                    <th className="px-4 py-3 font-medium">Contact</th>
                    <th className="px-4 py-3 font-medium">Org type</th>
                    <th className="px-4 py-3 font-medium">Owner</th>
                    <th className="px-4 py-3 font-medium">Intake</th>
                    <th className="px-4 py-3 font-medium">Activity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-navy/[0.06]">
                  {tableRows.map(({ row: l }) => {
                    const hooks = hookCountByLead.get(l.id) ?? 0;
                    const intake = intakeStatus(l);
                    const badge = INTAKE_BADGE[intake];
                    return (
                      <tr key={l.id} className="hover:bg-brand-cream/60">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Link href={`/leads/${l.id}`} className="font-medium text-brand-navy hover:underline">
                              {l.name}
                            </Link>
                            {l.needs_review && <Badge variant="warning">Review</Badge>}
                            {hooks > 0 && <Badge variant="secondary">{hooks} hook{hooks > 1 ? "s" : ""}</Badge>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{l.primary_contact_name || "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">{l.org_type?.replace(/_/g, " ") || "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {l.account_manager_id ? amById.get(l.account_manager_id) ?? "—" : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {l.discovery_booked_at
                            ? `Call ${fmtDate(l.discovery_booked_at)}`
                            : `Added ${fmtDate(l.created_at)}`}
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

function StageCard({
  stage,
  count,
  selected,
  href,
}: {
  stage: EffectiveStage;
  count: number;
  selected: boolean;
  href: string;
}) {
  const meta = STAGE_META[stage];
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
