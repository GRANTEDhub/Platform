import { describe, it, expect } from "vitest";
import { anyClientMatchPending } from "./match-queue-guard";

// The empty-queue fast-path guard the client-match cron / admin drain use to skip the
// drain (and its ~2.4s whole-pool load) when nothing is queued. Pure logic over a
// PostgREST count -- the value that decides whether loadPool runs at all.

type Resolved = { count: number | null; error: { message: string } | null };

// Minimal PostgREST-shaped fake: db.from(t).select(cols,{count,head}).in(col,vals) -> Promise<{count,error}>.
function fakeDb(
  resolved: Resolved,
  spy?: (call: { table: string; col: string; vals: unknown[] }) => void,
) {
  return {
    from(table: string) {
      return {
        select(_cols: string, _opts?: unknown) {
          return {
            in(col: string, vals: unknown[]) {
              spy?.({ table, col, vals });
              return Promise.resolve(resolved);
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof anyClientMatchPending>[0];
}

describe("anyClientMatchPending -- empty-queue fast-path for the client match drain", () => {
  it("true when a client is queued or running (count > 0) -> the drain runs", async () => {
    expect(await anyClientMatchPending(fakeDb({ count: 1, error: null }))).toBe(true);
    expect(await anyClientMatchPending(fakeDb({ count: 5, error: null }))).toBe(true);
  });

  it("false when nothing is queued (count 0) -> the drain and its whole-pool load are skipped", async () => {
    expect(await anyClientMatchPending(fakeDb({ count: 0, error: null }))).toBe(false);
  });

  it("null count with no error reads as empty -> skip", async () => {
    expect(await anyClientMatchPending(fakeDb({ count: null, error: null }))).toBe(false);
  });

  it("FAILS OPEN: a query error returns true, so a read blip never silently pauses client matching", async () => {
    expect(await anyClientMatchPending(fakeDb({ count: null, error: { message: "boom" } }))).toBe(true);
    // Fails open even if the DB happens to report count 0 alongside the error.
    expect(await anyClientMatchPending(fakeDb({ count: 0, error: { message: "boom" } }))).toBe(true);
  });

  it("checks clients on the drain's OWN status predicate (queued|running), no lease filter", async () => {
    let seen: { table: string; col: string; vals: unknown[] } | undefined;
    await anyClientMatchPending(fakeDb({ count: 0, error: null }, (c) => (seen = c)));
    expect(seen).toEqual({ table: "clients", col: "initial_match_status", vals: ["queued", "running"] });
  });
});
