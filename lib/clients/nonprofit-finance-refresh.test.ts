import { describe, it, expect } from "vitest";
import { budgetFillValue } from "./nonprofit-finance-refresh";
import type { NonprofitFinance } from "@/types/database";

// The 990 -> annual_budget prefill decision (FF-2). budgetFillValue is the pure never-overwrite guard:
// fill-if-empty, seeded from total functional EXPENSES (not revenue), formatted as an editable dated citation.
const fin = (over: Partial<NonprofitFinance> = {}): NonprofitFinance => ({
  ein: "71-0236875",
  fiscal_year: 2022,
  total_revenue: 9_000_000,
  total_expenses: 1_234_567,
  total_assets: 5_000_000,
  organization_name: "Test Org",
  source_url: "https://projects.propublica.org/nonprofits/organizations/710236875",
  verified: true,
  ...over,
});

describe("budgetFillValue -- 990 -> annual_budget prefill (FF-2)", () => {
  it("seeds a blank budget from total_expenses, tagged with fiscal year + source", () => {
    const expected = "$1,234,567 (FY2022, per IRS 990)";
    expect(budgetFillValue(null, fin())).toBe(expected);
    expect(budgetFillValue(undefined, fin())).toBe(expected);
    expect(budgetFillValue("", fin())).toBe(expected);
    expect(budgetFillValue("   ", fin())).toBe(expected); // whitespace counts as empty
  });

  it("NEVER overwrites a value already on file (fill-if-empty; a manual value always wins)", () => {
    expect(budgetFillValue("$2M, per the ED", fin())).toBeNull();
    // Even a prior seed is left alone -- forward-only, never re-stamped.
    expect(budgetFillValue("$1,234,567 (FY2021, per IRS 990)", fin())).toBeNull();
  });

  it("uses EXPENSES, not revenue: a filing with revenue but no expenses seeds nothing", () => {
    expect(budgetFillValue(null, fin({ total_expenses: null, total_revenue: 9_000_000 }))).toBeNull();
  });

  it("skips a non-usable expense figure (a verified 'no filings' 990, zero, or negative)", () => {
    expect(budgetFillValue(null, fin({ total_expenses: null }))).toBeNull();
    expect(budgetFillValue(null, fin({ total_expenses: 0 }))).toBeNull();
    expect(budgetFillValue(null, fin({ total_expenses: -5 }))).toBeNull();
  });

  it("omits the FY tag when the filing year is absent", () => {
    expect(budgetFillValue(null, fin({ fiscal_year: null }))).toBe("$1,234,567 (per IRS 990)");
  });

  it("rounds a fractional expense figure to whole dollars", () => {
    expect(budgetFillValue(null, fin({ total_expenses: 1_234_567.89 }))).toBe("$1,234,568 (FY2022, per IRS 990)");
  });
});
