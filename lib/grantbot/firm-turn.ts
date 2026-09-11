import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, OPUS_MODEL } from "@/lib/anthropic";
import { gatherFirmPack } from "@/lib/grantbot/firm-gather";
import { buildFirmSystemPrompt } from "@/lib/grantbot/firm-prompt";
import { FIRM_INSTRUCTIONS_VERSION } from "@/lib/grantbot/firm-instructions";
import { FIRM_KNOWLEDGE_VERSION } from "@/lib/grantbot/firm-knowledge";
import { budgetHistory, type HistoryTurn } from "@/lib/grantbot/history";
import { appendAssistant, appendUser, loadMessages, nextSeq, touchConversation } from "@/lib/grantbot/store";

// One firm-bot turn: gather the roster, build the prompt, call the model, PERSIST the exchange.
// The roster-wide sibling of turn.ts.
//
// ── PERSISTED (Memory / Brick 2), no longer ephemeral ──
//
// A firm thread is a grantbot_conversations row with scope='firm' (migration 0097); its messages are
// grantbot_messages rows exactly like a client thread's. The ROUTE creates-or-resolves the
// conversation (mirroring turn.ts's route) and hands this function the resolved id + the service-role
// db; this function loads the prior transcript from the store, appends the user turn, calls the
// model, and appends the assistant turn. A refresh reloads the thread from the store — it is no
// longer a clean slate. History comes from the STORE, never from the request body: a browser cannot
// forge prior turns.
//
// ── A FAILED TURN IS STILL A TURN (0080) ──
//
// The user turn is appended BEFORE the model call, and an assistant row is appended EITHER WAY — with
// the answer, or with an empty body + the error. So "it didn't answer me" always has a row to look
// at, and the persisted transcript matches what the page optimistically showed (the route returns the
// conversationId on a failure so the page keeps the bubble and continues the same thread).
//
// ── NO TOOLS ──
//
// Still a single model call, no tool loop. Cross-thread (the firm bot reaching its OTHER firm
// threads) is the next brick and adds the loop; persistence does not.

// Opus 5 for the firm bot's strategy reasoning (Shannon, 2026-09-11). Named constant so the model
// choice stays a one-line, per-surface lever; the matcher stays on the cheaper MODEL.
const FIRM_MODEL = OPUS_MODEL;

// Exported so the ROUTE can reject an oversized message BEFORE it creates a conversation — a
// length check that returned mid-runFirmTurn (after the route made the row) would leave an empty
// thread and a 200 the page mistakes for a persisted turn.
export const MAX_MESSAGE_CHARS = 20_000;
// Generous on purpose: Opus 5 runs ADAPTIVE THINKING (on by default for the firm strategy bot), and
// thinking tokens count against max_tokens. At 4000, a hard roster-strategy question spent the whole
// budget THINKING and emitted NO answer text. 16000 leaves ample room for the thinking PLUS a full
// strategy read. It is a CAP, not a charge (a short answer still bills short).
const MAX_OUTPUT_TOKENS = 16_000;
const CALL_TIMEOUT_MS = 120_000;

// Off unless exactly "true". Read SERVER-SIDE, never NEXT_PUBLIC_. Default-off means the firm bot's
// routes 404 and its page is unreachable in prod until the env var is flipped + redeployed.
export function firmGrantbotEnabled(): boolean {
  return process.env.GRANTBOT_FIRM_ENABLED === "true";
}

export interface FirmTurnInput {
  db: SupabaseClient;
  // The firm conversation this turn belongs to, already created/resolved by the route.
  conversationId: string;
  message: string;
  generatedBy: string;
  actorRole: string;
  now?: () => Date;
}

export type FirmTurnOutcome =
  | { ok: true; text: string; usage: Anthropic.Usage | null }
  | { ok: false; message: string };

