"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, ChevronRight, Loader2, Search } from "lucide-react";
import { BRAND, INK, RATING, SURFACE } from "@/lib/brand";
import { rollUpQueue, sortQueue, type QueueRow, type QueueSort } from "@/lib/report/report-queue";
import type { StaffBucket } from "@/lib/report/shape";
import { cn } from "@/lib/utils";

// The client's Grant Report — the queue of matched grants awaiting review, and the entry
// point into the review loop.
//
// NINE ROWS FIT ON ONE SCREEN AT 1440x900. The build this replaces showed about two and a
// half, which is not a queue: you cannot tell what you are facing, and you cannot triage
// in any order but top-down. Row height and gap are fixed and the list container is sized
// to an exact multiple of them, so a tenth row is fully hidden rather than half-showing —
// a 30px sliver of a card reads as a rendering artefact, not as a scroll affordance.
//
// A SUB-PAGE, NOT A TOP-LEVEL ONE. Portfolio and the client dashboard open with a full ink
// masthead because they are where you start. This hangs off a client's dashboard, so it
// opens white: a back link, a 23px title, and compact stats. Promoting it to a masthead
// would make every screen the front page of something.
//
// STAFF ONLY. app/portal/grants is the client's own list and still renders GrantReport —
// a separate surface rather than a variant, for the same reason as the grant review.

const ROW_H = 66;
const ROW_GAP = 8;
const VISIBLE_ROWS = 9;

// TABS PER ACTOR, and the sets differ in length rather than only in wording. A client has
// no release gate, so staffBucket never returns "admin" for them -- an "Awaiting release"
// tab would be permanently empty and would also be about OUR queue, not theirs.
//
// "Passed" on both sides, replacing "Rejected". The stored value has always been
// decision='passed'; only the label said otherwise, and "Rejected" is the wrong word for a
// client deciding not to pursue. It is reserved for a submitted application that did not
// win, which is a state the platform does not track yet.
const CONSOLE_BUCKETS: { key: StaffBucket; label: string }[] = [
  { key: "admin", label: "Awaiting release" },
  { key: "client", label: "With client" },
  { key: "pursued", label: "Pursued" },
  { key: "rejected", label: "Passed" },
];

// "Awaiting review" is the ones in their report they have not decided how to pursue --
// their untriaged matches are in Grant Alerts, not here (the list requires interested_at).
const PORTAL_BUCKETS: { key: StaffBucket; label: string }[] = [
  { key: "client", label: "Awaiting review" },
  { key: "pursued", label: "Pursuing" },
  { key: "rejected", label: "Passed" },
];

const SORTS: { key: QueueSort; label: string }[] = [
  { key: "deadline", label: "deadline" },
  { key: "fit", label: "fit" },
  { key: "ceiling", label: "ceiling" },
];

