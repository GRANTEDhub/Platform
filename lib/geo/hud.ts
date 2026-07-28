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
// Candidate FeatureServers per designation, tried in order: the current year-stamped
// service first, then the year-less evergreen alias as a fallback. Service names are
// CASE-SENSITIVE on ArcGIS Online and are verified against the live HUD org listing
// (QCT is all-caps; DDA is mixed-case). When HUD retires the _2026 service next year the
// evergreen alias keeps this working until the year is bumped -- so it degrades to the
// current data rather than silently going dark.
const QCT_LAYERS = [
  `${HUD_ORG}/QUALIFIED_CENSUS_TRACTS_2026/FeatureServer/0`,
  `${HUD_ORG}/QUALIFIED_CENSUS_TRACTS/FeatureServer/0`,
];
const DDA_LAYERS = [
  `${HUD_ORG}/Difficult_Development_Areas_2026/FeatureServer/0`,
  `${HUD_ORG}/Difficult_Development_Areas/FeatureServer/0`,
];
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

// Try each candidate layer in order; return the first DEFINITIVE answer (true = inside,
// false = valid count of 0). Only fall through on null (that candidate was unavailable),
// so a real "not designated" is never overridden by a fallback lookup.
async function pointInAny(layers: string[], lon: number, lat: number): Promise<boolean | null> {
  for (const layer of layers) {
    const result = await pointInLayer(layer, lon, lat);
    if (result !== null) return result;
  }
  return null;
}

// Look up HUD QCT/DDA membership at (lat, lon). Returns null only when BOTH queries
// fail (we learned nothing); otherwise a context with per-designation booleans (a
// false is a real negative; a null is "that layer was unavailable across all candidates").
export async function lookupHudDesignations(lat: number, lon: number): Promise<HudDesignations | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const [qct, dda] = await Promise.all([pointInAny(QCT_LAYERS, lon, lat), pointInAny(DDA_LAYERS, lon, lat)]);
  if (qct === null && dda === null) return null;
  return {
    checked_at: new Date().toISOString(),
    source: "HUD (services.arcgis.com)",
    qct,
    dda,
  };
}
