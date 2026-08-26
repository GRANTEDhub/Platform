import { describe, it, expect } from "vitest";
import {
  finalizeIntel,
  quoteGroundedInBodies,
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

// Deterministic tests — NO live model, NO network. They lock the structural invariants:
//   (1) PROPOSAL-ONLY: the payload never carries a fit_score mutation; qa_fit_score is a proposal.
//   (2) FAIL-SAFE: an adverse verdict whose quote is not found in a FETCHED PAGE BODY → 'unverified'
//       (not merely a host match — the anti-hallucination guard); and an 'affirm' with no successful
//       fetch → 'unverified' (not a web-backed affirmation). Model quality is the eval's job.

// A page body the "fetch" returned, and quotes that do / don't occur in it.
const BODY = "Mississippi County is a disparate jurisdiction; it applies for JAG through the State Administering Agency.";
const GOOD_QUOTE = "applies for JAG through the State Administering Agency"; // substring of BODY, > 12 chars
const BAD_QUOTE = "is a paradigmatic direct recipient with no barriers"; // NOT in BODY (hallucinated)

const okAudit = (url: string): FetchAuditRecord => ({ url, ok: true, finalUrl: url, truncated: false, fetchedAt: "T" });
const failAudit = (url: string, reason = "http_error"): FetchAuditRecord => ({ url, ok: false, reason, fetchedAt: "T" });
const ev = (source_url: string, quote: string): IntelEvidence => ({ claim: "cannot prime", source_url, quote });

const BASE = { engineFitScore: 3, model: INTEL_MODEL, reviewedBy: "staff-1", now: "2026-08-26T00:00:00.000Z" };

describe("quoteGroundedInBodies", () => {
  it("true when a long-enough quote occurs in a fetched body (case/whitespace-insensitive)", () => {
    expect(quoteGroundedInBodies([ev("https://bja.ojp.gov/x", "  APPLIES for JAG through the State Administering Agency ")], [BODY])).toBe(true);
  });
  it("false when the quote was never on the page (hallucinated, even if the host was fetched)", () => {
    expect(quoteGroundedInBodies([ev("https://bja.ojp.gov/x", BAD_QUOTE)], [BODY])).toBe(false);
  });
  it("false when there are no fetched bodies at all", () => {
    expect(quoteGroundedInBodies([ev("https://bja.ojp.gov/x", GOOD_QUOTE)], [])).toBe(false);
  });
  it("false for a too-short quote even if the fragment is in the body", () => {
    expect(quoteGroundedInBodies([ev("https://bja.ojp.gov/x", "disparate")], [BODY])).toBe(false); // < 12 chars
  });
});

describe("finalizeIntel — the fail-safe + proposal-only shaping", () => {
  it("null parsed → unverified, no score proposal", () => {
    const r = finalizeIntel({ ...BASE, parsed: null, audit: [], fetchedBodies: [] });
    expect(r.verdict).toBe("unverified");
    expect(r.qa_fit_score).toBeNull();
    expect(r.unverified).toBe(true);
  });

  it("affirm WITH a successful fetch → affirm, qa_fit_score = engine score", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "affirm", qa_fit_score: null, summary: "holds up", evidence: [] },
      audit: [okAudit("https://bja.ojp.gov/x")],
      fetchedBodies: [BODY],
    });
    expect(r.verdict).toBe("affirm");
    expect(r.qa_fit_score).toBe(3);
    expect(r.unverified).toBe(false);
  });

  it("affirm with NO successful fetch → unverified (not a web-backed affirmation)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "affirm", qa_fit_score: null, summary: "looks fine", evidence: [] },
      audit: [failAudit("https://bja.ojp.gov/x", "timeout")],
      fetchedBodies: [],
    });
    expect(r.verdict).toBe("unverified");
    expect(r.unverified).toBe(true);
    expect(r.summary).toMatch(/not a web-backed affirmation/i);
  });

  it("demote GROUNDED (quote found in a fetched body) → demote, qa below engine", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "asterisk county, apply through the state", evidence: [ev("https://bja.ojp.gov/x", GOOD_QUOTE)] },
      audit: [okAudit("https://bja.ojp.gov/x")],
      fetchedBodies: [BODY],
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.unverified).toBe(false);
  });

  it("demote whose quote is NOT in any fetched body → unverified (hallucinated-quote guard)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "asterisk county", evidence: [ev("https://bja.ojp.gov/x", BAD_QUOTE)] },
      audit: [okAudit("https://bja.ojp.gov/x")], // fetched the host, but the quote wasn't on it
      fetchedBodies: [BODY],
    });
    expect(r.verdict).toBe("unverified");
    expect(r.unverified).toBe(true);
    expect(r.qa_fit_score).toBeNull();
    expect(r.summary).toMatch(/could not ground/i);
  });

  it("demote with a failed fetch (no body) → unverified", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "asterisk county", evidence: [ev("https://bja.ojp.gov/x", GOOD_QUOTE)] },
      audit: [failAudit("https://bja.ojp.gov/x", "timeout")],
      fetchedBodies: [],
    });
    expect(r.verdict).toBe("unverified");
    expect(r.qa_fit_score).toBeNull();
  });

  it("flag not grounded → unverified too", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "flag", qa_fit_score: null, summary: "seems off", evidence: [] },
      audit: [okAudit("https://bja.ojp.gov/x")],
      fetchedBodies: [BODY],
    });
    expect(r.verdict).toBe("unverified");
  });

  it("demote with a nonsensical/high qa score is stepped below the engine score", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 5, summary: "x", evidence: [ev("https://bja.ojp.gov/x", GOOD_QUOTE)] },
      audit: [okAudit("https://bja.ojp.gov/x")],
      fetchedBodies: [BODY],
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(2); // engine 3 → clamped/stepped to 2
  });

  it("the payload carries no field that could mutate the card score (proposal-only)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "x", evidence: [ev("https://bja.ojp.gov/x", GOOD_QUOTE)] },
      audit: [okAudit("https://bja.ojp.gov/x")],
      fetchedBodies: [BODY],
    });
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
      return { text: "Asterisk county — applies through the state. Demote to 1.", toolUses: [], stopReason: "end_turn", usage: null, rawContent: [] };
    };
  };

  const okFetcher = (): ((u: string) => Promise<FetchResult>) => async (url) => ({
    ok: true,
    requestedUrl: url,
    finalUrl: url,
    contentType: "text/html",
    text: BODY,
    truncated: false,
    fetchedAt: "T",
  });

  it("a grounded demote survives (quote occurs in the fetched body)", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      reviewedBy: "staff-1",
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => ({ verdict: "demote", qa_fit_score: 1, summary: "asterisk county, apply through the state", evidence: [ev("https://bja.ojp.gov/program/jag/jag-allocations", GOOD_QUOTE)] }),
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
      structure: async () => ({ verdict: "demote", qa_fit_score: 1, summary: "asterisk county", evidence: [ev("https://bja.ojp.gov/program/jag/jag-allocations", GOOD_QUOTE)] }),
    });
    expect(r.verdict).toBe("unverified");
    expect(r.unverified).toBe(true);
    expect(r.qa_fit_score).toBeNull();
  });

  it("a demote citing a quote NOT on the fetched page fails safe to unverified", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => ({ verdict: "demote", qa_fit_score: 1, summary: "x", evidence: [ev("https://bja.ojp.gov/program/jag/jag-allocations", BAD_QUOTE)] }),
    });
    expect(r.verdict).toBe("unverified");
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
