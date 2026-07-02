import Link from "next/link";
import { format, parseISO } from "date-fns";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { IngestForm } from "./ingest-form";
import {
  getGrantDisposition,
  type DispositionCard,
  type DispositionTier,
} from "@/lib/grants/disposition";
import type { Grant } from "@/types/database";

export const dynamic = "force-dynamic";

// The Ledger: a permanent, read-only record of every grant that entered the
// system and its disposition across the full funnel. Searchable repository +
// calibration dataset. Acting on a grant happens on its detail page, not here.
const TIER_BADGE: Record<DispositionTier, { variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline" }> = {
  matched_alerted: { variant: "success" },
  matched_pending: { variant: "default" },
  matched_rejected: { variant: "outline" },
  no_match: { variant: "secondary" },
  not_pursued: { variant: "warning" },
  processing: { variant: "secondary" },
  error: { variant: "destructive" },
  forecasted: { variant: "outline" },
};

const TIER_FILTERS: { value: DispositionTier | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "matched_alerted", label: "Alerted" },
  { value: "matched_pending", label: "In review" },
  { value: "matched_rejected", label: "Rejected" },
  { value: "no_match", label: "No match" },
  { value: "not_pursued", label: "Not pursued" },
  { value: "processing", label: "Processing" },
  { value: "forecasted", label: "Forecasted" },
  { value: "error", label: "Failed" },
];

type ProspectEmbed = { name: string };
type CardRow = {
  grant_id: string | null;
  card_type: string | null;
  decision: DispositionCard["decision"];
  clients: { name: string } | { name: string }[] | null;
  prospects: ProspectEmbed | ProspectEmbed[] | null;
};

function embedName(e: { name: string } | { name: string }[] | null): string | null {
  if (!e) return null;
  return Array.isArray(e) ? e[0]?.name ?? null : e.name;
}

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: { q?: string; tier?: string };
}) {
  await requireUser(); // admins + contractors
  const supabase = createClient();

  const search = (searchParams.q ?? "").trim();
  const activeTier = (searchParams.tier ?? "all") as DispositionTier | "all";

  let grantQuery = supabase
    .from("grants")
    .select(
      "id, title, funder, status, grant_status, error_detail, submission_deadline, deadline, ingested_at, is_domestic, hard_disqualifiers, skip_reason, activated_from_forecast_at",
    )
    .order("ingested_at", { ascending: false })
    .limit(200);
  if (search) {
    // Sanitize before interpolating into the PostgREST or-filter (strip chars
    // that would break the filter grammar). Internal admin tool; best-effort.
    const safe = search.replace(/[%*(),:\\]/g, " ").trim();
    if (safe) grantQuery = grantQuery.or(`title.ilike.*${safe}*,funder.ilike.*${safe}*`);
  }
  const { data: grantData } = await grantQuery;
  const grants = (grantData ?? []) as Partial<Grant>[];

  // Cards for these grants, for disposition derivation (org names + decisions).
  const ids = grants.map((g) => g.id!).filter(Boolean);
  const cardsByGrant = new Map<string, DispositionCard[]>();
  if (ids.length > 0) {
    const { data: cards } = await supabase
      .from("review_cards")
      .select("grant_id, card_type, decision, clients(name), prospects(name)")
      .in("grant_id", ids);
    for (const c of (cards ?? []) as CardRow[]) {
      if (!c.grant_id) continue;
      const arr = cardsByGrant.get(c.grant_id) ?? [];
      arr.push({
        card_type: c.card_type,
        decision: c.decision,
        org_name: c.card_type === "prospect" ? embedName(c.prospects) : embedName(c.clients),
      });
      cardsByGrant.set(c.grant_id, arr);
    }
  }

  const rows = grants
    .map((g) => ({
      grant: g,
      disposition: getGrantDisposition(
        {
          status: g.status ?? "processing",
          grant_status: g.grant_status ?? null,
          is_domestic: g.is_domestic ?? true,
          hard_disqualifiers: g.hard_disqualifiers ?? null,
          skip_reason: g.skip_reason ?? null,
          error_detail: g.error_detail ?? null,
        },
        cardsByGrant.get(g.id!) ?? [],
      ),
    }))
    .filter((r) => activeTier === "all" || r.disposition.tier === activeTier);

  return (
    <div>
      <PageHeader
        title="Ledger"
        description="Every grant that entered the system and its disposition across the funnel. A read-only record — open a grant to act on it."
      />
      <div className="grid gap-8 p-8 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {TIER_FILTERS.map((f) => {
                const href =
                  f.value === "all"
                    ? search
                      ? `/grants?q=${encodeURIComponent(search)}`
                      : "/grants"
                    : `/grants?tier=${f.value}${search ? `&q=${encodeURIComponent(search)}` : ""}`;
                const active = activeTier === f.value;
                return (
                  <Link
                    key={f.value}
                    href={href}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "border bg-card text-muted-foreground hover:bg-accent/60"
                    }`}
                  >
                    {f.label}
                  </Link>
                );
              })}
            </div>
            <form method="get" className="flex gap-2">
              {activeTier !== "all" && <input type="hidden" name="tier" value={activeTier} />}
              <input
                type="text"
                name="q"
                defaultValue={search}
                placeholder="Search title or funder…"
                className="h-8 w-56 rounded-md border border-input bg-card px-3 text-sm"
              />
            </form>
          </div>

          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Opportunity</th>
                  <th className="px-4 py-3 font-medium">Disposition</th>
                  <th className="px-4 py-3 font-medium">Deadline</th>
                  <th className="px-4 py-3 font-medium">Ingested</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ grant: g, disposition: d }) => (
                  <tr key={g.id} className="border-b align-top last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`/grants/${g.id}`} className="font-medium hover:underline">
                        {g.title || "Processing…"}
                      </Link>
                      {g.funder && <p className="text-xs text-muted-foreground">{g.funder}</p>}
                      {g.activated_from_forecast_at && (
                        <span
                          className="mt-1 inline-block rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700"
                          title={`Was forecasted, activated ${format(parseISO(g.activated_from_forecast_at), "MMM d, yyyy")}`}
                        >
                          Was forecasted
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={TIER_BADGE[d.tier].variant}>{d.label}</Badge>
                      {d.detail && (
                        <p className="mt-1 max-w-md text-xs text-muted-foreground">{d.detail}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {g.deadline ? format(parseISO(g.deadline), "MMM d, yyyy") : g.submission_deadline || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {g.ingested_at ? format(parseISO(g.ingested_at), "MMM d, yyyy") : "—"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                      {search || activeTier !== "all"
                        ? "No grants match this filter."
                        : "No grants yet. Paste a link or NOFO on the right, or let the scheduled ingest pull new opportunities."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
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
