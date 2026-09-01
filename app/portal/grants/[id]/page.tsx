import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { ArrowRight, Sparkles } from "lucide-react";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { GrantReviewConsole, type ReviewKeyDetail, type ReviewMeta } from "@/components/report/grant-review-console";
import { DecisionBar } from "@/components/report/decision-bar";
import { pursuitClientAccessEnabled, intellEngineComingSoon } from "@/lib/pursuit/access";
import { ConceptProposalUpsell } from "@/components/report/concept-upsell";
import { ClientConceptProposal } from "@/components/report/client-concept-proposal";
import { getConceptProposal } from "@/lib/concept/store";
import { viewFitFactors, blockingReason } from "@/lib/report/fit-factors";
import { wasCalibrated } from "@/lib/grants/calibration";
import { computeEligibility } from "@/lib/intellengine/eligibility";
import { FIT_BAND, deadlineDaysLeft, isOverdue } from "@/lib/report/shape";
import { resolveFit } from "@/lib/report/qa-override";
import { buildRecommendation, buildVerdict, type HardKill } from "@/lib/report/recommendation";
import { fitNarrativeEnabled } from "@/lib/grants/fit-narrative";
import { MarkRead } from "@/components/report/mark-read";
import { formatAwardRange, compactCostShare } from "@/lib/grants/format";
import { BRAND } from "@/lib/brand";
import { clientAllowableUses } from "@/lib/grants/allowable-uses";
import type { Client, FactorScores, Grant, CardDecision, PursuitPath } from "@/types/database";

export const dynamic = "force-dynamic";

// The client's own copy of one matched grant.
//
// IT IS THE SAME SCREEN AS STAFF'S, deliberately and by instruction — GrantReviewConsole,
// identical frame, identical positions — so a change to the review screen lands on both
// sides instead of the portal drifting a release behind. It replaced ReportDetail, which
// was the pre-redesign layout and had become the only place in the product still drawing
// a grant the old way.
//
// FOUR THINGS A CLIENT DOES NOT GET, and every one of them is a passed-in child rather
// than a fork inside the frame:
//   decision      DecisionBar (Pursue / Save / Pass, with the pursuit chooser on premium)
//                 instead of the staff release + send-alert bar. Outreach is never theirs.
//   concept       read-only pointer at the draft; they may EDIT one we sent, never
//                 generate or regenerate. Base tier sees the upsell instead.
//   feedback      null. Score feedback writes match_feedback against a profiles row,
//                 which a portal member does not have. Their Pass reason already feeds
//                 the same calibration store via DecisionBar.
//   scoreFactors  null. The backfill spends a real scorer call; not the client's to spend.
//
// Reached from Grant Alerts (?from=alerts, before the grant is in their Report) as well as
// from the Report itself, so the back link follows where they came from.

type GrantEmbed = Pick<
  Grant,
  | "id" | "source_url" | "title" | "funder" | "fon" | "assistance_listings" | "focus_areas"
  | "submission_deadline" | "period_of_performance" | "cost_share" | "num_awards" | "description" | "description_brief"
  | "allowable_uses"
  | "award_range_min" | "award_range_max" | "award_range_is_estimate"
  | "eligible_entity_types" | "geographic_eligibility" | "ineligible_entities" | "hard_disqualifiers"
  | "skip_reason" | "grant_status"
>;

type CardRow = {
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
  decision: CardDecision;
  pursuit_path: PursuitPath | null;
  card_type: string;
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

// Cut an engine string at a sentence boundary — only ever CUT, never paraphrased, so
// nothing is asserted that the engine did not itself write. Same helper as the staff page.
function firstSentences(raw: string | null | undefined, max = 2): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const parts = s.match(/[^.!?]+[.!?]+/g);
  if (!parts) return s.endsWith(".") ? s : `${s}.`;
  return parts.slice(0, max).join(" ").trim();
}

