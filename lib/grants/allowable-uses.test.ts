import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clientAllowableUses,
  readAllowableUses,
  verifyAllowableUses,
  allowableSource,
  isAllowableUsesRegression,
  SECTION_PATTERNS,
  type AllowableUseItem,
  type AllowableUses,
} from "./allowable-uses";
import { sectionHits } from "./nofo-text";

// Deterministic — no model, no network. Locks:
//  1. the widened section-finder anchors on real ACF cost sections the old patterns walked past;
//  2. the two-list (allowed / not-allowed) parse + quote gate;
//  3. the CLIENT-surface filter (statutory not-allowed items dropped, budget kept, allowed kept).

// ── 1. The finder widen ─────────────────────────────────────────────────────────────────────

// The six patterns as they were BEFORE the widen — the ones that returned no_section on ACF NOFOs.
const OLD_PATTERNS = [
  /allowable\s+(?:costs?|uses?|activities|expenses?)/gi,
  /unallowable\s+(?:costs?|uses?|activities|expenses?)/gi,
  /funding\s+restrictions?/gi,
  /use\s+of\s+(?:grant\s+)?funds?/gi,
  /eligible\s+(?:costs?|uses?|activities|expenses?)/gi,
  /cost\s+principles?/gi,
];

// Verbatim cost wording from a 2026 HHS-ACF NOFO (Street Outreach / Kinship / ECD share this shape).
// None of it uses the word "allowable" as a heading — which is exactly why the old finder missed it.
const ACF_COST_SECTION = `Program-specific limitations and policies
We do not allow the following costs under this notice of funding opportunity (NOFO):
• Construction.
• Purchase of real property.
• Major renovation.
• Costs for renovation of existing structures may not normally exceed 15% of the federal award. Costs for acquisition are not allowable by statute.
• Fundraising (including campaigns, endowments, gifts, and similar expenses).
• Pre-award costs.
Indirect costs
Indirect costs are those shared across multiple projects and not easily separated. To charge indirect costs you can select one of two methods. Method 2 — De minimis rate. This rate may be up to 15% of modified total direct costs (MTDC).
As you develop your budget, consider:
• If the costs are necessary, reasonable, allocable, and consistent with your project's purpose and activities.
• The restrictions on spending funds. See the funding policies and limitations.
You must provide detail, including calculations for the object class categories in the Budget Information Standard Form. To create your line-item budget and justification, see detailed budget instructions.`;

describe("section finder", () => {
  it("the OLD patterns find NOTHING in a real ACF cost section — this was the no_section bug", () => {
    expect(sectionHits(ACF_COST_SECTION, OLD_PATTERNS)).toHaveLength(0);
  });

  it("the widened patterns anchor densely on the same text", () => {
    expect(sectionHits(ACF_COST_SECTION, SECTION_PATTERNS).length).toBeGreaterThan(3);
  });

  it("allowableSource lands the window on the cost section, not the document head", () => {
    // A realistic NOFO: ~12k of program prose, THEN the cost section — so the head-fallback (first
    // 10k) would miss it entirely, which is exactly the production failure this fixes.
    const head = "Program description and objectives. ".repeat(360); // ~12.6k chars, no cost language
    const { excerpt, anchored } = allowableSource(head + ACF_COST_SECTION);
    expect(anchored).toBe(true);
    expect(excerpt).toContain("We do not allow the following costs");
    expect(excerpt).toContain("necessary, reasonable, allocable");
  });

  it("a document with no cost language at all is not anchored (falls back to the head)", () => {
    const { anchored } = allowableSource("Program goals and background. ".repeat(50));
    expect(anchored).toBe(false);
  });
});

