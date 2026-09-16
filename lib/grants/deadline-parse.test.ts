import { describe, it, expect } from "vitest";
import { nextDeadlineFrom } from "./deadline-parse";
import { deadlineDaysLeft, isExpired } from "@/lib/report/shape";

// The guardrail for the free-text deadline parser, locked against the REAL 40-string AR-state
// corpus pulled from prod (grant_monitor_state, 2026-09-16). Each row is the verbatim
// `submission_deadline` and the date `nextDeadlineFrom` must resolve it to — or null. "Today" is
// pinned to 2026-09-16 so the future/past split is deterministic and never a time-bomb.
//
// The whole safety mechanism is the parses-vs-null column: every rolling / undated string → null
// (no fabricated date), every genuinely-closed string → a PAST date (so it expires), and a
// multi-date / open-then-deadline string → its LATEST-future date (never false-expired at an
// earlier "opens" date). 16 of the 40 resolve to a date, 24 are correctly null.
const TODAY = new Date("2026-09-16T12:00:00Z");
const on = (raw: string): string | null => {
  const d = nextDeadlineFrom(raw, TODAY);
  return d === null ? null : d.toISOString().slice(0, 10);
};

// [title, submission_deadline (verbatim), expected date-or-null]
const CORPUS: Array<[string, string, string | null]> = [
  ["Economic Development Funding", "", null],
  [
    "Recreational Trails Program (RTP)",
    "2026 application cycle closed April 30, 2026 at 4:00 p.m. CDT -- cycle is now closed",
    "2026-04-30", // all-past → latest-past → EXPIRES (the fake-match root)
  ],
  [
    "AmeriCorps State Formula",
    "AmeriCorps State Planning/Operational 2026-2027: CLOSED. 2027-2028 Planning Grant NOFO: TBD Spring 2027. Operational NOFO: Opens 2027, applications due February/March (cycle year TBD). AmeriCorps NCCC Cycle 3: September 17, 2026. AmeriCorps Seniors RSVP FY2027: October 20, 2026 at 5:00 p.m. ET. AmeriCorps VISTA 2026-2027: CLOSED.",
    "2026-10-20", // NCCC Sep 17 + RSVP Oct 20 are the only full dates; bare years ignored
  ],
  ["Specialty Crop Block Grant Program (SCBGP)", "Closed for 2026 funding cycle -- next application period TBD", null],
  [
    "Community Arts Project (CAP) Grant",
    "Currently closed; reopens April 2026. Applications accepted on a rolling basis year-round (apply at least 60 days before event). Funds awarded until depleted.",
    null, // rolling / year-round
  ],
  ["Rural Community Grant Program (RCGP)", "Cycle I: August 13, 2026; Cycle II: March 11, 2027", "2027-03-11"],
  [
    "General Operating Support (GOS)",
    "GOS FY28 Letter of Intent (new or newly returning applicants): December 3, 2026; GOS FY28 Year One application: January 14, 2027; GOS FY28 Years Two and Three application: January 28, 2027",
    "2027-01-28", // latest-future (over-surface past the Dec 3 LOI — the accepted safe cost)
  ],
  [
    "Arkansas Site Development Program",
    "Intent to Apply: September 30, 2026; Full Application: November 6, 2026, 5:00 PM CT",
    "2026-11-06", // the real full-app deadline, not the Sep 30 intent date
  ],
  [
    "County Courthouse Restoration Subgrants",
    "January 27, 2027 (Courthouse Grant application deadline); Letter of Intent period opens September 14, 2026; Application period opens November 16, 2026",
    "2027-01-27", // the deadline, NOT the earlier Nov 16 "opens" date — the anti-false-expire proof
  ],
  [
    "Historic Preservation Restoration Grant (HPRG)",
    "March 3, 2027 (Historic Preservation Restoration Grant application deadline); Letter of Intent period opens September 14, 2026; Application period opens November 16, 2026",
    "2027-03-03",
  ],
  ["Naloxone Community Hero Project", "No deadline -- funding opportunities through ARORP are ongoing", null],
  [
    "ARORP General Settlement Application",
    "No deadline for the General Application (rolling/open); COPE deadline was March 2023 and LCS deadline was April 2024 - both closed",
    null, // "no deadline" / rolling short-circuits; the historical month-year notes carry no day anyway
  ],
  ["State Airport Aid Program", "Not available - source page could not be read", null],
  [
    "Emergency Solutions Grant Program (ESG)",
    "Not explicitly stated; application documents reference SF-424 Form 11.30.25 -- verify via ADFA Programs Portal",
    null, // "11.30.25" is a 2-digit-year dotted form → not a candidate (strict-cost, re-fetch cohort)
  ],
  ["Arkansas Unpaved Roads Program (AURP)", "Not extracted -- full program page not available at seed time", null],
  ["Rural Health Grant Programs", "Not specified -- full NOFO not yet posted or not included in source text", null],
  [
    "OSD Workforce Training Grants",
    "Not specified -- rolling application process indicated ('Apply Now' portal); verify with OSD directly",
    null,
  ],
  ["Firewise USA Grants", "Not specified – full NOFO not yet confirmed available", null],
  [
    "Certified Local Government (CLG) Grant",
    "Not specified (CLG grant-specific deadline not provided in source text; Courthouse and Historic Preservation Restoration Grant deadlines listed separately)",
    null,
  ],
  ["Community Fire Prevention Grant Program", "Not specified in source text", null],
  ["Justice Assistance Grants (JAG): Local Law Enforcement", "Not specified in source text", null],
  [
    "Wildland Fire Suppression Kits / VFA Support",
    "Not specified in source text – see press release dated August 19, 2026 noting deadline extended for Forestry Cost-Share Programs; confirm live program page for current deadline",
    null, // leading "Not specified" short-circuits so the Aug 19 press-release date is NOT read as a deadline
  ],
  ["Business & Technology Accelerator Grant", "Not stated -- no deadline published in source text", null],
  ["PSAP Maintenance Reimbursements & Support", "Not stated — no open NOFO or application deadline cited in source text", null],
  ["Conservation District Grant Program", "Not stated in source text", null],
  ["Act 833 Fire Protection Grant Program", "Not stated in source text — verify via Fire Services Portal at dps.arkansas.gov", null],
  [
    "State Aid City Street Program",
    "Not stated; requests accepted on a rolling annual basis (one per city per calendar year)",
    null,
  ],
  ["Arkansas Community and Economic Development Program (ACEDP) / CDBG", "October 16, 2026 at 4:30 PM (2026 Program Year)", "2026-10-16"],
  ["Arts on Tour Grant", "Ongoing (rolling deadline)", null],
  [
    "Main Street Arkansas Grants (Public Art + Downtown)",
    "Public Art Grant: October 15, 2026; Downtown Revitalization Grant: Not stated",
    "2026-10-15", // a MIDDLE "Not stated" does not short-circuit a real leading date
  ],
  [
    "Curtis H. Sykes Memorial Grant Program",
    "Quarterly deadlines: January 2, April 2, July 2, October 2 (year not specified -- verify current cycle)",
    null, // month-day with no year → no candidate → null (no fabricated date)
  ],
  ["Intersection Improvement Program (IIP)", "Rolling", null],
  ["Transportation Research & Workforce Development Grants", "Unknown -- full NOFO not yet retrieved", null],
  ["Arkansas Port, Intermodal, and Waterway Development", "August 15, 2025, 11:59 PM CST", "2025-08-15"],
  ["Arkansas Minority Health Commission Mini-Grants", "Friday, April 24, 2026", "2026-04-24"],
  ["Arkansas Community Assistance Grant Program (CAGP)", "August 15, 2026", "2026-08-15"],
  ["FUN Park Grants", "August 28, 2026", "2026-08-28"],
  ["Matching Grants – Outdoor Recreation", "August 28, 2026", "2026-08-28"],
  ["Main Street Arkansas Public Art Grant Program", "2026-10-15", "2026-10-15"],
  ["Rural Services Block Grant Program (RSBGP)", "October 16, 2026 (Fiscal Year 2027 cycle)", "2026-10-16"],
];

