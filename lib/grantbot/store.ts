import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContextBlockRecord } from "@/lib/grantbot/prompt";
import { truncateSafely } from "@/lib/grantbot/label";

// The conversation store. I/O only, the same split as gather.ts over context-pack.ts: nothing
// here decides what a message SAYS, and nothing in the pure modules touches a database.
//
// ── APPEND-ONLY, VIA THE ABSENCE OF A POLICY ──
//
// 0080 gives both tables a staff SELECT policy and nothing else, so every write below runs on the
// service-role client (which bypasses RLS) and no API caller can rewrite a stored answer. What
// the transcript says GrantBot said is what GrantBot said. Same discipline as
// client_profile_changes in 0078, and for the same reason: the value of a log is exactly its
// unrewritability.
//
// ── A FAILED TURN IS STILL A TURN ──
//
// appendAssistant takes an `error` and writes the row anyway. A conversation that drops its
// failures reads as though the staffer never asked, and "it didn't answer me" is precisely the
// report that needs a row to look at.

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  // Anthropic content blocks. Text-only today; an array because a message stops being a string
  // the moment a tool, a retrieved skill, or a document reference enters a turn.
  content: { type: "text"; text: string }[];
  seq: number;
  contextBlocks: ContextBlockRecord[] | null;
  instructionsVersion: string | null;
  methodologyVersion: string | null;
  model: string | null;
  usage: TurnUsage | null;
  error: string | null;
  createdAt: string;
}

// The four numbers the response reports. cache_read_input_tokens is the one that matters: prompt
// caching is load-bearing here (a full pack in front of every turn), and whether the cache is
// actually being READ is invisible everywhere else. A prefix that silently stopped matching would
// look identical in the UI and cost roughly ten times as much per turn.
export interface TurnUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

export interface Conversation {
  id: string;
  clientId: string;
  title: string | null;
  startedByEmail: string | null;
  createdAt: string;
  lastMessageAt: string;
}

const TITLE_CHARS = 80;

export function conversationTitle(firstMessage: string): string {
  const one = firstMessage.replace(/\s+/g, " ").trim();
  return one.length <= TITLE_CHARS ? one : `${one.slice(0, TITLE_CHARS - 1)}…`;
}

export async function createConversation(
  db: SupabaseClient,
  opts: { clientId: string; title: string; startedBy?: string | null; startedByEmail?: string | null },
): Promise<Conversation | null> {
  const { data, error } = await db
    .from("grantbot_conversations")
    .insert({
      client_id: opts.clientId,
      title: opts.title,
      started_by: opts.startedBy ?? null,
      started_by_email: opts.startedByEmail ?? null,
    })
    .select("id, client_id, title, started_by_email, created_at, last_message_at")
    .maybeSingle();
  if (error || !data) {
    console.error("GrantBot conversation create failed", error?.message);
    return null;
  }
  return rowToConversation(data);
}

export async function getConversation(
  db: SupabaseClient,
  id: string,
): Promise<Conversation | null> {
  const { data } = await db
    .from("grantbot_conversations")
    .select("id, client_id, title, started_by_email, created_at, last_message_at")
    .eq("id", id)
    .maybeSingle();
  return data ? rowToConversation(data) : null;
}

export async function listConversations(
  db: SupabaseClient,
  clientId: string,
  limit = 30,
): Promise<Conversation[]> {
  const { data } = await db
    .from("grantbot_conversations")
    .select("id, client_id, title, started_by_email, created_at, last_message_at")
    .eq("client_id", clientId)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map(rowToConversation);
}

export async function loadMessages(
  db: SupabaseClient,
  conversationId: string,
): Promise<StoredMessage[]> {
  const { data } = await db
    .from("grantbot_messages")
    .select(
      "id, role, content, seq, context_blocks, instructions_version, methodology_version, model, usage, error, created_at",
    )
    .eq("conversation_id", conversationId)
    // BY seq, NOT created_at. The user turn and its answer can share a timestamp -- they are
    // written within the same request -- and "which came first" is not a detail in a
    // conversation, it is the conversation.
    .order("seq", { ascending: true });
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    role: r.role === "assistant" ? "assistant" : "user",
    content: normalizeContent(r.content),
    seq: Number(r.seq),
    contextBlocks: (r.context_blocks as ContextBlockRecord[] | null) ?? null,
    instructionsVersion: (r.instructions_version as string | null) ?? null,
    methodologyVersion: (r.methodology_version as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    usage: (r.usage as TurnUsage | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
}

// Tolerant on the way OUT, strict on the way in: a row written by an older shape (or by hand in
// SQL) should render rather than crash a page. The column is jsonb, so it can hold anything.
function normalizeContent(raw: unknown): { type: "text"; text: string }[] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      if (typeof b === "string") return { type: "text" as const, text: b };
      const o = b as Record<string, unknown>;
      return typeof o?.text === "string" ? { type: "text" as const, text: o.text } : null;
    })
    .filter((b): b is { type: "text"; text: string } => b !== null);
}