export function GrantReportConsole({
  clientName,
  clientHref,
  basePath,
  rows,
  refreshedLabel,
  canArchive,
  variant = "console",
  backLabel,
}: {
  clientName: string;
  clientHref: string;
  basePath: string;
  // Which actor's queue this is. Drives the tab set, the default tab, the stats the
  // header reports and the copy -- NOT the layout, which is identical by design.
  variant?: "console" | "portal";
  // What the back link reads as. Defaults to clientName (staff came from that client);
  // the portal came from its own dashboard.
  backLabel?: string;
  rows: QueueRow[];
  // "4h ago" — when matching last produced a card for this client. Null when never.
  refreshedLabel: string | null;
  // Bulk-archiving closed grants records a decision, so it is gated the same way any
  // other decision on this page is.
  canArchive: boolean;
}) {
  const router = useRouter();
  const portal = variant === "portal";
  const buckets = portal ? PORTAL_BUCKETS : CONSOLE_BUCKETS;
  // The actor's own queue: what is still waiting on them. Also the bucket the header
  // stats describe, so they never report on somebody else's work.
  const primary: StaffBucket = portal ? "client" : "admin";
  const [bucket, setBucket] = useState<StaffBucket>(primary);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<QueueSort>("deadline");
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // Bulk mark-as-unread. Console only: the client's read state is stamped when they open a
  // grant and is not staff's to rewrite, so the portal renders no checkboxes and no action.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  const roll = useMemo(() => rollUpQueue(rows, primary), [rows, primary]);
  const counts = { admin: roll.awaiting, client: roll.withClient, pursued: roll.pursued, rejected: roll.rejected };

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const inBucket = rows.filter((r) => r.bucket === bucket);
    const matched = needle
      ? inBucket.filter(
          (r) =>
            r.item.title.toLowerCase().includes(needle) || (r.item.funder ?? "").toLowerCase().includes(needle),
        )
      : inBucket;
    return sortQueue(matched, sort);
  }, [rows, bucket, q, sort]);

  const closedRows = rows.filter((r) => r.closedUnreviewed);
  const firstHref = visible[0] ? `${basePath}/${visible[0].item.id}` : null;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function markUnread() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setMarking(true);
    setMarkError(null);
    try {
      const res = await fetch("/api/review/mark-unread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardIds: ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't mark those unread");
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : "Couldn't mark those unread");
    } finally {
      setMarking(false);
    }
  }

  async function archiveClosed() {
    if (
      !window.confirm(
        `Archive ${closedRows.length} closed ${closedRows.length === 1 ? "grant" : "grants"}?\n\n` +
          "Each is recorded as rejected with the reason “Closed before review”. You can change a decision later.",
      )
    ) {
      return;
    }
    setArchiving(true);
    setArchiveError(null);
    try {
      const res = await fetch("/api/review/archive-closed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_ids: closedRows.map((r) => r.item.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't archive those");
      router.refresh();
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : "Couldn't archive those");
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col bg-ground">
      <header className="relative z-[1] shrink-0 border-b border-brand-navy/[0.11] bg-white px-[30px]">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-3.5 pt-[13px]">
          <div className="min-w-0">
            <Link
              href={clientHref}
              className="inline-flex items-center gap-[7px] rounded-sharp text-[12px] font-medium text-ink-muted transition-colors hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
            >
              <ArrowLeft className="h-[13px] w-[13px]" aria-hidden="true" />
              {backLabel ?? clientName}
            </Link>
            <h1 className="mt-[7px] font-serif text-[23px] font-bold leading-none tracking-[-0.012em] text-brand-navy">
              Grant Report
            </h1>
            <p className="mt-[7px] text-[12.5px] text-ink-muted">
              {portal
                ? `${roll.awaiting} awaiting your review · ${roll.pursued} you are pursuing`
                : `${roll.awaiting} awaiting your release · ${roll.withClient} with the client`}
              {!portal && refreshedLabel && ` · last refreshed ${refreshedLabel}`}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-end gap-x-[26px] gap-y-3">
            {roll.closedUnreviewed > 0 && (
              <Stat value={String(roll.closedUnreviewed)} label="Closed unreviewed" color={BRAND.orangeDeep} />
            )}
            <Divider />
            <Stat value={String(roll.dueSoon)} label="Due in 30 days" />
            <Divider />
            <Stat
              value={roll.avgFit ?? "–"}
              suffix={roll.avgFit ? "/3" : undefined}
              label="Average fit"
              // Says what the average is OF when part of the queue has no score, rather
              // than presenting a partial mean as a whole one.
              title={roll.unscored > 0 ? `${roll.unscored} awaiting grants are not scored and are excluded` : undefined}
            />
            <Divider />
            {/* LABELLED DIFFERENTLY FOR A CLIENT, not hidden from them. An award ceiling is
                what the PROGRAMME will fund at most, so "Combined ceiling" against their own
                organisation's name invites reading it as money coming to them. "Program
                maximums" says whose number it is in the label itself rather than relying on
                a hover, and the title spells out that it is not a forecast. Staff keep the
                shorter label -- they already know what a ceiling is. */}
            <Stat
              value={roll.ceiling ?? "–"}
              label={portal ? "Program maximums" : "Combined ceiling"}
              title={
                roll.ceiling
                  ? portal
                    ? `The most each program would award any applicant, added up. NOT a forecast of what you will receive.${roll.ceilingUnpriced > 0 ? ` ${roll.ceilingUnpriced} carry no published figure.` : ""}`
                    : `Estimated award ceilings${roll.ceilingUnpriced > 0 ? ` · ${roll.ceilingUnpriced} carry no published figure` : ""}`
                  : "No published award figures on this queue"
              }
            />
            {firstHref && (
              <Link
                href={firstHref}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-sharp bg-brand-orangeFill px-[17px] text-[13px] font-semibold text-white transition-colors duration-[120ms] hover:bg-brand-orangeFillHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
              >
                {portal ? "Start reviewing" : "Start review"}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="relative flex flex-1 flex-col overflow-hidden px-[30px] pb-4 pt-3.5">
        <Decor ghost={roll.awaiting} />

        <div className="relative z-[1] flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
            <div className="flex h-8 w-[240px] items-center gap-[7px] border border-brand-navy/[0.14] bg-white px-[11px]">
              <Search className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search these ${counts[bucket]}…`}
                aria-label="Search this queue by programme or agency"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-brand-navy outline-none placeholder:text-ink-muted"
              />
            </div>

            <div className="flex items-center gap-[2px] bg-brand-navy/[0.055] p-[3px]">
              {buckets.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  aria-pressed={bucket === b.key}
                  onClick={() => setBucket(b.key)}
                  className={cn(
                    "inline-flex h-[26px] items-center gap-1.5 px-3 text-[12.5px] transition-colors duration-[120ms]",
                    bucket === b.key ? "bg-white font-semibold text-brand-navy" : "font-medium text-ink-muted hover:text-brand-navy",
                  )}
                >
                  {b.label}
                  {counts[b.key] > 0 && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-[10px] font-bold leading-[1.4] tabular-nums",
                        bucket === b.key ? "bg-brand-orangeFill text-white" : "bg-brand-navy/[0.08] text-ink-muted",
                      )}
                    >
                      {counts[b.key]}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-x-[9px] gap-y-2">
              <label className="inline-flex items-center gap-[7px] text-[12px] text-ink-muted">
                Sorted by
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as QueueSort)}
                  className="cursor-pointer bg-transparent text-[12px] font-semibold text-brand-navy outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60"
                >
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* Appears only with a selection, so the header does not carry a permanently
                  disabled control for a mode nobody is in. */}
              {!portal && selected.size > 0 && (
                <button
                  type="button"
                  disabled={marking}
                  onClick={() => void markUnread()}
                  className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted transition-colors hover:text-brand-navy disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
                >
                  {marking && <Loader2 className="h-[13px] w-[13px] animate-spin" aria-hidden="true" />}
                  Mark <strong className="font-semibold text-brand-navy">{selected.size}</strong> unread
                </button>
              )}

              {/* A REAL ACTION, not a nudge. A prompt that only points at the problem is
                  the dead affordance this redesign keeps removing — and the count above
                  already points at it. */}
              {closedRows.length > 0 && canArchive && (
                <button
                  type="button"
                  disabled={archiving}
                  onClick={() => void archiveClosed()}
                  className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted transition-colors hover:text-brand-navy disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
                >
                  {archiving ? (
                    <Loader2 className="h-[13px] w-[13px] animate-spin" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="h-[13px] w-[13px]" style={{ color: BRAND.orangeDeep }} aria-hidden="true" />
                  )}
                  <strong className="font-semibold text-brand-navy">{closedRows.length} closed</strong> before review —
                  archive?
                </button>
              )}
            </div>
          </div>

          {archiveError && (
            <p className="shrink-0 pb-2 text-[12px]" style={{ color: BRAND.reject }}>
              {archiveError}
            </p>
          )}

          {markError && (
            <p className="shrink-0 pb-2 text-[12px]" style={{ color: BRAND.reject }}>
              {markError}
            </p>
          )}

          {visible.length === 0 ? (
            <EmptyQueue bucket={bucket} searching={q.trim().length > 0} awaiting={roll.awaiting} portal={portal} />
          ) : (
            <div
              // Sized to an exact multiple of the row pitch so a tenth row is fully
              // hidden rather than half-showing. scroll-snap keeps it that way while
              // scrolling, so there is never a partial card at rest.
              className="min-h-0 flex-1 overflow-y-auto [scroll-snap-type:y_proximity] [scrollbar-gutter:stable]"
              style={{ maxHeight: VISIBLE_ROWS * ROW_H + (VISIBLE_ROWS - 1) * ROW_GAP }}
            >
              <div className="flex flex-col" style={{ gap: ROW_GAP }}>
                {visible.map((row) => (
                  <QueueCard
                    key={row.item.id}
                    row={row}
                    href={`${basePath}/${row.item.id}`}
                    selected={selected.has(row.item.id)}
                    onToggleSelect={portal ? undefined : toggleSelect}
                  />
                ))}
              </div>
            </div>
          )}

          {/* The count is always the truth, whether or not the list is showing all of it. */}
          {visible.length > VISIBLE_ROWS && (
            <p className="shrink-0 pt-2.5 text-[11.5px] text-ink-muted">
              Showing {VISIBLE_ROWS} of {visible.length} — scroll for the rest.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <span aria-hidden="true" className="h-[34px] w-px shrink-0 self-end bg-brand-navy/10" />;
}

function Stat({
  value,
  suffix,
  label,
  color,
  title,
}: {
  value: string;
  suffix?: string;
  label: string;
  color?: string;
  title?: string;
}) {
  return (
    <div className="shrink-0" title={title}>
      <p
        className="font-serif text-[19px] font-bold leading-none tabular-nums"
        style={{ color: color ?? INK.DEFAULT }}
      >
        {value}
        {suffix && <span className="text-[12px] text-ink-muted">{suffix}</span>}
      </p>
      <p className="mt-[5px] text-[9.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">{label}</p>
    </div>
  );
}

function Decor({ ghost }: { ghost: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
      <span className="absolute inset-y-0 left-0 w-px bg-brand-navy/10" />
      <span className="absolute inset-y-0 right-0 w-px bg-brand-navy/10" />
      {ghost > 0 && (
        <span
          className="absolute -bottom-[150px] -right-[46px] select-none font-serif text-[340px] font-bold leading-none tracking-[-0.04em]"
          style={{ color: "rgba(11,30,58,0.03)" }}
        >
          {ghost}
        </span>
      )}
    </div>
  );
}

// THE DIAL CARRIES THE SCORE, and its colour is the score. Every circle rendering an
// identical grey "2 · CONDITIONAL" made the largest element on every card carry no
// information at all.
//
// Three states plus unscored, and rating is carried by colour AND the word — never by a
// green/amber/red scale, which is close to worst-case for red-green colour blindness.
function fitTone(score: 1 | 2 | 3 | null): { ring: string; fill?: string; num: string; word: string } {
  if (score === null) return { ring: RATING.empty, num: INK.faint, word: INK.muted };
  if (score >= 3) return { ring: "rgba(11,30,58,0.3)", num: INK.DEFAULT, word: INK.DEFAULT };
  if (score === 2) return { ring: "rgba(11,30,58,0.18)", num: INK.muted, word: INK.muted };
  return { ring: "rgba(228,118,31,0.55)", fill: "rgba(228,118,31,0.08)", num: BRAND.orangeDeep, word: BRAND.orangeDeep };
}

function QueueCard({
  row,
  href,
  selected,
  onToggleSelect,
}: {
  row: QueueRow;
  href: string;
  // Selection is console-only. Absent onToggleSelect = no checkbox column at all, which is
  // how the portal renders: a client's read state is automatic and not theirs to edit.
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const { item, closed, concern } = row;
  const tone = fitTone(item.fitScore);
  const days = item.deadlineDaysLeft;
  const urgent = closed || item.deadlineSoon;

  // CLOSED IS A TINTED BACKGROUND, NOT AN OPACITY DIM. Ancestor opacity composites the
  // whole subtree — it drags every text node in the card toward the background, including
  // the two strings that carry the point of the treatment, and no colour token inside can
  // correct it. An explicit tint keeps every value's contrast under our control.
  const edge = closed ? BRAND.orangeDeep : concern ? BRAND.orange : "#D8D4CB";

  // READ RECEDES TO THE PAGE GROUND; UNREAD IS WHITE AND CARRIES A DOT. `item.read` is
  // whichever side this surface is (staff_read_at or client_read_at, resolved in the
  // shaping layer) — this component is not told which, and must not be.
  //
  // The tint alone would not carry it. SURFACE.page and the closed tint are two nearby
  // creams, and closed already owns a background treatment, so on a closed row the two
  // would be indistinguishable — closed wins the tint below, since its orangeDeep left
  // edge is what actually says "closed" and a terminal row's read state is moot. The
  // POSITIVE marker on unread is what makes the state legible either way: orange, which
  // this palette already uses to mean "you owe something", against no marker once read.
  const unread = !item.read;

  // THE CHECKBOX IS A SIBLING OF THE LINK, NOT A CHILD OF IT. An <input> inside an <a> is
  // invalid HTML and behaves accordingly — the label's click activates the anchor, so
  // ticking a row would navigate to it. The wrapper carries the row's frame (height,
  // tint, edge) and the anchor fills what is left, so the checkbox column is inside the
  // row's background without being inside its click target.
  return (
    <div
      className="flex shrink-0 items-stretch border border-edge transition-colors duration-[120ms] hover:border-brand-navy/25 [scroll-snap-align:start]"
      style={{
        height: ROW_H,
        backgroundColor: closed ? "#F4F1EA" : unread ? "#FFFFFF" : SURFACE.page,
        borderLeftWidth: "3px",
        borderLeftColor: edge,
      }}
    >
      {onToggleSelect && (
        <label
          className="flex shrink-0 cursor-pointer items-center pl-[14px] pr-[2px]"
          // The row title is the only durable name for this checkbox; without it a screen
          // reader reads a column of bare "checkbox, not checked".
          aria-label={`Select ${item.title}`}
        >
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect(item.id)}
            className="h-[14px] w-[14px] cursor-pointer accent-brand-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60"
          />
        </label>
      )}
      <Link
        href={href}
        className="flex min-w-0 flex-1 items-center gap-[18px] px-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
      <div className="flex w-[150px] shrink-0 items-center gap-[11px]">
        <span
          className="flex h-[46px] w-[46px] shrink-0 flex-col items-center justify-center rounded-full"
          style={{ border: `1.5px solid ${tone.ring}`, backgroundColor: tone.fill }}
        >
          <span
            className="font-serif text-[19px] font-bold leading-none tabular-nums"
            style={{ color: tone.num }}
          >
            {item.fitScore ?? "–"}
          </span>
          <span className="mt-0.5 text-[8px] font-bold tracking-[0.1em] text-ink-muted">OF 3</span>
        </span>
        <span
          className="min-w-0 text-[11px] font-bold uppercase tracking-[0.09em]"
          style={{ color: tone.word }}
        >
          {item.band?.label ?? "Not scored"}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-[7px] font-serif text-[15.5px] font-bold text-brand-navy" title={item.title}>
          {unread && (
            // aria-hidden + the sr-only word below: a bare coloured dot is not a label, and
            // "unread" has to reach a screen reader as a word rather than as a colour.
            <span
              className="h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ backgroundColor: BRAND.orange }}
              aria-hidden="true"
            />
          )}
          {unread && <span className="sr-only">Unread. </span>}
          <span className="truncate">{item.title}</span>
        </p>
        <p className="mt-[5px] truncate text-[11.5px] text-ink-muted">{item.funder ?? "Funder not stated"}</p>
      </div>

      <div className="w-[118px] shrink-0 text-right">
        <p className="text-[13px] font-semibold tabular-nums text-brand-navy">{item.awardRange}</p>
        <p className="mt-[5px] text-[10.5px] text-ink-muted">ceiling{item.awardIsEstimate ? " · est." : ""}</p>
      </div>

      <div className="w-[124px] shrink-0 text-right">
        <p
          className="font-serif text-[15px] font-bold tabular-nums"
          style={{ color: urgent ? BRAND.orangeDeep : INK.DEFAULT }}
        >
          {item.deadlineLabel}
        </p>
        <p className="mt-[5px] text-[10.5px] text-ink-muted">
          {days === null
            ? "no deadline"
            : days < 0
              ? `closed ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago`
              : `${days} ${days === 1 ? "day" : "days"} left`}
        </p>
      </div>

      <ChevronRight className="h-4 w-4 shrink-0" style={{ color: INK.faint }} aria-hidden="true" />
      </Link>
    </div>
  );
}

// The empty queue is the PAYOFF for clearing the loop, not an error. It is the only
// state on this page that should feel good to arrive at, so it gets the ghost figure's
// space rather than a grey "no results" line.
function EmptyQueue({
  bucket,
  searching,
  awaiting,
  portal,
}: {
  bucket: StaffBucket;
  searching: boolean;
  awaiting: number;
  portal: boolean;
}) {
  if (searching) {
    return (
      <p className="shrink-0 border border-edge bg-white px-5 py-4 text-[12.5px] text-ink-muted">
        Nothing in this queue matches that.
      </p>
    );
  }

  // Per actor, because every one of these sentences names who is waiting on whom.
  const copy: Record<StaffBucket, { head: string; sub: string }> = portal
    ? {
        admin: { head: "Nothing here", sub: "This view is not part of your process." },
        client: {
          head: "You are all caught up",
          sub: "Grants you mark interested in Grant Alerts arrive here for your decision.",
        },
        pursued: { head: "Nothing in pursuit yet", sub: "Grants you decide to pursue appear here." },
        rejected: { head: "Nothing passed", sub: "Grants you pass on are kept here rather than deleted." },
      }
    : {
        admin: {
          head: "The queue is clear",
          sub:
            awaiting === 0
              ? "Every matched grant has been reviewed. New ones land here as the engine scores them."
              : "Nothing left awaiting release.",
        },
        client: { head: "Nothing with the client", sub: "Released grants appear here until the client decides." },
        pursued: { head: "Nothing in pursuit yet", sub: "Grants the client commits to appear here." },
        rejected: { head: "Nothing passed", sub: "Passed grants are kept here rather than deleted." },
      };
  const { head, sub } = copy[bucket];

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center border border-edge bg-white/50 px-6 py-10 text-center">
      <p className="font-serif text-[22px] font-bold text-brand-navy">{head}</p>
      <p className="mt-2 max-w-[380px] text-[12.5px] leading-[1.6] text-ink-muted">{sub}</p>
    </div>
  );
}
