import Link from "next/link";
import {
  ArrowRight,
  CalendarPlus,
  ChevronRight,
  LifeBuoy,
  Loader2,
  MessageSquare,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ClientMatchChart } from "@/components/clients/client-match-chart";
import {
  ClientGrantReportCard,
  type DashReportRow,
  type DashReportMetrics,
} from "@/components/clients/client-grant-report-card";
import { ClientDraftProgress, type DashDraft, type DraftNext } from "@/components/clients/client-draft-progress";
import { ClientCommunityContext } from "@/components/clients/client-community-context";
import { ClientActivity } from "@/components/clients/client-activity";
import type { CommunityView } from "@/lib/clients/community";
import type { ActivityEvent } from "@/lib/clients/activity";
import type { AmbientNote } from "@/lib/clients/ambient-note";
import { BRAND, INK, STAGE } from "@/lib/brand";
import type { PipelineStageKey } from "@/lib/clients/pipeline";

// The shared, actor-aware client dashboard — the per-client hub. Staff open it via
// Portfolio → client; the client lands here on login (Phase 2). Staff-only controls
// (Edit profile, Refresh matches) render only when isStaff. Staff-internal detail lives
// on Edit profile, not here.
//
// TWO BODY LAYOUTS, and the fork is deliberate. The approved design
// (design/dashboard/) is the STAFF console: a full-bleed two-column body at 34px
// gutters. app/portal/page.tsx mounts this same component with isStaff={false}, so the
// client portal renders from it too — and the design says nothing about the portal.
// Applying the console layout to both would silently restyle a client-facing surface
// and delete cards (the activity chart, the shortcut tiles) that only the portal still
// relies on. So `isStaff` picks the body: PortalBody is unchanged, ConsoleBody is the
// design. Converging them is a deliberate follow-up, not a side effect of this pass.

const SUPPORT = "support@grantedco.com";

export interface DashStat {
  label: string;
  value: string;
  sub?: string | null;
  icon: LucideIcon;
  accent?: boolean;
}

// The trailing control on an attention row, which encodes urgency rather than repeating
// it in words. An affordance you cannot act on is the failure this dashboard keeps being
// cleaned up for, so there are FOUR states and not three:
//
//   pill      work can start here, now — and the label must name where it goes
//   chevron   there is somewhere to look
//   none      nothing to click: either the action lives in a top-right control (the row
//             says so) or the row is purely informational, like a note from the team
//   blocked   genuinely waiting on a prerequisite
//
// `none` and `blocked` are deliberately distinct. Collapsing them -- defaulting any row
// with no href to "Blocked" -- put the word "Blocked" on a row whose own description read
// "Use the button, top right", which is a row contradicting itself.
export type DashAffordance =
  | { kind: "pill"; label: string }
  | { kind: "chevron" }
  | { kind: "none" }
  | { kind: "blocked" };

// A PINNED queue row. Unlike a DashActionItem these always render, at zero as much as at
// twenty, so the card has a floor height and the left column stops collapsing when a
// client happens to be quiet -- the same reasoning as the pipeline card's five always-
// present slots. The count IS the state: at zero the row says so and its control goes
// grey and inert rather than the row disappearing.
//
// A queue only earns a pinned row if it EXISTS. A permanently-zero row with a permanently
// dead button is the "Submitted" pipeline stage and the "Soon" nav links all over again --
// so in-app messaging does not get one until in-app messaging is built.
export interface DashPinnedRow {
  id: string;
  title: string;
  description: string;
  count: number;
  icon: LucideIcon;
  tone: PipelineStageKey;
  // Where the control goes when there is something to open. Null disables it regardless
  // of count, for a queue with no destination on this actor's path.
  href: string | null;
  actionLabel: string;
}

