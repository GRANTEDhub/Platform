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
import {
  firmWebFetchEnabled,
  executeWebFetch,
  FIRM_FETCH_INSTRUCTION_BLOCK,
  WEB_FETCH_TOOL,
  WEB_FETCH_TOOL_NAME,
  type FetchAuditRecord,
} from "@/lib/grantbot/firm-web-fetch";

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
// ── READ-ONLY TOOLS ──
//
// A bounded tool loop (runToolLoop, the same one turn.ts / intel use) with read-only tools:
//   · list_firm_conversations / read_firm_conversation (firm-cross-thread.ts) — ALWAYS on when the bot
//     runs (no separate flag; the whole firm surface is gated by GRANTBOT_FIRM_ENABLED). No external
//     reach: they only SELECT from our own Postgres.
//   · fetch_grant_source (firm-web-fetch.ts, reusing the per-client `.gov`-allowlisted guarded fetcher)
//     — behind its OWN flag GRANTBOT_FIRM_WEB_FETCH_ENABLED, default OFF. When OFF the fetch tool and
//     its instruction block are absent, so the request/prompt/stored row are byte-identical to the
//     cross-thread-only firm bot; when ON the bot can pull and read a live NOFO the staffer drops. This
//     is the one outward-reaching tool (a read-only HTTPS GET against the `.gov` allowlist with the
//     SSRF/IP guards) — no write, no internal reach.
// No write path either way — the append-only transcript is untouched. The firm bot keeps ADAPTIVE
// THINKING on (its 16k budget depends on it); the loop preserves thinking blocks by pushing raw
// assistant content back verbatim, and Opus 5 + this loop (thinking on, tool_choice "none" on the
// forced-final round) is proven safe by the green intel-review eval.

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
  // `persisted` tells the route whether ANYTHING was stored for this turn. false = the failure landed
  // BEFORE the user row was written (an early guard, or the appendUser insert itself failed), so the
  // route must NOT return a conversationId — the page then restores the draft for a clean retry rather
  // than keeping an optimistic bubble over an empty thread. true = the user row (and an assistant-error
  // row) are on disk, so the optimistic bubble matches the store and the page keeps it (Codex #542).
  | { ok: false; message: string; persisted: boolean };

export async function runFirmTurn(input: FirmTurnInput): Promise<FirmTurnOutcome> {
  const { db, conversationId } = input;
  const text = input.message.trim();
  // These two guard the belt-and-suspenders case (the route already validates both before creating the
  // conversation); nothing is stored, so persisted:false.
  if (!text) return { ok: false, message: "Empty message.", persisted: false };
  if (text.length > MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      message: `Message is too long (${text.length} characters, max ${MAX_MESSAGE_CHARS}).`,
      persisted: false,
    };
  }
  const now = input.now ?? (() => new Date());

  // Prior transcript BEFORE this turn (excludes the message we are about to append). loadMessages
  // returns role + text-block content + error, which is exactly HistoryTurn's shape; budgetHistory
  // drops failed/empty assistant turns, so a persisted error row does not poison the next call.
  const prior = await loadMessages(db, conversationId);
  const history: HistoryTurn[] = prior.map((m) => ({ role: m.role, content: m.content, error: m.error }));

  // The user turn is recorded first: the staffer asked, whatever the model does next. seq is one per
  // conversation (0080's unique index), so a concurrent same-thread double-submit is a constraint
  // violation, not two rows at the same position — CAUGHT here (the deferred review nit) so it never
  // becomes a bare uncaught 500. persisted:false: NOTHING was stored, so the route omits the
  // conversationId and the page RESTORES the draft for a clean retry rather than keeping an optimistic
  // bubble over an empty thread (Codex #542 — the failed-before-persist case must be distinguishable
  // from a failure after the user row was written).
  const userSeq = await nextSeq(db, conversationId);
  try {
    await appendUser(db, { conversationId, seq: userSeq, text });
  } catch (e) {
    console.error("Firm GrantBot user-append failed", e instanceof Error ? e.message : e);
    return {
      ok: false,
      message:
        "Could not save your message — the conversation may have just received another message at the same moment. Try again.",
      persisted: false,
    };
  }
  const assistantSeq = userSeq + 1;

  // Version stamps + manifest for the assistant row, resolved to the built prompt on success and left
  // at the module constants if gather threw before the prompt was built — a persisted failure is still
  // a turn, and it must not depend on a prompt a roster-load error prevented from existing.
  let manifestBlocks: ContextBlockRecord[] = [];
  let instructionsVersion = FIRM_INSTRUCTIONS_VERSION;
  let knowledgeVersion = FIRM_KNOWLEDGE_VERSION;

  // Read the fetch flag ONCE. OFF (default) → the fetch tool + its instruction block are never added,
  // so the request/prompt/stored row are byte-identical to the cross-thread-only firm bot.
  const webFetchEnabled = firmWebFetchEnabled();

  let answer = "";
  let usage: TurnUsage | null = null;
  let stopReason: string | null = null;
  let failure: string | null = null;
  // Stable audit sinks: dispatch pushes into these AS IT RUNS, so a later-round throw still leaves the
  // audit of tools already executed on the (failed) turn's row.
  const crossThreadReads: FirmCrossThreadAuditRecord[] = [];
  const fetches: FetchAuditRecord[] = [];

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
    const prompt = buildFirmSystemPrompt({
      pack,
      turnBlocks: [
        FIRM_CROSS_THREAD_INSTRUCTION_BLOCK,
        // Only when the fetch flag is on — cacheable:false, so the flag-off prompt is byte-identical.
        ...(webFetchEnabled ? [FIRM_FETCH_INSTRUCTION_BLOCK] : []),
      ],
    });
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
    // read-only cross-thread tools, plus fetch_grant_source when the fetch flag is on. On "auto"/"none"
    // `tools` stays PRESENT (a tool_use history without `tools` 400s); only "none" adds tool_choice to
    // force the final text answer. THINKING stays ON (the firm bot omits `thinking`, so Opus 5's
    // adaptive thinking runs — the 16k budget is for thinking + the answer); the loop preserves the
    // thinking blocks by pushing raw assistant content back verbatim, and Opus 5 + this loop (thinking
    // on, tool_choice "none" on the forced-final round) is proven safe by the green intel-review eval.
    const toolSet = [
      LIST_FIRM_CONVERSATIONS_TOOL,
      READ_FIRM_CONVERSATION_TOOL,
      ...(webFetchEnabled ? [WEB_FETCH_TOOL] : []),
    ] as unknown as Anthropic.Tool[];

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
      if (tu.name === WEB_FETCH_TOOL_NAME) {
        // The exact per-client executor: the guarded `.gov` fetch, framed as untrusted evidence, with
        // the typed could-not-retrieve fallback. Only reachable when the flag added the tool above.
        const { resultText, audit } = await executeWebFetch((tu.input as { url?: unknown } | undefined)?.url);
        fetches.push(audit);
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
    // Empty unless the model fetched a .gov source (flag on); omitted when empty, so a no-fetch turn's
    // stored row is byte-identical.
    fetches,
  }).catch((e) => console.error("Firm GrantBot assistant-row append failed", e instanceof Error ? e.message : e));
  await touchConversation(db, conversationId);

  // persisted:true here: appendUser succeeded above, so the user row (and, just now, an assistant-error
  // row) are on disk. The page's optimistic bubble matches the store, so it keeps the bubble and
  // continues this thread rather than restoring the draft.
  if (failure) return { ok: false, message: failure, persisted: true };
  return { ok: true, text: answer, usage };
}
