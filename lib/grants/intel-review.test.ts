import { describe, it, expect } from "vitest";
import {
  finalizeIntel,
  groundedOnFetchedSource,
  intelContext,
  runIntelReview,
  isSafeHttpUrl,
  INTEL_MODEL,
  type IntelCard,
  type IntelEvidence,
} from "./intel-review";
import { intelPhase1Config, serverSearchQueries, WEB_SEARCH_TOOL_NAME, SEARCH_SYSTEM_ADDENDUM, MAX_INTEL_SEARCHES } from "./intel-web-search";
import { WEB_FETCH_TOOL, WEB_FETCH_TOOL_NAME, type FetchAuditRecord } from "@/lib/grantbot/web-fetch";
import type { FetchResult } from "@/lib/grantbot/fetch";
import type { CallModel, ModelTurn } from "@/lib/grantbot/tool-loop";
import type { Grant, Client } from "@/types/database";

// Deterministic tests — NO live model, NO network. They lock the structural invariants of the REDESIGNED
// guard (PR A):
//   (1) GROUNDING: an adverse verdict (demote/flag) must cite a page the pass ACTUALLY FETCHED (host match
//       against the audit ok-set) — not a verbatim-quote-in-body (that suppressed correct table/PDF reads).
//   (2) REFUTE: a grounded adverse verdict APPLIES only if the adversarial second read supported it
//       (refuteSurvived === true); refuted / could-not-run → 'unverified'. Model quality is the eval's job.
//   (3) AFFIRM still needs a successful fetch, else 'unverified' (not a web-backed affirmation).

const BODY = "Mississippi County is a disparate jurisdiction; it applies for JAG through the State Administering Agency.";
const SPAN = "applies for JAG through the State Administering Agency"; // a supporting span (evidence.quote)

const okAudit = (url: string): FetchAuditRecord => ({ url, ok: true, finalUrl: url, truncated: false, fetchedAt: "T" });
const failAudit = (url: string, reason = "http_error"): FetchAuditRecord => ({ url, ok: false, reason, fetchedAt: "T" });
const ev = (source_url: string, quote = SPAN): IntelEvidence => ({ claim: "cannot prime", source_url, quote });

// A fetched .gov page and a matching cited source (same host) vs a host the pass never fetched.
const FETCHED = "https://bja.ojp.gov/program/jag/jag-allocations";
const UNFETCHED = "https://grants.nih.gov/some/other/page";

const BASE = { engineFitScore: 3, model: INTEL_MODEL, reviewedBy: "staff-1", now: "2026-08-26T00:00:00.000Z" };