// ── 1b. NSF-family finder (real IUSE / Two-Year College STEM fixture) ────────────────────────
//
// Verbatim excerpts from the NSF 23-584 IUSE: Innovation in Two-Year College STEM Education (ITYC)
// solicitation — the grant that proved the ACF-tuned finder misses NSF (stored no_section on 85.7k of
// real NOFO text). NSF states cost rules as allowable FRAMING under a "B. Budgetary Information"
// section, and a SEPARATE summary block earlier in the doc carries the "Indirect Cost (F&A)
// Limitations" line — the F&A decoy the finder must NOT anchor on instead of the real section.
const IUSE_BUDGET_SECTION = `B. Budgetary Information
Cost Sharing:
Voluntary committed cost sharing is prohibited.
Other Budgetary Limitations:
Budgets and budget justifications submitted to this solicitation must reflect an appropriate distribution of funds based on the proposed scope of the project.
Faculty Release Time/Extra Compensation Above Base Salary: Faculty release time and/or faculty stipends to carry out project work that goes beyond the normal faculty duties is allowed. Salary compensation above 2 months salary must be disclosed and justified in the Budget Justification.
Administrative Support: The salaries of administrative and clerical staff should normally be considered part of indirect costs. However, these may be applied as direct costs if the conditions of 2 CFR 200.413 are met.
Professional Development Conferences/Meetings: In proposals that involve professional development activities, reasonable travel costs and costs for subsistence (lodging and meals) during the meeting may be included in project budgets. In addition, funds may be requested for a reasonable stipend per meeting day for participants.
Equipment: Requested equipment must be essential components of proposed deliverables. Equipment costs must not exceed 30% of the total NSF budget requested.
NSF project funds may not be used for: Student scholarships; replacement equipment or instrumentation; teaching aids; the modification, construction, or furnishing of laboratories or other buildings; the installation of equipment or instrumentation (as distinct from the on-site assembly of multi-component instruments--which is an allowable charge).`;

const IUSE_SUMMARY_DECOY = `B. Budgetary Information
Cost Sharing Requirements:
Voluntary committed cost sharing is prohibited.
Indirect Cost (F&A) Limitations:
Not Applicable
Other Budgetary Limitations:
Other budgetary limitations apply. Please see the full text of this solicitation for further information.`;

describe("NSF-family section finder (real IUSE fixture)", () => {
  it("the widened patterns anchor densely on the real IUSE Budgetary Information section", () => {
    expect(sectionHits(IUSE_BUDGET_SECTION, SECTION_PATTERNS).length).toBeGreaterThan(5);
  });

  it("the ACF 'we do not allow the following' list patterns don't fire on NSF allowable framing", () => {
    const ACF_LIST = [
      /we\s+do\s+not\s+allow/gi,
      /do\s+not\s+allow\s+the\s+following/gi,
      /funding\s+policies\s+and\s+limitations/gi,
      /program-specific\s+limitations/gi,
    ];
    expect(sectionHits(IUSE_BUDGET_SECTION, ACF_LIST)).toHaveLength(0);
  });

  it("anchors on the real Budgetary Information section, not the earlier '(F&A)' summary decoy", () => {
    // The real doc shape: a summary block carrying the "Indirect Cost (F&A) Limitations" line up front,
    // the real Budgetary Information section ~45k chars later. The denser real section must win — the
    // "land there, not on the F&A line" requirement.
    const head1 = "The ITYC program invests in two-year colleges to advance STEM education. ".repeat(60); // ~4.3k
    const gap = "Proposals must describe evidence-based instructional practice and project evaluation. ".repeat(240); // ~20k
    const { excerpt, anchored } = allowableSource(head1 + IUSE_SUMMARY_DECOY + gap + IUSE_BUDGET_SECTION);
    expect(anchored).toBe(true);
    // Markers unique to the REAL section (absent from the F&A summary decoy):
    expect(excerpt).toContain("Faculty Release Time");
    expect(excerpt).toContain("is an allowable charge");
    // ...and in the PRIMARY window (before any second-window join), i.e. the finder anchored ON the
    // real section, not merely reached it via the second-window hedge off the decoy.
    const join = excerpt.indexOf("\n\n[...]\n\n");
    if (join >= 0) expect(excerpt.indexOf("Faculty Release Time")).toBeLessThan(join);
  });
});

