import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeDb } from "./fake-db";
import { arStateMonitorEnabled, runMonitor } from "./monitor";
import { contentHashOf, type FetchTextResult } from "./add-source";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = (db: FakeDb) => db as any;

describe("arStateMonitorEnabled", () => {
  const prev = process.env.AR_STATE_MONITOR_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.AR_STATE_MONITOR_ENABLED;
    else process.env.AR_STATE_MONITOR_ENABLED = prev;
  });
  it("is off unless the env var is exactly 'true'", () => {
    delete process.env.AR_STATE_MONITOR_ENABLED;
    expect(arStateMonitorEnabled()).toBe(false);
    process.env.AR_STATE_MONITOR_ENABLED = "1";
    expect(arStateMonitorEnabled()).toBe(false);
    process.env.AR_STATE_MONITOR_ENABLED = "true";
    expect(arStateMonitorEnabled()).toBe(true);
  });
});

describe("runMonitor — change detection", () => {
  function setup() {
    const grants = [
      { id: "g1", funder: "F1", title: "Unchanged Program" },
      { id: "g2", funder: "F2", title: "Changed Program" },
      { id: "g3", funder: "F3", title: "Down Program" },
      { id: "g4", funder: "F4", title: "Thin Seed Program" },
      { id: "g5", funder: "F5", title: "Reference Program" },
    ];
    const monitor = [
      { id: "m1", grant_id: "g1", monitor_url: "https://a.gov", jurisdiction: "AR", monitor_mode: "auto", last_content_hash: contentHashOf("SAME") },
      { id: "m2", grant_id: "g2", monitor_url: "https://b.gov", jurisdiction: "AR", monitor_mode: "auto", last_content_hash: contentHashOf("OLD") },
      { id: "m3", grant_id: "g3", monitor_url: "https://c.gov", jurisdiction: "AR", monitor_mode: "auto", last_content_hash: contentHashOf("X") },
      { id: "m4", grant_id: "g4", monitor_url: "https://d.gov", jurisdiction: "AR", monitor_mode: "auto", last_content_hash: null },
      { id: "m5", grant_id: "g5", monitor_url: "https://e.gov", jurisdiction: "AR", monitor_mode: "reference", last_content_hash: null },
    ];
    const pageByUrl: Record<string, FetchTextResult> = {
      "https://a.gov": { ok: true, text: "SAME" },
      "https://b.gov": { ok: true, text: "NEW CONTENT" },
      "https://c.gov": { ok: false, text: "", reason: "blocked_host" },
      "https://d.gov": { ok: true, text: "FIRST READ" },
    };
    const fetched: string[] = [];
    const fetchText = async (url: string): Promise<FetchTextResult> => {
      fetched.push(url);
      return pageByUrl[url] ?? { ok: false, text: "", reason: "unknown" };
    };
    return { db: new FakeDb({ grants, monitor }), fetchText, fetched };
  }

  it("re-derives only changed / first-baseline rows, skips reference, tolerates unreachable", async () => {
    const { db, fetchText, fetched } = setup();
    const pipeline = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rep = await runMonitor(anyDb(db), { fetchText, runPipelineImpl: pipeline as any });

    expect(rep.checked).toBe(4); // m1-m4; m5 reference is skipped before any fetch
    expect(rep.skipped).toBe(1); // m5
    expect(rep.unreachable).toBe(1); // m3
    expect(rep.changed).toBe(1); // m2 (real content move)
    expect(rep.rederived).toBe(2); // m2 changed + m4 first-baseline enrichment
    expect(fetched).not.toContain("https://e.gov"); // reference row never fetched

    // re-derive ran for exactly g2 and g4, with our controlled rawText (never a plain re-fetch)
    const targets = pipeline.mock.calls.map((c) => c[0]).sort();
    expect(targets).toEqual(["g2", "g4"]);
    for (const call of pipeline.mock.calls) {
      expect(call[1]).toBeUndefined(); // url=undefined
      expect(call[2]).toContain("State of Arkansas");
    }
    // the changed grant's re-derive carries its own identity (shared-page safety)
    const g2call = pipeline.mock.calls.find((c) => c[0] === "g2")!;
    expect(g2call[2]).toContain("Changed Program");
  });

  it("advances the baseline on an unchanged page without re-deriving", async () => {
    const { db, fetchText } = setup();
    const pipeline = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runMonitor(anyDb(db), { fetchText, runPipelineImpl: pipeline as any });
    // m1 was unchanged -> no re-derive for g1
    expect(pipeline.mock.calls.find((c) => c[0] === "g1")).toBeUndefined();
    // m3 unreachable -> its hash is left untouched (not blanked)
    expect(db.monitor.find((r) => r.id === "m3")!.last_content_hash).toBe(contentHashOf("X"));
  });

  it("keeps the OLD baseline (retryable) when a changed page's re-derive throws", async () => {
    const oldHash = contentHashOf("OLD");
    const db = new FakeDb({
      grants: [{ id: "g1", funder: "F", title: "P" }],
      monitor: [{ id: "m1", grant_id: "g1", monitor_url: "https://a.gov", jurisdiction: "AR", monitor_mode: "auto", last_content_hash: oldHash }],
    });
    const fetchText = async (): Promise<FetchTextResult> => ({ ok: true, text: "NEW" });
    const pipeline = vi.fn().mockRejectedValue(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rep = await runMonitor(anyDb(db), { fetchText, runPipelineImpl: pipeline as any });
    expect(rep.rederived).toBe(0);
    expect(db.monitor[0].last_content_hash).toBe(oldHash); // NOT advanced -> the change is re-detected next run
    expect(db.grants[0].status).toBe("error");
  });
});