export async function appendUser(
  db: SupabaseClient,
  opts: { conversationId: string; seq: number; text: string },
): Promise<void> {
  const { error } = await db.from("grantbot_messages").insert({
    conversation_id: opts.conversationId,
    role: "user",
    content: [{ type: "text", text: opts.text }],
    seq: opts.seq,
  });
  if (error) throw new Error(`GrantBot user message insert failed: ${error.message}`);
}

export async function appendAssistant(
  db: SupabaseClient,
  opts: {
    conversationId: string;
    seq: number;
    text: string;
    contextBlocks: ContextBlockRecord[];
    instructionsVersion: string;
    methodologyVersion: string;
    model: string;
    usage?: TurnUsage | null;
    stopReason?: string | null;
    error?: string | null;
    // Brick B: the web-fetch audit for this turn -- which URLs the model fetched, and whether each
    // succeeded. Stored as a NON-TEXT block inside `content` (which is jsonb and, per this file's
    // header, becomes a block array the moment a tool enters a turn). normalizeContent drops
    // non-text blocks on read, so render and history replay are unchanged; the raw column keeps the
    // audit for after-the-fact inspection. When there are no fetches the block is omitted, so the
    // row is byte-identical to a pre-brick-B assistant message.
    fetches?: unknown[] | null;
    // Brick 1a: the artifact audit for this turn -- which documents the model created/edited. Same
    // NON-TEXT-block mechanism as fetches (normalizeContent drops it on read, so render/replay are
    // unchanged); omitted when empty, so an artifact-free turn is byte-identical to before.
    artifacts?: unknown[] | null;
  },
): Promise<void> {
  const content: unknown[] = [{ type: "text", text: opts.text }];
  if (opts.fetches && opts.fetches.length > 0) {
    content.push({ type: "web_fetch_audit", fetches: opts.fetches });
  }
  if (opts.artifacts && opts.artifacts.length > 0) {
    content.push({ type: "artifact_ref", artifacts: opts.artifacts });
  }
  const { error } = await db.from("grantbot_messages").insert({
    conversation_id: opts.conversationId,
    role: "assistant",
    content,
    seq: opts.seq,
    context_blocks: opts.contextBlocks,
    instructions_version: opts.instructionsVersion,
    methodology_version: opts.methodologyVersion,
    model: opts.model,
    usage: opts.usage ?? null,
    stop_reason: opts.stopReason ?? null,
    error: opts.error ?? null,
  });
  if (error) throw new Error(`GrantBot assistant message insert failed: ${error.message}`);
}

// Ordering marker for the list view. Best-effort: a failure here costs the sort order of one
// thread, never the message that was just written, so it logs rather than throws.
export async function touchConversation(db: SupabaseClient, conversationId: string): Promise<void> {
  const { error } = await db
    .from("grantbot_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (error) console.error("GrantBot conversation touch failed", error.message);
}

// Rename a conversation. This edits ONLY the conversation title -- a metadata field on
// grantbot_conversations -- and never a stored message, so the append-only-TRANSCRIPT invariant
// (0080: "what the transcript says GrantBot said is what GrantBot said") is untouched: the thing
// that must not be rewritable is a model answer, not the label on a thread. Service-role, exactly
// like touchConversation above -- 0080 gives these tables no UPDATE policy, so the write bypasses
// RLS and the staff-gated route is the authorization boundary (0080's "a policy plus a route"
// note; the service-role route IS that route). Scoped by client_id as well as id so a
// (conversationId, wrong-clientId) pair updates zero rows -- defence in depth behind the route's
// own mislabel guard. The title is whitespace-collapsed and hard-capped so a hand-typed name cannot
// introduce runaway whitespace or exceed the column budget -- the cap goes through truncateSafely,
// the module's ONE surrogate-safe char-cap (label.ts), so an emoji straddling the 80th char can't
// be cut mid-pair into a dangling lone surrogate, the same discipline as web-fetch and the attach cap.
export async function updateConversationTitle(
  db: SupabaseClient,
  opts: { conversationId: string; clientId: string; title: string },
): Promise<boolean> {
  const normalized = opts.title.replace(/\s+/g, " ").trim();
  const title = truncateSafely(normalized, TITLE_CHARS).text;
  if (!title) return false;
  const { error } = await db
    .from("grantbot_conversations")
    .update({ title })
    .eq("id", opts.conversationId)
    .eq("client_id", opts.clientId);
  if (error) {
    console.error("GrantBot conversation rename failed", error.message);
    return false;
  }
  return true;
}

export async function nextSeq(db: SupabaseClient, conversationId: string): Promise<number> {
  const { data } = await db
    .from("grantbot_messages")
    .select("seq")
    .eq("conversation_id", conversationId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? Number((data as { seq: number }).seq) + 1 : 0;
}

function rowToConversation(r: Record<string, unknown>): Conversation {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    title: (r.title as string | null) ?? null,
    startedByEmail: (r.started_by_email as string | null) ?? null,
    createdAt: String(r.created_at),
    lastMessageAt: String(r.last_message_at),
  };
}
