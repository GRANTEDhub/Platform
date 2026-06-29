// ──────────────────────────────────────────────────────────────────────────
// THROWAWAY SPIKE ROUTE — DELETE AFTER ONE RUN.
//
// Answers two Step-2 unknowns from inside the real serverless runtime:
//   1. How Simpler.gov exposes the full-announcement attachment (raw shape).
//   2. Whether pdf-parse can fetch + parse a real NOFO PDF here.
//
// READ-ONLY: imports no database client, writes nothing. Pure fetch + parse.
// GUARDED: requires SPIKE_SECRET -- a throwaway env var you set just for this
// test, independent of CRON_SECRET (Bearer header or ?key=); 401 otherwise.
// ──────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs"; // pdf-parse needs Node APIs, not edge
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SIMPLER = "https://api.simpler.grants.gov";

// Recursively collect string values that look like document/attachment URLs.
function findDocUrls(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === "string") {
    if (/\.pdf(\?|$)/i.test(obj) || /attachment|download/i.test(obj)) out.push(obj);
  } else if (Array.isArray(obj)) {
    obj.forEach((v) => findDocUrls(v, out));
  } else if (obj && typeof obj === "object") {
    Object.values(obj as Record<string, unknown>).forEach((v) => findDocUrls(v, out));
  }
  return out;
}

// Recursively collect EVERY url string with its exact JSON path, so we can see
// which field holds the outbound agency/NOFO link (SAMHSA/NSF link-following).
function findUrls(
  obj: unknown,
  path: string,
  out: { path: string; url: string }[] = [],
): { path: string; url: string }[] {
  if (typeof obj === "string") {
    if (/^https?:\/\//i.test(obj.trim())) out.push({ path, url: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => findUrls(v, `${path}[${i}]`, out));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      findUrls(v, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  // ── Guard ── throwaway secret, independent of CRON_SECRET / the cron.
  const secret = process.env.SPIKE_SECRET;
  const auth = req.headers.get("authorization");
  const key = req.nextUrl.searchParams.get("key");
  if (!secret || (auth !== `Bearer ${secret}` && key !== secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.SIMPLER_GOV_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing SIMPLER_GOV_API_KEY" }, { status: 500 });
  }

  const oppQuery = req.nextUrl.searchParams.get("opp") || "26-508";
  const result: Record<string, unknown> = { oppQuery };

  try {
    // ── 1. Find the opportunity by number/text, then fetch its detail ──
    const searchRes = await fetch(`${SIMPLER}/v1/opportunities/search`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: oppQuery,
        pagination: {
          page_offset: 1,
          page_size: 5,
          sort_order: [{ order_by: "post_date", sort_direction: "descending" }],
        },
      }),
    });
    if (!searchRes.ok) {
      return NextResponse.json(
        { ...result, step: "search", status: searchRes.status, body: (await searchRes.text()).slice(0, 500) },
        { status: 502 },
      );
    }
    const searchJson = await searchRes.json();
    const hits: Array<Record<string, unknown>> = searchJson.data ?? [];
    result.searchHitCount = hits.length;
    const first = hits[0];
    if (!first) {
      return NextResponse.json({ ...result, note: "No search hits for query" });
    }
    const oppId = String(first.opportunity_id ?? first.legacy_opportunity_id ?? "");
    result.opportunity = {
      id: oppId,
      number: first.opportunity_number,
      title: first.opportunity_title,
    };

    const detailRes = await fetch(`${SIMPLER}/v1/opportunities/${oppId}`, {
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    });
    if (!detailRes.ok) {
      return NextResponse.json(
        { ...result, step: "detail", status: detailRes.status, body: (await detailRes.text()).slice(0, 500) },
        { status: 502 },
      );
    }
    const detailJson = await detailRes.json();
    const detail = detailJson.data ?? detailJson;

    // ── ANSWER 1: the attachment shape ──
    result.detailTopLevelKeys = Object.keys(detail);
    const attachmentKey = Object.keys(detail).find((k) => /attach|document|file/i.test(k));
    result.attachmentFieldName = attachmentKey ?? null;
    result.attachmentField = attachmentKey ? detail[attachmentKey] : null;
    const docUrls = findDocUrls(detail);
    result.candidateDocUrls = docUrls.slice(0, 10);

    // Full nested dump to locate the outbound agency/NOFO link (SAMHSA/NSF put
    // it inside summary or competitions, not at top level). allUrls gives the
    // exact JSON path of every link so we know which field to follow.
    result.summaryFull = detail.summary ?? null;
    result.competitionsFull = detail.competitions ?? null;
    result.allUrls = findUrls(detail, "");

    // ── 2. Fetch + parse one real NOFO PDF, inside this serverless function ──
    const pdfUrl = docUrls.find((u) => /\.pdf(\?|$)/i.test(u)) ?? docUrls[0];
    result.pickedPdfUrl = pdfUrl ?? null;
    if (pdfUrl) {
      try {
        const fileRes = await fetch(pdfUrl, { headers: { "X-API-Key": apiKey } });
        result.pdfFetchStatus = fileRes.status;
        result.pdfContentType = fileRes.headers.get("content-type");
        if (fileRes.ok) {
          const buf = Buffer.from(await fileRes.arrayBuffer());
          result.pdfBytes = buf.length;
          // Dynamic import + Buffer arg avoids pdf-parse's top-level test-file read.
          const pdfParse = (await import("pdf-parse")).default;
          const parsed = await pdfParse(buf);
          result.pdf = {
            pages: parsed.numpages,
            chars: parsed.text.length,
            sample: parsed.text.replace(/\s+/g, " ").trim().slice(0, 400),
          };
        }
      } catch (err) {
        result.pdfError = String(err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ...result, error: String(err instanceof Error ? err.message : err) },
      { status: 500 },
    );
  }
}
