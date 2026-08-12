import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { gatherContextPack } from "@/lib/grantbot/gather";
import {
  assembleSystem,
  buildSystemPrompt,
  framePastedContent,
  manifest,
  type PromptBlock,
  type SystemPrompt,
} from "@/lib/grantbot/prompt";
import {
  appendAssistant,
  appendUser,
  loadMessages,
  nextSeq,
  touchConversation,
  type TurnUsage,
} from "@/lib/grantbot/store";
import { budgetHistory } from "@/lib/grantbot/history";
import {
  executeWebFetch,
  grantbotWebFetchEnabled,
  runFetchLoop,
  FETCH_INSTRUCTION_BLOCK,
  TURN_DEADLINE_MS,
  WEB_FETCH_TOOL,
  type CallModel,
} from "@/lib/grantbot/web-fetch";

// One conversational turn: assemble, call, store. The orchestrator between the pure renderer and
// the store, and the only place that knows anything about the model.
//
// ── READ-ONLY BY DEFAULT; ONE READ-ONLY TOOL BEHIND A FLAG (brick B) ──
//
// Until brick B, no `tools` parameter was ever passed -- no tools at all, so no answer could reach
// a mutation regardless of what a paste said. Brick B widens that by EXACTLY ONE tool: a read-only
// GET of an allowlisted .gov grant source (lib/grantbot/web-fetch.ts + the Brick A guards), and
// only when GRANTBOT_WEB_FETCH_ENABLED is on. The narrowing is held by construction, not by prompt:
// the tool set is a server-side constant (never from the request body, same rule as turnBlocks),
// the executor is a guarded HTTPS GET with no write or internal reach, and the flag defaults OFF.
//
// OFF IS BYTE-IDENTICAL TO BEFORE. When the flag is off, `useTools` is always false, so the `tools`
// key is never added and the fetch-instruction block is never appended -- the system prompt, the
// request body, the single model call, and the stored row are exactly what they were pre-brick-B.
// That is the instant-revert guarantee: turning the env var off restores read-only-by-construction
// with no deploy. The loop runs exactly once on that path (no tool_use is possible without tools).
//
// The one thing it writes is the conversation itself (0080), which contains no client state -- now
// plus a non-text web_fetch_audit block on the assistant message when a fetch happened, so which
// URLs were read is inspectable after the fact.
//
// ── NO STREAMING, DELIBERATELY, AND THE TIMEOUT THAT PAYS FOR IT ──
//
// Nothing in this codebase streams, and a first conversational surface is a poor place to
// introduce a second response-handling path. A non-streamed answer over a large cached prefix is
// well inside the route's maxDuration; CALL_TIMEOUT_MS below is what keeps a hung call from
// eating the whole budget and returning nothing at all.

const MAX_MESSAGE_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 4000;
const CALL_TIMEOUT_MS = 120_000;

export type TurnOutcome =
  | { ok: true; text: string; usage: TurnUsage | null; seq: number }
  | { ok: false; message: string };

export interface RunTurnInput {
  db: SupabaseClient;
  clientId: string;
  conversationId: string;
  message: string;
  // Optional paste, framed as untrusted evidence rather than concatenated into the question.
  pasted?: { body: string; describedAs?: string } | null;
  actorEmail: string;
  actorRole: string;
  // ── THE SEAM FOR A FUTURE SKILL LIBRARY ──
  //
  // Blocks selected for THIS TURN rather than standing context: a retrieved methodology section,
  // a matched playbook. Not built, and nothing produces them today.
  //
  // NEVER FROM THE REQUEST BODY. This is a function argument, not a field the HTTP route parses,
  // because a browser-supplied prompt block would be a browser-supplied system prompt -- the
  // guardrails and the org rules are text, and text that arrives from the client can replace
  // them. The route reads `message` and `pasted` from the body and nothing else.
  //
  // assembleSystem places these AFTER the cache breakpoints and rejects any that claim to be
  // cacheable, so adding retrieval later cannot silently turn every turn into a cache write.
  turnBlocks?: PromptBlock[];
}

