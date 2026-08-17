"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Building2, Check, ChevronRight, Loader2, Lock, Sparkles, Users, X } from "lucide-react";
import { ComingSoonOverlay } from "@/components/ui/coming-soon-overlay";
import type { PursuitPath } from "@/types/database";

const SUPPORT = "support@grantedco.com";

// How a client acts on a grant that's in their Grant Report: choose HOW to pursue
// it (migration 0061). One chooser, mounted on both the report row (compact) and
// the grant detail (in the decision bar). Picking a path records it via
// PATCH /api/review/[id] (which also stamps decision='approved' + attribution =
// the activity staff see) and then routes: IntellEngine -> the builder, SME ->
// the booking page, in-house -> a confirmation. Re-routable. IntellEngine is
// Premium-only; base tier sees an upsell teaser (mirrors the concept-proposal
// teaser). Save-for-later / Pass stay in the decision bar, not here.

const PATH_SHORT: Record<PursuitPath, string> = {
  intellengine: "IntellEngine",
  sme: "an SME",
  in_house: "in-house",
};

function bookingHref(): string {
  return (
    process.env.NEXT_PUBLIC_BOOKING_URL ||
    `mailto:${SUPPORT}?subject=${encodeURIComponent("Meet with a subject-matter expert about a grant")}`
  );
}