export interface DashActionItem {
  id: string;
  title: string;
  tag?: string | null;
  date?: string | null;
  priority?: "high" | "medium" | null;
  href?: string | null;
  // Live work: renders a spinner + label on the right instead of a static chip, so
  // "something is running" lives ON the item rather than in a separate banner that
  // repeats it.
  busy?: boolean;
  // Where this sits in the onboarding sequence. A more useful right-hand slot than a
  // priority flag: it says how far along the record is, which is the question the
  // sequence exists to answer. Priorities are not a concept we have defined yet.
  stage?: { step: number; total: number } | null;
  // Console-only presentation. The portal's ActionRow ignores all three.
  description?: string | null;
  icon?: LucideIcon;
  // Which stage tint the row's icon tile carries. Reuses the pipeline scale so an
  // attention row and its pipeline column read as the same thing.
  tone?: PipelineStageKey;
  affordance?: DashAffordance;
}

export function ClientDashboard({
  name,
  subLine,
  isStaff,
  roadmapHref,
  intellEngineHref,
  hero,
  actionItems,
  pinnedRows,
  report,
  drafts,
  community,
  events,
  ambient,
  ghost,
  draftNext,
  scorer,
  attentionNote,
  matchNote,
}: {
  name: string;
  subLine: string | null;
  isStaff: boolean;
  roadmapHref: string;
  // Client-only: entry point into the self-serve AI proposal-drafting flow
  // (IntellEngine). Renders a shortcut tile only when provided (client portal
  // passes it; the staff dashboard doesn't).
  intellEngineHref?: string;
  // The masthead — ClientMasthead on both sides, `variant` picking whose funnel it
  // states. Full-bleed and outside the body gutter: it is chrome continuous with the
  // command band, not content. Both callers pass one; there is no fallback hero any more.
  hero?: React.ReactNode;
  actionItems: DashActionItem[];
  // Console-only: the always-present queue rows above the dynamic items.
  pinnedRows?: DashPinnedRow[];
  // Left-column cards. Both are optional, and when one is absent its old shortcut
  // tile renders in the bottom row instead -- so a caller that passes neither gets
  // exactly the previous dashboard rather than a gap where a card should be.
  report?: { rows: DashReportRow[]; total: number; emptyNote: string; metrics?: DashReportMetrics };
  drafts?: { list: DashDraft[]; emptyNote: string };
  // Rail: community need-context read from client_profile.community_context.
  community?: CommunityView;
  // Rail, console-only: what has moved on this client lately. Also the rail's slack
  // absorber — see ClientActivity.
  events?: ActivityEvent[];
  // Console-only: the IntellEngine observation at the foot of the attention card. Null
  // when no rule found anything specific to say, and that is the intended common case —
  // see lib/clients/ambient-note.ts.
  ambient?: AmbientNote | null;
  // Console-only: the oversized figure bled off the bottom-right of the body. The
  // unassessed count, at 3% ink. Null renders nothing.
  ghost?: number | null;
  // Console-only: what the IntellEngine panel says when no draft is in flight — see
  // DraftNext. The panel is never empty; this is what it points at.
  draftNext?: DraftNext | null;
  // Rail, console-only: the grant scorer. Passed as a node because it is a client
  // component with its own state and the console only needs to place it.
  scorer?: React.ReactNode;
  // Console-only. The design's header line is "Grant Alerts opens from here only", which
  // is not true for every actor: for an account-managed client or an unconverted lead the
  // review gate is the roadmap list, not the Grant Alerts swipe. The page knows which,
  // so it supplies the sentence rather than this component asserting a platform-wide
  // invariant it cannot check.
  attentionNote?: string | null;
  matchNote?: React.ReactNode; // staff-only in-progress indicator
}) {
  // ONE BODY FOR BOTH ACTORS. This used to fork: the console got the approved design and
  // the portal kept its old centred column, because the design said nothing about the
  // portal and applying the console layout would have silently restyled a client-facing
  // surface. That convergence is now the instruction — the two are meant to be identical
  // so a change lands on both instead of the portal drifting a release behind.
  //
  // `isStaff` now gates CONTROLS ONLY (Edit profile, Refresh matches, the in-progress
  // note), not layout. Everything else that differs is a prop the caller supplies or
  // omits: the portal passes no `scorer`, no `events`, no `ambient`, no `draftNext`, and a
  // portal-variant masthead as its `hero`.
  return (
    // The ink direction's ground, page-scoped exactly as on the Portfolio — see
    // SURFACE.ground in lib/brand.ts. `hero` (the masthead) is full-bleed and sits
    // OUTSIDE the gutter: it is chrome continuous with the command band, not content.
    <div className="flex min-h-full flex-col bg-ground">
      {hero}
      {isStaff && matchNote}
      <div className="relative flex flex-1 flex-col overflow-hidden px-[34px] pb-[15px] pt-[13px]">
        <ConsoleDecor ghost={ghost} />
        <div className="relative z-[1] flex min-h-0 flex-1 flex-col">
          <ConsoleBody
            actionItems={actionItems}
            pinnedRows={pinnedRows}
            report={report}
            drafts={drafts}
            community={community}
            events={events}
            ambient={ambient}
            draftNext={draftNext}
            scorer={scorer}
            attentionNote={attentionNote}
            roadmapHref={roadmapHref}
            intellEngineHref={intellEngineHref}
          />
        </div>
      </div>
    </div>
  );
}