// ── 2. Two-list parse + quote gate ──────────────────────────────────────────────────────────

describe("readAllowableUses / verifyAllowableUses", () => {
  it("defaults a legacy item with no kind to 'allowed' (back-compat)", () => {
    const parsed = readAllowableUses({ items: [{ line: "Personnel", quote: "salaries of staff" }], reason: null });
    expect(parsed?.items[0]?.kind).toBe("allowed");
    expect(parsed?.items[0]?.restriction_class).toBeNull();
  });

  it("parses not_allowed items and their restriction_class; allowed items carry no class", () => {
    const parsed = readAllowableUses({
      items: [
        { line: "Training travel", quote: "cost of required training", kind: "allowed" },
        { line: "Construction", quote: "we do not allow construction", kind: "not_allowed", restriction_class: "budget" },
        { line: "No abortions", quote: "may not fund abortions", kind: "not_allowed", restriction_class: "statutory" },
      ],
      reason: null,
    });
    expect(parsed?.items.map((i) => [i.kind, i.restriction_class])).toEqual([
      ["allowed", null],
      ["not_allowed", "budget"],
      ["not_allowed", "statutory"],
    ]);
  });

  it("quote gate still drops any line whose quote is not verbatim in raw_text — kind-agnostic", () => {
    const raw = "We do not allow construction. Costs must be reasonable and allocable.";
    const items: AllowableUseItem[] = [
      { line: "Reasonable costs", quote: "reasonable and allocable", kind: "allowed" },
      // Verbatim (matching case) — the model copies the span, so the gate is case-exact.
      { line: "No construction", quote: "do not allow construction", kind: "not_allowed", restriction_class: "budget" },
      { line: "Fabricated", quote: "no salaries over $200,000 permitted here", kind: "not_allowed", restriction_class: "budget" },
    ];
    const out = verifyAllowableUses(raw, items);
    // The two real quotes survive (carrying their kind); the fabricated one is dropped.
    expect(out.kept.map((i) => i.line)).toEqual(["Reasonable costs", "No construction"]);
    expect(out.kept[1]?.kind).toBe("not_allowed");
    expect(out.droppedNormalized).toBe(1);
  });
});

// ── 3. The client-surface filter ────────────────────────────────────────────────────────────

const FLAG = "ALLOWABLE_USES_CLIENT_VISIBLE";

const MIXED = {
  reason: null,
  items: [
    { line: "Required training travel", quote: "cost of required training", kind: "allowed" },
    { line: "No construction", quote: "we do not allow construction", kind: "not_allowed", restriction_class: "budget" },
    { line: "No fundraising", quote: "fundraising is not allowed", kind: "not_allowed", restriction_class: "budget" },
    { line: "No gender-ideology activities", quote: "promote gender ideology", kind: "not_allowed", restriction_class: "statutory" },
  ],
};

