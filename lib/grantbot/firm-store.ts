import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The FIRM conversation store — the client-less sibling of store.ts. Memory (Brick 2).
//
// ── WHAT THIS ADDS, AND WHAT IT REUSES ──
//
// A firm thread is a grantbot_conversations row with scope='firm' and client_id=null (migration
// 0097). Only the CLIENT-SCOPED store.ts functions need firm variants — create / list / get all key
// on client_id, which a firm thread does not have. Everything else in store.ts is conversation_id-
// scoped and CLIENT-AGNOSTIC (appendUser, appendAssistant, loadMessages, nextSeq, touchConversation,
// conversationTitle), so the firm turn imports those DIRECTLY from store.ts and this module is only
// the create / list / get trio. store.ts is not touched — byte-identical. (Rename is deliberately
// out of v1, exactly as the per-client bot shipped without it in 0080 — auto-title now, a rename
// route rides the cross-thread fast-follow.)
//
// ── scope='firm' IS THE BOUNDARY, ON A SERVICE-ROLE PATH ──
//
// The firm routes run service-role (RLS bypassed, like every GrantBot write), so scope is the code-
// side boundary the way client_id is for the per-client store: getFirmConversation and
// updateFirmConversationTitle both filter `scope='firm'`, so a CLIENT conversation id handed to a
// firm route resolves to nothing (never appended to, never renamed) — the same discipline that keeps
// the per-client store from touching another client's rows. rowToFirmConversation carries no
// clientId field (it is always null for a firm thread), so there is no `String(null)` → "null" trap.
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
  const { data } = await db
    .from("grantbot_conversations")
    .select(FIRM_COLS)
    .eq("scope", "firm")
    .order("last_message_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map(rowToFirmConversation);
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
