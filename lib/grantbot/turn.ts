import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, OPUS_MODEL } from "@/lib/anthropic";
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
  grantbotStateDocFetcher,
  FETCH_INSTRUCTION_BLOCK,
  WEB_FETCH_TOOL,
  WEB_FETCH_TOOL_NAME,
  type FetchAuditRecord,
} from "@/lib/grantbot/web-fetch";
import { runToolLoop, TURN_DEADLINE_MS, PER_CLIENT_MAX_TOOL_ROUNDS, DISPATCH_TIMEOUT_MS, type CallModel, type ToolDispatch } from "@/lib/grantbot/tool-loop";
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
import {
  grantbotVisionEnabled,
  buildImageUserContent,
  IMAGE_INSTRUCTION_BLOCK,
  IMAGE_ATTACHED_NOTE,
  type TurnImage,
} from "@/lib/grantbot/vision";
import {
  grantbotDataToolsEnabled,
  executeDataTool,
  DATA_TOOLS_INSTRUCTION_BLOCK,
  PROGRAM_AWARDS_TOOL,
  PROGRAM_AWARDS_TOOL_NAME,
  ORG_HISTORY_TOOL,
  ORG_HISTORY_TOOL_NAME,
  SAM_ENTITY_TOOL,
  SAM_ENTITY_TOOL_NAME,
  type DataLookupAuditRecord,
} from "@/lib/grantbot/data-tools";
import {
  grantbotWebSearchEnabled,
  grantbotWebSearchTool,
  extractWebSearchAudit,
  WEB_SEARCH_INSTRUCTION_BLOCK,
  type WebSearchAuditRecord,
} from "@/lib/grantbot/web-search";
import { loadFocusGrant, buildFocusGrantBlock } from "@/lib/grantbot/focus-grant";
import {
  grantbotStoredNofoEnabled,
  loadGrantNofoFields,
  buildStoredNofoFieldsBlock,
  executeStoredNofo,
  READ_STORED_NOFO_TOOL,
  READ_STORED_NOFO_TOOL_NAME,
  STORED_NOFO_INSTRUCTION_BLOCK,
  type NofoReadAuditRecord,
} from "@/lib/grantbot/stored-nofo";

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

// The per-client GrantBot's model. Opus 5 (Shannon, 2026-09-11) — the per-client bot is a
// low-volume, staff-only, high-judgment surface where reasoning quality matters more than the
// ~1.67x per-token cost over Sonnet; the MATCHER stays on the cheaper MODEL (Sonnet 4.6), which
// scores the full roster on every ingest. Named constant so the model choice is a one-line lever.
const CLIENT_BOT_MODEL = OPUS_MODEL;