describe("isSafeHttpUrl", () => {
  it("accepts http(s), rejects javascript:/data:/garbage", () => {
    expect(isSafeHttpUrl("https://bja.ojp.gov/x")).toBe(true);
    expect(isSafeHttpUrl("http://example.gov")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script>")).toBe(false);
    expect(isSafeHttpUrl("not a url")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
  });
});

describe("groundedOnFetchedSource — cited a page we actually fetched (host match)", () => {
  it("true when an evidence source_url is on a host that was fetched (ok)", () => {
    expect(groundedOnFetchedSource([ev(FETCHED)], [okAudit(FETCHED)])).toBe(true);
  });
  it("true when the cited path differs but the host was fetched (host-level grounding)", () => {
    expect(groundedOnFetchedSource([ev("https://bja.ojp.gov/a/different/path")], [okAudit(FETCHED)])).toBe(true);
  });
  it("true when the host matches the audit's finalUrl (post-redirect)", () => {
    const rec: FetchAuditRecord = { url: "https://bit.ly/x", ok: true, finalUrl: FETCHED, truncated: false, fetchedAt: "T" };
    expect(groundedOnFetchedSource([ev("https://bja.ojp.gov/y")], [rec])).toBe(true);
  });
  it("false when the cited host was never fetched", () => {
    expect(groundedOnFetchedSource([ev(UNFETCHED)], [okAudit(FETCHED)])).toBe(false);
  });
  it("false when there were no successful fetches", () => {
    expect(groundedOnFetchedSource([ev(FETCHED)], [failAudit(FETCHED)])).toBe(false);
  });
  it("false for an unparseable / javascript: source_url", () => {
    expect(groundedOnFetchedSource([ev("javascript:alert(1)")], [okAudit(FETCHED)])).toBe(false);
  });
});

describe("finalizeIntel — the fail-safe (grounding + refute) + shaping", () => {
  it("null parsed → unverified, low confidence, no score/factors", () => {
    const r = finalizeIntel({ ...BASE, parsed: null, audit: [] });
    expect(r.verdict).toBe("unverified");
    expect(r.confidence).toBe("low");
    expect(r.qa_fit_score).toBeNull();
    expect(r.qa_factor_scores).toBeNull();
    expect(r.refute_survived).toBeNull();
    expect(r.unverified).toBe(true);
  });

  it("affirm WITH a successful fetch → affirm, qa_fit_score = engine score", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "affirm", confidence: "high", qa_fit_score: null, summary: "holds up", evidence: [] },
      audit: [okAudit(FETCHED)],
    });
    expect(r.verdict).toBe("affirm");
    expect(r.qa_fit_score).toBe(3);
    expect(r.confidence).toBe("high");
    expect(r.unverified).toBe(false);
  });

  it("affirm with NO successful fetch → unverified (not a web-backed affirmation)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "affirm", qa_fit_score: null, summary: "looks fine", evidence: [] },
      audit: [failAudit(FETCHED, "timeout")],
    });
    expect(r.verdict).toBe("unverified");
    expect(r.summary).toMatch(/not a web-backed affirmation/i);
  });

  it("demote GROUNDED + refute SURVIVED → demote, qa below engine, refute_survived true", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", confidence: "high", qa_fit_score: 1, summary: "asterisk county", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.refute_survived).toBe(true);
    expect(r.unverified).toBe(false);
  });

  it("demote GROUNDED but refute FAILED → unverified (didn't hold up on a second read)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "asterisk county", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: false,
    });
    expect(r.verdict).toBe("unverified");
    expect(r.refute_survived).toBe(false);
    expect(r.qa_fit_score).toBeNull();
    expect(r.summary).toMatch(/did not hold up/i);
  });

  it("demote GROUNDED but refute not run (undefined) → unverified (apply requires an explicit survive)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "x", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      // refuteSurvived omitted
    });
    expect(r.verdict).toBe("unverified");
  });

  it("demote citing a host that was NEVER fetched → unverified (ungrounded), refute_survived null", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "asterisk county", evidence: [ev(UNFETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true, // even a 'survived' can't rescue an ungrounded citation
    });
    expect(r.verdict).toBe("unverified");
    expect(r.refute_survived).toBeNull();
    expect(r.summary).toMatch(/cited no page it actually retrieved/i);
  });

  it("demote with a failed fetch (no ok) → unverified", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "x", evidence: [ev(FETCHED)] },
      audit: [failAudit(FETCHED, "timeout")],
      refuteSurvived: true,
    });
    expect(r.verdict).toBe("unverified");
  });

  it("carries the model's corrected qa_factor_scores on an APPLIED demote", () => {
    const factors = {
      seat_role: { rating: "weak", rationale: "asterisk/disparate — cannot prime" },
      eligibility: { rating: "weak", rationale: "MOU-partner only" },
      geographic: { rating: "strong", rationale: "in-state" },
      program_history: { rating: "moderate", rationale: "some" },
      cost_share: { rating: "strong", rationale: "n/a" },
      mission: { rating: "strong", rationale: "aligned" },
    };
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, qa_factor_scores: factors as never, summary: "x", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_factor_scores?.seat_role.rating).toBe("weak");
  });

  it("rejects a malformed/partial qa_factor_scores whole (null, not half-written)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, qa_factor_scores: { seat_role: { rating: "weak", rationale: "x" } } as never, summary: "x", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_factor_scores).toBeNull(); // missing five factors → rejected
  });

  it("demote with a nonsensical/high qa score is stepped below the engine score", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 5, summary: "x", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(2); // engine 3 → clamped/stepped to 2
  });

  it("blanks an unsafe (javascript:) evidence source_url; stays grounded via a valid fetched source", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: {
        verdict: "demote",
        qa_fit_score: 1,
        summary: "x",
        evidence: [ev(FETCHED), { claim: "c", quote: SPAN, source_url: "javascript:alert(document.cookie)" }],
      },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(r.verdict).toBe("demote"); // grounded by the valid fetched source
    expect(r.evidence.some((e) => e.source_url === "")).toBe(true); // the javascript: url was stripped
    expect(r.evidence.some((e) => e.source_url === FETCHED)).toBe(true);
  });

  it("a demote of an engine-1 card becomes a flag (can't render 'engine 1 → QA 1')", () => {
    const r = finalizeIntel({
      ...BASE,
      engineFitScore: 1,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "weaker than a 1", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(r.verdict).toBe("flag");
    expect(r.qa_fit_score).toBeNull();
  });

  it("the payload shape carries the new guard fields (confidence, qa_factor_scores, refute_survived)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "x", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(Object.keys(r).sort()).toEqual(
      [
        "confidence", "engine_fit_score", "evidence", "fetched", "searched", "model", "qa_factor_scores",
        "qa_fit_score", "refute_survived", "reviewed_at", "reviewed_by", "summary", "unverified", "verdict",
      ].sort(),
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

  const baseCard = { fit_score: 3, proposed_role: "Prime", recommended_prime: null, why_this_org: [], before_you_approve: [], reasoning_context: null };

  it("hands the reviewer the seeded JAG allocation source for CFDA 16.738", () => {
    const ctx = intelContext(baseCard, grant, client);
    expect(ctx).toMatch(/bja\.ojp\.gov/);
    expect(ctx).toMatch(/16\.738/);
    expect(ctx).toMatch(/ENGINE'S READ/);
    expect(ctx).toMatch(/Mississippi County/);
  });

  it("discovery OFF (default) → NO formula-program note (byte-identical to today's context)", () => {
    const ctx = intelContext(baseCard, grant, client); // discovery defaults false
    expect(ctx).not.toMatch(/FORMULA \/ ALLOCATION PROGRAM/);
  });

  it("discovery ON → adds the formula-program note for a known formula CFDA (16.738)", () => {
    const ctx = intelContext(baseCard, grant, client, true);
    expect(ctx).toMatch(/FORMULA \/ ALLOCATION PROGRAM — CFDA 16\.738/);
    expect(ctx).toMatch(/ENTITY-TYPE eligibility is NOT application eligibility/);
    expect(ctx).toMatch(/SEARCH for it/);
  });

  it("discovery ON but a NON-formula CFDA → no formula note (tag is conservative)", () => {
    const competitive = { ...grant, assistance_listings: [{ number: "93.999" }] } as unknown as Grant;
    const ctx = intelContext(baseCard, competitive, client, true);
    expect(ctx).not.toMatch(/FORMULA \/ ALLOCATION PROGRAM/);
  });
});

describe("intelPhase1Config — flag-gated tool set + system (the byte-identical-off guarantee)", () => {
  const SYS = "BASE SYSTEM PROMPT";

  it("discovery OFF → tools are EXACTLY [fetch] and system is unchanged", () => {
    const cfg = intelPhase1Config(false, WEB_FETCH_TOOL, SYS);
    expect(cfg.tools).toEqual([WEB_FETCH_TOOL]);
    expect(cfg.tools.map((t) => (t as { name: string }).name)).toEqual([WEB_FETCH_TOOL_NAME]);
    expect(cfg.system).toBe(SYS); // byte-identical: no addendum appended
  });

  it("discovery ON, budget unspent → adds web_search (max_uses = remaining budget) and the addendum", () => {
    const cfg = intelPhase1Config(true, WEB_FETCH_TOOL, SYS); // searchesSpent defaults 0
    const names = cfg.tools.map((t) => (t as { name: string }).name);
    expect(names).toContain(WEB_FETCH_TOOL_NAME);
    expect(names).toContain(WEB_SEARCH_TOOL_NAME);
    expect(cfg.tools).toHaveLength(2);
    const search = cfg.tools.find((t) => (t as { name: string }).name === WEB_SEARCH_TOOL_NAME) as { max_uses: number };
    expect(search.max_uses).toBe(MAX_INTEL_SEARCHES);
    expect(cfg.system).toBe(SYS + SEARCH_SYSTEM_ADDENDUM);
  });

  it("discovery ON, some budget spent → web_search max_uses is the REMAINING budget", () => {
    const cfg = intelPhase1Config(true, WEB_FETCH_TOOL, SYS, MAX_INTEL_SEARCHES - 1);
    const search = cfg.tools.find((t) => (t as { name: string }).name === WEB_SEARCH_TOOL_NAME) as { max_uses: number };
    expect(search.max_uses).toBe(1);
  });

  it("discovery ON, budget SPENT → web_search is DROPPED (per-pass cap is real, not just per-request)", () => {
    const cfg = intelPhase1Config(true, WEB_FETCH_TOOL, SYS, MAX_INTEL_SEARCHES);
    expect(cfg.tools.map((t) => (t as { name: string }).name)).toEqual([WEB_FETCH_TOOL_NAME]);
    expect(cfg.system).toBe(SYS + SEARCH_SYSTEM_ADDENDUM); // addendum stays (system is stable across rounds)
  });
});

describe("serverSearchQueries — reads real web_search usage from response content", () => {
  it("extracts the query from each web_search server_tool_use block", () => {
    const content = [
      { type: "text", text: "let me search" },
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "VOCA state administering agency Arkansas" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "VOCA subgrantee formula" } },
    ];
    expect(serverSearchQueries(content)).toEqual(["VOCA state administering agency Arkansas", "VOCA subgrantee formula"]);
  });

  it("ignores non-search blocks and non-array content", () => {
    expect(serverSearchQueries([{ type: "text", text: "x" }, { type: "tool_use", name: "fetch_grant_source", input: { url: "u" } }])).toEqual([]);
    expect(serverSearchQueries(null)).toEqual([]);
    expect(serverSearchQueries("nope")).toEqual([]);
  });
});

