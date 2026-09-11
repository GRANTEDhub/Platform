import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, OPUS_MODEL } from "@/lib/anthropic";
import { gatherFirmPack } from "@/lib/grantbot/firm-gather";
import { buildFirmSystemPrompt } from "@/lib/grantbot/firm-prompt";
import { FIRM_INSTRUCTIONS_VERSION } from "@/lib/grantbot/firm-instructions";
import { FIRM_KNOWLEDGE_VERSION } from "@/lib/grantbot/firm-knowledge";
import { budgetHistory, type HistoryTurn } from "@/lib/grantbot/history";
import {
  appendAssistant,
  appendUser,
  loadMessages,
  nextSeq,
  touchConversation,
  type TurnUsage,
} from "@/lib/grantbot/store";
import type { ContextBlockRecord } from "@/lib/grantbot/prompt";
import { runToolLoop, TURN_DEADLINE_MS, type CallModel, type ToolDispatch } from "@/lib/grantbot/tool-loop";
import {
  executeFirmCrossThreadTool,
  FIRM_CROSS_THREAD_INSTRUCTION_BLOCK,
  LIST_FIRM_CONVERSATIONS_TOOL,
  LIST_FIRM_CONVERSATIONS_TOOL_NAME,
  READ_FIRM_CONVERSATION_TOOL,
  READ_FIRM_CONVERSATION_TOOL_NAME,
  type FirmCrossThreadAuditRecord,
} from "@/lib/grantbot/firm-cross-thread";

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
// ── A FAILED TURN IS STILL A TURN (0080), WRITTEN ONCE AFTER THE TRY ──
//
// The user turn is appended BEFORE the try (its own guard: a seq collision from a concurrent
// same-thread submit is caught and returned as a clean error, not a 500). The assistant row is then
// appended exactly ONCE, AFTER the try/catch — with the answer on success, or an empty body + the
// error on failure — mirroring turn.ts's single-write-after-try. This is the fix for the deferred
// review nit: the previous shape appended the answer INSIDE the try, so a transient DB fault on that
// write was caught and RE-recorded as a failure, discarding a billed answer. Now the model result is
// computed in the try and the one write happens after it, so a real answer is never converted into a
// recorded failure. "It didn't answer me" still has a row to look at, and the persisted transcript
// matches what the page optimistically showed (the route returns the conversationId on a failure so
// the page keeps the bubble and continues the same thread).
//
// ── READ-ONLY TOOLS: CROSS-THREAD (this brick) ──
//
// A bounded tool loop (runToolLoop, the same one turn.ts / intel use) with EXACTLY TWO read-only
// tools: list_firm_conversations / read_firm_conversation (firm-cross-thread.ts), so the firm bot can
// look back at its OTHER firm threads on demand. No write path, no external reach — the append-only
// transcript is untouched. There is NO separate flag: the whole firm surface is gated behind
// GRANTBOT_FIRM_ENABLED (routes 404 when off), so the tools are always present when the bot runs. The
// firm bot keeps ADAPTIVE THINKING on (its 16k budget depends on it); the loop preserves thinking
// blocks by pushing raw assistant content back verbatim, and Opus 5 + this loop (thinking on,
// tool_choice "none" on the forced-final round) is proven safe by the green intel-review eval.

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
  | { ok: true; text: string; usage: TurnUsage | null }
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

  // The user turn is recorded first: the staffer asked, whatever the model does next. seq is one per
  // conversation (0080's unique index), so a concurrent same-thread double-submit is a constraint
  // violation, not two rows at the same position — CAUGHT here and returned as a clean error the route
  // relays (200 + { conversationId, error }; the conversation already exists), so the page keeps the
  // bubble and the staffer retries, rather than the bare 500 an uncaught insert throw would produce
  // (the deferred review nit).
  const userSeq = await nextSeq(db, conversationId);
  try {
    await appendUser(db, { conversationId, seq: userSeq, text });
  } catch (e) {
    console.error("Firm GrantBot user-append failed", e instanceof Error ? e.message : e);
    return {
      ok: false,
      message:
        "Could not save your message — the conversation may have just received another message at the same moment. Try again.",
    };
  }
  const assistantSeq = userSeq + 1;

  // Version stamps + manifest for the assistant row, resolved to the built prompt on success and left
  // at the module constants if gather threw before the prompt was built — a persisted failure is still
  // a turn, and it must not depend on a prompt a roster-load error prevented from existing.
  let manifestBlocks: ContextBlockRecord[] = [];
  let instructionsVersion = FIRM_INSTRUCTIONS_VERSION;
  let knowledgeVersion = FIRM_KNOWLEDGE_VERSION;

  let answer = "";
  let usage: TurnUsage | null = null;
  let stopReason: string | null = null;
  let failure: string | null = null;
  // Stable audit sink: dispatch pushes into it AS IT RUNS, so a later-round throw still leaves the
  // audit of tools already executed on the (failed) turn's row.
  const crossThreadReads: FirmCrossThreadAuditRecord[] = [];

  try {
    // gatherFirmPack THROWS on a query error (never a fake-empty roster), so a roster-load failure
    // lands in the catch → the single after-try write records an assistant-error row, not confident
    // advice on "no clients".
    const { pack } = await gatherFirmPack({
      generatedBy: input.generatedBy,
      actorRole: input.actorRole,
      generatedAt: now().toISOString(),
    });
    // The cross-thread tool how-to rides as a turn block: appended after the cache breakpoint, before
    // the closing restatement (assembleSystem's order), so the stable prefix is unchanged.
    // buildFirmSystemPrompt takes it as data, staying pure.
    const prompt = buildFirmSystemPrompt({ pack, turnBlocks: [FIRM_CROSS_THREAD_INSTRUCTION_BLOCK] });
    manifestBlocks = prompt.manifest;
    instructionsVersion = prompt.instructionsVersion;
    knowledgeVersion = prompt.knowledgeVersion;

    const { messages, dropped } = budgetHistory(history, text);
    const baseMessages: unknown[] = dropped
      ? [
          {
            role: "user" as const,
            content: `[${dropped} earlier message(s) in this conversation were dropped to fit the context budget. If an answer depends on something said earlier that you cannot see, say so.]`,
          },
          ...messages,
        ]
      : messages;

    const anthropic = getAnthropicClient();

    // The tool set is a SERVER-SIDE constant (never from the request body, the turnBlocks rule): the two
    // read-only cross-thread tools. On "auto"/"none" `tools` stays PRESENT (a tool_use history without
    // `tools` 400s); only "none" adds tool_choice to force the final text answer. THINKING stays ON
    // (the firm bot omits `thinking`, so Opus 5's adaptive thinking runs — the 16k budget is for
    // thinking + the answer); the loop preserves the thinking blocks by pushing raw assistant content
    // back verbatim, and Opus 5 + this loop (thinking on, tool_choice "none" on the forced-final round)
    // is proven safe by the green intel-review eval.
    const toolSet = [LIST_FIRM_CONVERSATIONS_TOOL, READ_FIRM_CONVERSATION_TOOL] as unknown as Anthropic.Tool[];

    const callModel: CallModel = async ({ messages: msgs, tools, remainingMs }) => {
      const timeout = Math.min(CALL_TIMEOUT_MS, Math.max(remainingMs, 5_000));
      const res = await anthropic.messages.create(
        {
          model: FIRM_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: prompt.system,
          messages: msgs as Anthropic.MessageParam[],
          ...(tools === "off" ? {} : { tools: toolSet }),
          ...(tools === "auto" ? { tool_choice: { type: "auto" as const, disable_parallel_tool_use: true } } : {}),
          ...(tools === "none" ? { tool_choice: { type: "none" as const } } : {}),
        },
        { timeout, maxRetries: 1 },
      );
      const answerText = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      const toolUses = res.content
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const tb = b as { id: string; name: string; input?: unknown };
          return { id: tb.id, name: tb.name, input: tb.input };
        });
      return {
        text: answerText,
        toolUses,
        stopReason: res.stop_reason ?? null,
        usage: {
          input_tokens: res.usage?.input_tokens ?? null,
          output_tokens: res.usage?.output_tokens ?? null,
          cache_read_input_tokens: res.usage?.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: res.usage?.cache_creation_input_tokens ?? null,
        },
        rawContent: res.content,
      };
    };

    // Route the two tool_use names to the firm cross-thread executor, pushing the typed audit into the
    // sink as it runs. Scoped by scope='firm' inside the executor (getFirmConversation), not by a
    // clientId — the firm bot has no client.
    const dispatch: ToolDispatch = async (tu) => {
      if (tu.name === LIST_FIRM_CONVERSATIONS_TOOL_NAME || tu.name === READ_FIRM_CONVERSATION_TOOL_NAME) {
        const { resultText, audit } = await executeFirmCrossThreadTool(
          { name: tu.name, input: tu.input },
          { db, currentConversationId: conversationId },
        );
        crossThreadReads.push(audit);
        return { resultText };
      }
      return { resultText: `Unknown tool "${tu.name}". Nothing was done.` };
    };

    const loop = await runToolLoop({
      messages: baseMessages,
      // Always on: the firm surface is gated by GRANTBOT_FIRM_ENABLED, not a per-tool flag, so when the
      // bot runs it carries its tools. The loop still makes exactly ONE call when the model just answers
      // without a tool_use — the common case, so a plain question costs one call plus two tiny schemas.
      toolsEnabled: true,
      callModel,
      dispatch,
      now: () => Date.now(),
      deadlineMs: TURN_DEADLINE_MS,
    });

    answer = loop.text;
    usage = loop.usage;
    stopReason = loop.stopReason;
    if (!answer) {
      // Empty text is almost always the thinking budget swallowing max_tokens before any answer text.
      failure =
        stopReason === "max_tokens"
          ? "The answer hit the output-token limit before any text was produced (the model's thinking used the whole budget). Try a more focused question."
          : "The model returned no text.";
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : "Unknown error calling the model.";
  }

  // WRITTEN ONCE, AFTER THE TRY: the billed answer on success, or the assistant-error row on failure —
  // never both, and a transient write fault never converts a real answer into a recorded failure (the
  // deferred-nit fix). The append is non-fatal (a rare write error is logged, and the answer — already
  // computed — is still returned), so a storage hiccup degrades to "shown but not saved", not a 500.
  await appendAssistant(db, {
    conversationId,
    seq: assistantSeq,
    text: answer,
    contextBlocks: manifestBlocks,
    instructionsVersion,
    methodologyVersion: knowledgeVersion,
    model: FIRM_MODEL,
    usage,
    stopReason,
    error: failure,
    // Empty unless the model actually read another firm thread; appendAssistant omits the block then,
    // so a no-tool turn's stored row is byte-identical to before this brick.
    crossThreadReads,
  }).catch((e) => console.error("Firm GrantBot assistant-row append failed", e instanceof Error ? e.message : e));
  await touchConversation(db, conversationId);

  if (failure) return { ok: false, message: failure };
  return { ok: true, text: answer, usage };
}
