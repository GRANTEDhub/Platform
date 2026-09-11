import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { gatherFirmPack } from "@/lib/grantbot/firm-gather";
import { buildFirmSystemPrompt } from "@/lib/grantbot/firm-prompt";
import { budgetHistory, type HistoryTurn } from "@/lib/grantbot/history";

// One firm-bot turn: gather the roster, build the prompt, call the model, return the text. The
// ephemeral, roster-wide sibling of turn.ts.
//
// ── EPHEMERAL, BY DESIGN (Brick 1) ──
//
// NOTHING is persisted. There is no grantbot_conversations row (that table's client_id is NOT NULL —
// a firm thread has no client, which is exactly why persistence waits for the Brick 2 migration), no
// appendUser/appendAssistant, no store read. The running transcript is supplied by the caller (the
// page holds it in React state) and passed back each turn; a refresh is a clean slate. This is a
// REASONING PROOF — persistence, the switcher, and tools are later bricks.
//
// ── NO TOOLS ──
//
// A single model call, no tool loop. The firm bot is a pure reasoning surface here; "add a grant" and
// any other action is Brick 4. So there is no tool set, no dispatch, no request-body-derived anything.

// The model. Mirrors the per-client GrantBot (MODEL = Sonnet 4.6) so Brick 1 is a faithful copy of
// the live bot. It is a NAMED CONSTANT precisely so the head-to-head has a one-line lever: if the
// roster-wide strategy read wants more depth than Sonnet gives, bump this to "claude-opus-5" (and,
// if still wanted, add adaptive thinking) — the architecture does not change, only this line.
const FIRM_MODEL = MODEL;

const MAX_MESSAGE_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 4000;
const CALL_TIMEOUT_MS = 120_000;

// Off unless exactly "true". Read SERVER-SIDE, never NEXT_PUBLIC_. Default-off means the firm bot's
// route 404s and its page is unreachable in prod until the env var is flipped + redeployed — the same
// instant-revert discipline as every other GrantBot capability. Brick 1 adds only NEW files (no edit
// to any live path), so "off" is byte-identical regardless; the flag is the discoverability gate.
export function firmGrantbotEnabled(): boolean {
  return process.env.GRANTBOT_FIRM_ENABLED === "true";
}

export interface FirmTurnMessage {
  role: "user" | "assistant";
  text: string;
}

export interface FirmTurnInput {
  // The running transcript from the caller, oldest-first, EXCLUDING the new message. Ephemeral —
  // supplied by the page, never read from a store.
  history: FirmTurnMessage[];
  message: string;
  generatedBy: string;
  actorRole: string;
  now?: () => Date;
}

export type FirmTurnOutcome =
  | { ok: true; text: string; usage: Anthropic.Usage | null }
  | { ok: false; message: string };

export async function runFirmTurn(input: FirmTurnInput): Promise<FirmTurnOutcome> {
  const text = input.message.trim();
  if (!text) return { ok: false, message: "Empty message." };
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, message: `Message is too long (${text.length} characters, max ${MAX_MESSAGE_CHARS}).` };
  }
  const now = input.now ?? (() => new Date());

  try {
    // Inside the try so a roster-load failure (gatherFirmPack THROWS on a query error rather than
    // returning a fake-empty roster) becomes a clean failed turn, not an unhandled 500. The model is
    // never called on a roster that failed to load.
    const { pack } = await gatherFirmPack({
      generatedBy: input.generatedBy,
      actorRole: input.actorRole,
      generatedAt: now().toISOString(),
    });
    const prompt = buildFirmSystemPrompt({ pack });

    // Reuse the per-client history budgeter (pure): failed/empty assistant turns are dropped, a
    // leading assistant turn is trimmed (the API requires a user first), newest-first survives a
    // squeeze. The caller's transcript carries no error field, so every turn maps error:null.
    const history: HistoryTurn[] = input.history.map((m) => ({
      role: m.role,
      content: [{ type: "text" as const, text: m.text }],
      error: null,
    }));
    const { messages, dropped } = budgetHistory(history, text);

    const modelMessages: { role: "user" | "assistant"; content: string }[] = dropped
      ? [
          {
            role: "user" as const,
            content: `[${dropped} earlier message(s) in this conversation were dropped to fit the context budget. If an answer depends on something said earlier that you cannot see, say so.]`,
          },
          ...messages,
        ]
      : messages;

    const anthropic = getAnthropicClient();
    const res = await anthropic.messages.create(
      {
        model: FIRM_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: prompt.system,
        messages: modelMessages as Anthropic.MessageParam[],
      },
      { timeout: CALL_TIMEOUT_MS, maxRetries: 1 },
    );
    const answer = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!answer) return { ok: false, message: "The model returned no text." };
    return { ok: true, text: answer, usage: res.usage ?? null };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Unknown error calling the model." };
  }
}