describe("runIntelReview — threads the discovery flag into the reviewer context", () => {
  const card: IntelCard = { fit_score: 3, proposed_role: "Prime", recommended_prime: null, why_this_org: [], before_you_approve: [], reasoning_context: null };
  const grant = { title: "JAG", assistance_listings: [{ number: "16.738" }], source_url: "https://simpler.grants.gov/x" } as unknown as Grant;
  const client = { name: "Mississippi County", org_type: "local_government" } as unknown as Client;
  const now = () => "2026-08-26T00:00:00.000Z";

  const capture = (): { calls: string[]; model: CallModel } => {
    const calls: string[] = [];
    const model: CallModel = async ({ messages }): Promise<ModelTurn> => {
      const first = messages[0] as { content?: unknown };
      calls.push(typeof first?.content === "string" ? first.content : JSON.stringify(first?.content));
      return { text: "no change", toolUses: [], stopReason: "end_turn", usage: null, rawContent: [] };
    };
    return { calls, model };
  };

  it("discovery:true → the formula note reaches the model context", async () => {
    const cap = capture();
    await runIntelReview(card, grant, client, { now, discovery: true, callModel: cap.model, structure: async () => null });
    expect(cap.calls[0]).toMatch(/FORMULA \/ ALLOCATION PROGRAM/);
  });

  it("discovery:false → no formula note in the model context (byte-identical off)", async () => {
    const cap = capture();
    await runIntelReview(card, grant, client, { now, discovery: false, callModel: cap.model, structure: async () => null });
    expect(cap.calls[0]).not.toMatch(/FORMULA \/ ALLOCATION PROGRAM/);
  });
});

