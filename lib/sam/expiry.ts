import { differenceInCalendarDays, parseISO } from "date-fns";

// Derive the SAM registration expiry state at READ time from sam_expiration_date
// -- no stored "expired" flag, no cron (same derived-state pattern as the
// forecasted label and the client-first gate). Null date (never resolved) or a
// registration more than 30 days out yields null: the dashboard shows nothing.

export interface SamExpiryFlag {
  level: "expired" | "soon";
  label: string;
}

const SOON_DAYS = 30;

export function samExpiryFlag(
  expirationDate: string | null | undefined,
  now: Date = new Date(),
): SamExpiryFlag | null {
  if (!expirationDate) return null;
  let days: number;
  try {
    days = differenceInCalendarDays(parseISO(expirationDate), now);
  } catch {
    return null; // unparseable date -> no flag rather than a crash
  }
  if (days < 0) return { level: "expired", label: "SAM registration EXPIRED" };
  if (days <= SOON_DAYS) {
    return {
      level: "soon",
      label: days === 0 ? "SAM registration expires today" : `SAM expires in ${days} day${days === 1 ? "" : "s"}`,
    };
  }
  return null;
}

// One-line SAM readiness string for the matcher prompt. Built from the STRUCTURED
// SAM fields (sam_registration_status + sam_expiration_date written by the bind
// flow), falling back to the legacy free-text sam_uei_status, then "not verified"
// -- fail-closed so an unbound client reads exactly as it does today. Surfaces the
// raw expiration + a day count and lets the scorer apply its OWN "< 60 days" flag
// rule; deliberately NOT the dashboard's 30-day SOON_DAYS cutoff above.
export function formatSamForMatcher(
  client: {
    sam_registration_status?: string | null;
    sam_expiration_date?: string | null;
    sam_uei_status?: string | null;
  },
  now: Date = new Date(),
): string {
  const status = client.sam_registration_status?.trim();
  const exp = client.sam_expiration_date?.trim();
  if (status || exp) {
    const parts: string[] = [];
    if (status) parts.push(status);
    if (exp) {
      let days: number | null = null;
      try {
        days = differenceInCalendarDays(parseISO(exp), now);
      } catch {
        days = null;
      }
      if (days === null) parts.push(`expires ${exp}`);
      else if (days < 0) parts.push(`EXPIRED ${exp} (${-days} day${days === -1 ? "" : "s"} ago)`);
      else parts.push(`expires ${exp} (in ${days} day${days === 1 ? "" : "s"})`);
    }
    return `SAM: ${parts.join(", ")}`;
  }
  const legacy = client.sam_uei_status?.trim();
  if (legacy) return `SAM/UEI (manual note): ${legacy}`;
  return "SAM: not verified";
}
