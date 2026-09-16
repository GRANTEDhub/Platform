// The ONE deterministic parser for the free-text `submission_deadline` field.
//
// WHY THIS EXISTS: `submission_deadline` is prose the shred captures verbatim — a single date,
// a multi-cycle list ("Cycle I: August 13, 2026; Cycle II: March 11, 2027"), an open-then-deadline
// sequence ("app opens November 16, 2026; deadline January 27, 2027"), or a rolling / undated note.
// A naive `new Date(s)` chokes on all but the cleanest single date (it returns Invalid Date on
// "October 16, 2026 at 4:30 PM …", on every multi-date string, on every prose note), so every expiry
// gate that reads this field via `deadlineDaysLeft` (shape.ts) silently saw `null` and never expired a
// genuinely-closed grant — the AR-state "expired-until-next-year new match" bug. This is the shared
// source of truth those gates now delegate to (isExpired, the closed-sweep, the prospecting filter,
// the Ledger's Expired flag), so free-text is the raw truth and ONE parser is the single derivation.
//
// THE CONTRACT — strict, latest-future-else-latest-past:
//   1. Rolling / placeholder families short-circuit to null FIRST, before any date is read (the
//      ROLLING_DEADLINE / DEADLINE_PLACEHOLDER families defined here and reused by the format.ts tile).
//      So a non-deadline date sitting inside such a note — a press-release date in "Not specified …
//      see press release dated August 19, 2026" — is never mistaken for a deadline.
//   2. Extract only dates carrying an EXPLICIT 4-digit year (ISO, "Month D, YYYY", or M/D/YYYY). A bare
//      "Month D" / "quarterly" / "Spring 2027" / "April 2026" (month+year, no day) is NOT a candidate —
//      we never fabricate a year or a day. No candidate → null (the grant keeps surfacing; the SAFE
//      failure — staff still sees and passes it, vs. wrongly archiving a live grant).
//   3. Of the candidates, return the LATEST FUTURE date (>= today), else the latest PAST date.
//      LATEST-future, not earliest: an open-then-deadline string ("app opens Nov 16; deadline Jan 27")
//      must stay live until its real DEADLINE (Jan 27), never false-expire at the earlier OPEN date.
//      Over-surfacing (staying live to the last date) is the safe direction; false-expiring a live
//      grant is the destructive error this parser exists to prevent.
//
// Re-derived on every READ (never cached), so a multi-cycle grant's "next deadline" advances on its own
// as cycles pass — there is no stale snapshot for the hourly closed-sweep to auto-archive a live cycle on.
//
// Deterministic + fully unit-tested against the real 40-string AR-state corpus (deadline-parse.test.ts).

import { format } from "date-fns";

// The "no fixed date" families — the single source of truth for what counts as an unstated / rolling
// deadline. Defined here (next to the parser that gates on them) and imported by the format.ts display
// tiles, so the expiry parser and every deadline tile agree on "no date". A leading match is enough for
// the placeholder family ("Not available - verify at …" → the trailing note is where-to-look guidance).
export const DEADLINE_PLACEHOLDER =
  /^(?:not\s+(?:stated|available|specified|listed|given|provided|posted)|unspecified|unknown|undetermined|to\s+be\s+determined|tbd|n\/?a|none)\b/i;
// The rolling/continuous family — a real intake with no single fixed date.
export const ROLLING_DEADLINE =
  /\b(?:rolling|continuous(?:ly)?|ongoing|year[-\s]?round|open[-\s]?until[-\s]?filled|accepted\s+(?:on\s+a\s+)?rolling|no\s+(?:fixed\s+)?deadline)\b/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "Month D, YYYY" — full or 3+-letter month name, optional trailing "." (Sept.), optional ordinal
// (3rd), optional comma, then a 4-digit year. A month+year with NO day ("April 2026") does NOT match:
// after the day digits the pattern requires whitespace before the year, which "April 2026" lacks.
const MONTH_NAME_DATE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
// ISO YYYY-MM-DD, optionally the date half of a full ISO timestamp ("2026-09-11T14:39:55Z"). The
// trailing `(?!\d)` (not `\b`) is load-bearing: a `\b` fails between the day and the "T" of a
// timestamp (both non-boundary word chars), so the date half of a `toISOString()` value — how
// Postgres/`daysFromNow` and many federal feeds emit a deadline — would otherwise slip to null.
// `(?!\d)` still rejects a longer digit run ("2026-09-113"). The 4-digit-year-first shape can't
// collide with the numeric M/D/YYYY form below.
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
// Numeric M/D/YYYY — slash-separated, 4-digit year required (so "11.30.25", a dotted 2-digit-year
// form, is correctly NOT a candidate — the ESG strict-cost case that falls to the re-fetch cohort).
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

