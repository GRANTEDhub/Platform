// USASpending.gov past performance lookup
// Free API -- no key required
// Used to verify federal grant history before recommending a client as prime

const USASPENDING_BASE = "https://api.usaspending.gov/api/v2";

export interface USASpendingResult {
  has_federal_grant_history: boolean;
  award_count: number;
  total_awarded: number;
  agencies: string[];
  most_recent: {
    award_id: string;
    recipient_name: string;
    award_amount: number;
    awarding_agency: string;
    start_date: string;
    award_type: string;
  } | null;
  search_term: string;
  verified: boolean;
  note?: string;
}

export async function checkPastPerformance(orgName: string): Promise<USASpendingResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${USASPENDING_BASE}/search/spending_by_award/`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: {
          recipient_search_text: [orgName],
          award_type_codes: ["02", "03", "04", "05"], // grants + cooperative agreements
          time_period: [{ start_date: "2019-01-01", end_date: "2026-12-31" }],
        },
        fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "Award Type"],
        limit: 20,
        sort: "Start Date",
        order: "desc",
      }),
    });

    if (!response.ok) {
      return failed(orgName, `USASpending API error: ${response.status}`);
    }

    const data = await response.json();
    const results: Record<string, unknown>[] = data.results ?? [];

    const seen = new Set<string>();
    const agencies: string[] = [];
    for (const r of results) {
      const a = r["Awarding Agency"] as string;
      if (a && !seen.has(a)) { seen.add(a); agencies.push(a); }
    }

    const first = results[0];
    return {
      has_federal_grant_history: results.length > 0,
      award_count: results.length,
      total_awarded: results.reduce((sum, r) => sum + ((r["Award Amount"] as number) ?? 0), 0),
      agencies,
      most_recent: first
        ? {
            award_id: first["Award ID"] as string,
            recipient_name: first["Recipient Name"] as string,
            award_amount: first["Award Amount"] as number,
            awarding_agency: first["Awarding Agency"] as string,
            start_date: first["Start Date"] as string,
            award_type: first["Award Type"] as string,
          }
        : null,
      search_term: orgName,
      verified: true,
    };
  } catch (err) {
    return failed(orgName, err instanceof Error ? err.message : "Unknown error");
  } finally {
    clearTimeout(timeout);
  }
}

function failed(orgName: string, note: string): USASpendingResult {
  return {
    has_federal_grant_history: false,
    award_count: 0,
    total_awarded: 0,
    agencies: [],
    most_recent: null,
    search_term: orgName,
    verified: false,
    note,
  };
}

// ── Program awardee enumeration (Track 2 prospecting, #208a) ────────────────
// The INVERSE of checkPastPerformance: given a PROGRAM (Assistance Listing / CFDA
// number), find the orgs that WON it -- proven, eligible applicants to prospect.
// Aggregates awards by recipient. Sorted by RECENCY, not award size: the biggest
// federal winners have in-house grant teams and are the least likely to hire us
// (see #208), so we surface recent awardees rather than the mega-recipients.
// Graceful: returns [] on any failure so discovery falls back to web search only.
export interface ProgramAwardee {
  name: string;
  state: string | null;
  award_count: number;
  total_awarded: number;
  agencies: string[];
  recipient_id: string | null;
  most_recent_year: string | null;
}

export async function findProgramAwardees(
  cfdaNumbers: string[],
  opts: { state?: string; limit?: number } = {},
): Promise<ProgramAwardee[]> {
  const programs = Array.from(new Set(cfdaNumbers.map((n) => n.trim()).filter(Boolean)));
  if (programs.length === 0) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const filters: Record<string, unknown> = {
      program_numbers: programs,
      award_type_codes: ["02", "03", "04", "05"], // grants + cooperative agreements
      time_period: [{ start_date: "2019-01-01", end_date: "2026-12-31" }],
    };
    if (opts.state) filters.recipient_locations = [{ country: "USA", state: opts.state }];

    const response = await fetch(`${USASPENDING_BASE}/search/spending_by_award/`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filters,
        fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "recipient_id"],
        limit: opts.limit ?? 100,
        sort: "Start Date",
        order: "desc",
      }),
    });
    if (!response.ok) return [];

    const data = await response.json();
    const results: Record<string, unknown>[] = data.results ?? [];

    // Aggregate by recipient -- one program has many awards, we want distinct orgs.
    // Insertion order = the API's recency sort, so the first N are recent awardees.
    const byOrg = new Map<string, ProgramAwardee>();
    for (const r of results) {
      const name = ((r["Recipient Name"] as string) ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const amount = (r["Award Amount"] as number) ?? 0;
      const agency = (r["Awarding Agency"] as string) ?? "";
      const year = ((r["Start Date"] as string) ?? "").slice(0, 4);
      const rid = (r["recipient_id"] as string) ?? null;
      const cur = byOrg.get(key);
      if (cur) {
        cur.award_count += 1;
        cur.total_awarded += amount;
        if (agency && !cur.agencies.includes(agency)) cur.agencies.push(agency);
        if (year && (!cur.most_recent_year || year > cur.most_recent_year)) cur.most_recent_year = year;
        if (!cur.recipient_id && rid) cur.recipient_id = rid;
      } else {
        byOrg.set(key, {
          name,
          state: opts.state ?? null,
          award_count: 1,
          total_awarded: amount,
          agencies: agency ? [agency] : [],
          recipient_id: rid,
          most_recent_year: year || null,
        });
      }
    }
    return Array.from(byOrg.values());
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// A verifiable USASpending source_url for a past-awardee (the federal record that
// grounds the prospect, in place of a Brave result URL).
export function awardeeSourceUrl(a: ProgramAwardee): string {
  return a.recipient_id
    ? `https://www.usaspending.gov/recipient/${a.recipient_id}/latest`
    : `https://www.usaspending.gov/search/?hash=${encodeURIComponent(a.name)}`;
}