// The body's ornament: one faint rule down the column gutter, hairline margins at the
// page edges, and the unassessed count bled off the bottom-right at 3% ink.
//
// The gutter rule is positioned off the rail's own width rather than at a percentage, so
// it stays on the gutter if the rail is ever resized. Purely decorative — pointer-events
// off, z-0, and everything real sits above it.
function ConsoleDecor({ ghost }: { ghost?: number | null }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
      <span className="absolute inset-y-0 right-[325px] hidden w-px bg-brand-navy/[0.07] xl:block" />
      <span className="absolute inset-y-0 left-0 w-px bg-brand-navy/10" />
      <span className="absolute inset-y-0 right-0 w-px bg-brand-navy/10" />
      {ghost !== null && ghost !== undefined && ghost > 0 && (
        // Colour set inline rather than via an opacity modifier: at 3% the difference
        // between rendering and not rendering is one arbitrary-value class resolving, and
        // this is not worth debugging twice.
        <span
          className="absolute -bottom-[146px] -right-[52px] select-none font-serif text-[340px] font-bold leading-none tracking-[-0.04em]"
          style={{ color: "rgba(11,30,58,0.03)" }}
        >
          {ghost}
        </span>
      )}
    </div>
  );
}

// ── Console body — the approved design ──────────────────────────────────────
//
// grid-template-columns: 1fr 318px, gap 15px. The left column is everything with a next
// action attached, read top to bottom; the rail is standing context you consult rather
// than act on.
//
// BOTH COLUMNS STRETCH AND BOTTOM OUT LEVEL, which reverses the earlier build. That one
// used items-start after stretching produced a tall empty white card — but the slack was
// being absorbed by the ATTENTION card, which is exactly the wrong one: it is the card
// most likely to be nearly empty. The rail's activity card absorbs it now, and an
// activity feed with room to breathe reads as a feed rather than as a card that failed to
// fill. On the gridded ground a ragged bottom edge is visible in a way it was not on flat
// cream, so ending level is worth the constraint.
function ConsoleBody({
  actionItems,
  pinnedRows,
  report,
  drafts,
  community,
  events,
  ambient,
  draftNext,
  scorer,
  attentionNote,
  roadmapHref,
  intellEngineHref,
}: {
  actionItems: DashActionItem[];
  pinnedRows?: DashPinnedRow[];
  report?: { rows: DashReportRow[]; total: number; emptyNote: string; metrics?: DashReportMetrics };
  drafts?: { list: DashDraft[]; emptyNote: string };
  community?: CommunityView;
  events?: ActivityEvent[];
  ambient?: AmbientNote | null;
  draftNext?: DraftNext | null;
  scorer?: React.ReactNode;
  attentionNote?: string | null;
  roadmapHref: string;
  intellEngineHref?: string;
}) {
  return (
    <div className="grid min-h-0 flex-1 gap-[15px] xl:grid-cols-[1fr_318px] xl:items-stretch">
      <div className="flex min-h-0 min-w-0 flex-col gap-[15px]">
        <AttentionCard items={actionItems} pinned={pinnedRows} note={attentionNote} ambient={ambient} />

        {/* Side by side, equal width, equal height. IntellEngine is the shorter of the
            two by content: it stretches, its content stays top-aligned, and the slack
            falls to the bottom of the panel rather than centring it.

            CAPPED, and the cap is the point. `flex-1` alone hands these panels ALL the
            space left after the masthead and the attention card — which means their height
            is a function of how much content sits ABOVE them, not of what is in them. On a
            staff record that reads fine (17 grants, two attention rows, the panels fill).
            On a sparse one — a client with one grant and one attention row — the same rule
            gave them ~57px MORE and left 400px of white inside, and the page looked broken
            in a way no token change could fix.

            480px is the console's own measured panel height at 1440x900, so a full record
            is unchanged and a sparse one stops stretching; the leftover falls to the bottom
            of the page where empty space is supposed to go. flex-1 and min-h-0 stay, so a
            SHORT viewport still shrinks them rather than overflowing. */}
        <div className="grid min-h-0 max-h-[480px] flex-1 gap-[15px] lg:grid-cols-2 lg:items-stretch">
          {report && (
            <ClientGrantReportCard
              variant="console"
              rows={report.rows}
              total={report.total}
              reportHref={roadmapHref}
              emptyNote={report.emptyNote}
              metrics={report.metrics}
            />
          )}
          {drafts && intellEngineHref && (
            <ClientDraftProgress
              variant="console"
              drafts={drafts.list}
              intellEngineHref={intellEngineHref}
              emptyNote={drafts.emptyNote}
              next={draftNext}
            />
          )}
        </div>
      </div>

      {/* Rail, in the design's order: the scorer (a tool), then activity (what changed),
          then geography (standing evidence). The upcoming-deadlines card is gone — the
          design drops it, and every deadline it carried is on a Grant Report row with a
          day count beside it. */}
      <div className="flex min-h-0 flex-col gap-[15px]">
        {scorer}
        {events && <ClientActivity events={events} />}
        {community && <ClientCommunityContext variant="console" view={community} />}
      </div>
    </div>
  );
}

