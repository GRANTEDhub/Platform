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
