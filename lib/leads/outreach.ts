import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { sanitizeOutreachEmail } from "@/lib/email/sanitize";

// AI-drafted WARM outreach for a grant-matched lead. Grounded entirely in the
// grant hook we already scored (why_snapshot / concept_snapshot / fit / role /
// grant title+funder) -- the model invents nothing. Draft-then-human-approve:
// this only DRAFTS; a human edits and explicitly approves before anything sends.

export interface OutreachContext {
  orgName: string;
  orgType: string | null;
  contactName: string | null;
  grantTitle: string | null;
  funder: string | null;
  fitScore: number | null;
  proposedRole: string | null;
  why: string[] | null; // why_snapshot
  concept: string | null; // concept_snapshot
}

const SYSTEM = `You draft a short, warm outreach email for GRANTED, a U.S. grant consulting firm.

CONTEXT: GRANTED discovered a non-client organization whose profile fits a specific grant we are already tracking. This is a FIRST contact -- they have never heard from us -- but it is warm because we lead with a concrete, relevant funding opportunity, not a generic pitch.

WRITE THE EMAIL TO:
1. Open by naming the specific grant and, in one or two sentences, why it genuinely fits this organization (draw ONLY from the provided fit context).
2. Include ONE brief line introducing GRANTED as a grant consulting firm that helps organizations like theirs find and win funding (first contact -- they need to know who we are).
3. Say plainly what the opportunity could fund / the role they'd play, grounded in the provided concept.
4. Offer to help them pursue it and invite a short call. Keep it to a tight few short paragraphs.

HARD RULES:
- Ground every factual claim in the provided context. Do NOT invent award amounts, deadlines, eligibility, credentials, or track record. If a detail is not provided, do not state it.
- Do NOT use em dashes anywhere.
- NO signature block and NO sign-off name (the sender adds their own). Do not write "[Your Name]" or a closing signature.
- Plain text, no markdown. Warm and direct, not salesy. No overpromising ("could support", not "will win").

Return via the submit_draft tool: a concise subject line (lead with the grant) and the email body.`;

export async function draftOutreach(ctx: OutreachContext): Promise<{ subject: string; body: string }> {
  const anthropic = getAnthropicClient();

  const userContent = `ORGANIZATION: ${ctx.orgName}${ctx.orgType ? ` (${ctx.orgType})` : ""}
${ctx.contactName ? `CONTACT: ${ctx.contactName}` : "CONTACT: unknown (write without a personal salutation)"}

GRANT: ${ctx.grantTitle ?? "(untitled opportunity)"}${ctx.funder ? `\nFUNDER: ${ctx.funder}` : ""}
FIT SCORE: ${ctx.fitScore ?? "n/a"} (2 = conditional fit, 3 = strong fit)
PROPOSED ROLE: ${ctx.proposedRole ?? "n/a"}

WHY IT FITS (use these points, do not invent others):
${(ctx.why ?? []).map((w) => `- ${w}`).join("\n") || "- (no specific points provided)"}

WHAT IT COULD FUND / CONCEPT:
${ctx.concept ?? "(none provided)"}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0.5,
    system: SYSTEM,
    tools: [
      {
        name: "submit_draft",
        description: "Return the drafted outreach email. Call exactly once.",
        input_schema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["subject", "body"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_draft" },
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error("Draft truncated at max_tokens -- retry.");
  }
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return a draft.");
  }
  const out = toolUse.input as { subject?: string; body?: string };
  const subject = (out.subject ?? "").trim() || "A grant that fits your work";
  // Belt-and-suspenders: the prompt forbids a signature, but sanitize anyway
  // (strips a stray Subject: line, resolves [Contact Name], drops [Your Name]).
  const body = sanitizeOutreachEmail((out.body ?? "").trim(), ctx.contactName);
  return { subject, body };
}
