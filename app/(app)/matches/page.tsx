import Link from "next/link";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { ClipboardList, Building2, type LucideIcon } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// The staff review queue -- the repurposed Matches tab. ACCOUNT-MANAGED (premium)
// clients only: a base client's matches surface straight to their own Grant Alerts,
// so there is nothing for staff to review. For each premium client with matches
// awaiting review, one card with the count; click through to that client's SINGLE
// review gate (the roadmap review list, where why-it-matches + the manual concept
// generate/edit + release-to-client all live).
//
// "To review" = a non-passed card not yet released to the client (sme_released_at
// IS NULL) -- exactly the count the per-client dashboard shows, so the two can't
// drift. Only clients WITH pending review appear, so this is the day's worklist,
// not the whole roster (Portfolio is the browse-everyone surface).

type ClientRow = { id: string; name: string; org_type: string | null; engagement_tier: string | null };
type CardRow = {
  client_id: string | null;
  grants: { submission_deadline: string | null } | { submission_deadline: string | null }[] | null;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable navy/orange monogram per client (hashed on id), matching Portfolio.
function monogramFill(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 2 === 0 ? "bg-brand-navy" : "bg-brand-orange";
}

function deadlineParts(date: string | null): { top: string; bottom: string; urgent: boolean } {
  if (!date) return { top: "—", bottom: "no deadline", urgent: false };
  const days = differenceInCalendarDays(parseISO(date), new Date());
  if (days < 0) return { top: format(parseISO(date), "MMM d"), bottom: "overdue", urgent: true };
  return { top: format(parseISO(date), "MMM d"), bottom: `${days} ${days === 1 ? "day" : "days"}`, urgent: days <= 14 };
}

export default async function ReviewQueuePage() {
  await requireUser();
  const supabase = createClient();

  const { data: clientData } = await supabase
    .from("clients")
    .select("id, name, org_type, engagement_tier")
    .eq("account_managed", true);
  const clients = (clientData ?? []) as ClientRow[];
  const byId = new Map(clients.map((c) => [c.id, c]));
  const ids = clients.map((c) => c.id);

  type Group = { client: ClientRow; count: number; soonest: string | null };
  const groups = new Map<string, Group>();

  if (ids.length > 0) {
    const { data: cardData } = await supabase
      .from("review_cards")
      .select("client_id, grants(submission_deadline)")
      .in("client_id", ids)
      .neq("card_type", "prospect")
      .neq("decision", "passed")
      .is("sme_released_at", null);
    for (const c of (cardData ?? []) as CardRow[]) {
      if (!c.client_id) continue;
      const client = byId.get(c.client_id);
      if (!client) continue;
      const g = Array.isArray(c.grants) ? c.grants[0] : c.grants;
      const dl = g?.submission_deadline ?? null;
      const cur = groups.get(c.client_id);
      if (cur) {
        cur.count += 1;
        if (dl && (!cur.soonest || dl < cur.soonest)) cur.soonest = dl;
      } else {
        groups.set(c.client_id, { client, count: 1, soonest: dl });
      }
    }
  }

  // Most work first, then soonest deadline, then name.
  const rows = [...groups.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (a.soonest ?? "9999").localeCompare(b.soonest ?? "9999") ||
      a.client.name.localeCompare(b.client.name),
  );
  const totalToReview = rows.reduce((s, r) => s + r.count, 0);

  return (
    <div className="px-6 py-8 lg:px-10 lg:py-9">
      <header className="mb-8">
        <h1 className="text-[30px] font-semibold tracking-tight text-brand-navy">Review queue</h1>
        <p className="mt-1.5 text-[15px] text-muted-foreground">
          Account-managed clients with grants awaiting your review before they reach the client&apos;s Grant Alerts.
        </p>
      </header>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:max-w-md">
        <SummaryTile icon={ClipboardList} tone="orange" value={String(totalToReview)} label="grants to review" />
        <SummaryTile icon={Building2} tone="navy" value={String(rows.length)} label={rows.length === 1 ? "client waiting" : "clients waiting"} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-brand-navy/[0.05] bg-white p-12 text-center text-muted-foreground shadow-soft">
          Nothing to review — every account-managed client is caught up. New matches land here as grants are scored.
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ client, count, soonest }) => {
            const dl = deadlineParts(soonest);
            const subtitle = [client.engagement_tier, client.org_type?.replace(/_/g, " ")].filter(Boolean).join(" · ") || "—";
            return (
              <Link key={client.id} href={`/clients/${client.id}/roadmap`} className="block">
                <div className="rounded-2xl border border-brand-navy/[0.05] bg-white p-6 shadow-soft transition hover:shadow-card-hover">
                  <div className="flex items-center gap-3.5">
                    <div
                      className={cn(
                        "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white",
                        monogramFill(client.id),
                      )}
                    >
                      {initials(client.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[16px] font-semibold leading-tight text-brand-navy">{client.name}</h3>
                      <p className="mt-0.5 truncate text-[13px] capitalize text-muted-foreground">{subtitle}</p>
                    </div>
                  </div>

                  <div className="mt-5 flex items-end justify-between border-t border-brand-navy/[0.06] pt-4">
                    <div>
                      <p className="text-[22px] font-semibold leading-none text-brand-orange">{count}</p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">to review</p>
                    </div>
                    <div className="text-right">
                      <p className={cn("text-[15px] font-semibold leading-none", dl.urgent ? "text-brand-orange" : "text-brand-navy")}>
                        {dl.top}
                      </p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">{soonest ? "next deadline" : dl.bottom}</p>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  tone,
  value,
  label,
}: {
  icon: LucideIcon;
  tone: "navy" | "orange";
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-2xl border border-brand-navy/[0.05] bg-white p-5 shadow-soft">
      <div className="flex items-center gap-3.5">
        <span
          className={cn(
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white",
            tone === "orange" ? "bg-brand-orange" : "bg-brand-navy",
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="text-[26px] font-semibold leading-none text-brand-navy">{value}</p>
          <p className="mt-1.5 truncate text-[13px] text-muted-foreground">{label}</p>
        </div>
      </div>
    </div>
  );
}
