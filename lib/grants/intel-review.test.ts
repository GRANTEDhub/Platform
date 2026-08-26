import { describe, it, expect } from "vitest";
import {
  finalizeIntel,
  groundedOnFetch,
  intelContext,
  runIntelReview,
  INTEL_MODEL,
  type IntelCard,
  type IntelEvidence,
} from "./intel-review";
import type { FetchAuditRecord } from "@/lib/grantbot/web-fetch";
import type { FetchResult } from "@/lib/grantbot/fetch";
import type { CallModel, ModelTurn } from "@/lib/grantbot/tool-loop";
import type { Grant, Client } from "@/types/database";

// Deterministic tests — NO live model, NO network. They lock the two structural invariants:
//   (1) PROPOSAL-ONLY: the payload never carries a fit_score mutation; qa_fit_score is a proposal.
//   (2) FAIL-SAFE: an adverse verdict not grounded on a page actually fetched → 'unverified'.
// Model quality (does Opus catch the MS County JAG case) is the eval's job, not this file's.

const okAudit = (url: string): FetchAuditRecord => ({ url, ok: true, finalUrl: url, truncated: false, fetchedAt: "T" });
const failAudit = (url: string, reason = "http_error"): FetchAuditRecord => ({ url, ok: false, reason, fetchedAt: "T" });
const ev = (source_url: string, quote = "asterisk jurisdiction — apply through the state"): IntelEvidence => ({
  claim: "cannot prime",
  source_url,
  quote,
});

const BASE = { engineFitScore: 3, model: INTEL_MODEL, reviewedBy: "staff-1", now: "2026-08-26T00:00:00.000Z" };

describe("groundedOnFetch", () => {
  const audit = [okAudit("https://bja.ojp.gov/program/jag/jag-allocations")];
  it("true when an evidence item quotes a host that was successfully fetched", () => {
    expect(groundedOnFetch([ev("https://bja.ojp.gov/program/jag/overview")], audit)).toBe(true); // same host, diff path
  });
  it("false when the evidence host was never fetched", () => {
    expect(groundedOnFetch([ev("https://grants.gov/x")], audit)).toBe(false);
  });
  it("false when there was no successful fetch at all", () => {
    expect(groundedOnFetch([ev("https://bja.ojp.gov/x")], [failAudit("https://bja.ojp.gov/x")])).toBe(false);
  });
  it("false when the evidence quote is empty", () => {
    expect(groundedOnFetch([ev("https://bja.ojp.gov/x", "")], audit)).toBe(false);
  });
});

describe("finalizeIntel — the fail-safe + proposal-only shaping", () => {
  it("null parsed → unverified, no score proposal", () => {
    const r = finalizeIntel({ ...BASE, parsed: null, audit: [] });
    expect(r.verdict).toBe("unverified");
    expect(r.qa_fit_score).toBeNull();
    expect(r.unverified).toBe(true);
  });

  it("affirm → qa_fit_score equals the engine score (no web grounding required)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "affirm", qa_fit_score: null, summary: "holds up", evidence: [] },
      audit: [],
    });
    expect(r.verdict).toBe("affirm");
    expect(r.qa_fit_score).toBe(3);
    expect(r.unverified).toBe(false);
  });

  it("demote GROUNDED on a fetched source → demote, qa below engine", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "asterisk county, MOU-only", evidence: [ev("https://bja.ojp.gov/program/jag")] },
      audit: [okAudit("https://bja.ojp.gov/program/jag")],
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.unverified).toBe(false);
    expect(r.evidence).toHaveLength(1);
  });

  it("demote NOT grounded (fetch failed) → downgraded to unverified — the fail-safe", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "asterisk county", evidence: [ev("https://bja.ojp.gov/program/jag")] },
      audit: [failAudit("https://bja.ojp.gov/program/jag", "timeout")],
    });
    expect(r.verdict).toBe("unverified");
    expect(r.unverified).toBe(true);
    expect(r.qa_fit_score).toBeNull();
    expect(r.summary).toMatch(/could not ground/i);
  });

  it("flag NOT grounded → unverified too (any adverse call needs grounding)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "flag", qa_fit_score: null, summary: "seems off", evidence: [] },
      audit: [],
    });
    expect(r.verdict).toBe("unverified");
    expect(r.unverified).toBe(true);
  });

  it("demote with a nonsensical/high qa score is stepped below the engine score", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 5, summary: "x", evidence: [ev("https://bja.ojp.gov/x")] },
      audit: [okAudit("https://bja.ojp.gov/x")],
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(2); // engine 3 → clamped/stepped to 2
  });

  it("the payload carries no field that could mutate the card score (proposal-only)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "x", evidence: [ev("https://bja.ojp.gov/x")] },
      audit: [okAudit("https://bja.ojp.gov/x")],
    });
    // Only these keys — nothing named fit_score / seat / decision / suppressed.
    expect(Object.keys(r).sort()).toEqual(
      ["engine_fit_score", "evidence", "fetched", "model", "qa_fit_score", "reviewed_at", "reviewed_by", "summary", "unverified", "verdict"].sort(),
    );
  });
});

