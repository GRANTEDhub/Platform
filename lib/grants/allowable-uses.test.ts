import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clientAllowableUses,
  readAllowableUses,
  verifyAllowableUses,
  allowableSource,
  SECTION_PATTERNS,
  type AllowableUseItem,
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
