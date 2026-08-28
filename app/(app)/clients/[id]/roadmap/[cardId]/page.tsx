import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ReleaseToClientBar } from "@/components/report/release-bar";
import { ConceptProposalPanel } from "@/components/report/concept-proposal-panel";
import { ConceptCard } from "@/components/report/concept-card";
import { ScoreFeedback } from "@/components/report/score-feedback";
import { MarkUnreadButton } from "@/components/report/mark-unread-button";
import { ScoreFactorsBackfill } from "@/components/report/score-factors-backfill";
import { IntelReviewPanel } from "@/components/report/intel-review-panel";
import type { IntelReview } from "@/lib/grants/intel-review";
import { GrantReviewConsole, type ReviewKeyDetail, type ReviewMeta } from "@/components/report/grant-review-console";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { getConceptProposal } from "@/lib/concept/store";
import { getSentAlertForCard } from "@/lib/alerts/sent-status";
import { viewFitFactors, blockingReason } from "@/lib/report/fit-factors";
import { wasCalibrated } from "@/lib/grants/calibration";
import { computeEligibility } from "@/lib/intellengine/eligibility";
import { FIT_BAND, deadlineDaysLeft, isOverdue } from "@/lib/report/shape";
import { resolveFit } from "@/lib/report/qa-override";
import { MarkRead } from "@/components/report/mark-read";
import { formatAwardRange, compactCostShare } from "@/lib/grants/format";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { readAllowableUses } from "@/lib/grants/allowable-uses";
import type { Client, FactorScores, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

// The staff grant review — one matched grant, one client, one decision.
//
// THE CLIENT'S COPY IS THE SAME SCREEN. app/portal/grants/[id] mounts the same
// GrantReviewConsole, by instruction — the two are meant to be pixel-identical so a change
// lands on both. It differs only in the children it passes in (its own decision bar, a
// read-only concept pointer, null feedback and null score-factors). The portal used to
// render ReportDetail, a separate pre-redesign component; that is gone.
//
// There is a SECOND staff review surface — /review/[id], the cross-client Matches
// worklist reached from the command band's badge. It is unchanged and now looks nothing
// like this one. Converging them is a follow-up, not a side effect of this pass.

type GrantEmbed = Pick<
  Grant,
  | "id" | "source_url" | "title" | "funder" | "fon" | "assistance_listings" | "focus_areas"
  | "submission_deadline" | "period_of_performance" | "cost_share" | "num_awards" | "description" | "description_brief"
  | "allowable_uses"
  | "award_range_min" | "award_range_max" | "award_range_is_estimate"
  | "eligible_entity_types" | "geographic_eligibility" | "ineligible_entities" | "hard_disqualifiers"
  | "skip_reason" | "grant_status" | "status"
>;

type CardRow = {
  id: string;
  fit_score: 1 | 2 | 3;
  proposed_role: string | null;
  why_this_org: string[] | null;
  concept_synopsis: string | null;
  factor_scores: FactorScores | null;
  // The QA override layer (migration 0088); coalesced for display via resolveFit. Null today.
  qa_fit_score: number | null;
  qa_factor_scores: FactorScores | null;
  qa_sources: string[] | null;
  qa_narrative: string | null;
  qa_status: string | null;
  qa_engine_fit_score: number | null;
  reasoning_context: { consortium_rationale?: string; fit_score_derivation?: string } | null;
  decision: string;
  sme_released_at: string | null;
  // The card's OWN send copy -- the live "has this been sent" state. Recall clears it and
  // leaves the grant_alerts row alone, so this is what may gate a re-send, never the
  // history row (see AlertSend's note).
  sent_at: string | null;
  sent_to: string | null;
  grant_id: string | null;
  grants: GrantEmbed | GrantEmbed[] | null;
};

function grantOf(g: CardRow["grants"]) {
  if (!g) return null;
  return Array.isArray(g) ? g[0] ?? null : g;
}

function fmtDate(d: string | null | undefined): string | null {
  if (!d) return null;
  try {
    return format(parseISO(d), "MMM d, yyyy");
  } catch {
    return null;
  }
}

// Cut an engine string at a sentence boundary. The rationale reads as prose and a
// 400-word blob dropped mid-paragraph is not prose — but it is only ever CUT, never
// paraphrased, so nothing is asserted that the engine did not itself write.
function firstSentences(raw: string | null | undefined, max = 2): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const parts = s.match(/[^.!?]+[.!?]+/g);
  if (!parts) return s.endsWith(".") ? s : `${s}.`;
  return parts.slice(0, max).join(" ").trim();
}

