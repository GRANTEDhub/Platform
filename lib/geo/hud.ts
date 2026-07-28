import type { HudDesignations } from "@/types/database";

// ── HUD place-based designations (keyless ArcGIS map services) ───────────────
// Given a geocoded point (from lib/geo/census.ts), answer whether the org's address
// falls in a HUD Qualified Census Tract (QCT) or Difficult Development Area (DDA) --
// the LIHTC distress designations, and a general place-based need/underservedness
// marker for housing and community-development funding.
//
// Same posture as the HRSA overlay (lib/geo/hrsa.ts): keyless, timeout-bounded,
// fail-safe, and NARRATIVE-ONLY -- it feeds enrichMatchWithProfile, which is
// structurally isolated from occupancy, so it can never move a seat.
//
// Membership is answered by POINT-IN-POLYGON count (`returnCountOnly`), so it does
// not depend on guessing any attribute field name -- "count > 0" = designated. And a
// failed query is reported as null (unavailable), NEVER conflated with false ("checked,
// not designated"): a silent false-negative would be the worst outcome.

const HUD_ORG = "https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services";
// Year-versioned FeatureServers -- BUMP THE YEAR ANNUALLY (QCT/DDA lists are re-issued
// effective Jan 1). The QCT_2026 URL is confirmed via HUD Open Data; DDA follows the
// identical naming convention. A wrong/expired URL 404s -> null (unavailable, logged),
// so it degrades visibly rather than silently reading "not designated".
const QCT_LAYER = `${HUD_ORG}/QUALIFIED_CENSUS_TRACTS_2026/FeatureServer/0`;
const DDA_LAYER = `${HUD_ORG}/DIFFICULT_DEVELOPMENT_AREAS_2026/FeatureServer/0`;
const TIMEOUT_MS = 8000;

// Point-in-polygon membership test against one HUD layer.
//   true  -> point is inside >=1 polygon (designated)
//   false -> query succeeded, count 0 (not designated)
//   null  -> query failed / unavailable (kept distinct from "not designated")
async function pointInLayer(layer: string, lon: number, lat: number): Promise<boolean | null> {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnCountOnly: "true",
    f: "json",
  });
  const url = `${layer}/query?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    // ArcGIS can return an {error:{...}} envelope with HTTP 200; treat that as unavailable.
    const data = (await res.json()) as { count?: number; error?: unknown };
    if (data.error != null || typeof data.count !== "number") return null;
    return data.count > 0;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Look up HUD QCT/DDA membership at (lat, lon). Returns null only when BOTH queries
// fail (we learned nothing); otherwise a context with per-designation booleans (a
// false is a real negative; a null is "that one layer was unavailable").
export async function lookupHudDesignations(lat: number, lon: number): Promise<HudDesignations | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const [qct, dda] = await Promise.all([pointInLayer(QCT_LAYER, lon, lat), pointInLayer(DDA_LAYER, lon, lat)]);
  if (qct === null && dda === null) return null;
  return {
    checked_at: new Date().toISOString(),
    source: "HUD (services.arcgis.com)",
    qct,
    dda,
  };
}
