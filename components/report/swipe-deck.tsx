"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useMotionValue, useTransform, useDragControls, animate, type MotionValue } from "motion/react";
import { Archive, ArrowUpRight, Check } from "lucide-react";
import { ScoreRing, Tag } from "./primitives";
import type { ReportItem } from "@/lib/report/shape";

// Card-stack triage for undecided matches — the interactive half of the shared
// decision surface (Slice 3). Swipe/tap right = Interested (approved), left =
// Archive (passed); a binary call, no middle option. Fly-off physics via `motion`.
// Each decision writes through the same PATCH /api/review/[id] as the detail gate
// (actor-tracked, no email). The card body scrolls; horizontal drag is initiated
// from the banner (a drag handle) so reading the detail doesn't fight the gesture.

const THRESHOLD = 110;
const ROAD_BG = "/login-bg.jpg";

export function SwipeDeck({
  items,
  detailBasePath,
  backHref,
}: {
  items: ReportItem[];
  detailBasePath: string; // detail = `${detailBasePath}/${id}`
  backHref: string;
}) {
  const [queue, setQueue] = useState(items);
  const done = items.length - queue.length;

  async function persist(id: string, decision: "approved" | "passed") {
    try {
      await fetch(`/api/review/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
    } catch {
      // Optimistic: the card already flew off. A failed write surfaces on the
      // roadmap (the card reappears as pending on refresh) rather than blocking.
    }
  }

  function settle(item: ReportItem, decision: "approved" | "passed") {
    persist(item.id, decision);
    setQueue((q) => q.filter((i) => i.id !== item.id));
  }

  const top = queue[0];
  const peek = queue[1];

  if (!top) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-navy/[0.06]">
          <Check className="h-7 w-7 text-brand-orange" strokeWidth={3} />
        </div>
        <h2 className="mt-5 font-serif text-2xl font-semibold text-brand-navy">All caught up</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {done > 0 ? `You reviewed ${done} ${done === 1 ? "grant" : "grants"}.` : "Nothing new to review right now."}
        </p>
        <Link
          href={backHref}
          className="mt-6 inline-block rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white"
        >
          Back to roadmap
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5 flex items-center justify-between">
        <Link href={backHref} className="text-sm font-medium text-muted-foreground hover:text-brand-navy">
          ← Roadmap
        </Link>
        <span className="text-sm text-muted-foreground">{queue.length} to review</span>
      </div>

      <div className="relative h-[640px]">
        {peek && (
          <div className="absolute inset-0 translate-y-3 scale-[0.97] opacity-60">
            <CardFace item={peek} interactive={false} />
          </div>
        )}
        <SwipeCard key={top.id} item={top} detailBasePath={detailBasePath} onSettle={settle} />
      </div>
    </div>
  );
}

function SwipeCard({
  item,
  detailBasePath,
  onSettle,
}: {
  item: ReportItem;
  detailBasePath: string;
  onSettle: (item: ReportItem, decision: "approved" | "passed") => void;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-260, 260], [-11, 11]);
  const interestOpacity = useTransform(x, [30, 130], [0, 1]);
  const archiveOpacity = useTransform(x, [-130, -30], [1, 0]);
  const dragControls = useDragControls();

  function flyOff(dir: 1 | -1, decision: "approved" | "passed") {
    animate(x, dir * 760, {
      type: "spring",
      stiffness: 320,
      damping: 38,
      onComplete: () => onSettle(item, decision),
    });
  }

  return (
    <motion.div
      className="absolute inset-0"
      style={{ x, rotate }}
      drag="x"
      dragListener={false}
      dragControls={dragControls}
      dragElastic={0.6}
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={(_, info) => {
        if (info.offset.x > THRESHOLD) flyOff(1, "approved");
        else if (info.offset.x < -THRESHOLD) flyOff(-1, "passed");
        else animate(x, 0, { type: "spring", stiffness: 400, damping: 34 });
      }}
    >
      <CardFace
        item={item}
        interactive
        interestOpacity={interestOpacity}
        archiveOpacity={archiveOpacity}
        onArchive={() => flyOff(-1, "passed")}
        onInterested={() => flyOff(1, "approved")}
        onHandlePointerDown={(e) => dragControls.start(e)}
        detailHref={`${detailBasePath}/${item.id}`}
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
  interactive,
  interestOpacity,
  archiveOpacity,
  onArchive,
  onInterested,
  onHandlePointerDown,
  detailHref,
}: {
  item: ReportItem;
  interactive: boolean;
  interestOpacity?: MotionValue<number>;
  archiveOpacity?: MotionValue<number>;
  onArchive?: () => void;
  onInterested?: () => void;
  onHandlePointerDown?: (e: React.PointerEvent) => void;
  detailHref?: string;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-brand-navy/[0.06] bg-white shadow-lift">
      {/* road-photo banner — doubles as the drag handle */}
      <div
        className={`relative h-32 shrink-0 ${interactive ? "cursor-grab active:cursor-grabbing touch-none" : ""}`}
        onPointerDown={onHandlePointerDown}
      >
        <div
          className="absolute inset-0"
          style={{ backgroundImage: `url('${ROAD_BG}')`, backgroundSize: "cover", backgroundPosition: "center" }}
        />
        <div className="absolute inset-0 bg-brand-navy/40" />
        {interactive && (
          <>
            <motion.span
              style={{ opacity: interestOpacity }}
              className="absolute left-4 top-4 rounded-lg border-2 border-emerald-400 px-3 py-1 text-sm font-bold uppercase tracking-wider text-emerald-300"
            >
              Interested
            </motion.span>
            <motion.span
              style={{ opacity: archiveOpacity }}
              className="absolute right-4 top-4 rounded-lg border-2 border-white/70 px-3 py-1 text-sm font-bold uppercase tracking-wider text-white"
            >
              Archive
            </motion.span>
          </>
        )}
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

        {detailHref && (
          <Link
            href={detailHref}
            className="mt-4 inline-flex w-fit items-center gap-1 text-sm font-medium text-brand-orange hover:underline"
          >
            See the full breakdown <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>

      {/* labeled decision controls */}
      {interactive && (
        <div className="shrink-0 border-t border-brand-navy/[0.06] px-6 py-4">
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={onArchive}
              className="flex items-center gap-2 rounded-full border border-brand-navy/20 bg-white px-5 py-2.5 text-sm font-semibold text-muted-foreground shadow-soft transition hover:border-brand-navy/35 hover:text-brand-navy"
            >
              <Archive className="h-5 w-5" />
              Archive
            </button>
            <button
              onClick={onInterested}
              className="flex items-center gap-2 rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white shadow-lift transition hover:bg-brand-navyDeep"
            >
              <Check className="h-5 w-5" strokeWidth={3} />
              Interested
            </button>
          </div>
          <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
            Drag the card or tap · left to archive · right for interested
          </p>
        </div>
      )}
    </div>
  );
}
