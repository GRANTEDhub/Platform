"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, FileText, Sparkles, X } from "lucide-react";
import { ConceptProposalView } from "./concept-proposal-view";
import type { ConceptReveal } from "@/lib/report/shape";
import type { ConceptProposal } from "@/types/database";

const SUPPORT = "support@grantedco.com";

// The client-facing "concept proposal" affordance for the list surfaces (Grant
// Alerts swipe card + Grant Report row). One button, tier-aware:
//   - Premium + ready  -> opens the real proposal, read-only (reuses ConceptProposalView).
//   - Premium, not ready / absent -> renders nothing (matches the release-gated flow).
//   - Base tier -> opens an upsell teaser: what a concept proposal is, an
//     illustrative (fake) sample, and a contact button. MVP -- polish later.
// The slide-over is read-only; editing stays with GRANTED (staff panel / IntellEngine).

// Deliberately generic, fictional content so the base-tier preview reads as "here
// is the SHAPE of the deliverable," never as a real scoped proposal (a Premium
// deliverable). Blurred + watermarked in the teaser besides.
const SAMPLE_PROPOSAL: ConceptProposal = {
  role: "prime",
  scope:
    "A two-year initiative to expand access to workforce training in the region — pairing your core programming with partner-delivered wraparound services, measured against the funder's stated outcome priorities. (This is an illustrative example, not scoped to your organization.)",
  total_project_amount: "$750,000 (est.)",
  estimated_match: "$150,000 (est.)",
  project_term: "2 years",
  hook: null,
  partners: [
    {
      name: null,
      org_type_label: "Regional workforce board",
      role: "Recruitment & job placement",
      description: "Connects program graduates to employer partners and tracks placement outcomes.",
      source: "suggested",
    },
    {
      name: null,
      org_type_label: "Community college",
      role: "Curriculum & credentialing",
      description: "Delivers the accredited coursework and issues the industry-recognized credential.",
      source: "suggested",
    },
  ],
};

export function ConceptProposalReveal({
  concept,
  clientName,
  variant = "row",
}: {
  concept: ConceptReveal | null | undefined;
  clientName?: string;
  // "alert" is the client Grant Alert card's CTA row (icon tile + two-line label + arrow),
  // reusing this component's slide-over and tier logic rather than a bespoke trigger.
  variant?: "row" | "card" | "alert";
}) {
  const [open, setOpen] = useState(false);

  if (!concept) return null;
  const isBase = concept.tier === "base";
  const premiumReady = concept.tier === "premium" && concept.status === "ready" && !!concept.proposal;
  if (!isBase && !premiumReady) return null; // premium-but-not-ready: hide entirely

  const label = isBase ? "See a concept proposal" : "View concept proposal";
  // On the report row this button sits over a stretched navigation link; stop the click
  // from also triggering the row's View navigation.
  const openClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };

  const trigger =
    variant === "alert" ? (
      <button
        type="button"
        onClick={openClick}
        className="flex w-full items-center justify-between gap-[14px] rounded-[4px] border border-brand-orange/30 bg-brand-orange/[0.07] px-4 py-[11px] text-left transition hover:bg-brand-orange/[0.12]"
      >
        <span className="flex min-w-0 items-center gap-[10px]">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-brand-orangeFill">
            <FileText className="h-3.5 w-3.5 text-white" />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-brand-navy">{label}</span>
            <span className="mt-px block text-[11px] text-ink-subtle">
              {isBase ? "See how we'd scope a run at this" : "Two pages on how we'd scope this"}
            </span>
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-brand-orangeDeep" />
      </button>
    ) : (
      <button type="button" onClick={openClick} className={triggerClass(variant, isBase)}>
        {isBase ? <Sparkles className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
        {label}
      </button>
    );

  return (
    <>
      {trigger}

      {open && (
        <SlideOver onClose={() => setOpen(false)}>
          {isBase ? (
            <BaseTeaser clientName={clientName} />
          ) : (
            <div className="space-y-4">
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                How your GRANTED team scoped a run at this grant — a starting point to react to, not a final
                application.
              </p>
              <ConceptProposalView proposal={concept.proposal!} showSourceTags={false} />
            </div>
          )}
        </SlideOver>
      )}
    </>
  );
}

function triggerClass(variant: "row" | "card", isBase: boolean): string {
  const base =
    "inline-flex items-center gap-1.5 rounded-full font-semibold transition disabled:opacity-50";
  const tone = isBase
    ? "border border-brand-orange/40 text-brand-orange hover:bg-brand-orange/5"
    : "border border-brand-navy/20 text-brand-navy hover:border-brand-navy/35 hover:bg-brand-navy/[0.04]";
  const size = variant === "card" ? "w-full justify-center px-4 py-2.5 text-sm" : "px-4 py-1.5 text-xs";
  return `${base} ${tone} ${size}`;
}

function BaseTeaser({ clientName }: { clientName?: string }) {
  const subject = encodeURIComponent(
    clientName ? `Concept proposals — upgrade to Premium (${clientName})` : "Concept proposals — upgrade to Premium",
  );
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        A concept proposal is a practical snapshot of how your organization would pursue this grant — suggested role,
        partners, project scope, and budget — so you can see the shape of an application before committing to it.
        It&apos;s included with Premium.
      </p>

      {/* Illustrative-only preview: blurred + watermarked so it reads as a teaser. */}
      <div className="relative overflow-hidden rounded-2xl border border-brand-navy/[0.08] bg-brand-cream/40 p-5">
        <div className="pointer-events-none select-none blur-[2.5px]" aria-hidden>
          <ConceptProposalView proposal={SAMPLE_PROPOSAL} showSourceTags={false} />
        </div>
        <div className="absolute inset-0 flex items-center justify-center bg-white/10">
          <span className="rounded-full bg-brand-navy/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white shadow-soft">
            Illustrative sample
          </span>
        </div>
      </div>

      <a
        href={`mailto:${SUPPORT}?subject=${subject}`}
        className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-navyDeep"
      >
        <Sparkles className="h-4 w-4" />
        Contact us about a concept proposal
      </a>
    </div>
  );
}

// Read-only right-side slide-over. Mirrors the editor's portal-to-body pattern so
// the fixed overlay anchors to the viewport, not the transformed HubShell ancestor.
function SlideOver({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);

  const close = useCallback(() => {
    setShown(false);
    setTimeout(onClose, 200); // let the slide-out play
  }, [onClose]);

  useEffect(() => {
    setShown(true); // trigger the slide-in after mount
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-brand-navy/30 transition-opacity ${shown ? "opacity-100" : "opacity-0"}`}
        onClick={close}
      />
      <div
        className={`absolute right-0 top-0 flex h-full w-full max-w-lg flex-col bg-white shadow-2xl transition-transform duration-200 ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-brand-navy/[0.08] px-6 py-4">
          <h2 className="font-serif text-lg font-semibold text-brand-navy">Concept proposal</h2>
          <button onClick={close} aria-label="Close" className="text-muted-foreground hover:text-brand-navy">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
