import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ReleaseToClientBar } from "@/components/report/release-bar";
import { ConceptProposalPanel } from "@/components/report/concept-proposal-panel";
import { ConceptCard } from "@/components/report/concept-card";
import { ScoreFeedback } from "@/components/report/score-feedback";
import { GrantReviewConsole, type ReviewKeyDetail, type ReviewMeta } from "@/components/report/grant-review-console";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { getConceptProposal } from "@/lib/concept/store";
import { getSentAlertForCard } from "@/lib/alerts/sent-status";
import { viewFitFactors } from "@/lib/report/fit-factors";
import { computeEligibility } from "@/lib/intellengine/eligibility";
import { FIT_BAND, deadlineDaysLeft } from "@/lib/report/shape";
import { formatAwardRange, compactCostShare } from "@/lib/grants/format";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { Client, FactorScores, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

// The staff grant review — one matched grant, one client, one decision.
//
// THIS IS NOT THE CLIENT'S COPY. app/portal/grants/[id] renders ReportDetail for the
// client's own view of the same card, with different visibility rules and none of these
// controls. The two used to be one component; they are deliberately not any more, because
// every control added here would otherwise have to be suppressed there.
//
// There is a SECOND staff review surface — /review/[id], the cross-client Matches
// worklist reached from the command band's badge. It is unchanged and now looks nothing
// like this one. Converging them is a follow-up, not a side effect of this pass.

type GrantEmbed = Pick<
  Grant,
  | "id" | "source_url" | "title" | "funder" | "fon" | "assistance_listings" | "focus_areas"
  | "submission_deadline" | "period_of_performance" | "cost_share" | "num_awards" | "description"
  | "award_range_min" | "award_range_max" | "award_range_is_estimate"
  | "eligible_entity_types" | "geographic_eligibility" | "ineligible_entities" | "hard_disqualifiers"
  | "skip_reason" | "grant_status"
>;

type CardRow = {
  id: string;
  fit_score: 1 | 2 | 3;
  proposed_role: string | null;
  why_this_org: string[] | null;
  concept_synopsis: string | null;
  factor_scores: FactorScores | null;
  reasoning_context: { consortium_rationale?: string; fit_score_derivation?: string } | null;
  decision: string;
  sme_released_at: string | null;
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
      "id, fit_score, proposed_role, why_this_org, concept_synopsis, factor_scores, reasoning_context, decision, sme_released_at, grant_id, grants(id, source_url, title, funder, fon, assistance_listings, focus_areas, submission_deadline, period_of_performance, cost_share, num_awards, description, award_range_min, award_range_max, award_range_is_estimate, eligible_entity_types, geographic_eligibility, ineligible_entities, hard_disqualifiers, skip_reason, grant_status)",
    )
    .eq("id", params.cardId)
    .eq("client_id", params.id)
    .neq("card_type", "prospect")
    .maybeSingle();

  const card = data as CardRow | null;
  const g = grantOf(card?.grants ?? null);
  if (!card || !g) notFound();

  const { data: client } = await supabase
    .from("clients")
    .select("name, org_type, location_city, location_state, account_managed, pipeline_stage")
    .eq("id", params.id)
    .single<
      Pick<Client, "name" | "org_type" | "location_city" | "location_state" | "account_managed" | "pipeline_stage">
    >();

  const isLead = isUnconvertedLead(client?.pipeline_stage);

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
  const factors = viewFitFactors(card.factor_scores);

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
  const others = Math.max(0, factors.weakCount - (factors.lead ? 1 : 0));
  const rationale = {
    lead: firstSentences(why[0] ?? card.concept_synopsis, 2),
    blocking: factors.lead?.rationale
      ? `Capped at ${FIT_BAND[card.fit_score].label.toLowerCase()} on ${factors.lead.label.toLowerCase()} — ${
          factors.lead.rationale
        }${others > 0 ? ` (${others} other factor${others === 1 ? "" : "s"} also scored short.)` : ""}`
      : null,
    mitigation: firstSentences(card.reasoning_context?.consortium_rationale, 2),
  };

  const meta: ReviewMeta[] = [
    { label: "Award range", value: formatAwardRange(g.award_range_min, g.award_range_max) },
    { label: "Deadline", value: fmtDate(g.submission_deadline) ?? "Not stated" },
    { label: "Match required", value: compactCostShare(g.cost_share) },
    { label: "Term", value: g.period_of_performance?.trim() || "Not stated" },
    { label: "Awards expected", value: g.num_awards?.trim() || "Not stated" },
  ];

  const days = deadlineDaysLeft(g.submission_deadline);
  const keyDetails: ReviewKeyDetail[] = [
    { label: "Opportunity number", value: g.fon?.trim() || "—" },
    { label: "CFDA", value: (g.assistance_listings ?? []).map((a) => a.number).join(", ") || "—" },
    { label: "Cost sharing", value: compactCostShare(g.cost_share) },
  ];
  if (days !== null && days >= 0) keyDetails.push({ label: "Days remaining", value: String(days) });

  const backHref = `/clients/${params.id}/roadmap`;
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
        tags={[card.proposed_role, ...(g.focus_areas ?? []).slice(0, 1)].filter((t): t is string => !!t)}
        agencyLine={
          [g.funder, (g.assistance_listings ?? [])[0] && `CFDA ${(g.assistance_listings ?? [])[0].number}`]
            .filter(Boolean)
            .join(" · ") || null
        }
        title={g.title || "Untitled opportunity"}
        summary={g.description}
        meta={meta}
        eligibility={eligibility}
        rationale={rationale}
        factors={factors}
        fitScore={card.fit_score}
        verdict={FIT_BAND[card.fit_score].label}
        // What the score MEANS for the next step, derived from the lit factor rather than
        // from three canned sentences keyed off the number.
        consequence={
          factors.lead
            ? `Pursue only once ${factors.lead.label.toLowerCase()} is addressed.`
            : card.fit_score === 3
              ? "No blocking factor — this one is ready to go out."
              : null
        }
        scoreFootnote={`Machine-scored${
          surfacedAt ? ` ${format(parseISO(surfacedAt), "MMM d")}` : ""
        } · six factors weighted equally · your feedback tunes future scoring, not this score.`}
        feedback={<ScoreFeedback cardId={params.cardId} initial={myFeedback} />}
        decision={
          client?.account_managed ? (
            <ReleaseToClientBar
              cardId={params.cardId}
              released={!!card.sme_released_at}
              backHref={backHref}
              returnNote={
                remaining > 0
                  ? `Either way you'll go back to the Grant Report — ${remaining} left.`
                  : "Either way you'll go back to the Grant Report — this is the last one."
              }
            />
          ) : isLead && isAdmin ? (
            // A prospect has no portal, so the terminal action is the cold one-pager
            // rather than a release. Admin-only: this is BizDev outreach.
            <section className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]">
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
              <p className="mb-3 mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
                Prospects have no portal — the terminal action here is the cold one-pager.
              </p>
              <AlertSend
                cardId={params.cardId}
                sentAt={sentAlert?.sentAt ?? null}
                sentTo={sentAlert?.sentTo ?? null}
                contactName={client?.name ?? null}
              />
            </section>
          ) : (
            <section className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]">
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
              <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
                This client makes the pursuit call on their own copy of this grant. Nothing to release from here.
              </p>
            </section>
          )
        }
        concept={
          showConcept ? (
            <ConceptCard cardId={params.cardId} status={conceptProposal?.status ?? null} anchorHref="#concept" />
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
