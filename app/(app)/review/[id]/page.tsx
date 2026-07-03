import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DecisionBadge } from "@/components/grants/badges";
import { interTight, sourceSerif } from "@/lib/fonts";
import { DecisionBar } from "./decision-bar";
import { MatchFeedback } from "./match-feedback";
import type { ReviewCard, Client, Grant, Prospect } from "@/types/database";

export const dynamic = "force-dynamic";

type FullCard = ReviewCard & {
  clients: Pick<Client, "id" | "name" | "org_type" | "engagement_tier"> | null;
  prospects: Pick<Prospect, "id" | "name" | "org_type" | "source_url"> | null;
  grants: Pick<Grant, "id" | "title" | "funder" | "fon" | "source_url" | "submission_deadline" | "cost_share" | "award_range_min" | "award_range_max" | "award_range_is_estimate" | "num_awards" | "grant_status" | "description"> | null;
};

const BAND: Record<number, string> = { 3: "Strong fit", 2: "Conditional", 1: "Weak" };

// Compact a currency-ish string to $150K / $1.1M so a range fits one line. Falls
// back to the raw string when it is not numeric (e.g. "Varies").
function abbrevAmount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!m) return s;
  let n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  if (unit === "k") n *= 1e3;
  else if (unit === "m") n *= 1e6;
  else if (unit === "b") n *= 1e9;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function formatAwardRange(min: string | null | undefined, max: string | null | undefined): string {
  const lo = abbrevAmount(min);
  const hi = abbrevAmount(max);
  if (!lo && !hi) return "—";
  if (lo && hi) return `${lo} – ${hi}`;
  return (lo || hi)!;
}

// Cost share as a compact token: "None" when effectively none, else the raw
// value (truncated to one line by the Stat cell). Empty -> em dash.
function compactCostShare(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  if (/^(none|no\b|not required|n\/?a|\$?0\b|0%)/i.test(s)) return "None";
  return s;
}