describe("nextDeadlineFrom — real 40-string AR-state corpus (today 2026-09-16, strict, latest-future)", () => {
  it.each(CORPUS)("%s", (_title, submissionDeadline, expected) => {
    expect(on(submissionDeadline)).toBe(expected);
  });

  it("resolves exactly 16 to a date and 24 to null (the confirmed parse split)", () => {
    const resolved = CORPUS.filter(([, sd]) => nextDeadlineFrom(sd, TODAY) !== null);
    expect(resolved).toHaveLength(16);
    expect(CORPUS.length - resolved.length).toBe(24);
  });

  it("every rolling / placeholder / undated string → null (no fabricated date — the guardrail)", () => {
    const nulls = CORPUS.filter(([, , expected]) => expected === null);
    for (const [title, sd] of nulls) {
      expect(nextDeadlineFrom(sd, TODAY), title).toBeNull();
    }
  });

  it("every string that resolves to a PAST date is a genuinely-closed grant that must expire", () => {
    const past = CORPUS.filter(([, sd]) => {
      const d = nextDeadlineFrom(sd, TODAY);
      return d !== null && d.getTime() < TODAY.getTime();
    }).map(([title]) => title);
    // The six confirmed already-closed grants — RTP is the fake-match root.
    expect(past).toEqual([
      "Recreational Trails Program (RTP)",
      "Arkansas Port, Intermodal, and Waterway Development",
      "Arkansas Minority Health Commission Mini-Grants",
      "Arkansas Community Assistance Grant Program (CAGP)",
      "FUN Park Grants",
      "Matching Grants – Outdoor Recreation",
    ]);
  });
});

