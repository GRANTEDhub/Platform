"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SectionTitle } from "./primitives";

const SUPPORT = "support@grantedco.com";

// Base-tier entry point for the concept proposal (client portal). Concept
// proposals are a Premium deliverable, so this is PURE UI: it never generates
// anything, spends no tokens, and stores nothing -- it just routes an interested
// base client to an upgrade conversation with their GRANTED team.
export function ConceptProposalUpsell({ clientName }: { clientName: string }) {
  const [requested, setRequested] = useState(false);

  return (
    <Card elevation="card" className="p-6 sm:p-7">
      <SectionTitle>Concept proposal</SectionTitle>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        A concept proposal is a practical snapshot of how your organization would pursue this grant — suggested
        role, partners, project scope, and budget — so you can see the shape of an application before committing to
        it. It&apos;s included with Premium.
      </p>

      {requested ? (
        <div className="mt-4 rounded-xl bg-brand-navy/[0.04] p-4 text-sm text-brand-navy">
          Your GRANTED team will follow up about adding concept proposals to your plan. You can also reach them at{" "}
          <a href={`mailto:${SUPPORT}?subject=${encodeURIComponent("Concept proposals — upgrade to Premium")}`} className="font-medium text-brand-orange hover:underline">
            {SUPPORT}
          </a>
          .
        </div>
      ) : (
        <a
          href={`mailto:${SUPPORT}?subject=${encodeURIComponent(`Concept proposals — upgrade to Premium (${clientName})`)}`}
          onClick={() => setRequested(true)}
          className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-navyDeep"
        >
          <Sparkles className="h-4 w-4" />
          Request a concept proposal
        </a>
      )}
    </Card>
  );
}