// Thinking is DISABLED for this interactive chat (Shannon, 2026-09-11): Opus 5 runs adaptive
// thinking by default (omitting `thinking` = on), which adds latency + thinking-token cost on a
// surface staff use conversationally. Disabling keeps it snappy AND keeps the response shape
// (text + tool_use, no thinking blocks) identical to what the tool loop already handles — the
// safer choice than letting Opus inject thinking blocks the loop does not process. Available at
// effort <= high; this call sets no effort (default), so it never trips the xhigh/max 400.
const THINKING_DISABLED = { type: "disabled" as const };

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
  // Optional single image the vision model reads THIS turn (a screenshot, a map). Ignored unless
  // GRANTBOT_VISION_ENABLED is on; never stored. Validated (type + size) by the route before it gets
  // here. See lib/grantbot/vision.ts.
  image?: TurnImage | null;
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
  // The grant this conversation is ANCHORED to (Ask GrantBot from a grant card; migration 0098). Read
  // by the route from the STORED conversation, NOT the request body — so like turnBlocks it can never be
  // a browser-supplied prompt. When set, a cacheable:false grounding block (composed from the grant's
  // own public row) is appended after the cache breakpoint so the turn knows which grant it is about.
  // Null/absent → a general thread, byte-identical to before.
  focusGrantId?: string | null;
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

  // Vision is flag-gated: OFF drops any image so this turn is byte-identical to the pre-vision turn
  // (no framing block, string user content, unchanged stored row). The route already validated the
  // image's type + size; this is the master gate + kill-switch.
  const image = grantbotVisionEnabled() ? input.image ?? null : null;

  const history = await loadMessages(input.db, input.conversationId);
  const { messages, dropped } = budgetHistory(history, userText);

  const seq = await nextSeq(input.db, input.conversationId);
  // The bytes are NEVER stored; when an image rode this turn, a short note is appended to the stored
  // text so the transcript and a later turn's replay know an image existed (and is gone). userText
  // itself — what the model reads alongside the image below — is unchanged.
  const storedUserText = image ? `${userText}\n\n${IMAGE_ATTACHED_NOTE}` : userText;
  await appendUser(input.db, { conversationId: input.conversationId, seq, text: storedUserText });

  // The fetch instruction is appended AFTER the cache breakpoint (cacheable: false) and ONLY when
  // enabled, so it never enters the shared cached prefix -- the flag-off prompt is unchanged and
  // existing conversations' prompt caches are not busted. Off -> effectiveTurnBlocks is exactly what
  // it was, so `system` and the manifest are byte-identical to before.
  const webFetchEnabled = grantbotWebFetchEnabled();
  const artifactsEnabled = grantbotArtifactsEnabled();
  const crossThreadEnabled = grantbotCrossThreadEnabled();
  const dataToolsEnabled = grantbotDataToolsEnabled();
  const webSearchEnabled = grantbotWebSearchEnabled();
  const storedNofoEnabled = grantbotStoredNofoEnabled();
  const toolsEnabled =
    webFetchEnabled || artifactsEnabled || crossThreadEnabled || dataToolsEnabled || webSearchEnabled || storedNofoEnabled;

  // The grant anchor (Ask GrantBot from a grant card): when this conversation is tied to a grant, load
  // its public facts and add a grounding block below. focusGrantId is the STORED anchor (the route reads
  // it); the block text comes from the grant's own row, never the request body. A general thread
  // (focusGrantId null, or the grant no longer resolves) adds no block → byte-identical.
  const focusGrant = input.focusGrantId ? await loadFocusGrant(input.db, input.focusGrantId) : null;
  // LAYER 1 (stored-NOFO): when the flag is on AND this thread is anchored, load the anchored grant's
  // STORED structured NOFO fields (what it funds, eligibility, allowable uses, requirements) so most asks
  // are answered with no tool round. Null when the flag is off, the thread is unanchored, or the grant
  // carries no structured detail (a husk) → no block, byte-identical. Never raw_text (the tool's job).
  const nofoFields = storedNofoEnabled && focusGrant ? await loadGrantNofoFields(input.db, focusGrant.id) : null;
  // Each instruction block is cacheable:false and appended ONLY when its flag is on, so it never
  // enters the shared cached prefix -- the flag-off system prompt is unchanged and existing caches
  // are not busted. When ALL flags are off, effectiveTurnBlocks equals input.turnBlocks and the
  // assembled system + manifest are byte-identical to the pre-tools turn.
  const effectiveTurnBlocks = [
    ...(input.turnBlocks ?? []),
    // The grant-anchor grounding, when this thread was opened from a grant card. cacheable:false and
    // present only for an anchored thread, so a general thread's prompt is unchanged.
    ...(focusGrant ? [buildFocusGrantBlock(focusGrant)] : []),
    // LAYER 1 stored-NOFO fields for the anchored grant (flag-gated; only when there is detail to show).
    ...(nofoFields ? [buildStoredNofoFieldsBlock(nofoFields)] : []),
    ...(webFetchEnabled ? [FETCH_INSTRUCTION_BLOCK] : []),
    // The stored-NOFO tool instruction: prefer read_stored_nofo over fetching, and never claim a source
    // you did not read this turn. cacheable:false, only when the flag is on → flag-off byte-identical.
    ...(storedNofoEnabled ? [STORED_NOFO_INSTRUCTION_BLOCK] : []),
    ...(artifactsEnabled ? [ARTIFACT_INSTRUCTION_BLOCK] : []),
    ...(crossThreadEnabled ? [CROSS_THREAD_INSTRUCTION_BLOCK] : []),
    ...(dataToolsEnabled ? [DATA_TOOLS_INSTRUCTION_BLOCK] : []),
    ...(webSearchEnabled ? [WEB_SEARCH_INSTRUCTION_BLOCK] : []),
    // Only when an image actually rides this turn (cacheable:false, after the breakpoint) — so a
    // no-image turn's prompt is byte-identical and existing caches are not busted.
    ...(image ? [IMAGE_INSTRUCTION_BLOCK] : []),
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

  // When an image rides this turn, swap the CURRENT user turn's string content for image+text content
  // blocks so the vision model sees the picture. budgetHistory always appends the current turn LAST, so
  // it is baseMessages' final element (the dropped-notice, when present, is prepended). No-image turns
  // leave baseMessages untouched -> byte-identical string content, exactly the pre-vision request.
  const modelMessages = image
    ? baseMessages.map((m, i) =>
        i === baseMessages.length - 1 ? { role: "user" as const, content: buildImageUserContent(userText, image) } : m,
      )
    : baseMessages;

  let answer = "";
  let usage: TurnUsage | null = null;
  let stopReason: string | null = null;
  let failure: string | null = null;
  // Stable audit sinks: dispatch pushes into these AS IT RUNS, so if a later round throws mid-loop
  // the audit of tools already executed is still written on the (failed) turn's row, not discarded.
  const fetches: FetchAuditRecord[] = [];
  const artifacts: ArtifactAuditRecord[] = [];
  const crossThreadReads: CrossThreadAuditRecord[] = [];
  const dataLookups: DataLookupAuditRecord[] = [];
  // web_search has no dispatch branch (it runs on Anthropic's servers), so callModel below extracts its
  // audit straight from each round's response content into this sink -- the same "recorded as it runs,
  // so a mid-loop throw still keeps the audit of what already ran" discipline as the four above.
  const searches: WebSearchAuditRecord[] = [];
  // Which grants' stored NOFO the model read from the grant row (read_stored_nofo) instead of fetching.
  const nofoReads: NofoReadAuditRecord[] = [];

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
      ...(dataToolsEnabled ? [PROGRAM_AWARDS_TOOL, ORG_HISTORY_TOOL, SAM_ENTITY_TOOL] : []),
      // LAYER 2: the read-only stored-NOFO tool — reads the platform's already-parsed copy instead of
      // re-fetching + re-parsing the PDF. Flag-gated; absent when off → byte-identical tool set.
      ...(storedNofoEnabled ? [READ_STORED_NOFO_TOOL] : []),
      // Anthropic's server-side web_search: it executes on Anthropic's servers (no dispatch branch
      // below, and runToolLoop resumes the pause_turn it produces), so it appears only in the tool set.
      ...(webSearchEnabled ? [grantbotWebSearchTool()] : []),
    ] as unknown as Anthropic.Tool[];

    const callModel: CallModel = async ({ messages: msgs, tools, remainingMs }) => {
      const timeout = Math.min(CALL_TIMEOUT_MS, Math.max(remainingMs, 5_000));
      const res = await anthropic.messages.create(
        {
          model: CLIENT_BOT_MODEL,
          // Off — see THINKING_DISABLED. No `temperature` either (claude-opus-5 rejects it, 400).
          thinking: THINKING_DISABLED,
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
      // web_search runs server-side, so it never reaches dispatch; its audit lives in the response's
      // server_tool_use / web_search_tool_result blocks. Extract per round and accumulate. Guarded by the
      // flag so the flag-off path does no extra work and writes no audit block (byte-identical).
      if (webSearchEnabled) {
        searches.push(...extractWebSearchAudit(res.content, new Date().toISOString()));
      }
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
        // The per-client bot opts INTO the state-doc reach (grantbotStateDocFetcher) — its
        // FETCH_INSTRUCTION_BLOCK tells it media.ark.org is reachable. The firm bot, which shares this
        // executor, passes no fetcher and stays .gov-only (its own instruction block still says so).
        const { resultText, audit } = await executeWebFetch(
          (tu.input as { url?: unknown } | undefined)?.url,
          { fetcher: grantbotStateDocFetcher },
        );
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
      if (tu.name === PROGRAM_AWARDS_TOOL_NAME || tu.name === ORG_HISTORY_TOOL_NAME || tu.name === SAM_ENTITY_TOOL_NAME) {
        const { resultText, audit } = await executeDataTool({ name: tu.name, input: tu.input });
        dataLookups.push(audit);
        return { resultText };
      }
      if (tu.name === READ_STORED_NOFO_TOOL_NAME) {
        // Reads the anchored grant's stored NOFO (focusGrantId, server-side — never the request body),
        // or a grant the model names by opportunity number. Postgres text read: no PDF, no network.
        const { resultText, audit } = await executeStoredNofo(
          { input: tu.input },
          { db: input.db, focusGrantId: input.focusGrantId ?? null },
        );
        nofoReads.push(audit);
        return { resultText };
      }
      return { resultText: `Unknown tool "${tu.name}". Nothing was done.` };
    };

    const loop = await runToolLoop({
      messages: modelMessages,
      toolsEnabled,
      callModel,
      dispatch,
      now: () => Date.now(),
      deadlineMs: TURN_DEADLINE_MS,
      // 3, not the default 2 — a grounded who-wins answer wants national + in-state + synthesis (the
      // data-tools eval's run-1 truncation). Still bounded by TURN_DEADLINE_MS.
      maxToolRounds: PER_CLIENT_MAX_TOOL_ROUNDS,
      // Bound each single tool execution so a slow tool (a fetched PDF's parse) can't make the turn hang
      // returning nothing — the loop feeds a typed timeout tool_result and finishes. See DISPATCH_TIMEOUT_MS.
      dispatchTimeoutMs: DISPATCH_TIMEOUT_MS,
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
    model: CLIENT_BOT_MODEL,
    usage,
    stopReason,
    error: failure,
    // All empty on the all-flags-off path -> appendAssistant writes the same content as before.
    fetches,
    artifacts,
    crossThreadReads,
    dataLookups,
    searches,
    nofoReads,
  });
  await touchConversation(input.db, input.conversationId);

  if (failure) return { ok: false, message: failure };
  return { ok: true, text: answer, usage, seq: seq + 1 };
}

export type { SystemPrompt };
