import { describe, it, expect } from "vitest";
import {
  finalizeIntel,
  intelContext,
  runIntelReview,
  isSafeHttpUrl,
  INTEL_MODEL,
  STRUCTURE_MAX_ATTEMPTS,
  type IntelCard,
  type IntelEvidence,
} from "./intel-review";
import { intelPhase1Config, serverSearchQueries, WEB_SEARCH_TOOL_NAME, SEARCH_SYSTEM_ADDENDUM, MAX_INTEL_SEARCHES } from "./intel-web-search";
import { WEB_FETCH_TOOL, WEB_FETCH_TOOL_NAME, type FetchAuditRecord } from "@/lib/grantbot/web-fetch";
import type { FetchResult } from "@/lib/grantbot/fetch";
import type { CallModel, ModelTurn } from "@/lib/grantbot/tool-loop";
import type { Grant, Client } from "@/types/database";

// Deterministic tests — NO live model, NO network. They lock the structural invariants of the guard
// (PR A, as amended by PR F — grounding is the gate, the refute is advisory):
//   (1) GROUNDING is the GATE: an adverse verdict (demote/flag) applies only if the pass actually FETCHED a
//       relevant .gov page (hasSuccessfulFetch). Ungrounded → 'unverified' — never a from-nothing demote.
//       It does NOT require the model to echo the fetched URL in evidence.
//   (2) REFUTE is ADVISORY (PR F): a GROUNDED adverse verdict applies whether the adversarial second read
//       supported it, refuted it, or could not run — refute_survived is recorded + noted, never a veto. A
//       redundant veto also killed CORRECT grounded demotes, and a grounded demote is never-hide + sourced +
//       one-click-revertible, so it was dropped. Model quality is the eval's job.
//   (3) AFFIRM still needs a successful fetch, else 'unverified' (not a web-backed affirmation).
//   (4) STRUCTURED VERDICT is guaranteed (PR F): a verdict-less structuring call is retried before falling
//       back, so a one-off structuring miss no longer silently loses a real verdict.

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

  it("demote GROUNDED but refute did NOT confirm (false) → STILL demote; refute recorded as advisory (PR F)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "asterisk county", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: false,
    });
    expect(r.verdict).toBe("demote"); // grounded applies; the refute no longer vetoes it
    expect(r.qa_fit_score).toBe(1);
    expect(r.refute_survived).toBe(false); // recorded for staff visibility
    expect(r.unverified).toBe(false);
    expect(r.summary).toMatch(/advisory/i); // an advisory note is appended, not a downgrade
  });

  it("demote GROUNDED, refute could-not-complete (null) → STILL demote; advisory note (PR F)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "x", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: null,
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.refute_survived).toBeNull();
    expect(r.summary).toMatch(/could not complete/i);
  });

  it("demote APPLIES on a successful fetch even when the model's cited evidence host was NOT fetched (grounding is the fetch + refute, not the cited URL — the JAG fix)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", confidence: "high", qa_fit_score: 1, summary: "asterisk county", evidence: [ev(UNFETCHED)] },
      audit: [okAudit(FETCHED)], // a real .gov page WAS fetched for the refute to read
      refuteSurvived: true, // and the refute (reading it) confirmed the concern
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.refute_survived).toBe(true);
  });

  it("demote with NO successful fetch → unverified, 'could not retrieve' (nothing for the refute to read)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, summary: "x", evidence: [ev(FETCHED)] },
      audit: [failAudit(FETCHED, "timeout")],
      refuteSurvived: true, // irrelevant — the refute never had a page
    });
    expect(r.verdict).toBe("unverified");
    expect(r.summary).toMatch(/could not retrieve/i);
    expect(r.refute_survived).toBeNull();
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
    expect(r.qa_factor_scores?.seat_role?.rating).toBe("weak");
  });

  it("keeps a PARTIAL qa_factor_scores (only the changed factor) — the apply-write merges it onto the engine's real factors", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, qa_factor_scores: { seat_role: { rating: "weak", rationale: "asterisk — cannot prime" } }, summary: "x", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(r.verdict).toBe("demote");
    // The model returns ONLY the factor it changed — not the fabricated other five. sanitize keeps the
    // valid subset; the drain (buildQaPatch) merges it onto the card's real factor_scores.
    expect(r.qa_factor_scores).toEqual({ seat_role: { rating: "weak", rationale: "asterisk — cannot prime" } });
  });

  it("drops factors with an invalid rating but keeps the valid ones (→ null only if none valid)", () => {
    const r = finalizeIntel({
      ...BASE,
      parsed: { verdict: "demote", qa_fit_score: 1, qa_factor_scores: { seat_role: { rating: "bogus" }, eligibility: { rating: "weak", rationale: "MOU-only" } } as never, summary: "x", evidence: [ev(FETCHED)] },
      audit: [okAudit(FETCHED)],
      refuteSurvived: true,
    });
    expect(r.qa_factor_scores).toEqual({ eligibility: { rating: "weak", rationale: "MOU-only" } });
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
        "confidence", "engine_fit_score", "evidence", "fetched", "searched", "model", "narrative", "qa_factor_scores",
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
    // The note is two-directional (case-2 fix): it names the designated recipient as the PRIME to affirm,
    // not only the sub to demote.
    expect(ctx).toMatch(/PRIME to AFFIRM/);
  });

  it("discovery ON but a NON-formula CFDA → no formula note (tag is conservative)", () => {
    const competitive = { ...grant, assistance_listings: [{ number: "93.999" }] } as unknown as Grant;
    const ctx = intelContext(baseCard, competitive, client, true);
    expect(ctx).not.toMatch(/FORMULA \/ ALLOCATION PROGRAM/);
  });

  it("a PAST submission deadline adds the ⚠ CLOSED signal (so the reasoning stays coherent)", () => {
    const closed = { ...grant, submission_deadline: "2020-01-15" } as unknown as Grant;
    const ctx = intelContext(baseCard, closed, client);
    expect(ctx).toMatch(/Submission deadline: 2020-01-15/);
    expect(ctx).toMatch(/ALREADY PASSED/);
  });

  it("a FUTURE (or a due-today) deadline adds no PASSED signal — only a strictly-past date is closed", () => {
    const future = { ...grant, submission_deadline: "2099-12-31" } as unknown as Grant;
    const ctx = intelContext(baseCard, future, client);
    expect(ctx).toMatch(/Submission deadline: 2099-12-31/);
    expect(ctx).not.toMatch(/ALREADY PASSED/);
  });

  it("a missing deadline reads '(none stated)' and adds no PASSED signal", () => {
    const ctx = intelContext(baseCard, grant, client); // grant has no submission_deadline
    expect(ctx).toMatch(/Submission deadline: \(none stated\)/);
    expect(ctx).not.toMatch(/ALREADY PASSED/);
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

  it("narrative:true → a clean client narrative on an applied demote is kept (guarded)", async () => {
    const clean =
      "This program is built for county governments like this one, but the FY2026 allocation table lists it " +
      "with an asterisk, so it cannot apply as a standalone prime — the path is a formal MOU with the named " +
      "city as fiscal agent. This is a conditional 2, not a 3.";
    const r = await runIntelReview(card, grant, client, {
      now,
      narrative: true,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => ({ ...demoteVerdict, narrative: clean }),
      refute: async () => ({ supported: true, reason: "disparate" }),
    });
    expect(r.verdict).toBe("demote");
    expect(r.narrative).toBe(clean);
  });

  it("narrative:true → a LEAKY narrative is nulled (fail-safe to the engine paragraph)", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      narrative: true,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => ({ ...demoteVerdict, narrative: "The engine scored a 3; position this as a partnership." }),
      refute: async () => ({ supported: true, reason: "disparate" }),
    });
    expect(r.verdict).toBe("demote"); // the demote still applies — the narrative is additive
    expect(r.qa_fit_score).toBe(1);
    expect(r.narrative).toBeNull();
  });

  it("narrative rides EVERY resolved verdict — an affirm now carries its own reasoning body (guarded)", async () => {
    const clean = "Genuinely in the workforce-development lane with no formal match required, and there are real regional partners to line up.";
    const r = await runIntelReview(card, grant, client, {
      now,
      narrative: true,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => ({
        verdict: "affirm" as const,
        confidence: "high" as const,
        qa_fit_score: null,
        summary: "holds up",
        narrative: clean,
        evidence: [ev(FETCHED)],
      }),
      refute: async () => ({ supported: true, reason: "n/a" }),
    });
    expect(r.verdict).toBe("affirm");
    // The narrative is the reasoning body under the card's directional call — kept for a go/marginal, not
    // just a demote. The pin is elsewhere (buildVerdict), so this additive text never moves the score.
    expect(r.narrative).toBe(clean);
    expect(r.qa_fit_score).toBe(3); // affirm carries the engine score forward; the narrative is additive
  });

  it("an UNVERIFIED verdict carries NO narrative (QA couldn't ground → the card keeps today's engine paragraph)", async () => {
    const clean = "A perfectly clean client paragraph the model wrote anyway.";
    const r = await runIntelReview(card, grant, client, {
      now,
      narrative: true,
      callModel: fetchThenAnswer(),
      // no successful .gov fetch → an affirm/adverse can't ground → unverified
      fetcher: async () => ({ ok: false, reason: "fetch_error", detail: "unreachable" }) as FetchResult,
      structure: async () => ({
        verdict: "affirm" as const,
        confidence: "high" as const,
        qa_fit_score: null,
        summary: "holds up",
        narrative: clean,
        evidence: [],
      }),
      refute: async () => ({ supported: true, reason: "n/a" }),
    });
    expect(r.verdict).toBe("unverified");
    expect(r.narrative).toBeNull();
  });

  it("a grounded demote the refute does NOT confirm STILL applies (refute is advisory — PR F)", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => demoteVerdict,
      refute: async () => ({ supported: false, reason: "the fetched page does not establish the concern" }),
    });
    expect(r.verdict).toBe("demote"); // grounded → applies; the refute no longer vetoes
    expect(r.qa_fit_score).toBe(1);
    expect(r.refute_survived).toBe(false); // recorded as an advisory note, not a downgrade
    expect(r.summary).toMatch(/advisory/i);
    expect(r.confidence).toBe("high"); // an applied demote keeps the model's confidence
  });

  it("a refute that THROWS still applies the grounded demote; refute_survived stored null (advisory — PR F)", async () => {
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => demoteVerdict,
      refute: async () => {
        throw new Error("refute model error");
      },
    });
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    // A THROW is a technical failure, not a refutation — recorded null (honest "could not complete"), and
    // the grounded demote still applies.
    expect(r.refute_survived).toBeNull();
    expect(r.summary).toMatch(/could not complete/i);
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

  it("thin evidence (empty quote) does NOT block a demote — a real fetch happened and the refute confirmed", async () => {
    // Grounding is the FETCH (hasSuccessfulFetch), not the model's quote or URL. okFetcher retrieved a real
    // .gov page, so grounding passes regardless of the thin evidence; the refute confirms → demote applies,
    // instead of the old "cited no page" downgrade. The DISPLAY evidence stays quote-filtered (empty here).
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
    expect(refuteRan).toBe(true); // a real fetch happened → grounded → refute runs
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
    expect(r.refute_survived).toBe(true);
    expect(r.confidence).toBe("high");
    expect(r.evidence).toHaveLength(0); // display evidence quote-filtered; grounding is the fetch, not this
  });

  it("(d) a verdict-less structuring call is RETRIED, then the real verdict applies (no silent no-verdict)", async () => {
    let calls = 0;
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      // First structuring attempt yields nothing usable; the retry returns the real demote.
      structure: async () => {
        calls++;
        return calls === 1 ? null : demoteVerdict;
      },
      refute: async () => ({ supported: true, reason: "confirmed" }),
    });
    expect(calls).toBe(2); // it retried once, then got a verdict
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
  });

  it("(d) structuring that never yields a verdict falls back to unverified after the retries (rare, honest)", async () => {
    let calls = 0;
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(),
      fetcher: okFetcher(),
      structure: async () => {
        calls++;
        return null;
      },
    });
    expect(calls).toBe(STRUCTURE_MAX_ATTEMPTS); // initial + retries, all verdict-less
    expect(r.verdict).toBe("unverified");
    expect(r.summary).toMatch(/no usable verdict/i);
  });

  it("a demote whose cited evidence host was NOT fetched still APPLIES when a real .gov page WAS fetched (the JAG fix)", async () => {
    // The exact JAG-county failure: the model reads the fetched FY26 table and demotes, but its structured
    // evidence cites a non-fetched host (or omits the URL). Grounding is the fetch that happened + the refute
    // reading it — NOT the model's cited URL — so the demote lands instead of downgrading to "cited no page".
    let refuteRan = false;
    const r = await runIntelReview(card, grant, client, {
      now,
      callModel: fetchThenAnswer(), // fetches FETCHED (bja.ojp.gov) successfully
      fetcher: okFetcher(),
      structure: async () => ({ verdict: "demote" as const, confidence: "high" as const, qa_fit_score: 1, summary: "asterisk county", evidence: [ev(UNFETCHED)] }),
      refute: async () => {
        refuteRan = true;
        return { supported: true, reason: "x" };
      },
    });
    expect(refuteRan).toBe(true); // a fetch happened → grounded → refute runs
    expect(r.verdict).toBe("demote");
    expect(r.qa_fit_score).toBe(1);
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
