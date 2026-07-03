// SAM.gov Entity Management API wrapper (build 1: resolve at intake).
//
// Server-side ONLY: reads SAM_API_KEY from env and must never be imported into a
// client component (the key would ship to the browser). Pulls only PUBLIC
// registration fields -- UEI, legal name, status, expiration, physical city/state.
// Deliberately no POCs, no financials, no email harvesting.
//
// Field paths follow the documented v3 entity API shape. I could not exercise the
// live API from the build sandbox, so the normalization tolerates missing
// sections (e.g. coreData/physicalAddress not returned for this key's role): a
// candidate still resolves on registration fields alone, and city/state simply
// render blank. Verify the exact paths against a real response on preview.

const SAM_ENDPOINT = "https://api.sam.gov/entity-information/v3/entities";
const TIMEOUT_MS = 10_000;
const MAX_CANDIDATES = 4; // best guess + next 3

export interface SamEntity {
  uei: string;
  legalName: string;
  city: string | null;
  state: string | null;
  status: string | null; // registrationStatus (Active / Expired / Submitted / ...)
  expirationDate: string | null; // ISO YYYY-MM-DD
}

export type SamErrorCode = "config" | "rate_limit" | "bad_request" | "upstream";

export class SamError extends Error {
  code: SamErrorCode;
  constructor(message: string, code: SamErrorCode) {
    super(message);
    this.code = code;
  }
}

// A UEI is 12 alphanumeric characters, excluding the letters I and O (SAM omits
// them to avoid visual ambiguity). Cheap guard before spending an API call.
const UEI_RE = /^[A-HJ-NP-Z0-9]{12}$/;
export function isValidUei(uei: string): boolean {
  return UEI_RE.test(uei.trim().toUpperCase());
}

// SAM returns registrationExpirationDate as ISO in v3, but normalize MM/DD/YYYY
// defensively so a date column insert never fails on a format surprise.
function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}

function normalize(raw: unknown): SamEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, any>;
  const reg = e.entityRegistration ?? {};
  const addr = e.coreData?.physicalAddress ?? {};
  const uei = typeof reg.ueiSAM === "string" ? reg.ueiSAM : null;
  const legalName = typeof reg.legalBusinessName === "string" ? reg.legalBusinessName : null;
  if (!uei || !legalName) return null; // can't confirm/bind without these
  return {
    uei,
    legalName,
    status: typeof reg.registrationStatus === "string" ? reg.registrationStatus : null,
    expirationDate: toIsoDate(reg.registrationExpirationDate),
    city: typeof addr.city === "string" ? addr.city : null,
    state: typeof addr.stateOrProvinceCode === "string" ? addr.stateOrProvinceCode : null,
  };
}

async function samFetch(params: Record<string, string>): Promise<SamEntity[]> {
  const key = process.env.SAM_API_KEY;
  if (!key) throw new SamError("SAM_API_KEY is not configured.", "config");

  const url = new URL(SAM_ENDPOINT);
  url.searchParams.set("api_key", key);
  url.searchParams.set("includeSections", "entityRegistration,coreData");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch {
    throw new SamError("SAM.gov did not respond (timeout or network error).", "upstream");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new SamError("SAM.gov rate limit reached. Try again shortly.", "rate_limit");
  }
  if (!res.ok) {
    throw new SamError(`SAM.gov returned ${res.status}.`, "upstream");
  }

  const json = (await res.json().catch(() => null)) as { entityData?: unknown[] } | null;
  const rows = Array.isArray(json?.entityData) ? json!.entityData! : [];
  return rows.map(normalize).filter((e): e is SamEntity => e !== null);
}

// Direct lookup by UEI -- the authoritative path. Used by both "confirm a
// candidate" and "paste a UEI manually"; bind always re-resolves through here so
// the stored fields are SAM's, never client-posted values.
export async function lookupByUei(uei: string): Promise<SamEntity | null> {
  const clean = uei.trim().toUpperCase();
  if (!isValidUei(clean)) throw new SamError("That is not a valid UEI.", "bad_request");
  const results = await samFetch({ ueiSAM: clean });
  return results[0] ?? null;
}

// Name + state search for the best-guess flow. Name matching is unreliable
// (legal vs common names, suffixes), which is exactly why the caller confirms;
// state narrows the field. Zero results is normal (org not SAM-registered).
export async function searchByNameState(
  name: string,
  state: string | null | undefined,
  city: string | null | undefined,
): Promise<SamEntity[]> {
  const params: Record<string, string> = {
    legalBusinessName: name,
    registrationStatus: "A", // active-first best guess; deny surfaces the rest
    page: "0",
    size: String(MAX_CANDIDATES),
  };
  if (state && state.trim()) params.physicalAddressProvinceOrStateCode = state.trim();
  if (city && city.trim()) params.physicalAddressCity = city.trim();

  let results = await samFetch(params);
  // If the active-only, state-scoped guess is empty, widen once (drop the status
  // filter) before giving up -- a registration can be Expired/Submitted and still
  // be the org we want to flag.
  if (results.length === 0) {
    delete params.registrationStatus;
    results = await samFetch(params);
  }
  return results.slice(0, MAX_CANDIDATES);
}
