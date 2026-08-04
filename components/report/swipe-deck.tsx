"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion, useDragControls } from "motion/react";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { ScoreRing, Tag } from "./primitives";
import { ConceptProposalReveal } from "./concept-proposal-reveal";
import type { ReportItem } from "@/lib/report/shape";

// Grant Alerts (browse) for the client's brand-new, not-yet-triaged matches — the gate
// ahead of the Grant Report (migration 0057). BROWSE model (#21b): left/right — via the
// arrows, the keyboard, or a drag/swipe — NAVIGATE between alerts one at a time WITHOUT
// deciding, so a client can flip through and come back later. A decision is ONLY ever an
// explicit button: Interested (sets interested_at, promotes to the Grant Report — does
// NOT touch decision) or Pass (decision='passed'). One card on screen at a time; the
// page itself never scrolls (the card body does). Writes go through PATCH
// /api/review/[id], actor-tracked, no email.
//
// Account-managed clients (0059) only see a card here once staff releases it
// (sme_released_at). interestMode="sme" is staff's own separate first pass (0059):
// right = sme_interested_at instead of the client's interested_at; Pass is identical.

const THRESHOLD = 90;
const ROAD_BG = "/login-bg.jpg";

export function SwipeDeck({
  items,
  detailBasePath,
  backHref,
  interestMode = "client",
  clientName,
  startCardId,
}: {
  items: ReportItem[];
  detailBasePath: string; // detail = `${detailBasePath}/${id}`
  backHref: string;
  // Client org name — only threaded on the client portal, for the concept-proposal
  // reveal / base-tier upsell mailto. Absent on staff surfaces (no reveal there).
  clientName?: string;
  // "client" (default): right sets interested_at (the client's own gate, 0057). "sme":
  // right sets sme_interested_at instead — staff's OWN separate first pass for an
  // account-managed client (0059). Pass is identical either way (decision='passed').
  interestMode?: "client" | "sme";
  // Open on this card instead of the first one. Set from ?card= so the alert email lands
  // on the grant it was written about rather than on whatever happens to be at the front
  // of the queue. Unknown / already-decided id falls back to 0 -- a stale link from an old
  // email should still open the deck, not an error.
  startCardId?: string;
}) {
  const [queue, setQueue] = useState(items);
  const [index, setIndex] = useState(() => {
    if (!startCardId) return 0;
    const at = items.findIndex((i) => i.id === startCardId);
    return at >= 0 ? at : 0;
  });
  const decided = items.length - queue.length;
  const total = queue.length;
  const current = queue[index];

  const persist = useCallback(
    async (id: string, action: "interested" | "passed", reason?: string) => {
      try {
        const body =
          action === "passed"
            ? { decision: "passed", decision_reason: reason?.trim() || undefined }
            : interestMode === "sme"
              ? { sme_interested: true }
              : { interested: true };
        await fetch(`/api/review/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        // Optimistic: a failed write resurfaces the card on refresh rather than blocking.
      }
    },
    [interestMode],
  );

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => Math.min(Math.max(i + delta, 0), Math.max(0, total - 1)));
    },
    [total],
  );

  // Decide on the current card: persist, drop it from the queue, and stay at the same
  // position so the next card slides into view (clamped when we removed the last one).
  const decide = useCallback(
    (action: "interested" | "passed", reason?: string) => {
      if (!current) return;
      const id = current.id;
      persist(id, action, reason);
      setQueue((q) => q.filter((it) => it.id !== id));
      setIndex((i) => Math.max(0, Math.min(i, total - 2)));
    },
    [current, persist, total],
  );

  // Keyboard browse — ← / → move between alerts (never decide).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  if (!current) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        {interestMode === "sme" && (
          <div className="mb-6 rounded-xl bg-brand-navy px-4 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-white">
            Account manager review — the client does not see this pass
          </div>
        )}
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-navy/[0.06]">
          <Check className="h-7 w-7 text-brand-orange" strokeWidth={3} />
        </div>
        <h2 className="mt-5 font-serif text-2xl font-semibold text-brand-navy">All caught up</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {decided > 0
            ? `You reviewed ${decided} ${decided === 1 ? "grant" : "grants"}.`
            : "Nothing new to review right now."}
        </p>
        <Link
          href={backHref}
          className="mt-6 inline-block rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white"
        >
          Back to Grant Report
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      {interestMode === "sme" && (
        <div className="mb-4 rounded-xl bg-brand-navy px-4 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-white">
          Account manager review — the client does not see this pass
        </div>
      )}
      <div className="mb-5 flex items-center justify-between gap-3">
        <Link href={backHref} className="text-sm font-medium text-muted-foreground hover:text-brand-navy">
          ← Grant Report
        </Link>
        {/* BROWSE LIVES HERE, beside the counter it moves, at every width.
            It used to be a pair of arrows absolutely positioned OUTSIDE the card
            (-left-4 / -right-4) behind a `hidden sm:flex`, which meant: it did not exist at
            all on a phone, it hung in the page margin where it was easy to miss on a
            laptop, and with a single alert it rendered disabled at 30% opacity -- which
            reads as "not unlocked yet" rather than "nowhere to go". Now the control appears
            only when there IS somewhere to go, and it sits next to the "N of M" it drives.
            The keyboard handler above still works for anyone who finds it; nothing in the
            copy advertises it, because it silently does nothing on a one-card deck and that
            is what made it look broken. */}
        <div className="flex items-center gap-2">
          {total > 1 && <BrowseButton side="left" disabled={index === 0} onClick={() => go(-1)} />}
          <span className="text-sm tabular-nums text-muted-foreground">
            {index + 1} of {total}
          </span>
          {total > 1 && <BrowseButton side="right" disabled={index >= total - 1} onClick={() => go(1)} />}
        </div>
      </div>

      <div className="relative">
        <BrowseCard
          key={current.id}
          item={current}
          detailBasePath={detailBasePath}
          onArchive={(reason) => decide("passed", reason)}
          onInterested={() => decide("interested")}
          onNavigate={go}
          clientName={clientName}
        />
      </div>

      <p className="mt-3 text-center text-[11px] text-muted-foreground">
        {total > 1
          ? "Use the arrows or swipe to browse — Pass or Interested to decide"
          : "Pass or Interested to decide"}
      </p>
    </div>
  );
}

// Rendered only when the deck holds more than one alert, so it is never a control that
// looks pressable and isn't. Still disabled at the two ends of the deck -- there IS
// browsing to do, just not in that direction.
function BrowseButton({ side, disabled, onClick }: { side: "left" | "right"; disabled: boolean; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "left" ? "Previous alert" : "Next alert"}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-brand-navy/15 bg-white shadow-soft transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 ${
        disabled ? "cursor-not-allowed opacity-30" : "hover:border-brand-navy/35 hover:bg-brand-cream/60"
      }`}
    >
      <Icon className="h-4 w-4 text-brand-navy" />
    </button>
  );
}

// A single browsable alert card. Drag is horizontal-only and initiated from the banner
// (a drag handle), so reading/scrolling the body never fights the gesture; a drag past
// the threshold navigates (prev/next), it never decides. Keyed by item id in the parent
// so each navigation plays the entrance animation.
function BrowseCard({
  item,
  detailBasePath,
  onArchive,
  onInterested,
  onNavigate,
  clientName,
}: {
  item: ReportItem;
  detailBasePath: string;
  onArchive: (reason?: string) => void;
  onInterested: () => void;
  onNavigate: (delta: number) => void;
  clientName?: string;
}) {
  const dragControls = useDragControls();
  return (
    <motion.div
      drag="x"
      dragListener={false}
      dragControls={dragControls}
      dragElastic={0.5}
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={(_, info) => {
        if (info.offset.x < -THRESHOLD) onNavigate(1);
        else if (info.offset.x > THRESHOLD) onNavigate(-1);
      }}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
    >
      <CardFace
        item={item}
        onArchive={onArchive}
        onInterested={onInterested}
        onHandlePointerDown={(e) => dragControls.start(e)}
        detailHref={`${detailBasePath}/${item.id}?from=alerts`}
        clientName={clientName}
      />
    </motion.div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[13.5px] font-semibold text-brand-navy">{value}</p>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-brand-orange">{label}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

function CardFace({
  item,
  onArchive,
  onInterested,
  onHandlePointerDown,
  detailHref,
  clientName,
}: {
  item: ReportItem;
  onArchive: (reason?: string) => void;
  onInterested: () => void;
  onHandlePointerDown: (e: React.PointerEvent) => void;
  detailHref: string;
  clientName?: string;
}) {
  // Pass opens an OPTIONAL reason step; the reason (when given) is routed to the
  // match_feedback calibration store server-side (replaced the old agree/flag box).
  const [passing, setPassing] = useState(false);
  const [passReason, setPassReason] = useState("");
  return (
    <div className="flex h-[640px] flex-col overflow-hidden rounded-3xl border border-brand-navy/[0.06] bg-white shadow-overlay">
      {/* road-photo banner — doubles as the horizontal drag handle for browsing */}
      <div
        className="relative h-32 shrink-0 cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onHandlePointerDown}
      >
        <div
          className="absolute inset-0"
          style={{ backgroundImage: `url('${ROAD_BG}')`, backgroundSize: "cover", backgroundPosition: "center" }}
        />
        <div className="absolute inset-0 bg-brand-navy/40" />
        <div className="absolute -bottom-8 right-6">
          <div className="rounded-full bg-white p-1.5 shadow-soft">
            <ScoreRing fitScore={item.fitScore} band={item.band} size="lg" />
          </div>
        </div>
      </div>

      {/* scrollable body */}
      <div className="flex-1 overflow-y-auto px-6 pb-5 pt-5">
        <div className="pr-24">
          <h3 className="font-serif text-[21px] font-semibold leading-tight text-brand-navy">{item.title}</h3>
          {item.funder && <p className="mt-1 text-sm text-muted-foreground">{item.funder}</p>}
        </div>

        {item.focusAreas.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {item.focusAreas.map((f, i) => (
              <Tag key={i}>{f}</Tag>
            ))}
          </div>
        )}

        {/* Concept proposal, right out the gate — read-only for premium, upsell teaser
            for base. */}
        {item.concept && (
          <div className="mt-4">
            <ConceptProposalReveal concept={item.concept} clientName={clientName} variant="card" />
          </div>
        )}

        {/* stat grid */}
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl bg-brand-cream/70 p-4">
          <StatCell label="Total available" value={item.totalAvailable || "—"} />
          <StatCell label={`Award range${item.awardIsEstimate ? " · est." : ""}`} value={item.awardRange} />
          <StatCell label="Match required" value={item.matchRequired} />
          <StatCell label="Your role" value={item.role || "—"} />
        </div>

        <div className="mt-4 space-y-3.5">
          {item.purpose && <Section label="Purpose &amp; use">{item.purpose}</Section>}
          {item.programIdea && <Section label="Program design idea">{item.programIdea}</Section>}
          {item.eligibleTypes.length > 0 && <Section label="Eligibility">{item.eligibleTypes.join(", ")}</Section>}
          {item.geography && <Section label="Geography">{item.geography}</Section>}
        </div>

        <Link
          href={detailHref}
          className="mt-4 inline-flex w-fit items-center gap-1 text-sm font-medium text-brand-orange hover:underline"
        >
          See the full breakdown <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* decision controls — the ONLY way to decide; browsing never decides */}
      <div className="shrink-0 border-t border-brand-navy/[0.06] px-6 py-4">
        {passing ? (
          <div className="space-y-2.5">
            <p className="text-center text-[13px] font-medium text-brand-navy">Why pass? (optional)</p>
            <textarea
              value={passReason}
              onChange={(e) => setPassReason(e.target.value)}
              rows={2}
              autoFocus
              placeholder="e.g. wrong geography, no capacity this cycle, not a fit"
              className="w-full rounded-lg border border-input bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35"
            />
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setPassing(false)}
                className="rounded-full border border-brand-navy/20 bg-white px-5 py-2 text-sm font-medium text-muted-foreground transition hover:text-brand-navy"
              >
                Cancel
              </button>
              <button
                onClick={() => onArchive(passReason)}
                className="flex items-center gap-2 rounded-full bg-destructive px-6 py-2 text-sm font-semibold text-white shadow-soft transition hover:opacity-90"
              >
                <X className="h-4 w-4" />
                Pass on this grant
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setPassing(true)}
                className="flex items-center gap-2 rounded-full border border-brand-navy/20 bg-white px-5 py-2.5 text-sm font-semibold text-muted-foreground shadow-soft transition hover:border-brand-navy/35 hover:text-brand-navy"
              >
                <X className="h-5 w-5" />
                Pass
              </button>
              <button
                onClick={onInterested}
                className="flex items-center gap-2 rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white shadow-overlay transition hover:bg-brand-navyDeep"
              >
                Interested
                <Check className="h-5 w-5" strokeWidth={3} />
              </button>
            </div>
            <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
              Browse: arrows or swipe · Decide: Pass / Interested
            </p>
            <p className="mx-auto mt-3 max-w-md text-center text-[11px] leading-relaxed text-muted-foreground/80">
              Grant Alerts are a quick snapshot and concept proposal to gauge your interest. Marking one
              <span className="font-medium text-brand-navy"> Interested</span> simply moves it to your Grant Report —
              where you can assess the full details and make a pursuit decision or contact an expert. It&apos;s not a
              commitment.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
