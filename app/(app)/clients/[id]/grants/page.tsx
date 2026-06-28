import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/ui/stat";
import { MatchRow } from "@/components/grants/match-row";
import type { MatchCard } from "@/lib/grants/grouping";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

// Surface the client's most actionable matches first: new (pending), then
// held, then decided.
const STATUS_ORDER: Record<string, number> = { pending: 0, hold: 1, approved: 2, passed: 3 };

export default async function ClientGrantsPage({
  params,
}: {
  params: { id: string };
}) {
  await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, org_type, engagement_tier")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "org_type" | "engagement_tier">>();
  if (!client) notFound();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "*, clients(id, name, org_type, engagement_tier), grants(id, title, funder, submission_deadline, deadline)",
    )
    .eq("client_id", params.id)
    .order("created_at", { ascending: false });

  const cards = ((data ?? []) as MatchCard[]).sort(
    (a, b) =>
      (STATUS_ORDER[a.decision] ?? 9) - (STATUS_ORDER[b.decision] ?? 9) ||
      b.fit_score - a.fit_score,
  );

  const count = (d: string) => cards.filter((c) => c.decision === d).length;

  return (
    <div>
      <PageHeader
        title={client.name}
        description="Grant activity — every match for this client and where it stands."
        action={
          <Link href={`/clients/${client.id}`}>
            <Button variant="outline">Client profile</Button>
          </Link>
        }
      />
      <div className="space-y-6 p-8">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="New" value={String(count("pending"))} hint="awaiting review" />
          <Stat label="On hold" value={String(count("hold"))} hint="needs confirmation" />
          <Stat label="Approved" value={String(count("approved"))} hint="cleared to send" />
          <Stat label="Rejected" value={String(count("passed"))} hint="passed" />
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Opportunity</th>
                <th className="px-4 py-3 font-medium">Fit</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Deadline</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => <MatchRow key={c.id} card={c} />)}
              {cards.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                    No matches yet for this client. They appear here as grants are ingested and scored.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