// One-line federal-history note for a past-awardee candidate. Captured on the
// record for visibility; deliberately NOT used to rank (see #208).
export function awardeeCapabilitySummary(a: ProgramAwardee): string {
  const total = a.total_awarded > 0 ? `, $${(a.total_awarded / 1_000_000).toFixed(1)}M total` : "";
  const recent = a.most_recent_year ? `, most recent ${a.most_recent_year}` : "";
  const agencies = a.agencies.slice(0, 2).join(", ");
  return `Federal grant history: ${a.award_count} award${a.award_count === 1 ? "" : "s"} under this program${total}${recent}${agencies ? `. Agencies: ${agencies}` : ""}.`;
}

// Formats a STORED usaspending_summary (jsonb) into the matcher context string.
// Returns undefined for a null/empty cache so the caller falls through to the
// client's own federal_grant_history / "unknown" -- never a live fetch.
export function formatStoredUSASpending(summary: unknown): string | undefined {
  if (!summary || typeof summary !== "object") return undefined;
  return formatUSASpendingContext(summary as USASpendingResult);
}

// Formats the USASpending result into a one-line context string for Claude
export function formatUSASpendingContext(result: USASpendingResult): string {
  if (!result.verified) {
    return `USASpending lookup failed (${result.note ?? "unknown"}) -- treat as unknown, flag for manual verification`;
  }
  if (!result.has_federal_grant_history) {
    return `USASpending verified: NO federal grants or cooperative agreements found for "${result.search_term}" (2019-present) -- past performance scoring gap, recommend experienced co-applicant if award >$500K`;
  }
  const total =
    result.total_awarded > 0
      ? `, $${(result.total_awarded / 1_000_000).toFixed(1)}M total`
      : "";
  const agencies = result.agencies.slice(0, 3).join(", ");
  const recent = result.most_recent
    ? `. Most recent: ${result.most_recent.awarding_agency} (${(result.most_recent.start_date ?? "").slice(0, 4)})`
    : "";
  return `USASpending verified: ${result.award_count} federal grants/cooperative agreements${total}. Agencies: ${agencies}${recent}`;
}
