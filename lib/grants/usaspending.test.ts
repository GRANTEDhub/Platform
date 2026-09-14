import { describe, it, expect, vi, afterEach } from "vitest";
import { findProgramAwardees } from "./usaspending";

// findProgramAwardees' throwOnError contract (Vercel Agent Review, #552). The default swallows every
// failure to [] (so the discovery caller that falls back to web search on [] is byte-identical);
// throwOnError:true lets a caller that presents the result to a human — GrantBot's
// lookup_program_awards — DISTINGUISH a genuine "no awardees" from a lookup that could not run.

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const okEmpty = () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
const okRows = () =>
  new Response(
    JSON.stringify({ results: [{ "Recipient Name": "State DOT", "Award Amount": 1000, "Awarding Agency": "DOT", "Start Date": "2025-01-01", recipient_id: "r1" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

describe("findProgramAwardees — throwOnError contract", () => {
  it("default (no throwOnError): a non-OK response returns [] — byte-identical for the discovery caller", async () => {
    mockFetch(() => new Response("upstream boom", { status: 500 }));
    await expect(findProgramAwardees(["20.284"])).resolves.toEqual([]);
  });

  it("default: a network error returns [] too", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    await expect(findProgramAwardees(["20.284"])).resolves.toEqual([]);
  });

  it("throwOnError: a non-OK response THROWS (an outage is no longer an authoritative 'no winners')", async () => {
    mockFetch(() => new Response("upstream boom", { status: 503 }));
    await expect(findProgramAwardees(["20.284"], { throwOnError: true })).rejects.toThrow(/HTTP 503/);
  });

  it("throwOnError: a network error / timeout also THROWS", async () => {
    mockFetch(() => Promise.reject(new Error("aborted")));
    await expect(findProgramAwardees(["20.284"], { throwOnError: true })).rejects.toThrow(/aborted/);
  });

  it("throwOnError: a genuine OK-but-empty result still returns [] (a real 'no awardees', not an error)", async () => {
    mockFetch(okEmpty);
    await expect(findProgramAwardees(["20.284"], { throwOnError: true })).resolves.toEqual([]);
  });

  it("returns the aggregated awardees on a normal OK response regardless of the flag", async () => {
    mockFetch(okRows);
    const out = await findProgramAwardees(["20.284"], { throwOnError: true });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("State DOT");
  });

  it("no CFDAs → [] without any fetch (both modes)", async () => {
    const spy = vi.fn(okEmpty);
    mockFetch(spy);
    await expect(findProgramAwardees([], { throwOnError: true })).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