export default async function PortalGrantDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { from?: string };
}) {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("account_managed, org_type, location_city, location_state")
    .eq("id", org.clientId)
    .single<Pick<Client, "account_managed" | "org_type" | "location_city" | "location_state">>();

  // Typed `any`: the conditional `.not()` below sends the query builder's generic into a
  // "type instantiation is excessively deep" error if inferred.
  let query: any = supabase
    .from("review_cards")
    .select(
      "fit_score, proposed_role, why_this_org, concept_synopsis, factor_scores, qa_fit_score, qa_factor_scores, qa_sources, qa_narrative, qa_status, qa_engine_fit_score, reasoning_context, decision, pursuit_path, card_type, grants(id, source_url, title, funder, fon, assistance_listings, focus_areas, submission_deadline, period_of_performance, cost_share, num_awards, description, description_brief, allowable_uses, award_range_min, award_range_max, award_range_is_estimate, eligible_entity_types, geographic_eligibility, ineligible_entities, hard_disqualifiers, skip_reason, grant_status)",
    )
    .eq("id", params.id)
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect");
  // Same release gate as everywhere else (0059): a direct URL hit on an unreleased card
  // must 404 exactly as it is invisible everywhere else, not merely unlinked.
  if (client?.account_managed) query = query.not("sme_released_at", "is", null);
  const { data } = await query.maybeSingle();

  const card = data as CardRow | null;
  const g = grantOf(card?.grants ?? null);
  if (!card || !g) notFound();

  // Coalesce the engine score/factors against the QA override layer (migration 0088), staleness-guarded —
  // identical resolution to the staff page so the same card reads the same way on both sides. Null today.
  const resolved = resolveFit(card);
  const effFit: 1 | 2 | 3 = resolved.fitScore ?? card.fit_score;
  const effFactors = resolved.factorScores;

  const tier = client?.account_managed ? "premium" : "base";
  // Premium clients see their team's concept proposal and may edit it. concept_proposals
  // is admin-only RLS so this reads service-role; the card query above already pinned the
  // card to this client and applied the release gate.
  const conceptRow = client?.account_managed ? await getConceptProposal(params.id) : null;

  // How much else is waiting in their Report. Same predicate as their Report list, so the
  // two cannot disagree about the count.
  const { count: remainingCount } = await supabase
    .from("review_cards")
    .select("id", { count: "exact", head: true })
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect")
    .eq("decision", "pending")
    .neq("id", params.id);
  const remaining = remainingCount ?? 0;

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

  // Composed from what the engine already wrote, never generated here — identical
  // derivation to the staff page so the same card reads the same way on both sides.
  const why = (card.why_this_org ?? []).filter(Boolean);
  const calibrated = wasCalibrated(card.reasoning_context?.fit_score_derivation);
  const rationale = {
    lead: firstSentences(why[0] ?? card.concept_synopsis, 2),
    blocking: blockingReason(factors, effFit, { calibrated }),
    mitigation: firstSentences(card.reasoning_context?.consortium_rationale, 2),
    // Step C: the QA client-safe narrative replaces the assembled paragraph on an applied+fresh demote. It
    // is client-safe by construction (guarded at generation), so it rides to the portal exactly like console.
    narrative: resolved.narrative,
  };

  const days = deadlineDaysLeft(g.submission_deadline);
  const deadlineLabel = fmtDate(g.submission_deadline);

  // The go/no-go VERDICT LEAD — CLIENT side (flag-gated: FIT_NARRATIVE_ENABLED). Identical derivation to
  // the staff page (same pin, same hard kills), so the same card reads the same number on both sides. side
  // "client" gates the phrasing: a go/marginal renders as the client's own advice, a no-go returns null
  // (never shown to the client, like a PASS). Flag OFF → no pin, no lead, byte-identical to today.
  const verdictEnabled = fitNarrativeEnabled();
  const hardKill: HardKill | null = verdictEnabled
    ? eligibility.level === "ineligible"
      ? { kind: "ineligible", detail: eligibility.structuralNote }
      : days !== null && days < 0
        ? { kind: "closed" }
        : null
    : null;
  const displayFit: 1 | 2 | 3 = hardKill?.kind === "ineligible" ? 1 : effFit;
  const verdictLead = verdictEnabled ? buildVerdict(displayFit, hardKill, org.clientName, "client") : null;

  // Suppress the fit prose ONLY when a no-go LEAD is actually rendered (`hardKill && verdictLead`) — the same
  // expression as the staff page. On the CLIENT a no-go lead is null (`buildVerdict(…, "client")` returns null
  // for a hard kill), so `verdictLead` is null here and the rationale is KEPT: there is no lead for the prose
  // to contradict, and blanking it would only strip the client's why-this-grant explanation (Codex #471). The
  // closed/ineligible facts already surface in the deadline tile / eligibility callout. Flag OFF → hardKill
  // null → rationaleForRender === rationale, byte-identical.
  const rationaleForRender =
    hardKill && verdictLead ? { lead: null, blocking: null, mitigation: null, narrative: null } : rationale;

  const meta: ReviewMeta[] = [
    { label: "Award range", value: formatAwardRange(g.award_range_min, g.award_range_max) },
    {
      label: "Deadline",
      value: deadlineLabel ?? "Not stated",
      ...(isOverdue(days) ? { tone: "danger" as const } : {}),
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
  if (days !== null) {
    keyDetails.push(
      days > 0
        ? { label: "Days remaining", value: String(days) }
        : days === 0
          ? { label: "Days remaining", value: "Closes today" }
          : { label: "Closed", value: `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago` },
    );
  }

  const fromAlerts = searchParams?.from === "alerts";
  const backHref = fromAlerts ? "/portal/triage" : "/portal/grants";
  const backLabel = fromAlerts ? "Grant Alerts" : "Grant Report";

  const monogram = (() => {
    const parts = (org.clientName ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "—";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  })();

  const conceptReady = conceptRow?.status === "ready";

  return (
    <>
      <GrantReviewConsole
        backHref={backHref}
        backLabel={backLabel}
        clientName={org.clientName}
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
          remaining > 0 ? (
            <>
              <strong className="font-semibold text-brand-navy">{remaining} more</strong> in your Grant Report
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
        // agency's own prose. Same fallback on the console detail, so the two sides
        // cannot describe the same grant differently.
        summary={g.description_brief || g.description}
        // Flag-gated AND empty-hidden for the client: clientAllowableUses returns the
        // parsed list only when ALLOWABLE_USES_CLIENT_VISIBLE is on and it actually has
        // items, else null (render nothing). A verified-empty NOFO -- reference-style,
        // costs governed by 2 CFR 200 rather than itemized -- shows NO section here rather
        // than the "Ask our team" sentinel, which stays a staff-only signal on the roadmap.
        allowableUses={clientAllowableUses(g.allowable_uses)}
        meta={meta}
        eligibility={eligibility}
        rationale={rationaleForRender}
        factors={factors}
        // Spends a real scorer call — not the client's to spend.
        scoreFactors={null}
        // Client-safe QA provenance: ONLY an applied verdict (its grounded .gov sources) reaches the
        // client — the unverified/failed "couldn't verify" states are internal QA plumbing and stay
        // staff-side (the staff page passes them; here we pass null for them). Null today (no verdict).
        qaVerdict={resolved.qa?.status === "applied" ? resolved.qa : null}
        // The closing recommendation — CLIENT side, so a SEND reads as "Pursue" (their action word) and a
        // PASS yields null (a client never sees "Pass", even on a never-hide override that sent a low-fit
        // card). Fed the DISPLAYED score + any hard kill; null hardKill when the flag is off → identical.
        recommendation={buildRecommendation(displayFit, card.proposed_role, "client", hardKill)}
        // The go/no-go verdict LEAD — client side, so only a go/marginal renders (a no-go returns null,
        // never shown to the client). Null when the flag is off.
        verdictLead={verdictLead}
        // Displayed score: the ineligible hard kill pins it to 1 (same as staff, so both sides agree);
        // otherwise the coalesced engine/QA score. Byte-identical to effFit when the flag is off.
        fitScore={displayFit}
        verdict={FIT_BAND[displayFit].label}
        consequence={
          // Same hard-kill guard as the staff page (and as rationaleForRender): null the fit-based
          // next-step where a no-go lead is rendered. On the client the lead is null (no-go is staff-only),
          // so this keeps the consequence — it matches the client's displayed score and there is no lead to
          // contradict.
          hardKill && verdictLead
            ? null
            : // When calibration drove the score, the Fit-factors sentence already states that as
              // the reason; a factor-based next-step here would point at a second, different cause
              // on the same screen. Defer to the one explanation.
              calibrated
              ? null
              : factors.lead
                ? `Worth addressing ${factors.lead.label.toLowerCase()} before you commit.`
                : effFit === 3
                  ? "No blocking factor on this one."
                  : null
        }
        // No "your feedback tunes future scoring" line: that control is staff-only here, so
        // promising it would describe something the client cannot do.
        scoreFootnote="Machine-scored · six factors weighted equally · your GRANTED team reviewed it before sending."
        // Renders nothing visible. Opening this page is the read, and the route it posts to
        // writes client_read_at ONLY -- the side is derived from the session, so this cannot
        // touch staff's column even though the two pages mount the same component.
        feedback={<MarkRead cardId={params.id} />}
        decision={
          // Dark-themed, with the thin burnt-orange "act here" left accent: renders inside the
          // fit-score box (bg-brand-chrome) as a native section, not a white card. DecisionBar
          // carries its own dark styling for this surface.
          <div className="border-l-2 border-brand-orange pl-3.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-white/[0.55]">Your decision</p>
            <p className="mt-2 text-[12.5px] leading-[1.55] text-white/[0.72]">
              Pursue it, save it for later, or pass. Passing tells us why so we stop sending
              you ones like it.
            </p>
            <div className="mt-[13px]">
              <DecisionBar
                cardId={params.id}
                decision={card.decision}
                deciderLabel={null}
                tier={tier}
                pursuitPath={card.pursuit_path}
                showPursuitPath={pursuitClientAccessEnabled()}
                intellEngineComingSoon={intellEngineComingSoon()}
              />
            </div>
          </div>
        }
        concept={
          // Read-only pointer, mirroring the staff ConceptCard's shape without its generate
          // button — a client edits a proposal we sent, never asks for one.
          tier === "premium" ? (
            <section
              className="shrink-0 rounded-sharp border border-edge bg-white px-[17px] pb-[13px] pt-3"
              style={{ borderLeftWidth: "3px", borderLeftColor: BRAND.chrome }}
            >
              <div className="flex items-center gap-[9px]">
                <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: BRAND.orangeDeep }} aria-hidden="true" />
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Concept proposal</p>
                <span className="ml-auto shrink-0 text-[11px] text-ink-muted">
                  {conceptReady ? "Ready" : "Not started"}
                </span>
              </div>
              <p className="mt-2 text-[12px] leading-[1.5] text-ink-muted">
                {conceptReady
                  ? "Scope, budget frame and named partners — read it below and edit anything that isn't right."
                  : "Your GRANTED team drafts this when a pursuit is worth scoping. Nothing to read yet."}
              </p>
              {conceptReady && (
                <a
                  href="#concept"
                  className="mt-2.5 inline-flex h-[34px] w-full items-center justify-center gap-[7px] rounded-sharp border border-edge text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
                >
                  Read the draft
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
            </section>
          ) : null
        }
        keyDetails={keyDetails}
        sourceUrl={g.source_url}
      />

      {/* Below the frame, exactly as on the staff screen: the review screen is zero-scroll,
          reading a full proposal is not. Premium gets the editable draft; base gets the
          upsell it always had. */}
      <div id="concept" className="scroll-mt-24 bg-ground px-[30px] pb-8">
        {tier === "premium" ? (
          <ClientConceptProposal row={conceptRow} />
        ) : (
          <ConceptProposalUpsell clientName={org.clientName} />
        )}
      </div>
    </>
  );
}
