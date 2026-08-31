import { describe, it, expect, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  grantbotCrossThreadEnabled,
  executeCrossThreadTool,
  CROSS_THREAD_INSTRUCTION_BLOCK,
  LIST_CONVERSATIONS_TOOL,
  LIST_CONVERSATIONS_TOOL_NAME,
  READ_CONVERSATION_TOOL,
  READ_CONVERSATION_TOOL_NAME,
  MAX_TRANSCRIPT_CHARS,
} from "./cross-thread";

// A minimal fake of the three read chains the executor uses:
//   getConversation:  from(conversations).select().eq("id",…).maybeSingle()
//   listConversations: from(conversations).select().eq("client_id",…).order().limit()  (awaited)
//   loadMessages:      from(messages).select().eq("conversation_id",…).order()          (awaited)
interface Row {
  id: string;
  client_id: string;
  title: string | null;
  last_message_at: string;
  created_at: string;
  started_by_email: string | null;
}
function fakeDb(fixture: {
  conversations: Row[];
  messages: Record<string, { role: string; content: unknown; seq: number }[]>;
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
      maybeSingle: async () => {
        const c = fixture.conversations.find((r) => r.id === filters.id) ?? null;
        return { data: c, error: null };
      },
      // Awaited terminal for list (by client_id) and loadMessages (by conversation_id).
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        if (table === "grantbot_conversations") {
          const rows = fixture.conversations
            .filter((r) => r.client_id === filters.client_id)
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
    { id: "conv-current", client_id: "c1", title: "Current thread", last_message_at: "2026-08-31T10:00:00Z", created_at: "2026-08-01", started_by_email: null },
    { id: "conv-other", client_id: "c1", title: "JAG grant thread", last_message_at: "2026-08-20T10:00:00Z", created_at: "2026-08-01", started_by_email: null },
    { id: "conv-evil", client_id: "c2", title: "SECRET OTHER CLIENT PLAN", last_message_at: "2026-08-25T10:00:00Z", created_at: "2026-08-01", started_by_email: null },
  ] as Row[],
  messages: {
    "conv-other": [
      { role: "user", content: [{ type: "text", text: "Is NWACC eligible to prime the JAG grant?" }], seq: 1 },
      { role: "assistant", content: [{ type: "text", text: "No — the FY26 allocation lists them as a disparate-group member; they can only sub." }], seq: 2 },
    ],
    "conv-evil": [
      { role: "assistant", content: [{ type: "text", text: "TOP SECRET competitor strategy for client c2." }], seq: 1 },
    ],
  },
};

const CTX = { db: fakeDb(FIXTURE), clientId: "c1", currentConversationId: "conv-current" };

describe("grantbotCrossThreadEnabled", () => {
  const prev = process.env.GRANTBOT_CROSS_THREAD_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_CROSS_THREAD_ENABLED;
    else process.env.GRANTBOT_CROSS_THREAD_ENABLED = prev;
  });
  it("is off by default and off for anything but the literal 'true'", () => {
    delete process.env.GRANTBOT_CROSS_THREAD_ENABLED;
    expect(grantbotCrossThreadEnabled()).toBe(false);
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_CROSS_THREAD_ENABLED = v;
      expect(grantbotCrossThreadEnabled()).toBe(false);
    }
    process.env.GRANTBOT_CROSS_THREAD_ENABLED = "true";
    expect(grantbotCrossThreadEnabled()).toBe(true);
  });
});

