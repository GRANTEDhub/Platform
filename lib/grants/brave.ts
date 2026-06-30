// Brave Web Search — raw fetch, mirroring the USASpending / Simpler integration
// pattern: API-key header, AbortController timeout, graceful degrade, never a
// hard throw that breaks the caller. SERP-style: returns real result URLs from
// Brave's own crawl, which discovery extracts orgs from and grounds the
// source_url hallucination guard on.
//
// Blocked in the agent sandbox (same as USASpending/Simpler); runs in the Vercel
// runtime with BRAVE_SEARCH_API_KEY set.

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface BraveResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveSearchResult {
  ok: boolean;
  results: BraveResult[];
  note?: string;
}

export async function braveSearch(query: string, count = 15): Promise<BraveSearchResult> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return { ok: false, results: [], note: "BRAVE_SEARCH_API_KEY not configured" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}&country=us`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return { ok: false, results: [], note: `Brave search HTTP ${res.status}` };

    const json = await res.json();
    const raw: Array<{ title?: string; url?: string; description?: string }> =
      json?.web?.results ?? [];
    const results = raw
      .filter((r) => r.url)
      .map((r) => ({ title: r.title ?? "", url: r.url as string, description: r.description ?? "" }));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, results: [], note: err instanceof Error ? err.message : "Brave search failed" };
  } finally {
    clearTimeout(timeout);
  }
}
