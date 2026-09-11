import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFirmConversation, getFirmConversation, listFirmConversations } from "./firm-store";

// Deterministic — no DB. Locks the firm-store invariants that matter:
//   ① createFirmConversation writes scope='firm' AND client_id=null (the 0097 CHECK pairing).
//   ② getFirmConversation and listFirmConversations filter scope='firm', so a CLIENT thread is
//      INVISIBLE to the firm surface — the code-side boundary on a service-role path (RLS is bypassed).

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
function fakeDb(fixture: { conversations: Row[] }) {
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
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
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