// "Needs your attention" — a tinted-header card whose rows encode urgency in their
// trailing control. THE CARD NEVER DISAPPEARS: when the queue clears it keeps its frame
// and shows a caught-up row instead. A card that vanishes makes the page collapse to a
// different shape, which is the instability this redesign exists to remove.
function AttentionCard({
  items,
  pinned,
  note,
  ambient,
}: {
  items: DashActionItem[];
  pinned?: DashPinnedRow[];
  note?: string | null;
  ambient?: AmbientNote | null;
}) {
  const rows = pinned ?? [];
  // The header badge counts THINGS THAT WANT YOU, not rows on screen: a pinned queue at
  // zero is on the card but is not asking for anything. So it is the pinned rows carrying
  // a count, plus the dynamic items, plus the ambient note when one fired -- the note
  // names a specific piece of work and points at it, which is the same claim every other
  // counted row makes.
  const live = rows.filter((r) => r.count > 0).length + items.length + (ambient ? 1 : 0);
  return (
    <section className="shrink-0 overflow-hidden rounded-sharp border border-edge bg-white">
      <div
        className="flex items-center gap-2.5 border-b px-5 py-3"
        style={{ backgroundColor: STAGE.triage.tint, borderColor: STAGE.triage.border }}
      >
        <h2 className="font-serif text-base font-bold text-brand-navy">Needs your attention</h2>
        {live > 0 ? (
          <span className="rounded-full bg-brand-orangeFill px-2 py-0.5 text-[11px] font-bold leading-[1.4] tabular-nums text-white">
            {live}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: STAGE.pursuit.color }}
          />
        )}
        {note && <span className="ml-auto text-[11.5px] text-ink-muted">{note}</span>}
      </div>

      <ul>
        {rows.map((r) => (
          <PinnedRow key={r.id} row={r} last={false} />
        ))}
        {items.map((it, i) => (
          <AttentionRow key={it.id} item={it} last={i === items.length - 1} />
        ))}
      </ul>

      {/* ONE LINE, not an empty card. The card keeps its frame either way -- a card that
          vanishes changes the page's shape -- but the previous 8-row-tall centred block
          made "nothing to do" the largest thing on the screen. */}
      {rows.length === 0 && items.length === 0 && (
        <p className="px-5 py-3 text-[13px] text-ink-muted">
          <span className="font-semibold text-brand-navy">You&apos;re caught up.</span> New matches land here as
          grants are scored.
        </p>
      )}

      {ambient && <AmbientRow note={ambient} />}
    </section>
  );
}

