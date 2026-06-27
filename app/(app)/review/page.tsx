import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import type { ReviewCard, Client, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "hold", label: "Hold" },
  { value: "passed", label: "Passed" },
];

type Row = ReviewCard & {
  clients: Pick<Client, "name" | "engagement_tier"> | null;
  grants: Pick<Grant, "title" | "funder" | "submission_deadline"> | null;
};

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  await requireUser(); // admins + contractors
  const filter = searchParams.filter || "pending";
  const supabase = createClient();

  let query = supabase
    .from("review_cards")
    .select("*, clients(name, engagement_tier), grants(title, funder, submission_deadline)")
    .order("fit_score", { ascending: false })
    .order("created_at", { ascending: false });
  if (filter !== "all") query = query.eq("decision", filter);

  const { data } = await query;
  const cards = (data ?? []) as Row[];

  return (
    <div>
      <PageHeader
        title="Review Queue"
        description="Score 2–3 matches. Approve to clear for a client, or pass."
      />
      <div className="space-y-4 p-8">
        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.value}
              href={`/review?filter=${f.value}`}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                filter === f.value
                  ? "bg-primary text-primary-foreground"
                  : "border bg-card text-muted-foreground hover:bg-accent/60"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Opportunity</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Fit</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <Link href={`/review/${c.id}`} className="font-medium hover:underline">
                      {c.clients?.name || "Client"}
                    </Link>
                    {c.clients?.engagement_tier && (
                      <p className="text-xs text-muted-foreground">{c.clients.engagement_tier}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 max-w-[20rem]">
                    <p className="truncate">{c.grants?.title || "—"}</p>
                    <p className="text-xs text-muted-foreground">{c.grants?.funder}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{c.proposed_role}</td>
                  <td className="px-4 py-3"><ScoreBadge score={c.fit_score} /></td>
                  <td className="px-4 py-3"><DecisionBadge decision={c.decision} /></td>
                </tr>
              ))}
              {cards.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    Nothing here. Matches appear after a grant is ingested.
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
