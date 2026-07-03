import Link from "next/link";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { NON_LEAD_OR_FILTER } from "@/lib/leads/stage";
import type { ClientOverview } from "@/types/database";

export const dynamic = "force-dynamic";

function statusVariant(status: string) {
  switch (status) {
    case "active":
      return "success" as const;
    case "prospect":
      return "default" as const;
    case "paused":
      return "warning" as const;
    default:
      return "secondary" as const;
  }
}

function DeadlineCell({ date }: { date: string | null }) {
  if (!date) return <span className="text-muted-foreground">—</span>;
  const days = differenceInCalendarDays(parseISO(date), new Date());
  const urgent = days <= 14;
  return (
    <span className={urgent ? "font-medium text-destructive" : ""}>
      {format(parseISO(date), "MMM d")}
      <span className="ml-1 text-xs text-muted-foreground">({days}d)</span>
    </span>
  );
}

function ContractCell({ date }: { date: string | null }) {
  if (!date) return <span className="text-muted-foreground">—</span>;
  const days = differenceInCalendarDays(parseISO(date), new Date());
  const expiring = days <= 30;
  return (
    <span className={expiring ? "font-medium text-amber-700" : ""}>
      {format(parseISO(date), "MMM d, yyyy")}
    </span>
  );
}

export default async function DashboardPage() {
  await requireAdmin();
  const supabase = createClient();

  // Exclude leads — the dashboard is the real-client roster. Same predicate as
  // the matcher and the client list (pipeline_stage exposed on the view in 0026).
  const { data, error } = await supabase
    .from("client_overview")
    .select("*")
    .or(NON_LEAD_OR_FILTER)
    .order("name");

  const clients = (data ?? []) as ClientOverview[];

  const activeCount = clients.filter((c) => c.status === "active").length;
  const totalOwed = clients.reduce((sum, c) => sum + (c.owed_cents || 0), 0);
  const totalHoursRemaining = clients.reduce(
    (sum, c) => sum + (Number(c.hours_remaining) || 0),
    0,
  );
  const upcoming = clients.filter(
    (c) =>
      c.next_deadline &&
      differenceInCalendarDays(parseISO(c.next_deadline), new Date()) <= 30,
  ).length;

  return (
    <div>
      <PageHeader
        title="Client Dashboard"
        description="Every client at a glance — status, balances, deadlines, and what's next."
        action={
          <Link href="/clients">
            <Button variant="outline">Manage clients</Button>
          </Link>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Active clients" value={String(activeCount)} hint={`${clients.length} total`} />
          <Stat label="Outstanding" value={formatCurrency(totalOwed / 100)} hint="invoices sent, unpaid" />
          <Stat label="Hours remaining" value={totalHoursRemaining.toFixed(1)} hint="across retainers" />
          <Stat label="Deadlines ≤30d" value={String(upcoming)} hint="approved matches" />
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Client</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Owed</th>
                  <th className="px-4 py-3 font-medium text-right">Hrs left</th>
                  <th className="px-4 py-3 font-medium">Contract ends</th>
                  <th className="px-4 py-3 font-medium">Next deadline</th>
                  <th className="px-4 py-3 font-medium">Next step</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      {c.org_type && (
                        <p className="text-xs text-muted-foreground">
                          {c.org_type.replace(/_/g, " ")}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {c.owed_cents ? formatCurrency(c.owed_cents / 100) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {Number(c.hours_remaining ?? 0).toFixed(1)}
                    </td>
                    <td className="px-4 py-3">
                      <ContractCell date={c.contract_end} />
                    </td>
                    <td className="px-4 py-3">
                      <DeadlineCell date={c.next_deadline} />
                    </td>
                    <td className="px-4 py-3 max-w-[16rem] truncate text-muted-foreground">
                      {c.next_step || "—"}
                    </td>
                  </tr>
                ))}
                {clients.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      {error
                        ? "Could not load clients. Check the database connection."
                        : "No clients yet. Add your first client to get started."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
