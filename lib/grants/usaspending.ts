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
