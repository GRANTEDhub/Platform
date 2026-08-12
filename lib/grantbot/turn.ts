import "server-only";
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

// One conversational turn: assemble, call, store. The orchestrator between the pure renderer and
// the store, and the only place that knows anything about the model.
//
// ── READ-ONLY, ENFORCED BY CONSTRUCTION AND NOT BY PROMPT ──
//
// No `tools` parameter is passed. Not "no write tools" -- no tools at all, so there is no code
// path from an answer to a mutation regardless of what the model says or what a paste tells it to
// do. The instructions say read-only three times because a staffer should not be misled about
// what GrantBot can do; the reason it CANNOT do it is this function's argument list.
//
// The one thing it writes is the conversation itself (0080), which contains no client state.
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

  const system = assembleSystem(prompt, input.turnBlocks ?? []);
  const blockManifest = manifest([...prompt.blocks, ...(input.turnBlocks ?? [])]);

  let answer = "";
  let usage: TurnUsage | null = null;
  let stopReason: string | null = null;
  let failure: string | null = null;

  try {
    const anthropic = getAnthropicClient();
    const res = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: dropped
          ? [
              // The truncation, told to the model in its own turn rather than smuggled into the
              // user's words. It is a fact about the conversation, not something the staffer said.
              { role: "user" as const, content: `[${dropped} earlier message(s) in this conversation were dropped to fit the context budget. If an answer depends on something said earlier that you cannot see, say so.]` },
              ...messages,
            ]
          : messages,
        // NO `tools`. See the header -- this is the read-only property, not the prompt.
      },
      { timeout: CALL_TIMEOUT_MS, maxRetries: 1 },
    );
    answer = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    stopReason = res.stop_reason ?? null;
    usage = {
      input_tokens: res.usage?.input_tokens ?? null,
      output_tokens: res.usage?.output_tokens ?? null,
      cache_read_input_tokens: res.usage?.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: res.usage?.cache_creation_input_tokens ?? null,
    };
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
  });
  await touchConversation(input.db, input.conversationId);

  if (failure) return { ok: false, message: failure };
  return { ok: true, text: answer, usage, seq: seq + 1 };
}

export type { SystemPrompt };
