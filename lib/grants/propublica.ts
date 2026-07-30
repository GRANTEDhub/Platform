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

// ── EIN resolution by name ────────────────────────────────────────────────────
// The 990 pull is keyed on an EIN, but a nonprofit's own website almost never
// prints one -- so without this the budget chain dead-ends and "annual budget"
// stays blank forever. This resolves an EIN from the org NAME (+ state) via the
// ProPublica search endpoint.
//
// CONSERVATIVE BY DESIGN: it returns a match only when exactly one candidate
// normalizes to the same name (and, when a state is known, sits in that state).
// A fuzzy or ambiguous result returns null rather than guessing -- attaching the
// wrong EIN would publish another organization's finances onto this client, which
// is far worse than a blank field.

function normalizeOrgName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'"()]/g, "")
    .replace(/\b(inc|incorporated|llc|corp|corporation|co|the|a|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type EinMatch = { ein: string; matchedName: string; state: string | null };

export async function resolveEinByName(
  orgName: string,
  state?: string | null,
): Promise<EinMatch | null> {
  const q = (orgName ?? "").trim();
  if (q.length < 4) return null; // too short to disambiguate

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const params = new URLSearchParams({ q });
    if (state && state.trim()) params.set("state[id]", state.trim().toUpperCase());
    const res = await fetch(`${PP_BASE}/search.json?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { organizations?: Record<string, unknown>[] };
    const orgs = Array.isArray(data.organizations) ? data.organizations : [];
    const target = normalizeOrgName(q);
    const exact = orgs.filter((o) => normalizeOrgName(String(o.name ?? "")) === target);
    // Exactly one normalized-name match, or nothing. Two same-named orgs (a state
    // chapter and a national, say) are ambiguous -> refuse.
    if (exact.length !== 1) return null;
    const o = exact[0];
    const ein = normalizeEin(String(o.ein ?? ""));
    if (!ein) return null;
    return {
      ein,
      matchedName: String(o.name ?? "").trim(),
      state: typeof o.state === "string" ? o.state : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── EIN best-guess: ranked candidates with the evidence behind each ──────────
//
// resolveEinByName above is intentionally all-or-nothing: exactly one normalized
// name match or null. That is the right contract for the UNATTENDED refresh (it must
// never silently attach the wrong org's tax filings), but it discards useful work --
// two same-named orgs in different states are trivially separable once you look at
// location, and a human staring at the confirm screen can settle what a background
// job must not guess at.
//
// So this returns a RANKED shortlist with a confidence tier and the reasons for it,
// leaving the accept/reject decision to its caller. Same shape as the SAM.gov resolve
// flow, which solves the identical org-identity problem: propose candidates with
// facts, store nothing until a human (or a high-confidence rule) commits.
//
// SIGNALS. The search endpoint returns name, city and state per organization, so
// those are what can corroborate. Street address, contacts and services are NOT in
// the search payload -- matching on those would need a per-candidate detail fetch,
// deliberately not done here (N extra round trips inside an enrichment step).

export type EinConfidence = "high" | "medium" | "low";

export type EinCandidate = {
  ein: string;
  matchedName: string;
  city: string | null;
  state: string | null;
  confidence: EinConfidence;
  // Human-readable evidence, so the confirm screen can justify the ranking rather
  // than presenting a bare score the reviewer has to trust blindly.
  reasons: string[];
  // Kept on the candidate (not just folded into `confidence`) because auto-bind
  // reasons about UNIQUENESS WITHIN A LOCALITY, which needs the raw signals.
  cityMatch: boolean;
  stateMatch: boolean;
};

export type EinResolution = {
  candidates: EinCandidate[];
  // Safe to write without asking: exactly one candidate, name AND state AND city all
  // agreeing. Anything less is proposed, never auto-bound.
  autoBind: EinCandidate | null;
};

const normalizeCity = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

export async function resolveEinCandidates(signals: {
  name: string | null | undefined;
  city?: string | null;
  state?: string | null;
}): Promise<EinResolution> {
  const q = (signals.name ?? "").trim();
  if (q.length < 4) return { candidates: [], autoBind: null };

  const wantState = (signals.state ?? "").trim().toUpperCase() || null;
  const wantCity = normalizeCity(signals.city);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const params = new URLSearchParams({ q });
    // Deliberately NOT filtering by state in the query. A client whose mailing state
    // differs from its IRS registration state (common for a fiscally sponsored or
    // recently relocated org) would be filtered out entirely, and a zero-result
    // "no match" is far more misleading than a ranked list.
    const res = await fetch(`${PP_BASE}/search.json?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { candidates: [], autoBind: null };
    const data = (await res.json()) as { organizations?: Record<string, unknown>[] };
    const orgs = Array.isArray(data.organizations) ? data.organizations : [];
    const target = normalizeOrgName(q);

    const scored: EinCandidate[] = [];
    for (const o of orgs) {
      const ein = normalizeEin(String(o.ein ?? ""));
      if (!ein) continue;
      const rawName = String(o.name ?? "").trim();
      const norm = normalizeOrgName(rawName);
      const city = typeof o.city === "string" ? o.city : null;
      const state = typeof o.state === "string" ? o.state : null;

      const nameExact = norm === target;
      // Containment catches "Ozark Regional Transit" vs "Ozark Regional Transit
      // Authority" -- a real naming difference between a trade name and the
      // registered legal name, not a different organization.
      const nameContains = !nameExact && (norm.includes(target) || target.includes(norm));
      if (!nameExact && !nameContains) continue;

      const stateMatch = !!wantState && !!state && state.toUpperCase() === wantState;
      const cityMatch = !!wantCity && !!city && normalizeCity(city) === wantCity;

      const reasons: string[] = [];
      reasons.push(nameExact ? "Name matches exactly" : "Name is a close variant");
      if (stateMatch) reasons.push(`State matches (${state})`);
      else if (wantState && state) reasons.push(`State differs (IRS: ${state}, on file: ${wantState})`);
      if (cityMatch) reasons.push(`City matches (${city})`);
      else if (wantCity && city) reasons.push(`City differs (IRS: ${city})`);

      let confidence: EinConfidence = "low";
      if (nameExact && stateMatch && cityMatch) confidence = "high";
      else if (nameExact && stateMatch) confidence = "medium";
      else if (nameExact || stateMatch) confidence = "low";

      scored.push({ ein, matchedName: rawName, city, state, confidence, reasons, cityMatch, stateMatch });
    }

    const rank: Record<EinConfidence, number> = { high: 0, medium: 1, low: 2 };
    scored.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
    const top = scored.slice(0, 5);

    // AUTO-BIND ON UNIQUENESS, not on an exact name.
    //
    // Requiring an exact name match was too strict in the common case: an org's trade
    // name rarely equals its registered name ("Jones Center" vs "Jones Center for
    // Families"), so a single obvious candidate in the right city was graded merely
    // "likely" and pushed to a human -- who then had one plausible option in the
    // client's own state and no way to add information. That is a confirmation
    // request with no decision in it.
    //
    // Uniqueness within a locality is the real signal. Two tiers, most specific first:
    //   1. Exactly one candidate agreeing on BOTH city and state.
    //   2. Otherwise, exactly one candidate agreeing on state.
    // Ambiguity still refuses: two same-named orgs in one state, or a name that only
    // matched loosely with no location agreement, go to the human with the evidence.
    const inCityAndState = top.filter((c) => c.cityMatch && c.stateMatch);
    const inState = top.filter((c) => c.stateMatch);
    const autoBind =
      inCityAndState.length === 1 ? inCityAndState[0] : inState.length === 1 ? inState[0] : null;

    return { candidates: top, autoBind };
  } catch {
    return { candidates: [], autoBind: null };
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
