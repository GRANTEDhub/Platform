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
  FETCH_INSTRUCTION_BLOCK,
  WEB_FETCH_TOOL,
  WEB_FETCH_TOOL_NAME,
  type FetchAuditRecord,
} from "@/lib/grantbot/web-fetch";
import { runToolLoop, TURN_DEADLINE_MS, type CallModel, type ToolDispatch } from "@/lib/grantbot/tool-loop";
import {
  grantbotArtifactsEnabled,
  executeArtifactTool,
  ARTIFACT_INSTRUCTION_BLOCK,
  CREATE_ARTIFACT_TOOL,
  EDIT_ARTIFACT_TOOL,
  type ArtifactAuditRecord,
} from "@/lib/grantbot/artifacts";
import {
  grantbotCrossThreadEnabled,
  executeCrossThreadTool,
  CROSS_THREAD_INSTRUCTION_BLOCK,
  LIST_CONVERSATIONS_TOOL,
  LIST_CONVERSATIONS_TOOL_NAME,
  READ_CONVERSATION_TOOL,
  READ_CONVERSATION_TOOL_NAME,
  type CrossThreadAuditRecord,
} from "@/lib/grantbot/cross-thread";

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
// OFF IS BYTE-IDENTICAL TO BEFORE. When the flag is off, the loop's `toolMode` is always "off", so
// neither the `tools` nor the `tool_choice` key is ever added and the fetch-instruction block is
// never appended -- the system prompt, the request body, the single model call, and the stored row
// are exactly what they were pre-brick-B.
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
  const artifactsEnabled = grantbotArtifactsEnabled();
  const crossThreadEnabled = grantbotCrossThreadEnabled();
  const toolsEnabled = webFetchEnabled || artifactsEnabled || crossThreadEnabled;
  // Each instruction block is cacheable:false and appended ONLY when its flag is on, so it never
  // enters the shared cached prefix -- the flag-off system prompt is unchanged and existing caches
  // are not busted. When ALL flags are off, effectiveTurnBlocks equals input.turnBlocks and the
  // assembled system + manifest are byte-identical to the pre-tools turn.
  const effectiveTurnBlocks = [
    ...(input.turnBlocks ?? []),
    ...(webFetchEnabled ? [FETCH_INSTRUCTION_BLOCK] : []),
    ...(artifactsEnabled ? [ARTIFACT_INSTRUCTION_BLOCK] : []),
    ...(crossThreadEnabled ? [CROSS_THREAD_INSTRUCTION_BLOCK] : []),
  ];

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
  // Stable audit sinks: dispatch pushes into these AS IT RUNS, so if a later round throws mid-loop
  // the audit of tools already executed is still written on the (failed) turn's row, not discarded.
  const fetches: FetchAuditRecord[] = [];
  const artifacts: ArtifactAuditRecord[] = [];
  const crossThreadReads: CrossThreadAuditRecord[] = [];

  try {
    const anthropic = getAnthropicClient();

    // The tool set is assembled SERVER-SIDE from the flags, never from the request body (the same
    // rule as turnBlocks): web-fetch adds its one read-only tool, artifacts add create/edit. On the
    // all-flags-off path `tools` is "off" -- neither `tools` nor `tool_choice` is added, so the
    // request is byte-identical to the pre-tools call. "auto" and "none" both keep `tools` PRESENT
    // (a tool_use history without `tools` is a 400); only "none" adds tool_choice to force the final
    // text answer. Timeout is the full CALL_TIMEOUT_MS on the first call, shrinking as budget spends.
    const toolSet = [
      ...(webFetchEnabled ? [WEB_FETCH_TOOL] : []),
      ...(artifactsEnabled ? [CREATE_ARTIFACT_TOOL, EDIT_ARTIFACT_TOOL] : []),
      ...(crossThreadEnabled ? [LIST_CONVERSATIONS_TOOL, READ_CONVERSATION_TOOL] : []),
    ] as unknown as Anthropic.Tool[];

    const callModel: CallModel = async ({ messages: msgs, tools, remainingMs }) => {
      const timeout = Math.min(CALL_TIMEOUT_MS, Math.max(remainingMs, 5_000));
      const res = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages: msgs as Anthropic.MessageParam[],
          ...(tools === "off" ? {} : { tools: toolSet }),
          // "auto" disables PARALLEL tool use so the model emits at most one tool call per round,
          // bounding the loop's inner pass to a single execution; "none" forbids further calls to
          // force the final text answer.
          ...(tools === "auto" ? { tool_choice: { type: "auto" as const, disable_parallel_tool_use: true } } : {}),
          ...(tools === "none" ? { tool_choice: { type: "none" as const } } : {}),
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
          const tb = b as { id: string; name: string; input?: unknown };
          return { id: tb.id, name: tb.name, input: tb.input };
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

    // Route each tool_use to its executor BY NAME, pushing the typed audit into the matching sink.
    // The dispatch closes over the sinks, so an execution's audit is recorded the moment it runs.
    const dispatch: ToolDispatch = async (tu) => {
      if (tu.name === WEB_FETCH_TOOL_NAME) {
        const { resultText, audit } = await executeWebFetch((tu.input as { url?: unknown } | undefined)?.url);
        fetches.push(audit);
        return { resultText };
      }
      if (tu.name === CREATE_ARTIFACT_TOOL.name || tu.name === EDIT_ARTIFACT_TOOL.name) {
        const { resultText, audit } = await executeArtifactTool(
          { name: tu.name, input: tu.input },
          { db: input.db, clientId: input.clientId, originConversationId: input.conversationId, createdBy: null },
        );
        artifacts.push(audit);
        return { resultText };
      }
      if (tu.name === LIST_CONVERSATIONS_TOOL_NAME || tu.name === READ_CONVERSATION_TOOL_NAME) {
        const { resultText, audit } = await executeCrossThreadTool(
          { name: tu.name, input: tu.input },
          { db: input.db, clientId: input.clientId, currentConversationId: input.conversationId },
        );
        crossThreadReads.push(audit);
        return { resultText };
      }
      return { resultText: `Unknown tool "${tu.name}". Nothing was done.` };
    };

    const loop = await runToolLoop({
      messages: baseMessages,
      toolsEnabled,
      callModel,
      dispatch,
      now: () => Date.now(),
      deadlineMs: TURN_DEADLINE_MS,
    });

    answer = loop.text;
    usage = loop.usage;
    stopReason = loop.stopReason;
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
    // All empty on the all-flags-off path -> appendAssistant writes the same content as before.
    fetches,
    artifacts,
    crossThreadReads,
  });
  await touchConversation(input.db, input.conversationId);

  if (failure) return { ok: false, message: failure };
  return { ok: true, text: answer, usage, seq: seq + 1 };
}

export type { SystemPrompt };
