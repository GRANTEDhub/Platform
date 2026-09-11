import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  executeFirmCrossThreadTool,
  FIRM_CROSS_THREAD_INSTRUCTION_BLOCK,
  LIST_FIRM_CONVERSATIONS_TOOL,
  LIST_FIRM_CONVERSATIONS_TOOL_NAME,
  READ_FIRM_CONVERSATION_TOOL,
  READ_FIRM_CONVERSATION_TOOL_NAME,
  MAX_TRANSCRIPT_CHARS,
} from "./firm-cross-thread";

// Deterministic — no model, no DB. Locks the firm cross-thread boundary: the tools see FIRM threads
// only (scope='firm'), and a CLIENT thread is refused IDENTICALLY to a non-existent one, so the firm
// bot can never read (or even confirm the existence of) a client's own per-client GrantBot thread.
//
// A minimal fake of the three chains the executor uses via firm-store + store:
//   getFirmConversation:   from(conversations).select().eq("id",…).eq("scope","firm").maybeSingle()
//   listFirmConversations: from(conversations).select().eq("scope","firm").order().limit()  (awaited)
//   loadMessages:          from(messages).select().eq("conversation_id",…).order()          (awaited)
interface Row {
  id: string;
  scope: string;
  client_id: string | null;
  title: string | null;
  last_message_at: string;
  created_at: string;
  started_by_email: string | null;
}
function fakeDb(fixture: {
  conversations: Row[];
  messages: Record<string, { role: string; content: unknown; seq: number }[]>;
  // Inject a PostgREST error on the list query, to prove the tool reports a typed FAILURE rather than
  // a swallowed empty list (Codex #542).
  listError?: string;
}): SupabaseClient {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      // getFirmConversation: matches id AND scope='firm', so a client-scope row is invisible.
      maybeSingle: async () => {
        const c =
          fixture.conversations.find(
            (r) => r.id === filters.id && (filters.scope === undefined || r.scope === filters.scope),
          ) ?? null;
        return { data: c, error: null };
      },
      // Awaited terminal for listFirmConversationsResult (scope filter) and loadMessages (conversation_id).
      then: (resolve: (v: { data: unknown; error: { message: string } | null }) => void) => {
        if (table === "grantbot_conversations") {
          if (fixture.listError) {
            resolve({ data: null, error: { message: fixture.listError } });
            return;
          }
          const rows = fixture.conversations
            .filter((r) => filters.scope === undefined || r.scope === filters.scope)
            .sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : -1));
          resolve({ data: rows, error: null });
        } else {
          const rows = (fixture.messages[filters.conversation_id as string] ?? []).slice();
          resolve({ data: rows, error: null });
        }
      },
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

const FIXTURE = {
  conversations: [
    { id: "firm-current", scope: "firm", client_id: null, title: "Current firm thread", last_message_at: "2026-09-11T10:00:00Z", created_at: "2026-09-01", started_by_email: null },
    { id: "firm-other", scope: "firm", client_id: null, title: "Pricing + Build package", last_message_at: "2026-09-05T10:00:00Z", created_at: "2026-09-01", started_by_email: null },
    // A per-client GrantBot thread. The firm bot must NEVER list or read it.
    { id: "client-thread", scope: "client", client_id: "c-secret", title: "NWACC per-client thread", last_message_at: "2026-09-08T10:00:00Z", created_at: "2026-09-01", started_by_email: null },
  ] as Row[],
  messages: {
    "firm-other": [
      { role: "user", content: [{ type: "text", text: "What is our Build package price?" }], seq: 1 },
      { role: "assistant", content: [{ type: "text", text: "Build is a flat monthly retainer; the figure is in the engagement agreement, not the platform." }], seq: 2 },
    ],
    "client-thread": [
      { role: "assistant", content: [{ type: "text", text: "CONFIDENTIAL per-client GrantBot content for c-secret." }], seq: 1 },
    ],
  },
};

const CTX = { db: fakeDb(FIXTURE), currentConversationId: "firm-current" };

