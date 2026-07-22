"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useMotionValue, useTransform, animate, type MotionValue } from "motion/react";
import { Archive, ArrowUpRight, Check } from "lucide-react";
import { ScoreRing, Tag } from "./primitives";
import type { ReportItem } from "@/lib/report/shape";

// Card-stack triage for undecided matches — the interactive half of the shared
// decision surface (Slice 3). Swipe right = Interested (approved) · left = Archive
// (passed); a binary call, no middle option. Fly-off physics via `motion`. Each
// decision writes through the same PATCH /api/review/[id] as the detail gate
// (actor-tracked, no email), so triage and the roadmap stay one decision model.

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
  const router = useRouter();
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
      <div className="mx-auto max-w-md py-16 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-navy/[0.06]">
          <Check className="h-7 w-7 text-brand-orange" strokeWidth={3} />
        </div>
        <h2 className="mt-5 font-serif text-2xl font-semibold text-brand-navy">All caught up</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {done > 0 ? `You triaged ${done} ${done === 1 ? "grant" : "grants"}.` : "Nothing new to review right now."}
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
    <div className="mx-auto max-w-md">
      <div className="mb-5 flex items-center justify-between">
        <Link href={backHref} className="text-sm font-medium text-muted-foreground hover:text-brand-navy">
          ← Roadmap
        </Link>
        <span className="text-sm text-muted-foreground">{queue.length} to review</span>
      </div>

      <div className="relative h-[540px]">
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

  function flyOff(dir: 1 | -1, decision: "approved" | "passed") {
    animate(x, dir * 720, {
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
        detailHref={`${detailBasePath}/${item.id}`}
      />
    </motion.div>
  );
}

function CardFace({
  item,
  interactive,
  interestOpacity,
  archiveOpacity,
  onArchive,
  onInterested,
  detailHref,
}: {
  item: ReportItem;
  interactive: boolean;
  interestOpacity?: MotionValue<number>;
  archiveOpacity?: MotionValue<number>;
  onArchive?: () => void;
  onInterested?: () => void;
  detailHref?: string;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-brand-navy/[0.06] bg-white shadow-lift">
      {/* road-photo banner with the honest fit ring floated over it */}
      <div className="relative h-40 shrink-0">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url('${ROAD_BG}')`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
        <div className="absolute inset-0 bg-brand-navy/35" />
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

      <div className="flex flex-1 flex-col px-6 pb-6 pt-5">
        <div className="pr-24">
          <h3 className="font-serif text-[22px] font-semibold leading-tight text-brand-navy">{item.title}</h3>
          {item.funder && <p className="mt-1 text-sm text-muted-foreground">{item.funder}</p>}
        </div>

        {(item.role || item.focusAreas.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {item.role && <Tag>{item.role}</Tag>}
            {item.focusAreas.map((f, i) => (
              <Tag key={i}>{f}</Tag>
            ))}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-[13px]">
          <span className="text-brand-navy">
            <span className="font-semibold">{item.awardRange}</span>
            {item.awardIsEstimate && <span className="ml-1 text-muted-foreground">est.</span>}
          </span>
          <span className="text-muted-foreground">
            {item.deadlineLabel}
            {item.deadlineSoon && item.deadlineDaysLeft !== null && (
              <span className="ml-1 font-medium text-brand-orange">· {item.deadlineDaysLeft}d left</span>
            )}
          </span>
        </div>

        {detailHref && (
          <Link
            href={detailHref}
            className="mt-4 inline-flex w-fit items-center gap-1 text-sm font-medium text-brand-orange hover:underline"
          >
            See the full breakdown <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        )}

        {interactive && (
          <div className="mt-auto flex items-center justify-center gap-4 pt-5">
            <button
              onClick={onArchive}
              aria-label="Archive"
              className="flex h-14 w-14 items-center justify-center rounded-full border border-brand-navy/15 bg-white text-muted-foreground shadow-soft transition hover:border-brand-navy/30 hover:text-brand-navy"
            >
              <Archive className="h-6 w-6" />
            </button>
            <button
              onClick={onInterested}
              aria-label="Interested"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-navy text-white shadow-lift transition hover:bg-brand-navyDeep"
            >
              <Check className="h-7 w-7" strokeWidth={3} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