export default async function ClientRoadmapDetail({ params }: { params: { id: string; cardId: string } }) {
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "id, fit_score, proposed_role, why_this_org, concept_synopsis, factor_scores, qa_fit_score, qa_factor_scores, qa_sources, qa_narrative, qa_status, qa_engine_fit_score, reasoning_context, decision, sme_released_at, sent_at, sent_to, grant_id, grants(id, source_url, title, funder, fon, assistance_listings, focus_areas, submission_deadline, period_of_performance, cost_share, num_awards, description, description_brief, allowable_uses, award_range_min, award_range_max, award_range_is_estimate, eligible_entity_types, geographic_eligibility, ineligible_entities, hard_disqualifiers, skip_reason, grant_status, status)",
    )
    .eq("id", params.cardId)
    .eq("client_id", params.id)
    .neq("card_type", "prospect")
    .maybeSingle();

  const card = data as CardRow | null;
  const g = grantOf(card?.grants ?? null);
  if (!card || !g) notFound();

  // Coalesce the engine score/factors against the QA override layer (migration 0088), staleness-guarded.
  // Everything below renders off these effective values, so an applied+fresh QA verdict IS the score the
  // reviewer and client see; with no verdict (today) they are exactly the engine's own. `effFit` stays
  // 1|2|3 because the card is scored (fit_score is non-null here) and resolveFit only swaps within 1..3.
  const resolved = resolveFit(card);
  const effFit: 1 | 2 | 3 = resolved.fitScore ?? card.fit_score;
  const effFactors = resolved.factorScores;

  const { data: client } = await supabase
    .from("clients")
    .select("name, org_type, location_city, location_state, account_managed, pipeline_stage")
    .eq("id", params.id)
    .single<
      Pick<Client, "name" | "org_type" | "location_city" | "location_state" | "account_managed" | "pipeline_stage">
    >();

  const isLead = isUnconvertedLead(client?.pipeline_stage);

  // The on-demand QA verdict lives in the STAFF-ONLY card_intel_reviews table (migration 0086), not a
  // review_cards column — so a client member (who can read their own review_cards rows under 0055)
  // cannot reach it. Only fetched when the Intel panel could render (admin, pending, unreleased);
  // is_staff() RLS admits this read.
  const showIntel = isAdmin && card.decision === "pending" && !card.sme_released_at;
  let intelReview: IntelReview | null = null;
  if (showIntel) {
    const { data: intelRow } = await supabase
      .from("card_intel_reviews")
      .select("intel_review")
      .eq("review_card_id", params.cardId)
      .maybeSingle<{ intel_review: IntelReview }>();
    intelReview = intelRow?.intel_review ?? null;
  }

  const [{ count: queueCount }, attempts, feedbackRows] = await Promise.all([
    // What is left after this one. Same predicate as the dashboard's pinned review row,
    // so the two surfaces cannot disagree about how much is waiting.
    supabase
      .from("review_cards")
      .select("id", { count: "exact", head: true })
      .eq("client_id", params.id)
      .neq("card_type", "prospect")
      .neq("decision", "passed")
      .is("sme_released_at", null)
      .neq("id", params.cardId),
    // When this pair was first carded. review_cards has no created_at, so a carded
    // match_attempt is the only record of when the match appeared.
    card.grant_id
      ? supabase
          .from("match_attempts")
          .select("created_at")
          .eq("client_id", params.id)
          .eq("grant_id", card.grant_id)
          .eq("outcome", "carded")
          .order("created_at", { ascending: true })
          .limit(1)
      : Promise.resolve({ data: null }),
    // Whether THIS reviewer already weighed in. match_feedback is append-only, so
    // without this read the control would stack a duplicate row on every visit.
    supabase
      .from("match_feedback")
      .select("agree")
      .eq("review_card_id", params.cardId)
      .eq("created_by", profile.id)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const surfacedAt = ((attempts.data ?? []) as { created_at: string }[])[0]?.created_at ?? null;
  const myFeedback = ((feedbackRows.data ?? []) as { agree: boolean }[])[0] ?? null;
  const remaining = queueCount ?? 0;

  // Concept proposal is an INTERNAL AM artifact — for a premium client (a paid deliverable
  // they later see in the portal) OR a prospect (staff prep only; per policy the prospect
  // gets the one-pager, never the paid concept). All staff, since the contractor IS the AM;
  // prospect concepts stay admin-only alongside the cold-outreach controls.
  const showConcept = !!client?.account_managed || (isLead && isAdmin);
  const conceptProposal = showConcept ? await getConceptProposal(params.cardId) : null;
  const sentAlert = isLead ? await getSentAlertForCard(params.cardId) : null;

  // ── The page's argument ───────────────────────────────────────────────────
  // Score -> weakness -> mitigation as one chain. See the note in
  // components/report/grant-review-console.tsx for why the layout exists to carry it.
  const factors = viewFitFactors(effFactors);

  const eligibility = computeEligibility({
    eligibleEntityTypes: g.eligible_entity_types,
    ineligibleEntities: g.ineligible_entities,
    hardDisqualifiers: g.hard_disqualifiers,
    skipReason: g.skip_reason,
    geographicEligibility: g.geographic_eligibility,
    clientOrgType: client?.org_type ?? null,
    clientState: client?.location_state ?? null,
  });

  // The rationale paragraph, composed from what the engine already wrote — never
  // generated here. `lead` is why it fits; `blocking` is the weakest factor's OWN stored
  // rationale, which is precisely why it can be bolded as the cap without the page
  // asserting a reason the score does not rest on; `mitigation` is the consortium
  // reasoning when the engine produced one.
  //
  // When more than one factor is short the sentence says so. The single lit row would
  // otherwise imply the lead is the only problem, which is the one way this layout can
  // mislead.
  const why = (card.why_this_org ?? []).filter(Boolean);
  const calibrated = wasCalibrated(card.reasoning_context?.fit_score_derivation);
  const rationale = {
    lead: firstSentences(why[0] ?? card.concept_synopsis, 2),
    blocking: blockingReason(factors, effFit, { calibrated }),
    mitigation: firstSentences(card.reasoning_context?.consortium_rationale, 2),
    // Step C: the QA client-safe narrative REPLACES the three pieces above when present (applied+fresh only,
    // via resolveFit's staleness guard). Null otherwise → the assembled paragraph renders as today.
    narrative: resolved.narrative,
  };

  const days = deadlineDaysLeft(g.submission_deadline);
  const overdue = isOverdue(days);
  const deadlineLabel = fmtDate(g.submission_deadline);

  const meta: ReviewMeta[] = [
    { label: "Award range", value: formatAwardRange(g.award_range_min, g.award_range_max) },
    {
      label: "Deadline",
      value: deadlineLabel ?? "Not stated",
      // The one thing on this row that can invalidate the whole page, so it stops looking
      // like the award range. See the `tone` note on ReviewMeta.
      ...(overdue ? { tone: "danger" as const } : {}),
    },
    { label: "Match required", value: compactCostShare(g.cost_share) },
    { label: "Term", value: g.period_of_performance?.trim() || "Not stated" },
    { label: "Awards expected", value: g.num_awards?.trim() || "Not stated" },
  ];

  const keyDetails: ReviewKeyDetail[] = [
    { label: "Opportunity number", value: g.fon?.trim() || "—" },
    { label: "CFDA", value: (g.assistance_listings ?? []).map((a) => a.number).join(", ") || "—" },
    { label: "Cost sharing", value: compactCostShare(g.cost_share) },
  ];
  // The countdown row used to be DROPPED once the deadline passed, which is the one state
  // where it carries the most information — a card with four key details silently became
  // three and nothing said why. It now reports the closure instead of vanishing.
  if (days !== null) {
    keyDetails.push(
      days > 0
        ? { label: "Days remaining", value: String(days) }
        : days === 0
          ? { label: "Days remaining", value: "Closes today" }
          : { label: "Closed", value: `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago` },
    );
  }


  const backHref = `/clients/${params.id}/roadmap`;
  // #8: where a send/pass DECISION lands. Grant Report while this client still has grants
  // pending review, else the client's dashboard — never the cross-client Matches queue.
  // `remaining` already excludes this card, so it is "what's left for this client after this
  // one". Derived ONCE as a single object so href, label, and the pre-decision returnNote can
  // never drift apart on a later copy edit — all three describe the same destination. Threaded
  // into ReleaseToClientBar (pass) and, via it, AlertSend's release confirm (send).
  const done =
    remaining > 0
      ? {
          href: backHref,
          label: "the Grant Report",
          note: `Either way you'll go back to the Grant Report — ${remaining} left.`,
        }
      : {
          href: `/clients/${params.id}`,
          label: "the dashboard",
          note: "Either way you'll go back to the client's dashboard — this was the last one.",
        };
  // Shared by all three gated actions. backHref is where Archive lands — the Grant
  // Report, since an archived card is gone from this queue.
  const overdueConfig = { cardId: params.cardId, daysLeft: days, deadlineLabel, backHref };
  const monogram = (() => {
    const parts = (client?.name ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "—";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  })();

  return (
    <>
      <GrantReviewConsole
        backHref={backHref}
        clientName={client?.name ?? "Client"}
        clientMonogram={monogram}
        clientMeta={
          [
            client?.org_type?.replace(/_/g, " "),
            [client?.location_city, client?.location_state].filter(Boolean).join(", ") || null,
          ]
            .filter(Boolean)
            .join(" · ") || null
        }
        queueLine={
          surfacedAt || remaining > 0 ? (
            <>
              {surfacedAt && `Match surfaced ${format(parseISO(surfacedAt), "MMM d")}`}
              {surfacedAt && remaining > 0 && " · "}
              {remaining > 0 && (
                <strong className="font-semibold text-brand-navy">{remaining} more awaiting review</strong>
              )}
            </>
          ) : null
        }
        tags={[
          ...(card.proposed_role ? [{ label: card.proposed_role, role: true }] : []),
          ...(g.focus_areas ?? []).slice(0, 1).filter((l): l is string => !!l).map((label) => ({ label, role: false })),
        ]}
        agencyLine={
          [g.funder, (g.assistance_listings ?? [])[0] && `CFDA ${(g.assistance_listings ?? [])[0].number}`]
            .filter(Boolean)
            .join(" · ") || null
        }
        title={g.title || "Untitled opportunity"}
        // The generated plain-language paraphrase (0069) when we have one, else the
        // agency's own prose. Same fallback on the client's portal detail, so the two
        // sides cannot describe the same grant differently.
        summary={g.description_brief || g.description}
        // Staff see this from day one, unconditionally: the point of the staff-only
        // week is that WE read the list and the drop rate before a client does, which
        // is impossible if the console is gated too.
        allowableUses={readAllowableUses(g.allowable_uses)}
        meta={meta}
        eligibility={eligibility}
        rationale={rationale}
        factors={factors}
        // Only ever rendered in the unscored branch. Offered to every staff reviewer
        // rather than admins only: the reviewer looking at the empty panel is the person
        // who needs the breakdown, and the route writes nothing but the six ratings.
        scoreFactors={factors.unscored ? <ScoreFactorsBackfill cardId={params.cardId} /> : null}
        // On-demand IntellEngine QA: annotate-only (never changes the score), so it needs no
        // processing gate — just admin + a still-pending, not-yet-released card. Raw verdict is
        // staff-only; the portal never passes this slot.
        intel={showIntel ? <IntelReviewPanel cardId={params.cardId} initial={intelReview} /> : null}
        // The client-safe QA badge (applied score change + grounded sources, or a "couldn't verify"
        // note) — data, not a control, so it renders on BOTH this staff page and the client portal
        // detail. Null when no QA verdict is in effect (today). The RAW analyst note is the separate
        // staff-only `intel` slot above; this carries only the applied projection.
        qaVerdict={resolved.qa}
        fitScore={effFit}
        verdict={FIT_BAND[effFit].label}
        // What the score MEANS for the next step, derived from the lit factor rather than
        // from three canned sentences keyed off the number.
        consequence={
          // Calibration-driven score: the Fit-factors sentence carries the reason; a factor-based
          // next-step here would name a second, different cause on the same screen. Defer to it.
          calibrated
            ? null
            : factors.lead
              ? `Pursue only once ${factors.lead.label.toLowerCase()} is addressed.`
              : effFit === 3
                ? "No blocking factor — this one is ready to go out."
                : null
        }
        scoreFootnote={`Machine-scored${
          surfacedAt ? ` ${format(parseISO(surfacedAt), "MMM d")}` : ""
        } · six factors weighted equally · your feedback tunes future scoring, not this score.`}
        // Rides in the `feedback` slot rather than earning a new prop on GrantReviewConsole:
        // that component is shared pixel-for-pixel with the portal, and no CONTROL in this slot
        // is ever the client's (a portal member has no profiles row to write feedback against,
        // and marking unread is the reviewer's own action). The portal does populate the slot,
        // but only with the invisible <MarkRead> stamp -- never anything pressable.
        feedback={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ScoreFeedback cardId={params.cardId} initial={myFeedback} />
            <MarkUnreadButton cardId={params.cardId} backHref={backHref} />
            {/* Opening this page is the read. Renders nothing; the route it calls also
                revalidates the report list, so going back shows the row already grey. */}
            <MarkRead cardId={params.cardId} />
          </div>
        }
        decision={
          client?.account_managed ? (
            <ReleaseToClientBar
              cardId={params.cardId}
              released={!!card.sme_released_at}
              passed={card.decision === "passed"}
              backHref={backHref}
              doneHref={done.href}
              doneLabel={done.label}
              overdue={overdueConfig}
              returnNote={done.note}
            />
          ) : isLead && isAdmin ? (
            // A prospect has no portal, so the terminal action is the cold one-pager
            // rather than a release. Admin-only: this is BizDev outreach. Dark-themed: this
            // renders inside the fit-score box (bg-brand-chrome), not a white card of its own.
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-white/[0.55]">Your decision</p>
              <p className="mb-3 mt-2 text-[12.5px] leading-[1.55] text-white/[0.72]">
                Prospects have no portal — the terminal action here is the cold one-pager.
              </p>
              <AlertSend
                cardId={params.cardId}
                tone="dark"
                sentAt={card.sent_at ?? null}
                sentTo={card.sent_to ?? null}
                recalledFrom={card.sent_at === null && sentAlert ? sentAlert : null}
                contactName={client?.name ?? null}
                overdue={overdueConfig}
              />
            </div>
          ) : (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-white/[0.55]">Your decision</p>
              <p className="mt-2 text-[12.5px] leading-[1.55] text-white/[0.72]">
                This client makes the pursuit call on their own copy of this grant. Nothing to release from here.
              </p>
            </div>
          )
        }
        concept={
          showConcept ? (
            <ConceptCard
              cardId={params.cardId}
              status={conceptProposal?.status ?? null}
              anchorHref="#concept"
              overdue={overdueConfig}
            />
          ) : null
        }
        keyDetails={keyDetails}
        sourceUrl={g.source_url}
      />

      {/* The generated concept expands BELOW the frame. The review screen is zero-scroll;
          reading a full draft is not, and pretending otherwise would mean a 386px rail
          rendering a multi-page document. */}
      {showConcept && conceptProposal && (
        <div id="concept" className="scroll-mt-24 bg-ground px-[30px] pb-8">
          <ConceptProposalPanel cardId={params.cardId} initial={conceptProposal} />
        </div>
      )}
    </>
  );
}