// A calendar date built at UTC midnight, or null when the numbers don't form a real date — the
// round-trip check rejects a rollover fabrication ("February 30" → Mar 2) rather than accept it.
function utcDate(year: number, month0: number, day: number): Date | null {
  if (month0 < 0 || month0 > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month0, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month0 || d.getUTCDate() !== day) return null;
  return d;
}

// Every explicit-year date in the string, as UTC-midnight Dates. matchAll clones the /g regex
// internally, so the module-level patterns carry no cross-call lastIndex state.
function extractDates(s: string): Date[] {
  const out: Date[] = [];
  for (const m of s.matchAll(ISO_DATE)) {
    const d = utcDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d) out.push(d);
  }
  for (const m of s.matchAll(MONTH_NAME_DATE)) {
    const d = utcDate(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]));
    if (d) out.push(d);
  }
  for (const m of s.matchAll(NUMERIC_DATE)) {
    const d = utcDate(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    if (d) out.push(d);
  }
  return out;
}

// The next-upcoming deadline in the free text (latest-future-else-latest-past), or null when the text
// is rolling / placeholder / undated / carries no explicit-year date. `now` is injectable for
// deterministic tests; defaults to the current time. Returns a UTC-midnight Date so a due-TODAY grant
// reads as 0 days left (not yet expired), matching isExpired's "today is still winnable" boundary.
export function nextDeadlineFrom(raw: string | null | undefined, now: Date = new Date()): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // "No fixed date" families → null before reading any date, so a non-deadline date inside such a note
  // (a press-release date, a historical closed-cycle date) can't be mistaken for the deadline.
  if (ROLLING_DEADLINE.test(s) || DEADLINE_PLACEHOLDER.test(s)) return null;
  const dates = extractDates(s);
  if (dates.length === 0) return null;
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const future = dates.filter((d) => d.getTime() >= todayStart);
  const pool = future.length > 0 ? future : dates;
  return pool.reduce((latest, d) => (d.getTime() > latest.getTime() ? d : latest));
}

// The DISPLAY sibling of nextDeadlineFrom: format the resolved deadline in a date-fns pattern, or null
// when the text has no resolvable explicit-year date. Phase 1 unified deadline EXPIRY on nextDeadlineFrom
// but left the label formatters on a naive `new Date(prose)`, so a multi-cycle / prose-with-a-date string
// showed "Not stated" / raw prose while the same page's countdown (deadlineDaysLeft) read "Closed N days
// ago" — the split this closes. Reads the parser's UTC-midnight date as a CALENDAR date (a LOCAL date
// built from its UTC y/m/d) so the label is timezone-stable: no west-of-UTC off-by-one (the same guard
// formatDeadlineCompact documents — `new Date("2026-09-15")` is UTC midnight and renders as the previous
// day west of UTC when `format` uses local time).
export function formatResolvedDeadline(raw: string | null | undefined, pattern: string): string | null {
  const d = nextDeadlineFrom(raw);
  if (!d) return null;
  return format(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), pattern);
}

// The value for the review-console DEADLINE facts tile (staff roadmap + client portal). A resolvable
// deadline → its date ("Apr 30, 2026"); a rolling/continuous intake → "Rolling"; anything else (undated /
// placeholder / unreadable prose) → "Not stated". NEVER the raw prose — the gap that let a closed AR grant
// render "Not stated" beside its own "Closed 139 days ago". Full-month-less "MMM d, yyyy" fits the tile.
export function formatDeadlineTile(raw: string | null | undefined): string {
  const resolved = formatResolvedDeadline(raw, "MMM d, yyyy");
  if (resolved) return resolved;
  const s = (raw ?? "").trim();
  if (s && ROLLING_DEADLINE.test(s)) return "Rolling";
  return "Not stated";
}
