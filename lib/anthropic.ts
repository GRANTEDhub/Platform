import Anthropic from "@anthropic-ai/sdk";

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey });
}

// Analysis engine model. Sonnet balances quality and cost for high-volume
// matching (each ingest scores the full client roster).
export const MODEL = "claude-sonnet-4-6";