describe("intelContext", () => {
  const grant = {
    title: "JAG Local",
    funder: "BJA",
    assistance_listings: [{ number: "16.738" }],
    program_type: "Competitive Grant",
    eligible_entity_types: ["units of local government"],
    geographic_eligibility: "nationwide",
    source_url: "https://simpler.grants.gov/x",
  } as unknown as Grant;
  const client = { name: "Mississippi County", org_type: "local_government", location_state: "AR" } as unknown as Client;

  it("hands the reviewer the seeded JAG allocation source for CFDA 16.738", () => {
    const ctx = intelContext({ fit_score: 3, proposed_role: "Prime", recommended_prime: null, why_this_org: [], before_you_approve: [], reasoning_context: null }, grant, client);
    expect(ctx).toMatch(/bja\.ojp\.gov/);
    expect(ctx).toMatch(/16\.738/);
    expect(ctx).toMatch(/ENGINE'S READ/);
    expect(ctx).toMatch(/Mississippi County/);
  });
});

describe("runIntelReview — loop + guard together, injected seams", () => {
  const card: IntelCard = {
    fit_score: 3,
    proposed_role: "Prime",
    recommended_prime: null,
    why_this_org: ["paradigmatic direct recipient"],
    before_you_approve: [],
    reasoning_context: { fit_score_derivation: "no consortium required" },
  };
  const grant = { title: "JAG", assistance_listings: [{ number: "16.738" }], source_url: "https://simpler.grants.gov/x" } as unknown as Grant;
  const client = { name: "Mississippi County", org_type: "local_government" } as unknown as Client;
  const now = () => "2026-08-26T00:00:00.000Z";

  // A callModel that fetches once (round 0), then answers (round 1). Mirrors the real loop shape.
  const fetchThenAnswer = (): CallModel => {
    let round = 0;
    return async ({ tools }): Promise<ModelTurn> => {
      if (tools === "auto" && round === 0) {
        round++;
        return {
          text: "",
          toolUses: [{ id: "t1", name: "fetch_grant_source", input: { url: "https://bja.ojp.gov/program/jag/jag-allocations" } }],
          stopReason: "tool_use",
          usage: null,
          rawContent: [],
        };
      }
      return { text: "Asterisk county — must apply through the state. Demote to 1.", toolUses: [], stopReason: "end_turn", usage: null, rawContent: [] };
    };
  };

  const okFetcher = (): ((u: string) => Promise<FetchResult>) => async (url) => ({
    ok: true,
    requestedUrl: url,
    finalUrl: url,
    contentType: "text/html",
    text: "Mississippi County * — disparate jurisdiction; applies through the State Administering Agency.",
    truncated: false,
    fetchedAt: "T",
  });

  it("a grounded demote survives (fetch succeeded on the cited host)", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      reviewedBy: "staff-1",
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => ({ verdict: "demote", qa_fit_score: 1, summary: "asterisk county, apply through the state", evidence: [ev("https://bja.ojp.gov/program/jag/jag-allocations")] }),
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.engine_fit_score).toBe(3);
    expect(r.fetched.some((f) => f.ok)).toBe(true);
    expect(r.reviewed_by).toBe("staff-1");
  });

  it("the SAME demote fails safe to unverified when the fetch failed", async () => {
    const failFetcher: (u: string) => Promise<FetchResult> = async () => ({ ok: false, reason: "timeout" });
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: failFetcher,
      structure: async () => ({ verdict: "demote", qa_fit_score: 1, summary: "asterisk county", evidence: [ev("https://bja.ojp.gov/program/jag/jag-allocations")] }),
    });
    expect(r.verdict).toBe("unverified");
    expect(r.unverified).toBe(true);
    expect(r.qa_fit_score).toBeNull();
  });

  it("no structured output from phase 2 → unverified, never a throw", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => null,
    });
    expect(r.verdict).toBe("unverified");
  });
});
