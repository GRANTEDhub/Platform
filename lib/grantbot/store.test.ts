import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConversation, updateConversationTitle } from "./store";

// A minimal fake of the update chain updateConversationTitle uses:
//   db.from(t).update(row).eq("id", …).eq("client_id", …)  -> awaited -> { error }
// It captures the written row and the eq filters so a test can assert the title was normalised and
// the write was scoped to BOTH the conversation id and its client (defence in depth behind the
// route's mislabel guard).
interface Capture {
  update?: Record<string, unknown>;
  eqs: [string, unknown][];
  error?: string;
}
function fakeDb(capture: Capture): SupabaseClient {
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

describe("updateConversationTitle", () => {
  it("normalises whitespace, trims, and scopes the write to id AND client_id", async () => {
    const capture: Capture = { eqs: [] };
    const ok = await updateConversationTitle(fakeDb(capture), {
      conversationId: "conv1",
      clientId: "c1",
      title: "  NWACC   reentry\n grant  ",
    });
    expect(ok).toBe(true);
    expect(capture.update).toEqual({ title: "NWACC reentry grant" });
    expect(capture.eqs).toEqual([
      ["id", "conv1"],
      ["client_id", "c1"],
    ]);
  });

  it("caps the title at the column budget (80 chars)", async () => {
    const capture: Capture = { eqs: [] };
    await updateConversationTitle(fakeDb(capture), {
      conversationId: "conv1",
      clientId: "c1",
      title: "x".repeat(200),
    });
    expect((capture.update?.title as string).length).toBe(80);
  });

  it("caps via truncateSafely, so an emoji on the boundary can't leave a lone surrogate", async () => {
    const capture: Capture = { eqs: [] };
    // 79 chars then an astral emoji: a plain slice(0, 80) would cut the surrogate pair in half.
    await updateConversationTitle(fakeDb(capture), {
      conversationId: "conv1",
      clientId: "c1",
      title: "y".repeat(79) + "📄" + "z".repeat(20),
    });
    const title = capture.update?.title as string;
    expect(title).toBe(title.toWellFormed()); // no dangling lone surrogate
  });

  it("refuses an empty / whitespace-only title WITHOUT writing (never blanks a row)", async () => {
    const capture: Capture = { eqs: [] };
    const ok = await updateConversationTitle(fakeDb(capture), {
      conversationId: "conv1",
      clientId: "c1",
      title: "   \n  ",
    });
    expect(ok).toBe(false);
    expect(capture.update).toBeUndefined(); // .from().update() was never reached
  });

  it("returns false when the write errors", async () => {
    const capture: Capture = { eqs: [], error: "boom" };
    const ok = await updateConversationTitle(fakeDb(capture), {
      conversationId: "conv1",
      clientId: "c1",
      title: "a real title",
    });
    expect(ok).toBe(false);
  });
});

// A minimal fake of getConversation's read chain:
//   db.from(t).select(cols).eq("id",…).eq("scope",…).maybeSingle() -> { data }
// Captures the eq filters (to assert the scope='client' guard) and returns a configurable row.
function fakeSelectDb(row: Record<string, unknown> | null, eqs: [string, unknown][]): SupabaseClient {
  const from = () => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        eqs.push([col, val]);
        return chain;
      },
      maybeSingle: async () => ({ data: row, error: null }),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

// Locks the 0097 security boundary: getConversation is the PER-CLIENT lookup, so it must never
// return a firm thread (scope='firm', client_id NULL) — otherwise the per-client context route
// (staff, not admin-gated) would leak the admin-only firm transcript.
describe("getConversation — firm-row isolation (0097 security boundary)", () => {
  it("filters the read to scope='client', so a firm thread is never returned here", async () => {
    const eqs: [string, unknown][] = [];
    await getConversation(fakeSelectDb(null, eqs), "some-id");
    expect(eqs).toContainEqual(["scope", "client"]);
  });

  it("NEVER coerces a NULL client_id to the string \"null\" (defeats the route's !== guard)", async () => {
    const eqs: [string, unknown][] = [];
    // A defensive check on the mapping itself: even handed a null-client_id row, clientId is "",
    // which the per-client routes reject (their `!clientId` 400) and which never equals a real id.
    const convo = await getConversation(
      fakeSelectDb(
        { id: "x", client_id: null, title: "t", started_by_email: null, created_at: "d", last_message_at: "d" },
        eqs,
      ),
      "x",
    );
    expect(convo?.clientId).toBe("");
    expect(convo?.clientId).not.toBe("null");
  });

  it("maps a real client_id through unchanged", async () => {
    const eqs: [string, unknown][] = [];
    const convo = await getConversation(
      fakeSelectDb(
        { id: "x", client_id: "client-1", title: "t", started_by_email: null, created_at: "d", last_message_at: "d" },
        eqs,
      ),
      "x",
    );
    expect(convo?.clientId).toBe("client-1");
  });
});
