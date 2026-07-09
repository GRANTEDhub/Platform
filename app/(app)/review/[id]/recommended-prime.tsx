"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/ui/stat";

// Recommended-prime cell on the Match tab. Plain <Stat> presentation (ae075b8),
// made clickable to open a detail overlay -- reusing AlertSend's modal pattern
// (fixed backdrop + card panel, click-outside to close; NOT a new mechanism).
//
// The stat value is capped word-safe at <=50 chars so it never exceeds ~2 rows;
// the null case (engine nulls recommended_prime for ineligible partners, see
// lib/grants/constraints.ts) shows the KNP-operator fallback as the value. The
// overlay shows the UNtruncated prime plus the real role fields we hold on the
// card -- proposed_role, role_assignment_logic, consortium_rationale -- omitting
// any that are empty. Real data only; no invented fields.
const FALLBACK_PRIME = "or a qualified nonprofit KNP operator";

function capChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  const base = sp > Math.floor(max * 0.6) ? cut.slice(0, sp) : cut;
  return base.replace(/[\s.,;:–—-]+$/, "") + "…";
}

export function RecommendedPrime({
  prime,
  proposedRole,
  roleAssignmentLogic,
  consortiumRationale,
  tone = "onLight",
}: {
  prime: string | null;
  proposedRole: string | null;
  roleAssignmentLogic?: string;
  consortiumRationale?: string;
  // "onLight" = the Match-tab body stat (wide card). "onHero" = the narrow banner
  // tile on the Match tab: same click-to-expand overlay, but the value clips to one
  // line (the overlay carries the full name + fields).
  tone?: "onLight" | "onHero";
}) {
  const [open, setOpen] = useState(false);

  const name = (prime ?? "").trim();
  const display = name ? capChars(name, 50) : FALLBACK_PRIME;

  // Secondary detail rows: real fields only, empties dropped.
  const details: { label: string; value: string }[] = [];
  const pr = (proposedRole ?? "").trim();
  if (pr) details.push({ label: "Proposed role", value: pr });
  const ral = (roleAssignmentLogic ?? "").trim();
  if (ral) details.push({ label: "Why this role", value: ral });
  const cr = (consortiumRationale ?? "").trim();
  if (cr) details.push({ label: "Consortium rationale", value: cr });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="View prime detail"
        className={`group w-full text-left transition hover:ring-2 hover:ring-brand-orange/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${
          tone === "onHero" ? "rounded-2xl" : "rounded-3xl"
        }`}
      >
        <Stat tone={tone} truncateValue label="Recommended prime" value={display} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <h2 className="font-serif text-lg font-semibold text-brand-navy">Recommended prime</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-sm text-muted-foreground transition hover:text-brand-navy"
              >
                ✕
              </button>
            </div>

            {/* Untruncated prime name (or the KNP fallback) leads. */}
            <p className="mt-2 whitespace-pre-wrap font-serif text-xl font-semibold leading-snug text-brand-navy">
              {name || FALLBACK_PRIME}
            </p>

            {details.length > 0 && (
              <div className="mt-4 space-y-4 border-t border-brand-navy/10 pt-4">
                {details.map((d, i) => (
                  <div key={i}>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{d.label}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{d.value}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5 flex justify-end">
              <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
