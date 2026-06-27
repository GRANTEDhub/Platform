import Link from "next/link";
import { format, parseISO } from "date-fns";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { GrantStatusBadge } from "@/components/grants/badges";
import { IngestForm } from "./ingest-form";
import type { Grant } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function GrantsPage() {
  await requireUser(); // admins + contractors
  const supabase = createClient();
  const { data } = await supabase
    .from("grants")
    .select("id, title, funder, status, submission_deadline, deadline, ingested_at")
    .order("ingested_at", { ascending: false })
    .limit(100);
  const grants = (data ?? []) as Partial<Grant>[];

  return (
    <div>
      <PageHeader
        title="Grant Intelligence"
        description="Domestic federal opportunities, shredded and matched against the client roster."
      />
      <div className="grid gap-8 p-8 lg:grid-cols-[1fr_22rem]">
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Opportunity</th>
                <th className="px-4 py-3 font-medium">Deadline</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <Link href={`/grants/${g.id}`} className="font-medium hover:underline">
                      {g.title || "Processing…"}
                    </Link>
                    {g.funder && <p className="text-xs text-muted-foreground">{g.funder}</p>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {g.deadline ? format(parseISO(g.deadline), "MMM d, yyyy") : g.submission_deadline || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <GrantStatusBadge status={g.status || "processing"} />
                  </td>
                </tr>
              ))}
              {grants.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-12 text-center text-muted-foreground">
                    No grants yet. Paste a link or NOFO on the right, or let the scheduled
                    ingest pull new opportunities.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Analyze on demand
          </h2>
          <IngestForm />
        </div>
      </div>
    </div>
  );
}
