import Anthropic from "@anthropic-ai/sdk";

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey });
}

// Analysis engine model. Sonnet balances quality and cost for high-volume
// matching (each ingest scores the full client roster).
export const MODEL = "claude-sonnet-4-6";

// Cheap model for light, high-volume, low-stakes judgments that are NOT the
// occupancy scorer -- e.g. the forecasted "on the horizon" relevance rank, which
// reads ~240 short summaries in one call and only orders/filters (no seat, no
// fit score). Kept distinct from MODEL so a relevance pass never silently runs
// on the expensive matcher model.
export const CHEAP_MODEL = "claude-haiku-4-5-20251001";

// Most-capable model, for LOW-VOLUME, HIGH-JUDGMENT conversational reasoning where
// depth matters more than per-call cost -- the GrantBot chat surfaces. Deliberately
// SEPARATE from MODEL: the matcher scores the full roster on every ingest and must
// stay on the cheaper Sonnet, so this is opt-in per surface, never a blanket swap.
// (Same string as intel-review.ts's INTEL_MODEL, which already runs the QA pass on
// Opus 5 in production.)
export const OPUS_MODEL = "claude-opus-5";