describe("CROSS_THREAD_INSTRUCTION_BLOCK", () => {
  it("is non-cacheable, names both tools, and states the this-client-only scope", () => {
    expect(CROSS_THREAD_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(CROSS_THREAD_INSTRUCTION_BLOCK.kind).toBe("cross-thread");
    expect(CROSS_THREAD_INSTRUCTION_BLOCK.text).toContain(LIST_CONVERSATIONS_TOOL.name);
    expect(CROSS_THREAD_INSTRUCTION_BLOCK.text).toContain(READ_CONVERSATION_TOOL.name);
    expect(CROSS_THREAD_INSTRUCTION_BLOCK.text).toMatch(/this client|never .*another client/i);
  });
});

describe("executeCrossThreadTool — list", () => {
  it("lists the client's OTHER threads and excludes the current one", async () => {
    const { resultText, audit } = await executeCrossThreadTool({ name: LIST_CONVERSATIONS_TOOL_NAME, input: {} }, CTX);
    expect(audit).toEqual({ action: "list", ok: true, count: 1 });
    expect(resultText).toContain("conv-other");
    expect(resultText).toContain("JAG grant thread");
    expect(resultText).not.toContain("conv-current"); // the current thread is excluded
    expect(resultText).not.toContain("conv-evil"); // a different client's thread never appears
    expect(resultText).not.toContain("SECRET OTHER CLIENT");
  });

  it("reports none when the client has only the current thread", async () => {
    const ctx = { db: fakeDb({ conversations: [FIXTURE.conversations[0]], messages: {} }), clientId: "c1", currentConversationId: "conv-current" };
    const { resultText, audit } = await executeCrossThreadTool({ name: LIST_CONVERSATIONS_TOOL_NAME, input: {} }, ctx);
    expect(audit).toEqual({ action: "list", ok: true, count: 0 });
    expect(resultText).toMatch(/no other conversations/i);
  });
});

describe("executeCrossThreadTool — read", () => {
  it("reads a same-client thread and renders its transcript", async () => {
    const { resultText, audit } = await executeCrossThreadTool(
      { name: READ_CONVERSATION_TOOL_NAME, input: { conversation_id: "conv-other" } },
      CTX,
    );
    expect(audit).toEqual({ action: "read", ok: true, conversationId: "conv-other", count: 2 });
    expect(resultText).toContain("JAG grant thread");
    expect(resultText).toContain("Staff: Is NWACC eligible");
    expect(resultText).toContain("GrantBot: No — the FY26 allocation");
  });

  it("REFUSES a different client's thread and never returns its content (the cross-client boundary)", async () => {
    const { resultText, audit } = await executeCrossThreadTool(
      { name: READ_CONVERSATION_TOOL_NAME, input: { conversation_id: "conv-evil" } },
      CTX,
    );
    expect(audit).toEqual({ action: "read", ok: false, conversationId: "conv-evil", reason: "not_found_or_cross_client" });
    expect(resultText).not.toContain("TOP SECRET");
    expect(resultText).not.toContain("SECRET OTHER CLIENT");
    expect(resultText).toMatch(/different client|no such conversation/i);
  });

  it("refuses a non-existent thread with the SAME message as a cross-client one (no existence leak)", async () => {
    const cross = await executeCrossThreadTool({ name: READ_CONVERSATION_TOOL_NAME, input: { conversation_id: "conv-evil" } }, CTX);
    const missing = await executeCrossThreadTool({ name: READ_CONVERSATION_TOOL_NAME, input: { conversation_id: "conv-nope" } }, CTX);
    expect(missing.resultText).toBe(cross.resultText); // identical, so a caller can't tell "exists elsewhere" from "doesn't exist"
    expect(missing.audit.reason).toBe("not_found_or_cross_client");
  });

  it("refuses the current thread (already in context)", async () => {
    const { resultText, audit } = await executeCrossThreadTool(
      { name: READ_CONVERSATION_TOOL_NAME, input: { conversation_id: "conv-current" } },
      CTX,
    );
    expect(audit).toMatchObject({ action: "read", ok: false, reason: "current_thread" });
    expect(resultText).toMatch(/current conversation/i);
  });

  it("refuses a missing conversation_id without a read", async () => {
    const { audit } = await executeCrossThreadTool({ name: READ_CONVERSATION_TOOL_NAME, input: {} }, CTX);
    expect(audit).toEqual({ action: "read", ok: false, reason: "no_id" });
  });

  it("caps the transcript even when the newest message alone exceeds the budget", async () => {
    // A single message far larger than the cap (reachable via the 200k-char attach path). The cap is
    // absolute: the returned transcript must not carry the whole oversized message.
    const huge = "Z".repeat(MAX_TRANSCRIPT_CHARS * 2);
    const fx = {
      conversations: [
        FIXTURE.conversations[0],
        { id: "conv-big", client_id: "c1", title: "Big thread", last_message_at: "2026-08-19T10:00:00Z", created_at: "2026-08-01", started_by_email: null },
      ] as Row[],
      messages: { "conv-big": [{ role: "user", content: [{ type: "text", text: huge }], seq: 1 }] },
    };
    const ctx = { db: fakeDb(fx), clientId: "c1", currentConversationId: "conv-current" };
    const { resultText, audit } = await executeCrossThreadTool(
      { name: READ_CONVERSATION_TOOL_NAME, input: { conversation_id: "conv-big" } },
      ctx,
    );
    expect(audit).toEqual({ action: "read", ok: true, conversationId: "conv-big", count: 1 });
    // The Z-run is bounded by the cap: the whole message (label + body) is truncated to
    // MAX_TRANSCRIPT_CHARS, so the Z count is the cap minus the short "Staff: " label -- NOT the
    // full 2× cap the message actually held.
    const zCount = (resultText.match(/Z/g) ?? []).length;
    expect(zCount).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    expect(zCount).toBeGreaterThan(MAX_TRANSCRIPT_CHARS - 20);
    expect(resultText).toMatch(/truncated to fit/i);
  });
});