describe("nextDeadlineFrom — latest-future-else-latest-past semantics", () => {
  it("with multiple future dates, returns the LATEST (never false-expires at an earlier open date)", () => {
    // The County Courthouse shape: an "opens" date earlier than the real deadline.
    expect(on("Application period opens November 16, 2026; deadline January 27, 2027")).toBe("2027-01-27");
  });

  it("prefers any future date over a past one (a live cycle keeps the grant surfaced)", () => {
    expect(on("Cycle I: August 13, 2026; Cycle II: March 11, 2027")).toBe("2027-03-11");
  });

  it("with all dates past, returns the LATEST past (so it reads as expired, not immortal)", () => {
    expect(on("Round 1: January 5, 2020; Round 2: March 9, 2021")).toBe("2021-03-09");
  });

  it("a deadline due TODAY resolves to today (>= today counts as still-open, days-left 0)", () => {
    expect(on("Applications due September 16, 2026")).toBe("2026-09-16");
  });
});

describe("nextDeadlineFrom — date-format coverage", () => {
  it("ISO YYYY-MM-DD", () => expect(on("2027-01-05")).toBe("2027-01-05"));
  it("Month D, YYYY", () => expect(on("Applications due January 5, 2027")).toBe("2027-01-05"));
  it("Month D YYYY (no comma)", () => expect(on("due January 5 2027")).toBe("2027-01-05"));
  it("abbreviated month + optional period", () => {
    expect(on("Sep 30, 2026")).toBe("2026-09-30");
    expect(on("Sept. 30, 2026")).toBe("2026-09-30");
  });
  it("ordinal suffix", () => expect(on("November 6th, 2026")).toBe("2026-11-06"));
  it("numeric M/D/YYYY (slash, 4-digit year)", () => expect(on("Due 10/16/2026")).toBe("2026-10-16"));
  it("day-of-week prefix does not interfere", () => expect(on("Friday, April 24, 2026")).toBe("2026-04-24"));
});

describe("nextDeadlineFrom — never fabricates (strict allowlist)", () => {
  it("month + year with NO day → null (would have to invent a day)", () => {
    expect(on("Reopens April 2026")).toBeNull();
    expect(on("Cycle opens Spring 2027")).toBeNull();
  });
  it("bare year → null", () => expect(on("2026 program year")).toBeNull());
  it("2-digit year → null (never assumed to be 20xx)", () => expect(on("Form due 11.30.25")).toBeNull());
  it("rollover / out-of-range dates are rejected → null", () => {
    expect(on("February 30, 2026")).toBeNull();
    expect(on("13/40/2026")).toBeNull();
  });
  it("empty / whitespace → null", () => {
    expect(on("")).toBeNull();
    expect(on("   ")).toBeNull();
  });
});

describe("nextDeadlineFrom — rolling/placeholder short-circuit runs BEFORE date extraction", () => {
  it("a rolling note with an embedded date → null (rolling wins)", () => {
    expect(on("Rolling; next review January 5, 2099")).toBeNull();
  });
  it("a leading placeholder with a non-deadline date → null (the press-release case)", () => {
    expect(on("Not specified — see press release dated August 19, 2026")).toBeNull();
  });
  it("a placeholder in the MIDDLE does NOT suppress a real leading date", () => {
    expect(on("Public Art Grant: October 15, 2026; Downtown Grant: Not stated")).toBe("2026-10-15");
  });
});

// The Phase-1 wiring: shape.ts's deadlineDaysLeft / isExpired now read this parser, so the four
// expiry gates inherit it. These use the real clock, so they assert only far-dated (time-stable) cases.
describe("deadlineDaysLeft / isExpired delegate to nextDeadlineFrom", () => {
  it("a prose-embedded PAST date now expires (the old new Date() returned null → never expired)", () => {
    expect(isExpired("2026 application cycle closed April 30, 2000 at 4:00 p.m. CDT")).toBe(true);
  });
  it("a trailing-time string now parses (the old new Date() choked on 'at 5:00 PM')", () => {
    expect(deadlineDaysLeft("December 31, 2099 at 5:00 PM CT")).toBeGreaterThan(0);
  });
  it("a multi-cycle string with a live future cycle is NOT expired", () => {
    expect(isExpired("Cycle I: August 13, 2098; Cycle II: March 11, 2099")).toBe(false);
  });
  it("rolling / quarterly-no-year stay null → never expired", () => {
    expect(deadlineDaysLeft("Rolling")).toBeNull();
    expect(isExpired("Quarterly deadlines: January 2, April 2, July 2, October 2 (year not specified)")).toBe(false);
  });
});
