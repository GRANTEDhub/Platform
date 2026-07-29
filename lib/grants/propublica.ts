// IRS Form 990 financials for one organization, via the ProPublica Nonprofit
// Explorer detail endpoint. The financial counterpart to eo-directory.ts (which uses
// the SEARCH endpoint for prospect enumeration and has no financials). Keyless, no
// migration to the API. Graceful: every failure path degrades to an unverified
// result so enrichment never breaks a save.
//
// ENRICHMENT ONLY: the pulled budget is a sourced, dated CITATION ("FY2022 total
// revenue $X, IRS 990") that grounds narrative + flags. It is never read by the
// occupancy/seat scorer — same contract as the USASpending cache.

import type { NonprofitFinance } from "@/types/database";

const PP_BASE = "https://projects.propublica.org/nonprofits/api/v2";

// EINs are 9 digits; ProPublica's detail path takes the bare integer. Strip any
// formatting (dashes/spaces) a human typed.
export function normalizeEin(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length === 9 ? digits : null;
}

export function propublicaOrgUrl(ein: string): string {
  return `https://projects.propublica.org/nonprofits/organizations/${ein}`;
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// Fetch the latest 990 figures for an EIN. Returns { verified: false } on any
// failure (network / non-200 / unparseable) so the caller leaves the prior cache
// intact and retries later. Returns { verified: true } with nulls when the org
// exists but has no filings with financial data (a real, terminal answer).
export async function fetchNonprofitFinancials(einRaw: string): Promise<NonprofitFinance> {
  const ein = normalizeEin(einRaw);
  const source_url = ein ? propublicaOrgUrl(ein) : `${PP_BASE}`;
  const unverified: NonprofitFinance = {
    ein: ein ?? (einRaw ?? "").trim(),
    fiscal_year: null,
    total_revenue: null,
    total_expenses: null,
    total_assets: null,
    organization_name: null,
    source_url,
    verified: false,
  };
  if (!ein) return unverified;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${PP_BASE}/organizations/${ein}.json`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return unverified;
    const data = (await res.json()) as {
      organization?: { name?: unknown };
      filings_with_data?: Record<string, unknown>[];
    };
    const org = data.organization ?? {};
    const organization_name = typeof org.name === "string" ? org.name.trim() : null;
    // filings_with_data is ordered most-recent-first; the first entry carries the
    // latest 990 totals. Absent/empty = the org exists but has no financial filings
    // (a verified, terminal "no data" — not an error).
    const latest = Array.isArray(data.filings_with_data) ? data.filings_with_data[0] : undefined;
    if (!latest) {
      return { ...unverified, organization_name, verified: true };
    }
    return {
      ein,
      fiscal_year: numOrNull(latest.tax_prd_yr),
      total_revenue: numOrNull(latest.totrevenue),
      total_expenses: numOrNull(latest.totfuncexpns),
      total_assets: numOrNull(latest.totassetsend),
      organization_name,
      source_url,
      verified: true,
    };
  } catch {
    return unverified;
  } finally {
    clearTimeout(timeout);
  }
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// One-line rendering for the profile's auto-pulled block and the form citation.
// Returns null when there is nothing sourced to show (unverified or no figures).
export function formatStoredNonprofitFinance(
  finance: NonprofitFinance | null | undefined,
): string | null {
  if (!finance || !finance.verified) return null;
  const parts: string[] = [];
  if (finance.total_revenue != null) parts.push(`total revenue ${usd(finance.total_revenue)}`);
  if (finance.total_expenses != null) parts.push(`total expenses ${usd(finance.total_expenses)}`);
  if (finance.total_assets != null) parts.push(`total assets ${usd(finance.total_assets)}`);
  if (parts.length === 0) return null;
  const fy = finance.fiscal_year ? `FY${finance.fiscal_year} ` : "";
  return `IRS Form 990 (${fy}via ProPublica): ${parts.join("; ")}.`;
}
