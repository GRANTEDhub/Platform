import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateConversationTitle } from "./store";

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