describe("FIRM_CROSS_THREAD_INSTRUCTION_BLOCK", () => {
  it("is non-cacheable, names both tools, and states the firm-threads-only scope", () => {
    expect(FIRM_CROSS_THREAD_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(FIRM_CROSS_THREAD_INSTRUCTION_BLOCK.kind).toBe("cross-thread");
    expect(FIRM_CROSS_THREAD_INSTRUCTION_BLOCK.text).toContain(LIST_FIRM_CONVERSATIONS_TOOL.name);
    expect(FIRM_CROSS_THREAD_INSTRUCTION_BLOCK.text).toContain(READ_FIRM_CONVERSATION_TOOL.name);
    expect(FIRM_CROSS_THREAD_INSTRUCTION_BLOCK.text).toMatch(/FIRM threads|client's own GrantBot thread/i);
  });
});

describe("executeFirmCrossThreadTool — list", () => {
  it("lists the OTHER firm threads, excludes the current one, and NEVER a client thread", async () => {
    const { resultText, audit } = await executeFirmCrossThreadTool({ name: LIST_FIRM_CONVERSATIONS_TOOL_NAME, input: {} }, CTX);
    expect(audit).toEqual({ action: "list", ok: true, count: 1 });
    expect(resultText).toContain("firm-other");
    expect(resultText).toContain("Pricing + Build package");
    expect(resultText).not.toContain("firm-current"); // the current thread is excluded
    expect(resultText).not.toContain("client-thread"); // a client thread never appears (scope filter)
    expect(resultText).not.toContain("NWACC per-client thread");
  });

  it("reports none when only the current firm thread exists", async () => {
    const ctx = { db: fakeDb({ conversations: [FIXTURE.conversations[0]], messages: {} }), currentConversationId: "firm-current" };
    const { resultText, audit } = await executeFirmCrossThreadTool({ name: LIST_FIRM_CONVERSATIONS_TOOL_NAME, input: {} }, ctx);
    expect(audit).toEqual({ action: "list", ok: true, count: 0 });
    expect(resultText).toMatch(/no other firm conversations/i);
  });

  it("reports a query FAILURE as a typed failure, NOT an authoritative empty list (Codex #542)", async () => {
    const ctx = { db: fakeDb({ conversations: FIXTURE.conversations, messages: {}, listError: "connection reset" }), currentConversationId: "firm-current" };
    const { resultText, audit } = await executeFirmCrossThreadTool({ name: LIST_FIRM_CONVERSATIONS_TOOL_NAME, input: {} }, ctx);
    expect(audit).toEqual({ action: "list", ok: false, reason: "list_failed" });
    expect(resultText).toMatch(/lookup failed|couldn't check/i);
    // The critical property: a failed lookup must NOT masquerade as "there are none".
    expect(resultText).not.toMatch(/no other firm conversations/i);
  });
});

describe("executeFirmCrossThreadTool — read", () => {
  it("reads a firm thread and renders its transcript", async () => {
    const { resultText, audit } = await executeFirmCrossThreadTool(
      { name: READ_FIRM_CONVERSATION_TOOL_NAME, input: { conversation_id: "firm-other" } },
      CTX,
    );
    expect(audit).toEqual({ action: "read", ok: true, conversationId: "firm-other", count: 2 });
    expect(resultText).toContain("Pricing + Build package");
    expect(resultText).toContain("Staff: What is our Build package price?");
    expect(resultText).toContain("GrantBot: Build is a flat monthly retainer");
  });

  it("REFUSES a client thread and never returns its content (the scope boundary)", async () => {
    const { resultText, audit } = await executeFirmCrossThreadTool(
      { name: READ_FIRM_CONVERSATION_TOOL_NAME, input: { conversation_id: "client-thread" } },
      CTX,
    );
    expect(audit).toEqual({ action: "read", ok: false, conversationId: "client-thread", reason: "not_found_or_not_firm" });
    expect(resultText).not.toContain("CONFIDENTIAL");
    expect(resultText).not.toContain("c-secret");
    expect(resultText).toMatch(/client's own GrantBot thread|no such firm conversation/i);
  });

  it("refuses a non-existent thread with the SAME message as a client one (no existence leak)", async () => {
    const client = await executeFirmCrossThreadTool({ name: READ_FIRM_CONVERSATION_TOOL_NAME, input: { conversation_id: "client-thread" } }, CTX);
    const missing = await executeFirmCrossThreadTool({ name: READ_FIRM_CONVERSATION_TOOL_NAME, input: { conversation_id: "does-not-exist" } }, CTX);
    // Byte-equal, so a caller can't tell "is a client thread" from "doesn't exist".
    expect(missing.resultText).toBe(client.resultText);
    expect(missing.audit.reason).toBe("not_found_or_not_firm");
  });

  it("refuses the current thread (already in context)", async () => {
    const { resultText, audit } = await executeFirmCrossThreadTool(
      { name: READ_FIRM_CONVERSATION_TOOL_NAME, input: { conversation_id: "firm-current" } },
      CTX,
    );
    expect(audit).toMatchObject({ action: "read", ok: false, reason: "current_thread" });
    expect(resultText).toMatch(/current conversation/i);
  });

  it("refuses a missing conversation_id without a read", async () => {
    const { audit } = await executeFirmCrossThreadTool({ name: READ_FIRM_CONVERSATION_TOOL_NAME, input: {} }, CTX);
    expect(audit).toEqual({ action: "read", ok: false, reason: "no_id" });
  });

  it("caps the transcript even when the newest message alone exceeds the budget", async () => {
    const huge = "Z".repeat(MAX_TRANSCRIPT_CHARS * 2);
    const fx = {
      conversations: [
        FIXTURE.conversations[0],
        { id: "firm-big", scope: "firm", client_id: null, title: "Big firm thread", last_message_at: "2026-09-04T10:00:00Z", created_at: "2026-09-01", started_by_email: null },
      ] as Row[],
      messages: { "firm-big": [{ role: "user", content: [{ type: "text", text: huge }], seq: 1 }] },
    };
    const ctx = { db: fakeDb(fx), currentConversationId: "firm-current" };
    const { resultText, audit } = await executeFirmCrossThreadTool(
      { name: READ_FIRM_CONVERSATION_TOOL_NAME, input: { conversation_id: "firm-big" } },
      ctx,
    );
    expect(audit).toEqual({ action: "read", ok: true, conversationId: "firm-big", count: 1 });
    const zCount = (resultText.match(/Z/g) ?? []).length;
    expect(zCount).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    expect(zCount).toBeGreaterThan(MAX_TRANSCRIPT_CHARS - 20);
    expect(resultText).toMatch(/truncated to fit/i);
  });

  it("refuses an unknown tool name without touching the DB", async () => {
    const { audit } = await executeFirmCrossThreadTool({ name: "delete_everything", input: {} }, CTX);
    expect(audit).toMatchObject({ ok: false, reason: "unknown_tool" });
  });
});
