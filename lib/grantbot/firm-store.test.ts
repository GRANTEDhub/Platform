import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFirmConversation,
  getFirmConversation,
  listFirmConversations,
  listFirmConversationsResult,
  updateFirmConversationTitle,
} from "./firm-store";

// Deterministic — no DB. Locks the firm-store invariants that matter:
//   ① createFirmConversation writes scope='firm' AND client_id=null (the 0097 CHECK pairing).
//   ② getFirmConversation and listFirmConversations filter scope='firm', so a CLIENT thread is
//      INVISIBLE to the firm surface — the code-side boundary on a service-role path (RLS is bypassed).
//   ③ updateFirmConversationTitle scopes the write to id AND scope='firm' (never a client thread),
//      normalises + caps the title, and refuses an empty one without writing.

interface Row {
  id: string;
  scope: string;
  client_id: string | null;
  title: string | null;
  started_by_email: string | null;
  created_at: string;
  last_message_at: string;
}

// A minimal fake of the three chains firm-store uses:
//   create: from().insert(payload).select().maybeSingle()
//   get:    from().select().eq("id").eq("scope","firm").maybeSingle()
//   list:   from().select().eq("scope","firm").order().limit()   (awaited)
function fakeDb(fixture: { conversations: Row[]; listError?: string }) {
  const inserted: Record<string, unknown>[] = [];
  const from = () => {
    const filters: Record<string, unknown> = {};
    let payload: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {
      insert: (p: Record<string, unknown>) => {
        payload = p;
        inserted.push(p);
        return builder;
      },
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        if (payload) {
          // Echo the created row with server-generated fields, as .select() would.
          return {
            data: {
              id: "firm-new",
              title: payload.title ?? null,
              started_by_email: payload.started_by_email ?? null,
              created_at: "2026-09-11T00:00:00Z",
              last_message_at: "2026-09-11T00:00:00Z",
            },
            error: null,
          };
        }
        const c = fixture.conversations.find(
          (r) => r.id === filters.id && (filters.scope === undefined || r.scope === filters.scope),
        );
        return { data: c ?? null, error: null };
      },
      then: (resolve: (v: { data: unknown; error: { message: string } | null }) => void) => {
        if (fixture.listError) {
          resolve({ data: null, error: { message: fixture.listError } });
          return;
        }
        const rows = fixture.conversations
          .filter((r) => filters.scope === undefined || r.scope === filters.scope)
          .sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : -1));
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  };
  return { db: { from } as unknown as SupabaseClient, inserted };
}

const clientRow: Row = {
  id: "c-thread",
  scope: "client",
  client_id: "client-1",
  title: "A client thread",
  started_by_email: "staff@grantedco.com",
  created_at: "2026-09-10T00:00:00Z",
  last_message_at: "2026-09-10T00:00:00Z",
};
const firmRow: Row = {
  id: "f-thread",
  scope: "firm",
  client_id: null,
  title: "A firm thread",
  started_by_email: "shannon@grantedco.com",
  created_at: "2026-09-11T00:00:00Z",
  last_message_at: "2026-09-11T00:00:00Z",
};

describe("createFirmConversation", () => {
  it("writes scope='firm' and client_id=null (the 0097 pairing)", async () => {
    const { db, inserted } = fakeDb({ conversations: [] });
    const convo = await createFirmConversation(db, { title: "New strategy thread", startedByEmail: "shannon@grantedco.com" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].scope).toBe("firm");
    expect(inserted[0].client_id).toBeNull();
    // The returned shape carries no clientId — a firm thread has none.
    expect(convo?.id).toBe("firm-new");
    expect(convo && "clientId" in convo).toBe(false);
  });
});

describe("getFirmConversation — scope boundary", () => {
  it("returns a firm thread by id", async () => {
    const { db } = fakeDb({ conversations: [firmRow, clientRow] });
    const convo = await getFirmConversation(db, "f-thread");
    expect(convo?.id).toBe("f-thread");
  });

  it("returns null for a CLIENT thread id — a client thread is invisible to the firm surface", async () => {
    const { db } = fakeDb({ conversations: [firmRow, clientRow] });
    const convo = await getFirmConversation(db, "c-thread");
    expect(convo).toBeNull();
  });
});