export async function runFirmTurn(input: FirmTurnInput): Promise<FirmTurnOutcome> {
  const { db, conversationId } = input;
  const text = input.message.trim();
  if (!text) return { ok: false, message: "Empty message." };
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, message: `Message is too long (${text.length} characters, max ${MAX_MESSAGE_CHARS}).` };
  }
  const now = input.now ?? (() => new Date());

  // Prior transcript BEFORE this turn (excludes the message we are about to append). loadMessages
  // returns role + text-block content + error, which is exactly HistoryTurn's shape; budgetHistory
  // drops failed/empty assistant turns, so a persisted error row does not poison the next call.
  const prior = await loadMessages(db, conversationId);
  const history: HistoryTurn[] = prior.map((m) => ({ role: m.role, content: m.content, error: m.error }));

  // The user turn is recorded first: the staffer asked, whatever the model does next. seq is one
  // per conversation (0080's unique index), so a double-submit is a constraint violation, not two
  // rows at the same position.
  const userSeq = await nextSeq(db, conversationId);
  await appendUser(db, { conversationId, seq: userSeq, text });
  const assistantSeq = userSeq + 1;

  try {
    // gatherFirmPack THROWS on a query error (never a fake-empty roster), so a roster-load failure
    // lands in the catch as a persisted assistant-error row, not confident advice on "no clients".
    const { pack } = await gatherFirmPack({
      generatedBy: input.generatedBy,
      actorRole: input.actorRole,
      generatedAt: now().toISOString(),
    });
    const prompt = buildFirmSystemPrompt({ pack });

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

    const usage = toTurnUsage(res.usage);
    if (!answer) {
      // Empty text is almost always the thinking budget swallowing max_tokens before any answer
      // text. Persist the failed turn (empty body + the reason), then surface it.
      const why =
        res.stop_reason === "max_tokens"
          ? "The answer hit the output-token limit before any text was produced (the model's thinking used the whole budget). Try a more focused question."
          : "The model returned no text.";
      await appendAssistant(db, {
        conversationId,
        seq: assistantSeq,
        text: "",
        contextBlocks: prompt.manifest,
        instructionsVersion: prompt.instructionsVersion,
        methodologyVersion: prompt.knowledgeVersion,
        model: FIRM_MODEL,
        usage,
        stopReason: res.stop_reason ?? null,
        error: why,
      });
      await touchConversation(db, conversationId);
      return { ok: false, message: why };
    }

    await appendAssistant(db, {
      conversationId,
      seq: assistantSeq,
      text: answer,
      contextBlocks: prompt.manifest,
      instructionsVersion: prompt.instructionsVersion,
      methodologyVersion: prompt.knowledgeVersion,
      model: FIRM_MODEL,
      usage,
      stopReason: res.stop_reason ?? null,
      error: null,
    });
    await touchConversation(db, conversationId);
    return { ok: true, text: answer, usage: res.usage ?? null };
  } catch (err) {
    // A failed turn is still a turn: record the assistant-error row so the transcript shows the
    // failure rather than reading as though the staffer never asked. Version stamps fall back to the
    // constants (the prompt may not have been built if gather threw).
    const message = err instanceof Error ? err.message : "Unknown error calling the model.";
    await appendAssistant(db, {
      conversationId,
      seq: assistantSeq,
      text: "",
      contextBlocks: [],
      instructionsVersion: FIRM_INSTRUCTIONS_VERSION,
      methodologyVersion: FIRM_KNOWLEDGE_VERSION,
      model: FIRM_MODEL,
      error: message,
    }).catch((e) => console.error("Firm GrantBot error-row append failed", e instanceof Error ? e.message : e));
    await touchConversation(db, conversationId);
    return { ok: false, message };
  }
}

// The four numbers store.ts persists, pulled from the SDK usage shape (which carries more).
function toTurnUsage(u: Anthropic.Usage | null | undefined) {
  if (!u) return null;
  return {
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    cache_read_input_tokens: u.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
  };
}