export function PursuitChooser({
  cardId,
  pursuitPath,
  tier,
  variant = "detail",
  showPursuitPath = false,
  intellEngineComingSoon = false,
}: {
  cardId: string;
  pursuitPath: PursuitPath | null;
  tier: "premium" | "base";
  variant?: "row" | "detail";
  // Whether the IntellEngine path is offered as a LIVE, selectable option. Server-resolved from
  // pursuitClientAccessEnabled() and threaded through DecisionBar, because this is a "use client"
  // component and cannot read the env var itself.
  //
  // Offering a LIVE path while the screens are gated would be the worst version of the bug it is
  // closing: the click records decision='approved' with pursuit_path='intellengine' and THEN
  // navigates into a 404, leaving the card claiming a pursuit route the client was never able to
  // walk. Defaults to FALSE, so a caller that forgets the prop hides the live path.
  showPursuitPath?: boolean;
  // CLIENT soft-launch: when the live path is off, show the IntellEngine option as an INERT
  // "COMING SOON" card instead of omitting it (see intellEngineComingSoon() in lib/pursuit/access.ts).
  // The chooser is client-only (it renders only when DecisionBar has a `tier`, set on the portal),
  // so this can never reach staff. Defaults FALSE. When showPursuitPath is true this is ignored --
  // the live option wins.
  intellEngineComingSoon?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const routed = pursuitPath !== null;

  // Trigger — reflects current state; compact on the row, prominent on the detail.
  const openBtn = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };

  return (
    <>
      {variant === "row" ? (
        <button
          type="button"
          onClick={openBtn}
          className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition ${
            routed
              ? "border border-brand-navy/15 bg-brand-navy/[0.04] text-brand-navy hover:bg-brand-navy/[0.08]"
              : "bg-brand-navy text-white hover:bg-brand-navyDeep"
          }`}
        >
          {routed ? `Pursuing · ${PATH_SHORT[pursuitPath!]}` : "Decide how to pursue"}
        </button>
      ) : routed ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white">
            <Check className="h-4 w-4" strokeWidth={3} />
            Pursuing with {PATH_SHORT[pursuitPath!]}
          </span>
          <button
            type="button"
            onClick={openBtn}
            className="text-sm font-medium text-brand-navy underline-offset-2 hover:underline"
          >
            Change
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openBtn}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep"
        >
          Choose how to pursue
          <ChevronRight className="h-4 w-4" />
        </button>
      )}

      {open && (
        <ChooserPanel
          cardId={cardId}
          pursuitPath={pursuitPath}
          tier={tier}
          showPursuitPath={showPursuitPath}
          intellEngineComingSoon={intellEngineComingSoon}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ChooserPanel({
  cardId,
  pursuitPath,
  tier,
  showPursuitPath,
  intellEngineComingSoon,
  onClose,
}: {
  cardId: string;
  pursuitPath: PursuitPath | null;
  tier: "premium" | "base";
  showPursuitPath: boolean;
  intellEngineComingSoon: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState<PursuitPath | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTeaser, setShowTeaser] = useState(false);
  const [confirmedInHouse, setConfirmedInHouse] = useState(false);

  const close = useCallback(() => {
    setShown(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    setShown(true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  // Record a path (or clear it). Returns true on success.
  const record = useCallback(
    async (path: PursuitPath | null): Promise<boolean> => {
      setBusy(path ?? "clear");
      setError(null);
      try {
        const res = await fetch(`/api/review/${cardId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pursuit_path: path }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Couldn't save that");
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save that");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [cardId],
  );

  async function chooseIntellEngine() {
    // Premium only. Base tier gets the upsell teaser instead of a live route.
    if (tier === "base") {
      setShowTeaser((v) => !v);
      return;
    }
    if (await record("intellengine")) {
      // Create (or resume) this grant's IntellEngine draft, then open it -- so the
      // client lands on the grant-aware proposal page, not the generic hub. Falls
      // back to the hub if the draft call hiccups (the path is already recorded).
      try {
        const res = await fetch("/api/intellengine/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card_id: cardId }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.draft?.id) {
          router.push(`/intellengine/${data.draft.id}`);
          return;
        }
      } catch {
        // fall through to the hub
      }
      router.push("/intellengine");
    }
  }

  async function chooseSme() {
    if (await record("sme")) {
      window.open(bookingHref(), "_blank", "noopener,noreferrer");
      router.refresh();
      close();
    }
  }

  async function chooseInHouse() {
    if (await record("in_house")) {
      setConfirmedInHouse(true);
      router.refresh();
    }
  }

  async function clearChoice() {
    if (await record(null)) {
      router.refresh();
      close();
    }
  }

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
          <h2 className="font-serif text-lg font-semibold text-brand-navy">How do you want to pursue this?</h2>
          <button onClick={close} aria-label="Close" className="text-muted-foreground hover:text-brand-navy">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {confirmedInHouse ? (
            <div className="rounded-2xl border border-brand-navy/[0.08] bg-brand-cream/50 p-5 text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-navy/[0.06]">
                <Check className="h-5 w-5 text-brand-orange" strokeWidth={3} />
              </div>
              <p className="mt-3 text-sm font-semibold text-brand-navy">Tracked as an in-house pursuit</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                Your GRANTED team can see you&apos;re running this one yourselves — reach out at{" "}
                <a href={`mailto:${SUPPORT}`} className="font-medium text-brand-orange hover:underline">
                  {SUPPORT}
                </a>{" "}
                any time you want a hand.
              </p>
              <button
                onClick={close}
                className="mt-4 rounded-full bg-brand-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-navyDeep"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              {showPursuitPath ? (
                <>
                  <OptionCard
                    icon={<Sparkles className="h-5 w-5" />}
                    title="Write with IntellEngine"
                    sub="Draft the proposal with GRANTED's AI, starting from your concept proposal."
                    onClick={chooseIntellEngine}
                    busy={busy === "intellengine"}
                    active={pursuitPath === "intellengine"}
                    premiumLock={tier === "base"}
                  />
                  {tier === "base" && showTeaser && <IntellEngineTeaser />}
                </>
              ) : intellEngineComingSoon ? (
                <ComingSoonOption />
              ) : null}

              <OptionCard
                icon={<Users className="h-5 w-5" />}
                title="Work with a subject-matter expert"
                sub="Book time with a GRANTED advisor to scope and write it together."
                onClick={chooseSme}
                busy={busy === "sme"}
                active={pursuitPath === "sme"}
              />

              <OptionCard
                icon={<Building2 className="h-5 w-5" />}
                title="Pursue in-house"
                sub="Run it with your own team. We'll track it and stay on call."
                onClick={chooseInHouse}
                busy={busy === "in_house"}
                active={pursuitPath === "in_house"}
              />

              {pursuitPath !== null && (
                <button
                  onClick={clearChoice}
                  disabled={busy !== null}
                  className="mt-1 text-[13px] font-medium text-muted-foreground underline-offset-2 hover:text-brand-navy hover:underline disabled:opacity-50"
                >
                  {busy === "clear" ? "Removing…" : "Remove this choice (back to undecided)"}
                </button>
              )}
            </>
          )}

          {error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function OptionCard({
  icon,
  title,
  sub,
  onClick,
  busy,
  active,
  premiumLock,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
  busy: boolean;
  active: boolean;
  premiumLock?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`flex w-full items-start gap-3.5 rounded-2xl border p-4 text-left transition disabled:opacity-60 ${
        active
          ? "border-brand-navy/40 bg-brand-navy/[0.04]"
          : "border-brand-navy/[0.1] hover:border-brand-navy/30 hover:bg-brand-navy/[0.02]"
      }`}
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-navy/[0.06] text-brand-navy">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-brand-navy">{title}</span>
          {active && (
            <span className="rounded-full bg-brand-navy/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-navy">
              Current
            </span>
          )}
          {premiumLock && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-orange/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-orange">
              <Lock className="h-2.5 w-2.5" />
              Premium
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">{sub}</span>
      </span>
    </button>
  );
}

// CLIENT soft-launch: the IntellEngine path shown as an INERT card with a diagonal "COMING SOON"
// watermark, in place of the live selectable option. A <div>, not a <button> -- there is nothing to
// click, so a client cannot record pursuit_path='intellengine' into the 404 the route would give
// them (the API refuses it too, pursuitApiDenied). The muted "Coming soon" line carries the state to
// assistive tech; the rotated overlay is decorative. Mirrors OptionCard's frame so it reads as the
// same third option, not open yet.
function ComingSoonOption() {
  return (
    <div className="relative flex w-full items-start gap-3.5 overflow-hidden rounded-2xl border border-brand-navy/[0.1] bg-white p-4 text-left opacity-90">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-navy/[0.06] text-brand-navy">
        <Sparkles className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-sm font-semibold text-brand-navy">Write with IntellEngine</span>
        <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
          Draft the proposal with GRANTED&apos;s AI. Coming soon — we&apos;ll let you know the moment it&apos;s ready.
        </span>
      </span>
      <ComingSoonOverlay tone="onLight" />
    </div>
  );
}

// Base-tier upsell for IntellEngine — same posture as the concept-proposal teaser:
// an illustrative (blurred) preview + a contact route. Pure UI, records nothing.
function IntellEngineTeaser() {
  const subject = encodeURIComponent("IntellEngine — upgrade to Premium");
  return (
    <div className="rounded-2xl border border-brand-orange/25 bg-brand-orange/[0.03] p-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        IntellEngine drafts your proposal with you — pulling in your concept proposal, mapping the NOFO&apos;s
        requirements, and building out each section. It&apos;s included with Premium.
      </p>
      <div className="relative mt-3 overflow-hidden rounded-xl border border-brand-navy/[0.08] bg-white p-4">
        <div className="pointer-events-none select-none space-y-2 blur-[3px]" aria-hidden>
          <div className="h-3 w-1/3 rounded bg-brand-navy/20" />
          <div className="h-2.5 w-full rounded bg-brand-navy/10" />
          <div className="h-2.5 w-11/12 rounded bg-brand-navy/10" />
          <div className="h-2.5 w-4/5 rounded bg-brand-navy/10" />
          <div className="mt-3 h-3 w-1/4 rounded bg-brand-navy/20" />
          <div className="h-2.5 w-full rounded bg-brand-navy/10" />
          <div className="h-2.5 w-3/4 rounded bg-brand-navy/10" />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-brand-navy/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white shadow-soft">
            Illustrative sample
          </span>
        </div>
      </div>
      <a
        href={`mailto:${SUPPORT}?subject=${subject}`}
        className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-navyDeep"
      >
        <Sparkles className="h-4 w-4" />
        Contact us about IntellEngine
      </a>
    </div>
  );
}