describe("listFirmConversations — scope boundary", () => {
  it("returns only scope='firm' rows, never client threads", async () => {
    const { db } = fakeDb({ conversations: [firmRow, clientRow] });
    const list = await listFirmConversations(db);
    expect(list.map((c) => c.id)).toEqual(["f-thread"]);
  });
});

describe("listFirmConversationsResult — surfaces query errors (Codex #542)", () => {
  it("returns the error string, NOT a swallowed empty list, when the query fails", async () => {
    const { db } = fakeDb({ conversations: [firmRow], listError: "connection reset" });
    const res = await listFirmConversationsResult(db);
    expect(res.error).toBe("connection reset");
    expect(res.conversations).toEqual([]);
  });

  it("returns firm conversations and a null error on success", async () => {
    const { db } = fakeDb({ conversations: [firmRow, clientRow] });
    const res = await listFirmConversationsResult(db);
    expect(res.error).toBeNull();
    expect(res.conversations.map((c) => c.id)).toEqual(["f-thread"]);
  });
});

// A minimal fake of the update chain updateFirmConversationTitle uses:
//   db.from(t).update(row).eq("id",…).eq("scope","firm") -> awaited -> { error }
// Captures the written row and the eq filters so a test can assert the title was normalised and the
// write was scoped to id AND scope='firm' (never a client thread).
interface UpdateCapture {
  update?: Record<string, unknown>;
  eqs: [string, unknown][];
  error?: string;
}
function fakeUpdateDb(capture: UpdateCapture): SupabaseClient {
  const from = () => ({
    update: (row: Record<string, unknown>) => {
      capture.update = row;
      const chain = {
        eq: (col: string, val: unknown) => {
          capture.eqs.push([col, val]);
          return chain;
        },
        then: (resolve: (v: { error: { message: string } | null }) => void) =>
          resolve({ error: capture.error ? { message: capture.error } : null }),
      };
      return chain;
    },
  });
  return { from } as unknown as SupabaseClient;
}

describe("updateFirmConversationTitle", () => {
  it("normalises whitespace, trims, and scopes the write to id AND scope='firm'", async () => {
    const capture: UpdateCapture = { eqs: [] };
    const ok = await updateFirmConversationTitle(fakeUpdateDb(capture), {
      conversationId: "f-thread",
      title: "  Pricing   +\n Build  ",
    });
    expect(ok).toBe(true);
    expect(capture.update).toEqual({ title: "Pricing + Build" });
    // The boundary: id AND scope='firm', so a client-thread id updates zero rows.
    expect(capture.eqs).toEqual([
      ["id", "f-thread"],
      ["scope", "firm"],
    ]);
  });

  it("caps the title at the column budget (80 chars), surrogate-safe", async () => {
    const capture: UpdateCapture = { eqs: [] };
    // 79 chars then an astral emoji: a plain slice(0, 80) would cut the surrogate pair in half.
    await updateFirmConversationTitle(fakeUpdateDb(capture), {
      conversationId: "f-thread",
      title: "y".repeat(79) + "📄" + "z".repeat(20),
    });
    const title = capture.update?.title as string;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toBe(title.toWellFormed()); // no dangling lone surrogate
  });

  it("refuses an empty / whitespace-only title WITHOUT writing (never blanks a row)", async () => {
    const capture: UpdateCapture = { eqs: [] };
    const ok = await updateFirmConversationTitle(fakeUpdateDb(capture), {
      conversationId: "f-thread",
      title: "   \n  ",
    });
    expect(ok).toBe(false);
    expect(capture.update).toBeUndefined(); // .from().update() was never reached
  });

  it("returns false when the write errors", async () => {
    const capture: UpdateCapture = { eqs: [], error: "boom" };
    const ok = await updateFirmConversationTitle(fakeUpdateDb(capture), {
      conversationId: "f-thread",
      title: "A real title",
    });
    expect(ok).toBe(false);
  });
});