export async function runTurn(input: RunTurnInput): Promise<TurnOutcome> {
  const text = input.message.trim();
  if (!text) return { ok: false, message: "Empty message." };
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, message: `Message is too long (${text.length} characters, max ${MAX_MESSAGE_CHARS}).` };
  }

  // Actor-scoped by construction: gatherContextPack reads documents and their commit history
  // under the CALLER's RLS, so a contractor's context is a contractor's context, and the
  // commercial/billing exclusion holds for everyone because those columns are never selected.
  const gathered = await gatherContextPack({
    clientId: input.clientId,
    generatedBy: input.actorEmail,
    actorRole: input.actorRole,
    generatedAt: new Date().toISOString(),
  });
  if (!gathered) return { ok: false, message: "Client not found." };

  const prompt = buildSystemPrompt({ pack: gathered.pack });

  // The user's turn as the model will see it: the question, then any paste inside the frame. The
  // frame is applied HERE and never by the browser, so the delimiter cannot be forged by typing
  // it into the message box -- a paste is trusted to be delimited because the server delimited
  // it.
  const userText = input.pasted?.body?.trim()
    ? `${text}\n\n${framePastedContent(input.pasted.body, new Date().toISOString(), input.pasted.describedAs)}`
    : text;

  const history = await loadMessages(input.db, input.conversationId);
  const { messages, dropped } = budgetHistory(history, userText);

  const seq = await nextSeq(input.db, input.conversationId);
  await appendUser(input.db, { conversationId: input.conversationId, seq, text: userText });

  // The fetch instruction is appended AFTER the cache breakpoint (cacheable: false) and ONLY when
  // enabled, so it never enters the shared cached prefix -- the flag-off prompt is unchanged and
  // existing conversations' prompt caches are not busted. Off -> effectiveTurnBlocks is exactly what
  // it was, so `system` and the manifest are byte-identical to before.
  const webFetchEnabled = grantbotWebFetchEnabled();
  const effectiveTurnBlocks = webFetchEnabled
    ? [...(input.turnBlocks ?? []), FETCH_INSTRUCTION_BLOCK]
    : input.turnBlocks ?? [];

  const system = assembleSystem(prompt, effectiveTurnBlocks);
  const blockManifest = manifest([...prompt.blocks, ...effectiveTurnBlocks]);

  const baseMessages: unknown[] = dropped
    ? [
        // The truncation, told to the model in its own turn rather than smuggled into the user's
        // words. It is a fact about the conversation, not something the staffer said.
        { role: "user" as const, content: `[${dropped} earlier message(s) in this conversation were dropped to fit the context budget. If an answer depends on something said earlier that you cannot see, say so.]` },
        ...messages,
      ]
    : messages;

  let answer = "";
  let usage: TurnUsage | null = null;
  let stopReason: string | null = null;
  let failure: string | null = null;
  let fetches: unknown[] = [];

  try {
    const anthropic = getAnthropicClient();

    // One model call per loop iteration. When useTools is false -- ALWAYS, on the flag-off path --
    // no `tools` key is added, so the request is byte-identical to the pre-brick-B call, and the
    // timeout is the full CALL_TIMEOUT_MS on the first call (remainingMs starts at the whole
    // deadline), shrinking only as the turn's wall-clock budget is spent.
    const callModel: CallModel = async ({ messages: msgs, useTools, remainingMs }) => {
      const timeout = Math.min(CALL_TIMEOUT_MS, Math.max(remainingMs, 5_000));
      const res = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages: msgs as Anthropic.MessageParam[],
          ...(useTools ? { tools: [WEB_FETCH_TOOL] as unknown as Anthropic.Tool[] } : {}),
        },
        { timeout, maxRetries: 1 },
      );
      const text = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      const toolUses = res.content
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const tb = b as { id: string; input?: { url?: unknown } };
          return { id: tb.id, url: tb.input?.url };
        });
      return {
        text,
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

    const loop = await runFetchLoop({
      messages: baseMessages,
      webFetchEnabled,
      callModel,
      executeFetch: (url) => executeWebFetch(url),
      now: () => Date.now(),
      deadlineMs: TURN_DEADLINE_MS,
    });

    answer = loop.text;
    usage = loop.usage;
    stopReason = loop.stopReason;
    fetches = loop.fetches;
    if (!answer) failure = "The model returned no text.";
  } catch (err) {
    failure = err instanceof Error ? err.message : "Unknown error calling the model.";
  }

  // WRITTEN EITHER WAY. A failed turn is still a turn: the row carries the reason so
  // "it didn't answer me" has something to look at.
  await appendAssistant(input.db, {
    conversationId: input.conversationId,
    seq: seq + 1,
    text: answer,
    contextBlocks: blockManifest,
    instructionsVersion: prompt.instructionsVersion,
    methodologyVersion: prompt.methodologyVersion,
    model: MODEL,
    usage,
    stopReason,
    error: failure,
    // Empty on the flag-off path -> appendAssistant writes the same content as before.
    fetches,
  });
  await touchConversation(input.db, input.conversationId);

  if (failure) return { ok: false, message: failure };
  return { ok: true, text: answer, usage, seq: seq + 1 };
}

export type { SystemPrompt };
