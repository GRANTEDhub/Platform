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
- programShort: the program acronym/short name if one clearly exists (e.g. "NSGP"); else "".
- whatItFundsIntro: one short lead-in line ending with a colon.
- whatItFunds: 4-10 very short chip labels (1-3 words each) of fundable items/uses.
- ctaSendItems: what the org should send us to start, e.g. "your top security priorities and any incident history".
- riskCallout: the single make-or-break factor, or null if none is clear. Object: {label:"The make-or-break factor", points: optional short scoring note or omit, headline: one sentence, body: 2-4 sentences}.
Return a single JSON object with exactly these keys: headline, alertLabel, programShort, whatItFundsIntro, whatItFunds, ctaSendItems, riskCallout.`;

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
      riskCallout = {
        label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : "The make-or-break factor",
        points: typeof r.points === "string" && r.points.trim() ? r.points.trim() : undefined,
        headline: typeof r.headline === "string" ? r.headline.trim() : "",
        body,
      };
    }
  }
  return {
    headline: headline.slice(0, 60),
    alertLabel: typeof o.alertLabel === "string" ? o.alertLabel.trim().slice(0, 40) : "",
    programShort: typeof o.programShort === "string" ? o.programShort.trim().slice(0, 24) : "",
    whatItFundsIntro: typeof o.whatItFundsIntro === "string" ? o.whatItFundsIntro.trim() : "",
    whatItFunds: asStringArray(o.whatItFunds).slice(0, 10),
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
