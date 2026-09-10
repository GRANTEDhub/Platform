// Source I/O: fetch a source's page (or RSS feed) and reduce it to (a) candidate hits and (b) a
// content hash for change detection. The fetch goes through the SSRF-guarded fetchWebsite (public
// egress, no domain allowlist, http+https) — the same guarded fetcher the enrich path uses, so no
// new egress surface config is needed for the AR domains (open egress in prod; the guard blocks only
// internal IPs). fetchText is injectable so the orchestrator's tests never touch the network.

import { fetchWebsite } from "@/lib/net/fetch-website";
import { extractAnchors, normalizeForHash, parseRssItems, sha256hex, type RawItem } from "@/lib/ar-grants/parse";
import type { ArGrantSource } from "@/lib/ar-grants/sources";

export type FetchTextFn = (url: string) => Promise<{ ok: true; body: string } | { ok: false; reason: string }>;

const defaultFetchText: FetchTextFn = async (url) => {
  const res = await fetchWebsite(url);
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, body: res.html };
};

export interface SourceFetchResult {
  ok: boolean;
  items: RawItem[];
  contentHash: string;
  reason?: string;
}

export async function fetchSource(source: ArGrantSource, fetchText: FetchTextFn = defaultFetchText): Promise<SourceFetchResult> {
  const isRss = source.fetch_mode === "rss" && !!source.rss_url;
  const target = isRss ? (source.rss_url as string) : source.url;
  const res = await fetchText(target);
  if (!res.ok) return { ok: false, items: [], contentHash: "", reason: res.reason };

  if (isRss) {
    const items = parseRssItems(res.body);
    // Hash the STABLE item identity (title|link), not the raw feed — a feed's lastBuildDate churns
    // every fetch and would otherwise read as a change every run.
    const contentHash = sha256hex(items.map((i) => `${i.title}|${i.url ?? ""}`).join("\n"));
    return { ok: true, items, contentHash };
  }
  const items = extractAnchors(res.body, source.url);
  const contentHash = sha256hex(normalizeForHash(res.body));
  return { ok: true, items, contentHash };
}
