import { describe, it, expect, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { runSeed } from "./seed";
import { AR_STATE_SEED } from "./fixture";
import type { FetchTextResult } from "./add-source";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = (db: FakeDb) => db as any;
const okFetch = async (): Promise<FetchTextResult> => ({ ok: true, text: "page" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopPipeline = vi.fn().mockResolvedValue(undefined) as any;

describe("runSeed — dry-run", () => {
  it("reports all 40 as would_seed against an empty corpus and writes nothing", async () => {
    const db = new FakeDb();
    const r = await runSeed(anyDb(db), { apply: false, fetchText: okFetch });
    expect(r.total).toBe(40);
    expect(r.would_seed).toBe(40);
    expect(r.seeded).toBe(0);
    expect(r.skipped).toBe(0);
    expect(db.writes).toHaveLength(0);
  });

  it("skips already-present urls and flags the verify_url reachability", async () => {
    const seeded = AR_STATE_SEED[0].url;
    const db = new FakeDb({ grants: [{ id: "g1", source_url: seeded }] });
    const r = await runSeed(anyDb(db), { apply: false, fetchText: okFetch });
    expect(r.skipped).toBe(1);
    expect(r.would_seed).toBe(39);
    // exactly one verify_url entry in the fixture -> exactly one reachability note
    expect(r.flagged).toHaveLength(1);
    expect(r.flagged[0]).toMatch(/reachable/);
  });
});

describe("runSeed — apply", () => {
  it("seeds every entry once (grant shell + monitor row) with nothing left remaining", async () => {
    const db = new FakeDb();
    const r = await runSeed(anyDb(db), { apply: true, fetchText: okFetch, runPipelineImpl: noopPipeline });
    expect(r.seeded).toBe(40);
    expect(r.remaining).toBe(0);
    expect(db.grants).toHaveLength(40);
    expect(db.monitor).toHaveLength(40);
  });

  it("is idempotent — a second run skips everything already seeded", async () => {
    const db = new FakeDb();
    await runSeed(anyDb(db), { apply: true, fetchText: okFetch, runPipelineImpl: noopPipeline });
    const again = await runSeed(anyDb(db), { apply: true, fetchText: okFetch, runPipelineImpl: noopPipeline });
    expect(again.seeded).toBe(0);
    expect(again.skipped).toBe(40);
    expect(db.grants).toHaveLength(40); // no duplicates
  });

  it("honors a per-run limit and reports the remainder, making progress across runs", async () => {
    const db = new FakeDb();
    const first = await runSeed(anyDb(db), { apply: true, limit: 5, fetchText: okFetch, runPipelineImpl: noopPipeline });
    expect(first.seeded).toBe(5);
    expect(first.remaining).toBe(35);

    const second = await runSeed(anyDb(db), { apply: true, limit: 5, fetchText: okFetch, runPipelineImpl: noopPipeline });
    expect(second.skipped).toBe(5); // the first batch dedups
    expect(second.seeded).toBe(5); // next five
    expect(second.remaining).toBe(30);
    expect(db.grants).toHaveLength(10);
  });
});
