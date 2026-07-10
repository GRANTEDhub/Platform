import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { extractSimplerGovOpportunityId } from "@/lib/grants/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// TEMPORARY probe (#107) -- verifies the LIVE Simpler.gov assistance-listing field
// path against real opportunities before the extraction is written. Admin-only,
// read-only, returns no secrets. DELETE this route once the field path is confirmed.
const SGG = "https://api.simpler.grants.gov";

function assistanceKeys(obj: Record<string, unknown> | null | undefined): string[] {
  if (!obj) return [];
  return Object.keys(obj).filter((k) => /assistance|cfda|program.?number/i.test(k));
}

export async function GET(req: NextRequest) {
  // Admin gate (mirrors the add-client route).
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const apiKey = process.env.SIMPLER_GOV_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "SIMPLER_GOV_API_KEY is not set in THIS environment.",
        hint: "Vercel → Project → Settings → Environment Variables → ensure SIMPLER_GOV_API_KEY includes the Preview environment, then redeploy this branch.",
      },
      { status: 500 },
    );
  }

  const db = createServiceClient();
  const override = req.nextUrl.searchParams.get("opp");

  // Candidate opportunity ids: an explicit ?opp=<id>, else recent Simpler-sourced grants.
  const candidates: { id: string; title: string | null }[] = [];
  if (override) {
    candidates.push({ id: override, title: "(from ?opp=)" });
  } else {
    const { data: rows } = await db
      .from("grants")
      .select("id, title, source_url, ingested_at")
      .ilike("source_url", "%simpler.grants.gov%")
      .order("ingested_at", { ascending: false })
      .limit(20);
    for (const g of (rows ?? []) as { title: string | null; source_url: string | null }[]) {
      const oid = extractSimplerGovOpportunityId(g.source_url ?? "");
      if (oid) candidates.push({ id: oid, title: g.title });
      if (candidates.length >= 6) break;
    }
  }
  if (candidates.length === 0) {
    return NextResponse.json({ error: "No Simpler opportunity ids found; pass ?opp=<id>." }, { status: 404 });
  }

  const checked: Record<string, unknown>[] = [];
  let firstPopulated: Record<string, unknown> | null = null;

  for (const c of candidates) {
    try {
      const res = await fetch(`${SGG}/v1/opportunities/${c.id}`, {
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      });
      if (!res.ok) {
        checked.push({ oppId: c.id, title: c.title, http: res.status });
        continue;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const data = (json.data ?? json) as Record<string, unknown>;
      const summary = (data.summary ?? {}) as Record<string, unknown>;

      const topListings = data["opportunity_assistance_listings"] ?? null;
      const sumListings = summary["opportunity_assistance_listings"] ?? null;
      const listings = topListings ?? sumListings ?? null;
      const populated = Array.isArray(listings) && listings.length > 0;

      const row: Record<string, unknown> = {
        oppId: c.id,
        title: c.title,
        top_level_assistance_keys: assistanceKeys(data),
        summary_assistance_keys: assistanceKeys(summary),
        listings_location:
          topListings != null ? "top-level" : sumListings != null ? "summary" : "not found",
        listings_count: Array.isArray(listings) ? listings.length : 0,
        sample_entry: populated ? (listings as unknown[])[0] : null,
      };
      checked.push(row);
      if (populated && !firstPopulated) {
        firstPopulated = { ...row, all_listings: listings };
      }
    } catch (e) {
      checked.push({ oppId: c.id, title: c.title, error: String(e instanceof Error ? e.message : e) });
    }
  }

  return NextResponse.json({
    verified_against: "live api.simpler.grants.gov",
    // The answer: exact path (top-level vs summary) + field names in sample_entry + real values.
    populated_example: firstPopulated,
    fill_rate: `${checked.filter((c) => (c.listings_count as number) > 0).length} of ${checked.length} checked carried listings`,
    all_checked: checked,
  });
}
