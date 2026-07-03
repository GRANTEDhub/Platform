import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { effectiveStage, type StoredStage } from "@/lib/leads/stage";
import { signalsFromLeadRow, SETTABLE_STAGES } from "@/lib/leads/events";

export const dynamic = "force-dynamic";

type LeadRow = {
  id: string;
  name: string;
  org_type: string | null;
  pipeline_stage: string | null;
  lead_source: string | null;
  account_manager_id: string | null;
  needs_review: boolean;
  contract_status: string | null;
  contract_signed_at: string | null;
};

type HookRow = {
  client_id: string;
  grants: { title: string | null } | { title: string | null }[] | null;
};

const FILTERS = ["all", ...SETTABLE_STAGES] as const;

function grantTitle(h: HookRow): string | null {
  const g = h.grants;
  if (!g) return null;
  return (Array.isArray(g) ? g[0]?.title : g.title) ?? null;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { stage?: string };
}) {
  await requireAdmin();
  const supabase = createClient();

  const active = searchParams.stage && SETTABLE_STAGES.includes(searchParams.stage as never)
    ? searchParams.stage
    : "all";

  // Leads = clients in the pipeline but not yet converted.
  let q = supabase
    .from("clients")
    .select(
      "id, name, org_type, pipeline_stage, lead_source, account_manager_id, needs_review, contract_status, contract_signed_at",
    )
    .not("pipeline_stage", "is", null)
    .neq("pipeline_stage", "converted")
    .order("created_at", { ascending: false });
  if (active !== "all") q = q.eq("pipeline_stage", active);
  const { data: leadData } = await q;
  const leads = (leadData ?? []) as LeadRow[];

  const ids = leads.map((l) => l.id);
  const hooksByLead = new Map<string, string[]>();
  const amById = new Map<string, string>();
  if (ids.length > 0) {
    const [{ data: hooks }, { data: profiles }] = await Promise.all([
      supabase.from("lead_grant_hooks").select("client_id, grants(title)").in("client_id", ids),
      supabase.from("profiles").select("id, full_name, email"),
    ]);
    for (const h of (hooks ?? []) as HookRow[]) {
      const t = grantTitle(h);
      if (!t) continue;
      const arr = hooksByLead.get(h.client_id) ?? [];
      arr.push(t);
      hooksByLead.set(h.client_id, arr);
    }
    for (const p of (profiles ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
      amById.set(p.id, p.full_name || p.email || "Unknown");
    }
  }

  return (
    <div>
      <PageHeader
        title="Leads"
        description="Prospects promoted into the pipeline — worked toward becoming clients."
      />
      <div className="space-y-4 p-8">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const isActive = active === f;
            return (
              <Link
                key={f}
                href={f === "all" ? "/leads" : `/leads?stage=${f}`}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {f === "all" ? "All" : f.replace(/_/g, " ")}
              </Link>
            );
          })}
        </div>

        {leads.length === 0 ? (
          <p className="text-sm text-muted-foreground">No leads in this view.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Organization</th>
                  <th className="px-4 py-3 font-medium">Stage</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Account manager</th>
                  <th className="px-4 py-3 font-medium">Grant hook(s)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {leads.map((l) => {
                  const eff = effectiveStage(l.pipeline_stage as StoredStage | null, signalsFromLeadRow(l));
                  const hooks = hooksByLead.get(l.id) ?? [];
                  return (
                    <tr key={l.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link href={`/leads/${l.id}`} className="font-medium hover:underline">
                          {l.name}
                        </Link>
                        {l.needs_review && (
                          <Badge variant="warning" className="ml-2 align-middle">Review</Badge>
                        )}
                        {l.org_type && (
                          <p className="text-xs text-muted-foreground">{l.org_type.replace(/_/g, " ")}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary">{(eff ?? "—").replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {(l.lead_source ?? "—").replace(/_/g, " ")}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {l.account_manager_id ? amById.get(l.account_manager_id) ?? "—" : "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {hooks.length === 0 ? "—" : hooks.join(", ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