describe("clientAllowableUses (client-surface filter)", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[FLAG];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it("returns null when the flag is off, even with a real list", () => {
    delete process.env[FLAG];
    expect(clientAllowableUses(MIXED)).toBeNull();
  });

  it("treats any value other than exactly \"true\" as off", () => {
    for (const v of ["", "1", "TRUE", "false"]) {
      process.env[FLAG] = v;
      expect(clientAllowableUses(MIXED), `flag=${JSON.stringify(v)}`).toBeNull();
    }
  });

  it("keeps allowed + budget not-allowed, drops the statutory not-allowed item", () => {
    process.env[FLAG] = "true";
    const out = clientAllowableUses(MIXED);
    expect(out?.items.map((i) => i.line)).toEqual([
      "Required training travel",
      "No construction",
      "No fundraising",
    ]);
    // The ideological item never reaches the client card.
    expect(out?.items.some((i) => i.restriction_class === "statutory")).toBe(false);
  });

  it("drops a not-allowed item with no restriction_class (fail toward hiding)", () => {
    process.env[FLAG] = "true";
    const out = clientAllowableUses({
      reason: null,
      items: [{ line: "Something restricted", quote: "this is restricted", kind: "not_allowed" }],
    });
    expect(out).toBeNull();
  });

  it("deterministic backstop: a statutory-worded item tagged budget is still dropped", () => {
    process.env[FLAG] = "true";
    const out = clientAllowableUses({
      reason: null,
      items: [
        { line: "General standard", quote: "costs must be reasonable", kind: "allowed" },
        { line: "No conversion therapy", quote: "no conversion therapy", kind: "not_allowed", restriction_class: "budget" },
      ],
    });
    expect(out?.items.map((i) => i.line)).toEqual(["General standard"]);
  });

  it("backstop catches INFLECTED statutory wording tagged budget (the #483 regex fix)", () => {
    process.env[FLAG] = "true";
    // Each quote is a not-allowed item MIS-tagged "budget"; the backstop must still hide it. These
    // inflected forms are exactly what a trailing \b after the stem failed to match ("ideology" after
    // "ideolog", plus the plurals) — the bug this test locks closed.
    for (const quote of [
      "may not promote gender ideology",
      "no funds for abortions",
      "activities targeting gender identities are unallowable",
      "conversion therapies are not permitted",
    ]) {
      const out = clientAllowableUses({
        reason: null,
        items: [
          { line: "General standard", quote: "costs must be reasonable", kind: "allowed" },
          { line: "Restricted", quote, kind: "not_allowed", restriction_class: "budget" },
        ],
      });
      expect(out?.items.map((i) => i.line), quote).toEqual(["General standard"]);
    }
  });

  it("returns null when everything filters out (only statutory not-allowed items)", () => {
    process.env[FLAG] = "true";
    const out = clientAllowableUses({
      reason: null,
      items: [{ line: "No gender ideology", quote: "promote gender ideology", kind: "not_allowed", restriction_class: "statutory" }],
    });
    expect(out).toBeNull();
  });

  it("hides a verified-empty result and unparseable input", () => {
    process.env[FLAG] = "true";
    expect(clientAllowableUses({ items: [], reason: "no_section" })).toBeNull();
    expect(clientAllowableUses(null)).toBeNull();
    expect(clientAllowableUses("nonsense")).toBeNull();
  });
});

// ── 4. The on-demand re-extract regression guard ──────────────────────────────────────────────
// isAllowableUsesRegression is the guard that stops a nondeterministic re-run from silently clobbering
// an already-populated list with a thinner one (and stamping it out of recut reach). Pure — no DB.

describe("isAllowableUsesRegression", () => {
  const uses = (n: number): AllowableUses => ({
    items: Array.from({ length: n }, (_, i) => ({ line: `item ${i}`, quote: `q${i}`, kind: "allowed" as const })),
    reason: n === 0 ? "no_section" : null,
  });

  it("flags a shrink on a populated list", () => {
    // 5 good items already stored, the fresh run came back with 2 — the exact clobber this guards.
    expect(isAllowableUsesRegression(uses(5), uses(2))).toBe(true);
  });

  it("flags a shrink all the way to empty", () => {
    // A verified-empty re-run must NOT be allowed to wipe a real populated list.
    expect(isAllowableUsesRegression(uses(3), uses(0))).toBe(true);
  });

  it("does not flag an equal count or a growth", () => {
    expect(isAllowableUsesRegression(uses(3), uses(3))).toBe(false);
    expect(isAllowableUsesRegression(uses(2), uses(4))).toBe(false);
  });

  it("does not flag when there was nothing to lose (prior empty or absent)", () => {
    // A prior empty row (the sweep/recut's 0-item state) or no prior value at all can't regress —
    // this is the fail-open path when the prior-read finds nothing.
    expect(isAllowableUsesRegression(uses(0), uses(2))).toBe(false);
    expect(isAllowableUsesRegression(uses(0), uses(0))).toBe(false);
    expect(isAllowableUsesRegression(null, uses(0))).toBe(false);
    expect(isAllowableUsesRegression(null, uses(3))).toBe(false);
  });
});
