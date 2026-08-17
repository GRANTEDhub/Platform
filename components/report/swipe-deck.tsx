"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useDragControls } from "motion/react";
import { ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { ScoreRing, Tag } from "./primitives";
import { ConceptProposalReveal } from "./concept-proposal-reveal";
import { AlertDecisionTransition } from "./alert-decision-transition";
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
// The navy scrim over the road photo on the client Grant Alert view (`presentation="alert"`).
// Design's "blue filter" is our brand navy #0B1E3A — darker at top and bottom so the white
// card and the top-bar / button chrome stay legible over a busy photo.
const ALERT_SCRIM = "linear-gradient(180deg,rgba(11,30,58,.82),rgba(11,30,58,.7) 55%,rgba(11,30,58,.88))";

export function SwipeDeck({
  items,
  detailBasePath,
  backHref,
  interestMode = "client",
  clientName,
  startCardId,
  requireReason = false,
  dashboardHref,
  presentation = "classic",
}: {
  items: ReportItem[];
  detailBasePath: string; // detail = `${detailBasePath}/${id}`
  backHref: string;
  // Client org name — only threaded on the client portal, for the concept-proposal
  // reveal / base-tier upsell mailto. Absent on staff surfaces (no reveal there).
  clientName?: string;
  // Require a non-empty Pass reason before the confirm button enables. Set true ONLY by the
  // CLIENT portal (/portal/triage): a client Pass is the calibration signal, and the server only
  // records the match_feedback datapoint when a reason is present, so an empty pass silently drops
  // it (mirrors the DecisionBar guard on the grant-report detail). Staff surfaces leave it false —
  // the staff-console pass-control is the deferred console half. Defaults false.
  requireReason?: boolean;
  // "client" (default): right sets interested_at (the client's own gate, 0057). "sme":
  // right sets sme_interested_at instead — staff's OWN separate first pass for an
  // account-managed client (0059). Pass is identical either way (decision='passed').
  interestMode?: "client" | "sme";
  // Open on this card instead of the first one. Set from ?card= so the alert email lands
  // on the grant it was written about rather than on whatever happens to be at the front
  // of the queue. Unknown / already-decided id falls back to 0 -- a stale link from an old
  // email should still open the deck, not an error.
  startCardId?: string;
  // CLIENT PORTAL ONLY (#12): the client's dashboard route. Its presence turns on the
  // branded rotating-logo transition after each decision — more pending → "Redirecting to
  // grant alerts" (next card), none left → "Redirecting to dashboard" (this href). Absent on
  // staff triage, which keeps the plain slide-to-next / "All caught up" behaviour.
  dashboardHref?: string;
  // "classic" (default): the scrollable white card used by staff triage AND (until the client
  // redesign) the client. "alert": the client Grant Alert redesign — a full-bleed
  // road photo + navy scrim, a centered one-glance card, and floating Pass/Interested. Only
  // /portal/triage passes "alert"; staff triage stays "classic", untouched.
  presentation?: "classic" | "alert";
}) {
  const router = useRouter();
  const [queue, setQueue] = useState(items);
  // The post-decision transition overlay (client portal). Null on staff triage and between
  // decisions; set on a decision to play the branded redirect, which its effect then drives.
  const [transition, setTransition] = useState<{ decision: "interested" | "passed"; morePending: boolean } | null>(
    null,
  );
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
  // On the client portal (dashboardHref set) the branded transition plays over the top and
  // drives where we go next — `morePending` is captured BEFORE removal, so it means "were
  // there other cards besides this one".
  const decide = useCallback(
    (action: "interested" | "passed", reason?: string) => {
      // Freeze while the transition overlay is up: it covers the deck but the underlying
      // CardFace buttons stay in the tab order, so a keyboard user could otherwise Enter a
      // second decision behind the overlay and double-persist. Mirrors the browse guard below.
      if (!current || transition) return;
      const id = current.id;
      persist(id, action, reason);
      const morePending = total > 1;
      setQueue((q) => q.filter((it) => it.id !== id));
      setIndex((i) => Math.max(0, Math.min(i, total - 2)));
      if (dashboardHref) setTransition({ decision: action, morePending });
    },
    [current, persist, total, dashboardHref, transition],
  );

  // Drive the post-decision transition (client portal). It plays over the deck — which has
  // already advanced underneath it — then either lifts to reveal the next alert, or leaves
  // for the dashboard when the deck is empty. The card is decided the instant the button is
  // pressed (persist above); this only paces the redirect.
  useEffect(() => {
    if (!transition) return;
    const t = setTimeout(() => {
      if (transition.morePending) setTransition(null);
      else if (dashboardHref) router.push(dashboardHref);
    }, 1800);
    return () => clearTimeout(t);
  }, [transition, dashboardHref, router]);

  // Keyboard browse — ← / → move between alerts (never decide). Ignored while the transition
  // overlay is up, so a stray arrow can't shift the deck underneath it before the redirect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (transition) return;
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, transition]);

  // Defined once and rendered in BOTH return branches below (a decision can empty the deck →
  // the !current branch, or leave cards → the main branch). Portal-rendered, so its position
  // in the tree has no layout effect; single definition keeps the two branches from drifting.
  const overlay = transition ? (
    <AlertDecisionTransition decision={transition.decision} morePending={transition.morePending} />
  ) : null;

  // Client Grant Alert redesign — the full-bleed immersive layout. Shares every bit of deck
  // state above (queue, browse, decide, the #12 transition); only the presentation differs.
  if (presentation === "alert") {
    return (
      <AlertDeck
        current={current}
        index={index}
        total={total}
        decided={decided}
        transitioning={!!transition}
        overlay={overlay}
        onBrowse={go}
        onDecide={decide}
        clientName={clientName}
        detailBasePath={detailBasePath}
        requireReason={requireReason}
        dashboardHref={dashboardHref}
      />
    );
  }

  if (!current) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        {/* On the client portal, a decision that emptied the deck routes to the dashboard;
            the transition overlay (portal) covers this "All caught up" state until it does. */}
        {overlay}
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
      {/* Post-decision branded transition (client portal). Portal-rendered, so it sits over
          the deck that has already advanced to the next card underneath it. */}
      {overlay}
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
          requireReason={requireReason}
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
  requireReason,
}: {
  item: ReportItem;
  detailBasePath: string;
  onArchive: (reason?: string) => void;
  onInterested: () => void;
  onNavigate: (delta: number) => void;
  clientName?: string;
  requireReason?: boolean;
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
        requireReason={requireReason}
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
  requireReason,
}: {
  item: ReportItem;
  onArchive: (reason?: string) => void;
  onInterested: () => void;
  onHandlePointerDown: (e: React.PointerEvent) => void;
  detailHref: string;
  clientName?: string;
  requireReason?: boolean;
}) {
  // Pass opens a reason step. The reason is routed to the match_feedback calibration store
  // server-side (replaced the old agree/flag box), and the server records a datapoint ONLY when a
  // reason is present. On the client portal (requireReason) it is REQUIRED — the confirm stays
  // disabled until non-empty — so a client Pass never silently drops the calibration signal (mirrors
  // DecisionBar on the grant-report detail). On staff surfaces it stays optional.
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
            <p className="text-center text-[13px] font-medium text-brand-navy">
              {requireReason
                ? "Why pass? This is how we tune your matches — tell us what's off and we'll send fewer like it."
                : "Why pass? (optional)"}
            </p>
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
                disabled={requireReason && !passReason.trim()}
                className="flex items-center gap-2 rounded-full bg-destructive px-6 py-2 text-sm font-semibold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
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

// ── Client Grant Alert redesign (`presentation="alert"`) ────────────────────────────────
// A one-glance, no-scroll card over the road photo + navy scrim, with Pass/Interested as
// floating circles below it. All deck state (browse, decide, the #12 transition) is owned by
// SwipeDeck and passed in; this tree is presentation + the local Pass-reason step only.

// Small stopword set + the emphasis rule: italic-orange the single most DISTINCTIVE word in
// the title (longest content word, skipping short words and stopwords), falling back to the
// last word. A deterministic stand-in for "most relevant" — no LLM at render — that reproduces
// Design's emphasis on the mock ("Scholarships for Disadvantaged Students" → "Disadvantaged").
const TITLE_STOPWORDS = new Set([
  "for", "of", "the", "and", "to", "in", "a", "an", "on", "with", "from", "by", "or", "at", "as", "its", "your",
]);
function titleParts(title: string): { text: string; em: boolean }[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words.map((text) => ({ text, em: false }));
  let idx = -1;
  let best = 0;
  words.forEach((w, i) => {
    const clean = w.replace(/[^A-Za-z-]/g, "");
    if (clean.length < 6 || TITLE_STOPWORDS.has(clean.toLowerCase())) return;
    if (clean.length > best) {
      best = clean.length;
      idx = i;
    }
  });
  if (idx === -1) idx = words.length - 1; // nothing qualified → the last word
  return words.map((text, i) => ({ text, em: i === idx }));
}

function AlertDeck({
  current,
  index,
  total,
  decided,
  transitioning,
  overlay,
  onBrowse,
  onDecide,
  clientName,
  detailBasePath,
  requireReason,
  dashboardHref,
}: {
  current: ReportItem | undefined;
  index: number;
  total: number;
  decided: number;
  transitioning: boolean;
  overlay: React.ReactNode;
  onBrowse: (delta: number) => void;
  onDecide: (action: "interested" | "passed", reason?: string) => void;
  clientName?: string;
  detailBasePath: string;
  requireReason?: boolean;
  dashboardHref?: string;
}) {
  const [passing, setPassing] = useState(false);
  const [passReason, setPassReason] = useState("");
  const dashHref = dashboardHref ?? "/portal";

  // A new card is a fresh decision: never carry a half-typed Pass reason across a browse.
  useEffect(() => {
    setPassing(false);
    setPassReason("");
  }, [current?.id]);

  return (
    <div className="relative min-h-full overflow-hidden bg-brand-navy">
      {overlay}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: `url('${ROAD_BG}')`, backgroundSize: "cover", backgroundPosition: "center" }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: ALERT_SCRIM }} />

      <div className="relative flex min-h-full flex-col items-center justify-center px-5 py-10">
        {current ? (
          <>
            {/* top bar — Dashboard exit on the left, browse on the right */}
            <div className="mb-4 flex w-full max-w-[620px] items-center justify-between">
              <Link
                href={dashHref}
                className="inline-flex items-center gap-[7px] text-[12.5px] font-medium text-white/65 transition hover:text-white"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Dashboard
              </Link>
              <div className="flex items-center gap-[10px]">
                <span className="text-[12px] tabular-nums text-white/50">
                  {index + 1} of {total}
                </span>
                <AlertBrowseButton dir="left" disabled={index === 0 || transitioning} onClick={() => onBrowse(-1)} />
                <AlertBrowseButton
                  dir="right"
                  disabled={index >= total - 1 || transitioning}
                  onClick={() => onBrowse(1)}
                />
              </div>
            </div>

            <AlertCard
              key={current.id}
              item={current}
              clientName={clientName}
              detailHref={`${detailBasePath}/${current.id}?from=alerts`}
            />

            {passing ? (
              <AlertPassReason
                requireReason={requireReason}
                value={passReason}
                onChange={setPassReason}
                onCancel={() => {
                  setPassing(false);
                  setPassReason("");
                }}
                onConfirm={() => onDecide("passed", passReason)}
                disabled={transitioning}
              />
            ) : (
              <div className="mt-[22px] flex w-full max-w-[620px] items-center justify-center gap-[56px]">
                <AlertAction kind="pass" onClick={() => setPassing(true)} disabled={transitioning} />
                <AlertAction kind="interested" onClick={() => onDecide("interested")} disabled={transitioning} />
              </div>
            )}
          </>
        ) : (
          // Only the INITIAL empty deck reaches this (nothing to review). A decision that
          // empties the deck is handled by the #12 transition, which redirects before this shows.
          <div className="w-full max-w-[620px] text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white/10 backdrop-blur-[6px]">
              <Check className="h-7 w-7 text-white" strokeWidth={3} />
            </div>
            <h2 className="mt-5 font-serif text-2xl font-semibold text-white">All caught up</h2>
            <p className="mt-2 text-sm text-white/70">
              {decided > 0
                ? `You reviewed ${decided} ${decided === 1 ? "grant" : "grants"}.`
                : "Nothing new to review right now."}
            </p>
            <Link
              href={dashHref}
              className="mt-6 inline-block rounded-full bg-brand-orangeFill px-6 py-2.5 text-sm font-semibold text-white transition hover:brightness-105"
            >
              Back to dashboard
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function AlertBrowseButton({ dir, disabled, onClick }: { dir: "left" | "right"; disabled: boolean; onClick: () => void }) {
  const Icon = dir === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "left" ? "Previous alert" : "Next alert"}
      className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-full border border-white/20 text-white/75 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
        disabled ? "cursor-not-allowed opacity-40" : "hover:border-white/45 hover:text-white"
      }`}
    >
      <Icon className="h-[13px] w-[13px]" />
    </button>
  );
}

function AlertCard({
  item,
  clientName,
  detailHref,
}: {
  item: ReportItem;
  clientName?: string;
  detailHref: string;
}) {
  const parts = titleParts(item.title);
  // "Sep 4 · 32d" for a future deadline; never a raw negative countdown. A past deadline
  // reads "closed", a same-day one "today" (still winnable — federal cutoffs carry a time we
  // don't store, mirroring isOverdue in report/shape.ts).
  const d = item.deadlineDaysLeft;
  const closes =
    d === null
      ? item.deadlineLabel
      : d < 0
        ? `${item.deadlineLabel} · closed`
        : d === 0
          ? `${item.deadlineLabel} · today`
          : `${item.deadlineLabel} · ${d}d`;
  const meta = [item.nofoNumber, item.role ? `${item.role} applicant` : null].filter(Boolean).join(" · ");
  return (
    <div
      className="relative w-full max-w-[620px] overflow-visible rounded-[4px] bg-white"
      style={{
        borderTop: `4px solid ${BRAND.orange}`,
        boxShadow:
          "0 0 0 1px rgba(255,255,255,.05),0 40px 80px -24px rgba(0,0,0,.6),0 0 70px -18px rgba(228,118,31,.35)",
      }}
    >
      {item.fitScore !== null && (
        <div
          className="absolute -top-[18px] right-[28px] flex h-[74px] w-[74px] flex-col items-center justify-center rounded-full border-[3px] border-brand-orange bg-brand-navy"
          style={{ boxShadow: "0 10px 24px rgba(0,0,0,.35)" }}
        >
          <span className="font-serif text-[22px] font-bold leading-none tabular-nums text-white">{item.fitScore}</span>
          <span className="mt-0.5 text-[8px] font-bold uppercase tracking-[.08em] text-brand-orange">score</span>
        </div>
      )}

      <div className="pl-[30px] pr-[100px] pt-[26px]">
        <div className="flex flex-wrap items-center gap-x-[9px] gap-y-1">
          {item.category && (
            <span className="inline-flex rounded-[2px] bg-brand-navy px-[9px] py-[3px] text-[10.5px] font-semibold tracking-[.03em] text-white">
              {item.category}
            </span>
          )}
          {meta && <span className="text-[11.5px] text-ink-subtle">{meta}</span>}
        </div>
        <h1 className="mt-3 font-serif text-[25px] font-bold leading-[1.2] tracking-[-.01em] text-brand-navy [text-wrap:pretty]">
          {parts.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && " "}
              {p.em ? <em className="italic text-brand-orange">{p.text}</em> : p.text}
            </Fragment>
          ))}
        </h1>
        {item.funder && <p className="mt-[7px] text-[12.5px] text-ink-subtle">{item.funder}</p>}
      </div>

      <div className="mx-[30px] mt-[18px] flex items-center gap-3">
        <span className="h-[3px] w-10 shrink-0 bg-brand-orange" />
        <span className="h-px flex-1 bg-brand-navy/10" />
      </div>

      {item.purpose && (
        <div className="px-[30px] pt-[14px]">
          <p className="mb-[6px] text-[9.5px] font-bold uppercase tracking-[.12em] text-brand-orangeDeep">
            Grant description
          </p>
          <p className="text-[13px] leading-[1.6] text-[#3d4756] [text-wrap:pretty]">{item.purpose}</p>
        </div>
      )}

      <div className="mx-[30px] mt-4 grid grid-cols-5 gap-px overflow-hidden rounded-[4px] bg-brand-navy/[0.08]">
        <AlertStat label="Total avail." value={item.totalAvailable || "—"} />
        <AlertStat label="Award range" value={item.awardRange} />
        <AlertStat label="Match req." value={item.matchRequired} />
        <AlertStat label="Your role" value={item.role || "—"} />
        <AlertStat label="Closes" value={closes} highlight />
      </div>

      {item.concept && (
        <div className="mx-[30px] mt-4">
          <ConceptProposalReveal concept={item.concept} clientName={clientName} variant="alert" />
        </div>
      )}

      <div className="mx-[30px] mb-[22px] mt-3 flex justify-end">
        {item.sourceUrl ? (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted transition hover:text-brand-navy"
          >
            Read full NOFO
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <Link
            href={detailHref}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted transition hover:text-brand-navy"
          >
            See the full breakdown
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    </div>
  );
}

function AlertStat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`px-3 py-[10px] ${highlight ? "bg-brand-orangeFill" : "bg-[#FBFAF8]"}`}>
      <p className={`text-[9px] uppercase tracking-[.05em] ${highlight ? "text-white/75" : "text-ink-subtle"}`}>{label}</p>
      <p
        className={`mt-1 text-[12.5px] tabular-nums ${highlight ? "font-bold text-white" : "font-semibold text-brand-navy"}`}
      >
        {value}
      </p>
    </div>
  );
}

function AlertAction({ kind, onClick, disabled }: { kind: "pass" | "interested"; onClick: () => void; disabled: boolean }) {
  const interested = kind === "interested";
  return (
    <div className="flex flex-col items-center gap-[10px]">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={interested ? "Interested" : "Pass"}
        className={`flex h-[60px] w-[60px] items-center justify-center rounded-full border-[1.5px] transition disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
          interested
            ? "border-white/50 bg-brand-orangeFill hover:brightness-105"
            : "border-white/40 bg-white/10 backdrop-blur-[6px] hover:bg-white/20"
        }`}
        style={interested ? { boxShadow: "0 10px 26px rgba(228,118,31,.5)" } : undefined}
      >
        {interested ? (
          <Check className="h-6 w-6 text-white" strokeWidth={3} />
        ) : (
          <X className="h-[22px] w-[22px] text-white" />
        )}
      </button>
      <span className={`text-[12.5px] ${interested ? "font-bold text-white" : "font-semibold text-white/75"}`}>
        {interested ? "Interested" : "Pass"}
      </span>
    </div>
  );
}

function AlertPassReason({
  requireReason,
  value,
  onChange,
  onCancel,
  onConfirm,
  disabled,
}: {
  requireReason?: boolean;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-[22px] w-full max-w-[620px] rounded-lg border border-white/15 bg-white p-4 shadow-overlay">
      <p className="text-center text-[13px] font-medium text-brand-navy">
        {requireReason
          ? "Why pass? This is how we tune your matches — tell us what's off and we'll send fewer like it."
          : "Why pass? (optional)"}
      </p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        autoFocus
        placeholder="e.g. wrong geography, no capacity this cycle, not a fit"
        className="mt-2.5 w-full rounded-lg border border-input bg-white px-3 py-2 text-sm outline-none focus:border-brand-navy/35"
      />
      <div className="mt-2.5 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-brand-navy/20 bg-white px-5 py-2 text-sm font-medium text-ink-muted transition hover:text-brand-navy"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={disabled || (requireReason && !value.trim())}
          className="flex items-center gap-2 rounded-full bg-destructive px-6 py-2 text-sm font-semibold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
        >
          <X className="h-4 w-4" />
          Pass on this grant
        </button>
      </div>
    </div>
  );
}
