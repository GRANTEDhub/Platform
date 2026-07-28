import type { ShortageContext, ShortageDesignation } from "@/types/database";

// ── HRSA shortage-area overlay (keyless ArcGIS map services) ─────────────────
// Given a geocoded point (from the Census geocoder in lib/geo/census.ts), answer
// "does the org's address fall inside a federally-designated shortage area?" via
// point-in-polygon queries against HRSA's public ArcGIS layers. No API key.
//
// This is a NEED / ELIGIBILITY signal for the enrichment narrative only -- it feeds
// enrichMatchWithProfile (why-this-org / concept / draft-email), which is structurally
// isolated from occupancy, so it can never move a seat. Fail-safe throughout: any
// failure (network, timeout, shape change, bad point) degrades to null / empty, and
// enrichment simply omits the section -- it never throws into the caller.
//
// HPSA = Health Professional Shortage Area (carries a 0-26 HPSA_SCORE, the key
// competitiveness signal). MUA/MUP = Medically Underserved Area / Population (no score
// on the layer; presence is the signal). We query the per-discipline HPSA COMPONENT
// polygon layers (the precise designated geographies) and the MUA perimeter layer.

const HPSA_BASE =
  "https://gisportal.hrsa.gov/server/rest/services/Shortage/HealthProfessionalShortageAreas_FS/MapServer";
const MUA_BASE =
  "https://gisportal.hrsa.gov/server/rest/services/Shortage/MedicallyUnderservedAreas_FS/MapServer";

// Component-polygon layer id -> discipline (verified against the live MapServer).
const HPSA_LAYERS: ReadonlyArray<{ layer: number; discipline: string }> = [
  { layer: 11, discipline: "Primary Care" },
  { layer: 3, discipline: "Dental Health" },
  { layer: 7, discipline: "Mental Health" },
];

// The only "live" status; the other observed value is "Proposed For Withdrawal", which
// is not a current designation and must be excluded.
const DESIGNATED = "Designated";
const TIMEOUT_MS = 8000;

function pointQueryUrl(base: string, layer: number, lon: number, lat: number, outFields: string): string {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    returnGeometry: "false",
    f: "json",
  });
  return `${base}/${layer}/query?${params.toString()}`;
}

// Timeout-bounded, never-throws fetch of an ArcGIS /query feature list.
async function queryFeatures(url: string): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: Array<{ attributes?: Record<string, unknown> }> };
    return (data.features ?? []).map((f) => f.attributes ?? {});
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Point-in-polygon lookup of federal shortage-area designations at (lat, lon).
// Returns null only on a bad point; otherwise a context whose `designations` array is
// empty when the point is in none (a real negative signal, distinct from "not checked").
export async function lookupShortageAreas(lat: number, lon: number): Promise<ShortageContext | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const hpsaJobs = HPSA_LAYERS.map(async ({ layer, discipline }) => {
    const rows = await queryFeatures(
      pointQueryUrl(HPSA_BASE, layer, lon, lat, "HPSA_STATUS_DESC,HPSA_SCORE,HPSA_POPULATION_TYP_DESC"),
    );
    const found: ShortageDesignation[] = [];
    for (const a of rows) {
      if (String(a["HPSA_STATUS_DESC"]) !== DESIGNATED) continue;
      const score = Number(a["HPSA_SCORE"]);
      found.push({
        program: "HPSA",
        discipline,
        score: Number.isFinite(score) ? score : null,
        population_type: a["HPSA_POPULATION_TYP_DESC"] != null ? String(a["HPSA_POPULATION_TYP_DESC"]) : null,
        name: null,
        status: DESIGNATED,
      });
    }
    // Overlapping components can hit one point; keep the single highest-scoring per discipline.
    if (found.length <= 1) return found;
    found.sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
    return [found[0]];
  });

  const muaJob = (async () => {
    const rows = await queryFeatures(
      pointQueryUrl(MUA_BASE, 0, lon, lat, "DESIGNATION_TYPE_DESCRIPTION,STATUS_DESCRIPTION,SERVICE_AREA_NAME"),
    );
    const found: ShortageDesignation[] = [];
    const seen = new Set<string>();
    for (const a of rows) {
      if (String(a["STATUS_DESCRIPTION"]) !== DESIGNATED) continue;
      const typeDesc = String(a["DESIGNATION_TYPE_DESCRIPTION"] ?? "");
      const program: ShortageDesignation["program"] = /population/i.test(typeDesc) ? "MUP" : "MUA";
      const name = a["SERVICE_AREA_NAME"] != null ? String(a["SERVICE_AREA_NAME"]) : null;
      const key = `${program}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ program, discipline: null, score: null, population_type: null, name, status: DESIGNATED });
    }
    return found;
  })();

  const groups = await Promise.all([...hpsaJobs, muaJob]);
  return {
    checked_at: new Date().toISOString(),
    source: "HRSA (data.hrsa.gov ArcGIS)",
    designations: groups.flat(),
  };
}