// The IntellEngine observation. NOT A PANEL: no card, no header, no avatar, no name, no
// chat affordance. One row appended to a list of things that need doing, because that is
// what it is — and anything more would make a note that is right two times in three look
// like a feature that is wrong one time in three.
//
// The eyebrow runs INLINE on the first line rather than stacked above it. Stacking costs
// about 19px, which the page does not have at 900px, and it also turns the row into a
// little header-plus-body block — the thing this is deliberately not.
//
// Libre Baskerville italic is doing real work: the italic serif is what makes it read as
// a colleague's margin note rather than as UI copy. The action is a text link for the
// same reason — a filled button would rank it above the actual tasks above it.
function AmbientRow({ note }: { note: AmbientNote }) {
  return (
    <div className="flex items-center gap-3 border-t px-5 py-3" style={{ borderColor: "rgba(11,30,58,0.07)" }}>
      <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: BRAND.orangeDeep }} aria-hidden="true" />
      <p className="min-w-0 flex-1 font-serif text-[12.5px] italic leading-[1.5] text-brand-navy [text-wrap:pretty]">
        <span
          className="font-sans text-[9.5px] font-bold uppercase not-italic tracking-[0.14em]"
          style={{ color: BRAND.orangeDeep }}
        >
          IntellEngine{"  "}
        </span>
        {note.body}
      </p>
      <Link
        href={note.action.href}
        className="inline-flex shrink-0 items-center gap-1.5 border-b border-brand-navy/30 pb-px text-[12px] font-semibold text-brand-navy transition-colors hover:border-brand-orangeDeep hover:text-brand-orangeDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
        {note.action.label}
        <ArrowRight className="h-[13px] w-[13px]" aria-hidden="true" />
      </Link>
    </div>
  );
}