export default async function CardDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireUser();
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select("*, clients(id, name, org_type, engagement_tier), prospects(id, name, org_type, source_url), grants(id, title, funder, fon, source_url, submission_deadline, cost_share, award_range_min, award_range_max, award_range_is_estimate, num_awards, grant_status, description)")
    .eq("id", params.id)
    .single();

  const card = data as FullCard | null;
  if (!card) notFound();

  const rc = card.reasoning_context || {};
  // Prospect cards (Track 2) carry a prospect org instead of a client. The org
  // name + source live here; the scored analysis below stays internal.
  const isProspect = card.card_type === "prospect";
  const orgName = card.clients?.name || card.prospects?.name || "Match";
  const g = card.grants;

  const awardRange = formatAwardRange(g?.award_range_min, g?.award_range_max);
  const costShare = compactCostShare(g?.cost_share);
  const draftEmail = card.final_outreach_email || card.draft_outreach_email;
  const hasFullReasoning =
    !!(rc.eligibility_analysis || rc.role_assignment_logic || rc.consortium_rationale || rc.why_not_others);

  return (
    <div className={`${interTight.variable} ${sourceSerif.variable}`}>
      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {/* Header: grant is the subject; org is a pill below. */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-serif text-3xl font-semibold leading-tight text-brand-navy">
                {g?.title || "Opportunity"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {[g?.funder, g?.fon].filter(Boolean).join(" · ") || "—"}
              </p>
            </div>
            <DecisionBadge decision={card.decision} />
          </div>

          {/* Pill row: quiet context, not the headline */}
          <div className="mt-4 flex flex-wrap gap-2">
            {g?.grant_status && <Pill>{g.grant_status}</Pill>}
            <Pill tone="orange">Fit {card.fit_score} · {BAND[card.fit_score] ?? "—"}</Pill>
            <Pill>{isProspect ? `Prospect: ${orgName}` : orgName}</Pill>
          </div>

          {/* Funding stats — value leads, no icons */}
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={`Award range${g?.award_range_is_estimate ? " · est." : ""}`} value={awardRange} />
            <Stat label="Est. awards" value={g?.num_awards || "—"} />
            <Stat label="Deadline" value={g?.submission_deadline || "—"} />
            <Stat label="Cost share" value={costShare} />
          </div>

          {/* Content — one light container, hairline-separated rows, labels recede */}
          <div className="mt-8 divide-y divide-brand-navy/[0.08] overflow-hidden rounded-xl border border-brand-navy/10 bg-white">
            {g?.description && (
              <div className="p-4">
                <FieldLabel>What it funds</FieldLabel>
                <p className="mt-1.5 line-clamp-4 text-sm leading-relaxed text-foreground">{g.description}</p>
              </div>
            )}

            {/* Role + recommended prime read as one tight pair */}
            <div className="grid grid-cols-2 gap-4 p-4">
              <div>
                <FieldLabel>Role</FieldLabel>
                <p className="mt-1.5 text-sm text-foreground">{card.proposed_role || "—"}</p>
              </div>
              <div>
                <FieldLabel>Recommended prime</FieldLabel>
                <p className="mt-1.5 text-sm text-foreground">{card.recommended_prime || "—"}</p>
              </div>
            </div>

            {(card.description_short || (card.why_this_org?.length || 0) > 0) && (
              <div className="p-4">
                <FieldLabel>Alignment</FieldLabel>
                <div className="mt-1.5 space-y-2 text-sm text-foreground">
                  {card.description_short && <p className="leading-relaxed">{card.description_short}</p>}
                  {(card.why_this_org?.length || 0) > 0 && (
                    <ul className="list-disc space-y-1 pl-4">
                      {card.why_this_org!.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {card.concept_synopsis && (
              <div className="p-4">
                <FieldLabel>Concept</FieldLabel>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {card.concept_synopsis}
                </p>
              </div>
            )}
          </div>

          {/* Depth — collapsed detail, content verbatim */}
          <div className="mt-8">
            <h2 className="mb-2 font-serif text-lg font-semibold text-brand-navy">Depth</h2>
            <div className="divide-y overflow-hidden rounded-lg border border-input">
              {(card.before_you_approve?.length || 0) > 0 && (
                <DepthRow title="Before you approve" count={card.before_you_approve!.length}>
                  <ul className="list-disc space-y-1 pl-4">
                    {card.before_you_approve!.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                  {(card.inferred_fields?.length || 0) > 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Inferred (not confirmed): {card.inferred_fields!.join(", ")}
                    </p>
                  )}
                </DepthRow>
              )}

              {rc.fit_score_derivation && (
                <DepthRow title="How this score was reached">
                  <p className="leading-relaxed">{rc.fit_score_derivation}</p>
                </DepthRow>
              )}

              {draftEmail && (
                <DepthRow
                  title={
                    card.final_outreach_email
                      ? "Approved email (to send)"
                      : `Draft outreach email${card.outreach_track ? ` · ${card.outreach_track}` : ""}`
                  }
                >
                  <pre className="whitespace-pre-wrap font-sans text-sm">{draftEmail}</pre>
                </DepthRow>
              )}

              {hasFullReasoning && (
                <DepthRow title="Full reasoning">
                  <div className="space-y-3">
                    {rc.eligibility_analysis && <Detail label="Eligibility" value={rc.eligibility_analysis} />}
                    {rc.role_assignment_logic && <Detail label="Role logic" value={rc.role_assignment_logic} />}
                    {rc.consortium_rationale && <Detail label="Consortium" value={rc.consortium_rationale} />}
                    {rc.why_not_others && <Detail label="Why not others" value={rc.why_not_others} />}
                  </div>
                </DepthRow>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
            <CardContent>
              <DecisionBar
                cardId={card.id}
                decision={card.decision}
                isAdmin={profile.role === "admin"}
                draft={card.draft_outreach_email ?? ""}
                finalEmail={card.final_outreach_email}
              />
              {card.decision === "passed" && card.decision_reason && (
                <p className="mt-3 text-xs text-muted-foreground">Rejected: {card.decision_reason}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Score feedback</CardTitle></CardHeader>
            <CardContent>
              <MatchFeedback cardId={card.id} />
            </CardContent>
          </Card>

          {isProspect && card.prospects && (
            <Card>
              <CardHeader><CardTitle>Prospect org</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Detail label="Organization" value={card.prospects.name} />
                <Detail label="Type" value={card.prospects.org_type} />
                {card.prospects.source_url && (
                  <a
                    href={card.prospects.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-primary hover:underline"
                  >
                    Source ↗
                  </a>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Opportunity</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Detail label="Funder" value={card.grants?.funder} />
              <Detail label="Deadline" value={card.grants?.submission_deadline} />
              <Detail
                label="Award range"
                value={
                  card.grants?.award_range_min || card.grants?.award_range_max
                    ? `${card.grants?.award_range_min || "?"} – ${card.grants?.award_range_max || "?"}${card.grants?.award_range_is_estimate ? " (estimate)" : ""}`
                    : undefined
                }
              />
              {card.grants?.id && (
                <Link href={`/grants/${card.grants.id}`} className="block text-primary hover:underline">
                  Open shred →
                </Link>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{value}</p>
    </div>
  );
}

// Quiet context chips -- smaller and less saturated than the grant-title headline.
function Pill({ children, tone = "navy" }: { children: React.ReactNode; tone?: "navy" | "orange" }) {
  const cls =
    tone === "orange"
      ? "bg-brand-orange/[0.08] text-brand-orange"
      : "bg-brand-navy/[0.05] text-brand-navy/80";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

// Small uppercase label; the content below is the primary text, the label recedes.
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground">{children}</p>
  );
}

// Iconless funding stat: muted label on top, serif value below on a single line.
// Consistent height across the row.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-brand-navy/10 bg-white px-4 py-3">
      <FieldLabel>{label}</FieldLabel>
      <p
        className="mt-1 truncate font-serif text-xl font-medium leading-6 text-brand-navy"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

// Inline accordion row (native <details>: no JS, server-component-safe). Collapsed
// by default; click the summary to expand in place. Holds dense content verbatim.
function DepthRow({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-brand-navy [&::-webkit-details-marker]:hidden">
        <span>
          {title}
          {typeof count === "number" ? ` (${count})` : ""}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4 text-sm">{children}</div>
    </details>
  );
}
