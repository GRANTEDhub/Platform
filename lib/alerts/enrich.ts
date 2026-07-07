import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import type { Grant, ReviewCard } from "@/types/database";
import type { AlertEnrichment } from "./types";

// LLM enrichment for the grant alert: the model writes ONLY the editorial /
// narrative tokens. Facts (award, deadline, match, eligibility, FON) are injected
// deterministically elsewhere and are given here as READ-ONLY context so the copy
// is accurate -- the model must not restate or invent any number/date. Output is
// shape-validated; on any failure the caller falls back to deterministic defaults.

const SYSTEM = `You write concise, factual copy for GRANTED, a U.S. grant-consulting firm.
You are given a grant's facts as READ-ONLY context and must return ONLY short editorial fields for a one-page alert.
Rules:
- Do NOT invent or restate dollar amounts, deadlines, percentages, or eligibility — those are rendered separately from verified data.
- Domestic U.S. framing. Plain, direct language. No hype, no over-promising, no em-dashes.
- headline: punchy, ~30-45 characters, reads on one or two lines (e.g. "FEMA Grant for Faith-based Orgs").
- alertLabel: short program tag for a pill, e.g. "FEMA NSGP Alert".
- programName: the clean, human-readable PROGRAM name in Title Case (e.g. "Nonprofit Security Grant Program"). Do NOT return the raw funding agency/org name and do NOT use ALL CAPS. If no distinct program name exists, write a short descriptive one.
- programShort: the program acronym/short name if one clearly exists (e.g. "NSGP"); else "".
- whatItFundsIntro: one short lead-in line ending with a colon.
- whatItFunds: 4-10 very short chip labels (1-3 words each) of fundable items/uses.
- eligibilitySummary: 1-2 tight sentences summarizing WHO CAN APPLY. Ground it strictly in the provided eligible_entity_types, geographic_eligibility, and ineligible_entities: stay factually faithful (do not add or drop eligibility categories), but readable, not a raw dump. Note key ineligibility briefly only if it matters.
- eligibilityNote: a SHORT labeled nuance note ONLY if one clearly applies (e.g. reimbursement, pre-registration). Object {label: 2-4 words, body: 1-2 short sentences}. Otherwise null.
- ctaSendItems: what the org should send us to start, e.g. "your top security priorities and any incident history".
- riskCallout: the single make-or-break factor, or null if none is clear. Object {label:"The make-or-break factor", points: a VERY short badge only (max ~6 words, e.g. "Risk = 15 of 40 pts") or omit, never a sentence, headline: ONE punchy sentence, separate from points, body: 2-4 sentences}.
Return a single JSON object with exactly these keys: headline, alertLabel, programName, programShort, whatItFundsIntro, whatItFunds, eligibilitySummary, eligibilityNote, ctaSendItems, riskCallout.`;

function factsContext(g: Grant, card: ReviewCard): string {
  return JSON.stringify(
    {
      title: g.title,
      funder: g.funder,
      description: g.description,
      description_short: card.description_short,
      focus_areas: g.focus_areas,
      program_type: g.program_type,
      eligible_entity_types: g.eligible_entity_types,
      geographic_eligibility: g.geographic_eligibility,
      ineligible_entities: g.ineligible_entities,
      incumbent_risk: g.incumbent_risk,
      technical_burden_flags: g.technical_burden_flags,
      scoring_rubric: g.scoring_rubric,
      why_this_org: card.why_this_org,
      concept_synopsis: card.concept_synopsis,
    },
    null,
    2,
  );
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
}

// Cap a string without cutting mid-word: trim back to the last whole word and
// add an ellipsis.
function truncateWords(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+\S*$/, "").replace(/[.,;]$/, "") + "…";
}

// Cap on a SENTENCE boundary so copy never ends mid-sentence (e.g. the eligibility
// summary, which reads as prose). Trim to the last complete sentence within the
// limit; only if the first sentence itself overruns do we fall back to a
// word-boundary ellipsis.
function truncateToSentence(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  const slice = t.slice(0, n);
  const m = slice.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].trim().length >= 40) return m[0].trim();
  return truncateWords(t, n);
}

// Validate + normalize the model output into AlertEnrichment. Returns null if the
// core narrative isn't usable (caller then falls back to deterministic defaults).
function validate(raw: unknown): AlertEnrichment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const headline = typeof o.headline === "string" ? o.headline.trim() : "";
  if (!headline) return null;
  let riskCallout: AlertEnrichment["riskCallout"] = null;
  if (o.riskCallout && typeof o.riskCallout === "object") {
    const r = o.riskCallout as Record<string, unknown>;
    const body = typeof r.body === "string" ? r.body.trim() : "";
    if (body) {
      // Keep the badge short so it can't run into the headline (a sentence-long
      // "points" was the garble we're fixing).
      const rawPoints = typeof r.points === "string" ? r.points.trim() : "";
      const points = rawPoints && rawPoints.split(/\s+/).length <= 8 && rawPoints.length <= 48 ? rawPoints : undefined;
      riskCallout = {
        label: typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 40) : "The make-or-break factor",
        points,
        headline: typeof r.headline === "string" ? r.headline.trim().slice(0, 120) : "",
        body: body.slice(0, 600),
      };
    }
  }

  let eligibilityNote: AlertEnrichment["eligibilityNote"] = null;
  if (o.eligibilityNote && typeof o.eligibilityNote === "object") {
    const n = o.eligibilityNote as Record<string, unknown>;
    const nbody = typeof n.body === "string" ? n.body.trim() : "";
    if (nbody) {
      eligibilityNote = {
        label: typeof n.label === "string" && n.label.trim() ? n.label.trim().slice(0, 30) : "Note",
        body: nbody.slice(0, 220),
      };
    }
  }

  return {
    headline: headline.slice(0, 60),
    alertLabel: typeof o.alertLabel === "string" ? o.alertLabel.trim().slice(0, 40) : "",
    programName: typeof o.programName === "string" ? o.programName.trim().slice(0, 70) : "",
    programShort: typeof o.programShort === "string" ? o.programShort.trim().slice(0, 24) : "",
    whatItFundsIntro: typeof o.whatItFundsIntro === "string" ? o.whatItFundsIntro.trim() : "",
    whatItFunds: asStringArray(o.whatItFunds).slice(0, 10),
    eligibilitySummary: typeof o.eligibilitySummary === "string" ? truncateToSentence(o.eligibilitySummary, 280) : "",
    eligibilityNote,
    ctaSendItems: typeof o.ctaSendItems === "string" ? o.ctaSendItems.trim() : "",
    riskCallout,
  };
}

export async function enrichAlert(g: Grant, card: ReviewCard): Promise<AlertEnrichment | null> {
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      system: SYSTEM,
      messages: [
        { role: "user", content: `Grant facts (read-only):\n${factsContext(g, card)}\n\nReturn the JSON object now.` },
      ],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return validate(JSON.parse(match[0]));
  } catch {
    return null; // deterministic fallbacks take over
  }
}