// A pinned queue row. Its control is the state indicator: orange and live when the queue
// has something in it, grey and genuinely disabled at zero. A disabled control here is
// honest in a way the "Soon" nav links were not -- the destination exists and works, there
// is simply nothing in the queue right now, and that is a fact about today's data rather
// than a feature that was never built.
function PinnedRow({ row, last }: { row: DashPinnedRow; last: boolean }) {
  const live = row.count > 0 && row.href !== null;
  const Icon = row.icon;
  return (
    <li className={`flex items-center gap-[13px] px-5 py-3 ${last ? "" : "border-b border-hairline"}`}>
      <span
        aria-hidden="true"
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-pill"
        style={{ backgroundColor: live ? STAGE[row.tone].tint : "rgba(11,30,58,0.04)" }}
      >
        <Icon
          className="h-[15px] w-[15px]"
          style={{
            color: live
              ? row.tone === "client"
                ? STAGE.client.text
                : STAGE[row.tone].color
              : INK.faint,
          }}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-brand-navy">{row.title}</p>
          <span
            className="shrink-0 rounded-full px-1.5 py-px text-[11px] font-bold leading-[1.4] tabular-nums"
            style={
              live
                ? { backgroundColor: STAGE.triage.color, color: "#fff" }
                : { backgroundColor: "rgba(11,30,58,0.05)", color: INK.subtle }
            }
          >
            {row.count}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-ink-subtle">{row.description}</p>
      </div>
      {live ? (
        <Link
          href={row.href as string}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sharp bg-brand-orangeFill px-3.5 text-[12.5px] font-semibold text-white transition-colors duration-[120ms] hover:bg-brand-orangeFillHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          {row.actionLabel}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      ) : (
        <span
          aria-disabled="true"
          className="inline-flex h-8 shrink-0 cursor-default items-center rounded-sharp px-3.5 text-[12.5px] font-semibold"
          style={{ backgroundColor: "rgba(11,30,58,0.05)", color: INK.faint }}
        >
          {row.actionLabel}
        </span>
      )}
    </li>
  );
}

function AttentionRow({ item, last }: { item: DashActionItem; last: boolean }) {
  const Icon = item.icon;
  const tone = item.tone ?? "triage";
  const affordance = item.affordance ?? (item.href ? { kind: "chevron" as const } : { kind: "none" as const });

  const row = (
    <div className={`flex items-center gap-[13px] px-5 py-3 ${last ? "" : "border-b border-hairline"}`}>
      {Icon && (
        <span
          aria-hidden="true"
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-pill"
          style={{ backgroundColor: STAGE[tone].tint }}
        >
          <Icon
            className="h-[15px] w-[15px]"
            // stage-client's raw colour fails contrast, so its text companion is used
            // for the glyph — the same rule the pipeline dots follow.
            style={{ color: tone === "client" ? STAGE.client.text : STAGE[tone].color }}
          />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-brand-navy">{item.title}</p>
        {item.description && <p className="mt-0.5 text-xs text-ink-subtle">{item.description}</p>}
      </div>
      {item.busy ? (
        // Small orange text on white -- the burnt variant, not brand orange. See
        // BRAND.orangeDeep. The spinner keeps the brand hue: a 14px glyph is not type.
        <span
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold"
          style={{ color: BRAND.orangeDeep }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: BRAND.orange }} />
          In progress
        </span>
      ) : affordance.kind === "pill" ? (
        <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sharp bg-brand-orangeFill px-3.5 text-[12.5px] font-semibold text-white">
          {affordance.label}
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      ) : affordance.kind === "chevron" ? (
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" />
      ) : affordance.kind === "blocked" ? (
        <span className="shrink-0 text-xs font-medium text-ink-subtle">Blocked</span>
      ) : null}
    </div>
  );

  return <li>{item.href ? <Link href={item.href} className="block hover:bg-page/60">{row}</Link> : row}</li>;
}



function QuickAction({
  href,
  icon: Icon,
  title,
  sub,
  featured,
  external,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  sub: string;
  featured?: boolean;
  external?: boolean;
}) {
  const cls = `flex flex-col gap-2 rounded-2xl p-5 shadow-card transition ${
    featured ? "bg-brand-navy text-white" : "border border-brand-navy/[0.08] bg-white text-brand-navy hover:border-brand-navy/20"
  }`;
  const inner = (
    <>
      <Icon className={`h-6 w-6 ${featured ? "text-brand-orange" : "text-brand-navy"}`} />
      <span className="mt-1 text-[15px] font-semibold">{title}</span>
      <span className={`text-[12.5px] ${featured ? "text-white/70" : "text-muted-foreground"}`}>{sub}</span>
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  );
}