describe("runIntelReview — loop + guard + refute together, injected seams", () => {
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
          toolUses: [{ id: "t1", name: "fetch_grant_source", input: { url: FETCHED } }],
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

  const demoteVerdict = { verdict: "demote" as const, confidence: "high" as const, qa_fit_score: 1, summary: "asterisk county, apply through the state", evidence: [ev(FETCHED)] };

  it("a grounded demote that SURVIVES the refute applies", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      reviewedBy: "staff-1",
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => demoteVerdict,
      refute: async () => ({ supported: true, reason: "the allocation table lists the county as disparate" }),
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.engine_fit_score).toBe(3);
    expect(r.refute_survived).toBe(true);
    expect(r.confidence).toBe("high"); // an APPLIED demote keeps the model's confidence
    expect(r.fetched.some((f) => f.ok)).toBe(true);
    expect(r.reviewed_by).toBe("staff-1");
  });

  it("a grounded demote that is REFUTED fails safe to unverified", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => demoteVerdict,
      refute: async () => ({ supported: false, reason: "the fetched page does not establish the concern" }),
    });
    expect(r.verdict).toBe("unverified");
    // A GENUINE refutation (the second read ran and said supported=false) stores false, with the
    // "did not hold up" summary — a trustworthy "the sources don't support this".
    expect(r.refute_survived).toBe(false);
    expect(r.summary).toMatch(/did not hold up/i);
    expect(r.confidence).toBe("low"); // a fail-safe downgrade derates the model's "high" self-report
    expect(r.qa_fit_score).toBeNull();
  });

  it("a refute that THROWS fails safe to unverified, stored as null (could-not-complete, not a refutation)", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => demoteVerdict,
      refute: async () => {
        throw new Error("refute model error");
      },
    });
    expect(r.verdict).toBe("unverified");
    // A THROW is a technical failure, not a refutation — stored as null (a retry signal) with a
    // "could not complete" summary, so it is never mislabeled as "the sources don't support this".
    expect(r.refute_survived).toBeNull();
    expect(r.summary).toMatch(/could not complete/i);
    expect(r.confidence).toBe("low");
    expect(r.qa_fit_score).toBeNull();
  });

  it("the SAME demote fails safe to unverified when the fetch failed (ungrounded — refute never runs)", async () => {
    let refuteRan = false;
    const failFetcher: (u: string) => Promise<FetchResult> = async () => ({ ok: false, reason: "timeout" });
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: failFetcher,
      structure: async () => demoteVerdict,
      refute: async () => {
        refuteRan = true;
        return { supported: true, reason: "x" };
      },
    });
    expect(r.verdict).toBe("unverified");
    expect(refuteRan).toBe(false); // nothing grounded → no point refuting
    expect(r.qa_fit_score).toBeNull();
  });

  it("evidence with a fetched-host source_url but NO quote still GROUNDS (grounding is decoupled from the quote filter)", async () => {
    // The JAG-county fix: the model cites a page it actually fetched (FETCHED host) but supplies no quotable
    // span — the relaxed prompt says it needn't. groundingEvidence keeps it (source_url present, quote
    // optional), so grounding PASSES, the refute runs, and a supported demote APPLIES — instead of the old
    // "cited no page" downgrade. The DISPLAY evidence stays quote-filtered, so it's empty here; that is the
    // accepted trade (grounding on source_url, presentation on quotes).
    let refuteRan = false;
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => ({ verdict: "demote" as const, confidence: "high" as const, qa_fit_score: 1, summary: "asterisk county", evidence: [ev(FETCHED, "")] }),
      refute: async () => {
        refuteRan = true;
        return { supported: true, reason: "the allocation table lists the county as disparate" };
      },
    });
    expect(refuteRan).toBe(true); // grounded on the fetched-host source_url → refute runs
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.refute_survived).toBe(true);
    expect(r.confidence).toBe("high");
    expect(r.evidence).toHaveLength(0); // display evidence is quote-filtered; grounding was source_url-based
  });

  it("a demote citing a host NOT fetched fails safe to unverified (ungrounded)", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => ({ verdict: "demote" as const, qa_fit_score: 1, summary: "x", evidence: [ev(UNFETCHED)] }),
      refute: async () => ({ supported: true, reason: "x" }),
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
