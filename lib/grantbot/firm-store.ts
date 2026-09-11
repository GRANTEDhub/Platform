import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { truncateSafely } from "@/lib/grantbot/label";

// The FIRM conversation store — the client-less sibling of store.ts. Memory (Brick 2).
//
// ── WHAT THIS ADDS, AND WHAT IT REUSES ──
//
// A firm thread is a grantbot_conversations row with scope='firm' and client_id=null (migration
// 0097). Only the CLIENT-SCOPED store.ts functions need firm variants — create / list / get / rename
// all key on client_id, which a firm thread does not have. Everything else in store.ts is
// conversation_id-scoped and CLIENT-AGNOSTIC (appendUser, appendAssistant, loadMessages, nextSeq,
// touchConversation, conversationTitle), so the firm turn imports those DIRECTLY from store.ts and this
// module is only the create / list / get / rename set. store.ts is not touched — byte-identical.
// (Rename rides the cross-thread fast-follow, the same brick that adds the firm bot's read tools.)
//
// ── scope='firm' IS THE BOUNDARY, ON A SERVICE-ROLE PATH ──
//
// The firm routes run service-role (RLS bypassed, like every GrantBot write), so scope is the code-
// side boundary the way client_id is for the per-client store: getFirmConversation and
// updateFirmConversationTitle both filter `scope='firm'`, so a CLIENT conversation id handed to a
// firm route resolves to nothing (never read, never renamed) — the same discipline that keeps the
// per-client store from touching another client's rows. rowToFirmConversation carries no clientId
// field (it is always null for a firm thread), so there is no `String(null)` → "null" trap.
//
// ── APPEND-ONLY, VIA THE ABSENCE OF A POLICY ──
//
// 0080 + 0097 give the tables a staff SELECT policy and nothing else, so these writes run
// service-role and no API caller can rewrite a stored answer — the firm transcript is as
// unrewritable as the per-client one.

// A firm thread carries no client, so — unlike store.ts's Conversation — there is no clientId here.
export interface FirmConversation {
  id: string;
  title: string | null;
  startedByEmail: string | null;
  createdAt: string;
  lastMessageAt: string;
}

const FIRM_COLS = "id, title, started_by_email, created_at, last_message_at";

// The title column budget, same 80 as store.ts's TITLE_CHARS — a hand-typed rename is normalised and
// hard-capped so it cannot blank or overrun the column.
const FIRM_TITLE_CHARS = 80;

export async function createFirmConversation(
  db: SupabaseClient,
  opts: { title: string; startedBy?: string | null; startedByEmail?: string | null },
): Promise<FirmConversation | null> {
  const { data, error } = await db
    .from("grantbot_conversations")
    .insert({
      // The two fields that make this a firm thread. The 0097 CHECK pairs them: scope='firm'
      // REQUIRES client_id null, so this insert is the only shape that validates for a firm row.
      scope: "firm",
      client_id: null,
      title: opts.title,
      started_by: opts.startedBy ?? null,
      started_by_email: opts.startedByEmail ?? null,
    })
    .select(FIRM_COLS)
    .maybeSingle();
  if (error || !data) {
    console.error("Firm GrantBot conversation create failed", error?.message);
    return null;
  }
  return rowToFirmConversation(data);
}

// One firm thread by id, but ONLY if it is a firm thread. The scope filter is the boundary: a
// client conversation id returns null here, so the firm turn route rejects it rather than appending
// a firm turn onto a client's thread.
export async function getFirmConversation(
  db: SupabaseClient,
  id: string,
): Promise<FirmConversation | null> {
  const { data } = await db
    .from("grantbot_conversations")
    .select(FIRM_COLS)
    .eq("id", id)
    .eq("scope", "firm")
    .maybeSingle();
  return data ? rowToFirmConversation(data) : null;
}

export async function listFirmConversations(
  db: SupabaseClient,
  limit = 30,
): Promise<FirmConversation[]> {
  return (await listFirmConversationsResult(db, limit)).conversations;
}

// Result-returning sibling that SURFACES a PostgREST error instead of swallowing it. The cross-thread
// `list` tool needs to tell a genuine empty list from a query FAILURE: a swallowed error reported to the
// model as "no other firm conversations" would let it give an authoritative wrong answer during a
// transient DB/schema fault (Codex #542). The rail read route keeps the []-on-error listFirmConversations
// above (an empty rail is a display glitch, not a model-facing claim). ONE query, so the two can't drift.
export async function listFirmConversationsResult(
  db: SupabaseClient,
  limit = 30,
): Promise<{ conversations: FirmConversation[]; error: string | null }> {
  const { data, error } = await db
    .from("grantbot_conversations")
    .select(FIRM_COLS)
    .eq("scope", "firm")
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (error) return { conversations: [], error: error.message };
  return { conversations: (data ?? []).map(rowToFirmConversation), error: null };
}

// Rename a firm thread, but ONLY if it is a firm thread. The scope='firm' filter is the boundary —
// exactly like getFirmConversation — so a client conversation id updates ZERO rows (never renamed
// through the firm surface), mirroring store.ts's updateConversationTitle scoping the write by
// client_id. It edits only the conversation TITLE (metadata); it never touches grantbot_messages, so
// the append-only-transcript invariant is intact (0080). Service-role, like touchConversation — 0080
// gives these tables no UPDATE policy, so the write bypasses RLS and the staff-gated route is the
// authorization boundary. The title is whitespace-collapsed and hard-capped through truncateSafely
// (the module's ONE surrogate-safe char-cap), so a hand-typed name cannot blank the column, overrun
// it, or be cut mid-surrogate-pair; an empty title is refused WITHOUT a write.
export async function updateFirmConversationTitle(
  db: SupabaseClient,
  opts: { conversationId: string; title: string },
): Promise<boolean> {
  const normalized = opts.title.replace(/\s+/g, " ").trim();
  const title = truncateSafely(normalized, FIRM_TITLE_CHARS).text;
  if (!title) return false;
  const { error } = await db
    .from("grantbot_conversations")
    .update({ title })
    .eq("id", opts.conversationId)
    .eq("scope", "firm");
  if (error) {
    console.error("Firm GrantBot conversation rename failed", error.message);
    return false;
  }
  return true;
}

function rowToFirmConversation(r: Record<string, unknown>): FirmConversation {
  return {
    id: String(r.id),
    title: (r.title as string | null) ?? null,
    startedByEmail: (r.started_by_email as string | null) ?? null,
    createdAt: String(r.created_at),
    lastMessageAt: String(r.last_message_at),
  };
}
