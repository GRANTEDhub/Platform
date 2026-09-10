import { describe, it, expect, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { addSource, planSource, buildSeedPreamble, contentHashOf, seedSourceUrl, type FetchTextResult } from "./add-source";
import type { SeedGrant } from "./fixture";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = (db: FakeDb) => db as any;

const plainEntry: SeedGrant = {
  grantor: "AR Dept. of Transportation",
  program: "Intersection Improvement Program (IIP)",
  url: "https://ardot.gov/divisions/local-programs/local-funding-opportunities/iip/",
  jurisdiction: "AR",
  funder_type: "state",
  monitor_mode: "auto",
};
const headlessEntry: SeedGrant = {
  grantor: "AR Economic Development Commission",
  program: "Rural Community Grant Program (RCGP)",
  url: "https://www.arkansasedc.com/Rural-Services/division/grants/rural-community-grant",
  jurisdiction: "AR",
  funder_type: "state",
  monitor_mode: "auto",
  tags: ["headless"],
};

function fakeFetch(result: FetchTextResult, spy?: (url: string, headless: boolean) => void) {
  return async (url: string, headless: boolean): Promise<FetchTextResult> => {
    spy?.(url, headless);
    return result;
  };
}

describe("buildSeedPreamble", () => {
  it("pins AR geography + funder/program identity + seed_text and the page body", () => {
    const out = buildSeedPreamble(
      { grantor: "AR Arts Council", program: "GOS", seedText: "operating support for arts nonprofits", url: "https://x.gov" },
      "LIVE PAGE TEXT",
    );
    expect(out).toContain("State of Arkansas");
    expect(out).toContain("AR Arts Council");
    expect(out).toContain("GOS");
    expect(out).toContain("operating support for arts nonprofits");
    expect(out).toContain("LIVE PAGE TEXT");
  });

  it("falls back to a derive-from-identity note when the page could not be read", () => {
    const out = buildSeedPreamble({ grantor: "X", program: "Y", url: "https://x.gov" }, "");
    expect(out).toContain("could not be read");
  });
});

describe("contentHashOf", () => {
  it("is stable for the same visible text and differs for different text", () => {
    expect(contentHashOf("hello world")).toBe(contentHashOf("hello world"));
    expect(contentHashOf("hello world")).not.toBe(contentHashOf("hello mars"));
  });
});

describe("planSource (dry-run, no writes)", () => {
  it("reports would_seed for a new url and never writes", async () => {
    const db = new FakeDb();
    const plan = await planSource(anyDb(db), plainEntry, {});
    expect(plan.action).toBe("would_seed");
    expect(db.writes).toHaveLength(0);
  });

  it("reports skip_exists when the source_url is already a grant", async () => {
    const db = new FakeDb({ grants: [{ id: "g1", source_url: plainEntry.url }] });
    const plan = await planSource(anyDb(db), plainEntry, {});
    expect(plan).toMatchObject({ action: "skip_exists", grantId: "g1" });
    expect(db.writes).toHaveLength(0);
  });

  it("probes reachability for a verify_url entry and records the note", async () => {
    const db = new FakeDb();
    const entry: SeedGrant = { ...plainEntry, tags: ["verify_url"] };
    const ok = await planSource(anyDb(db), entry, { fetchText: fakeFetch({ ok: true, text: "abc" }) }, false);
    expect(ok.action).toBe("would_seed");
    expect((ok as { note?: string }).note).toMatch(/reachable/);
    const bad = await planSource(anyDb(db), entry, { fetchText: fakeFetch({ ok: false, text: "", reason: "blocked_host" }) }, false);
    expect((bad as { note?: string }).note).toMatch(/UNREACHABLE/);
  });
});

describe("seedSourceUrl — shared-page programs get a unique identity", () => {
  const shared = (program: string): SeedGrant => ({
    grantor: "Arkansas Arts Council",
    program,
    url: "https://www.arkansasheritage.com/arkansas-art-council/about/aac-grants",
    jurisdiction: "AR",
    funder_type: "state",
    monitor_mode: "auto",
    tags: ["shared_page"],
    seed_text: "x",
  });

  it("leaves a non-shared url bare and discriminates a shared page by program", () => {
    expect(seedSourceUrl(plainEntry)).toBe(plainEntry.url);
    const gos = seedSourceUrl(shared("General Operating Support (GOS)"));
    const aot = seedSourceUrl(shared("Arts on Tour Grant"));
    expect(gos).not.toBe(aot);
    expect(gos.startsWith(shared("x").url + "#")).toBe(true);
  });

  it("lets two programs on the SAME page both seed (no false dedup collapse)", async () => {
    const db = new FakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline = vi.fn().mockResolvedValue(undefined) as any;
    const a = await addSource(anyDb(db), shared("General Operating Support (GOS)"), { fetchText: fakeFetch({ ok: true, text: "p" }), runPipelineImpl: pipeline });
    const b = await addSource(anyDb(db), shared("Arts on Tour Grant"), { fetchText: fakeFetch({ ok: true, text: "p" }), runPipelineImpl: pipeline });
    expect(a.action).toBe("seeded");
    expect(b.action).toBe("seeded"); // NOT skip_exists — the sibling did not collide
    expect(db.grants).toHaveLength(2);
    // both watch the SAME bare page
    const monitorUrls = db.monitor.map((m) => m.monitor_url);
    expect(monitorUrls[0]).toBe(monitorUrls[1]);
    expect(monitorUrls[0]).toBe(shared("x").url);
    // but carry DISTINCT source identities
    expect(db.grants[0].source_url).not.toBe(db.grants[1].source_url);
  });
});

describe("addSource (apply)", () => {
  it("inserts the grant shell + monitor row and shreds via runPipeline with our rawText", async () => {
    const db = new FakeDb();
    const pipeline = vi.fn().mockResolvedValue(undefined);
    const res = await addSource(anyDb(db), plainEntry, {
      fetchText: fakeFetch({ ok: true, text: "LIVE PAGE" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runPipelineImpl: pipeline as any,
    });
    expect(res.action).toBe("seeded");

    const grantInsert = db.writes.find((w) => w.op === "insert" && w.table === "grants");
    expect(grantInsert?.row).toMatchObject({ source_url: plainEntry.url, title: plainEntry.program, status: "processing" });

    const monitorInsert = db.writes.find((w) => w.op === "insert" && w.table === "grant_monitor_state");
    expect(monitorInsert?.row).toMatchObject({ jurisdiction: "AR", funder_type: "state", monitor_mode: "auto", monitor_url: plainEntry.url });
    expect(monitorInsert?.row.last_content_hash).toBeTruthy(); // baseline captured (fetch ok)

    expect(pipeline).toHaveBeenCalledTimes(1);
    const [grantId, url, rawText] = pipeline.mock.calls[0];
    expect(typeof grantId).toBe("string");
    expect(url).toBeUndefined(); // never re-fetch — shred OUR text
    expect(rawText).toContain("State of Arkansas");
    expect(rawText).toContain(plainEntry.program);
    expect(rawText).toContain("LIVE PAGE");
  });

  it("renders headless for an AEDC/DFA domain and plain-fetches otherwise", async () => {
    const calls: Array<{ url: string; headless: boolean }> = [];
    const spy = (url: string, headless: boolean) => calls.push({ url, headless });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline = vi.fn().mockResolvedValue(undefined) as any;

    await addSource(anyDb(new FakeDb()), headlessEntry, { fetchText: fakeFetch({ ok: true, text: "x" }, spy), runPipelineImpl: pipeline });
    await addSource(anyDb(new FakeDb()), plainEntry, { fetchText: fakeFetch({ ok: true, text: "x" }, spy), runPipelineImpl: pipeline });

    expect(calls[0]).toMatchObject({ url: headlessEntry.url, headless: true });
    expect(calls[1]).toMatchObject({ url: plainEntry.url, headless: false });
  });

  it("skips (no insert, no pipeline) when the url is already a grant", async () => {
    const db = new FakeDb({ grants: [{ id: "g9", source_url: plainEntry.url }] });
    const pipeline = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await addSource(anyDb(db), plainEntry, { runPipelineImpl: pipeline as any });
    expect(res).toMatchObject({ action: "skip_exists", grantId: "g9" });
    expect(db.writes).toHaveLength(0);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("seeds a null baseline hash when the page can't be read, but still shreds from the preamble", async () => {
    const db = new FakeDb();
    const pipeline = vi.fn().mockResolvedValue(undefined);
    const res = await addSource(anyDb(db), plainEntry, {
      fetchText: fakeFetch({ ok: false, text: "", reason: "timeout" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runPipelineImpl: pipeline as any,
    });
    expect(res).toMatchObject({ action: "seeded", fetchOk: false });
    const monitorInsert = db.writes.find((w) => w.op === "insert" && w.table === "grant_monitor_state");
    expect(monitorInsert?.row.last_content_hash).toBeNull();
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline.mock.calls[0][2]).toContain("could not be read");
  });
});
