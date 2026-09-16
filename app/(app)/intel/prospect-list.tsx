"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import { Badge } from "@/components/ui/badge";
import { ProspectAlertButton } from "./prospect-alert-button";
import type { CardDecision } from "@/types/database";
import type { CredibilitySnapshot, CredibilityTier } from "@/lib/prospects/credibility";

// The discovered-prospects list for the /intel/[id] IntellEngine output column — expand-in-place.
//
// Replaces the old rail <ul> whose org name LINKED to /review/[id] (the antiquated second-page match
// view). Clicking a name now EXPANDS the row inline to show the engine's already-stored "why this
// grant matched this org" rationale (why_this_org + concept_synopsis) plus the deterministic
// credibility snapshot — no navigation, no new model call, no new query (the page already selects
// these columns). The per-row "Alert" action is the UNCHANGED ProspectAlertButton (AlertSend autoOpen
// modal), reused as-is.
//
// HONEST-THIN by design: a prospect is scored off a bare-bones shape (no client profile / mission), so
// this rationale is grounded but capability-grade, and the credibility pill carries the "not verified"
// caveat for emerging/web-surfaced orgs. There are deliberately NO factor-score bars — a prospect card
// has null factor_scores, so the client match card's bar graphic would render empty here.

export interface ProspectRow {
  cardId: string;
  name: string;
  orgType: string | null;
  fitScore: 1 | 2 | 3 | null;
  decision: CardDecision;
  sentAt: string | null;
  sentTo: string | null;
  alerted: boolean;
  whyThisOrg: string[] | null;
  conceptSynopsis: string | null;
  credibility: CredibilitySnapshot;
  // Overdue-gate inputs for the Alert action (grant-level).
  daysLeft: number | null;
  deadlineLabel: string | null;
  backHref: string;
}

// The credibility tier carries a redundant WORD (label) as well as hue, so this stays inside the
// colour-blind rule — the pill text ("Proven"/"Emerging"/"Web-surfaced") is the signal, the variant
// just reinforces it.
const CRED_VARIANT: Record<CredibilityTier, "success" | "secondary" | "warning"> = {
  proven: "success",
  emerging: "secondary",
  surfaced: "warning",
};

export function ProspectList({ prospects }: { prospects: ProspectRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <ul className="divide-y divide-brand-navy/[0.08]">
      {prospects.map((p) => {
        const open = openId === p.cardId;
        const orgLabel = p.orgType ? p.orgType.replace(/_/g, " ") : null;
        return (
          <li key={p.cardId} className="py-2.5">
            <div className="flex items-start justify-between gap-3">
              {/* Name is the expand toggle (a button), a SIBLING of the action controls — not their
                  parent (a button inside a button is invalid HTML). */}
              <button
                type="button"
                onClick={() => setOpenId(open ? null : p.cardId)}
                aria-expanded={open}
                className="group flex min-w-0 flex-1 items-start gap-2 rounded-sharp text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
              >
                <ChevronDown
                  className={`mt-0.5 h-4 w-4 shrink-0 text-ink-subtle transition-transform ${open ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-brand-navy group-hover:underline">
                    {p.name}
                  </span>
                  {orgLabel && (
                    <span className="block truncate text-[11px] capitalize text-ink-subtle">{orgLabel}</span>
                  )}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                <ScoreBadge score={(p.fitScore ?? 2) as 1 | 2 | 3} />
                {p.alerted ? (
                  <Badge variant="success">✓ Alerted</Badge>
                ) : (
                  <>
                    <DecisionBadge decision={p.decision} />
                    <ProspectAlertButton
                      cardId={p.cardId}
                      sentAt={p.sentAt}
                      sentTo={p.sentTo}
                      contactName={p.name}
                      daysLeft={p.daysLeft}
                      deadlineLabel={p.deadlineLabel}
                      backHref={p.backHref}
                    />
                  </>
                )}
              </div>
            </div>

            {open && (
              <div className="mt-2.5 space-y-3 pl-6 pr-1">
                {/* Who is this org — the deterministic, read-time credibility snapshot. */}
                <div>
                  <Badge variant={CRED_VARIANT[p.credibility.tier]}>{p.credibility.label}</Badge>
                  <p className="mt-1.5 text-[12px] leading-[1.55] text-ink-muted">{p.credibility.blurb}</p>
                  {p.credibility.detail && (
                    <p className="mt-1 text-[12px] leading-[1.55] text-ink-subtle [text-wrap:pretty]">
                      {p.credibility.detail}
                    </p>
                  )}
                </div>

                {/* Why this grant matched this org — the engine's stored rationale (grounded but thin). */}
                {p.whyThisOrg && p.whyThisOrg.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.09em] text-brand-navy">Why it matched</p>
                    <ul className="mt-1 space-y-1">
                      {p.whyThisOrg.map((w, i) => (
                        <li key={i} className="flex gap-1.5 text-[12px] leading-[1.55] text-ink-muted">
                          <span aria-hidden="true" className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-brand-navy/50" />
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Concept scope — what a pursuit would look like (2-3 sentences). */}
                {p.conceptSynopsis && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.09em] text-brand-navy">Concept</p>
                    <p className="mt-1 text-[12px] leading-[1.55] text-ink-muted [text-wrap:pretty]">
                      {p.conceptSynopsis}
                    </p>
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
