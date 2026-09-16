import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resolveBackfill,
  applyDeadlineBackfill,
  runDeadlineBackfill,
  deadlineBackfillEnabled,
  type BackfillGrantRow,
} from "./deadline-backfill";

// "Today" pinned so the past/future split is deterministic and never a time-bomb (same clock as the
// Phase-1 parser corpus).
const TODAY = new Date("2026-09-16T12:00:00Z");

// The REAL 40-string AR-state corpus (verbatim submission_deadline), the same set Phase 1 locks. Here
// each is modeled as a null-deadline grant row so we prove the backfill classifier reproduces Phase
// 1's exact split: 16 resolve to a date (would-write), 24 stay null (the guardrail — never fabricated,
// never clobbered), 6 of the 16 are PAST (the fake-match fixes that drop out of the pool).
const AR_CORPUS: Array<[string, string]> = [
  ["Economic Development Funding", ""],
  ["Recreational Trails Program (RTP)", "2026 application cycle closed April 30, 2026 at 4:00 p.m. CDT -- cycle is now closed"],
  [
    "AmeriCorps State Formula",
    "AmeriCorps State Planning/Operational 2026-2027: CLOSED. 2027-2028 Planning Grant NOFO: TBD Spring 2027. Operational NOFO: Opens 2027, applications due February/March (cycle year TBD). AmeriCorps NCCC Cycle 3: September 17, 2026. AmeriCorps Seniors RSVP FY2027: October 20, 2026 at 5:00 p.m. ET. AmeriCorps VISTA 2026-2027: CLOSED.",
  ],
  ["Specialty Crop Block Grant Program (SCBGP)", "Closed for 2026 funding cycle -- next application period TBD"],
  ["Community Arts Project (CAP) Grant", "Currently closed; reopens April 2026. Applications accepted on a rolling basis year-round (apply at least 60 days before event). Funds awarded until depleted."],
  ["Rural Community Grant Program (RCGP)", "Cycle I: August 13, 2026; Cycle II: March 11, 2027"],
  ["General Operating Support (GOS)", "GOS FY28 Letter of Intent (new or newly returning applicants): December 3, 2026; GOS FY28 Year One application: January 14, 2027; GOS FY28 Years Two and Three application: January 28, 2027"],
  ["Arkansas Site Development Program", "Intent to Apply: September 30, 2026; Full Application: November 6, 2026, 5:00 PM CT"],
  ["County Courthouse Restoration Subgrants", "January 27, 2027 (Courthouse Grant application deadline); Letter of Intent period opens September 14, 2026; Application period opens November 16, 2026"],
  ["Historic Preservation Restoration Grant (HPRG)", "March 3, 2027 (Historic Preservation Restoration Grant application deadline); Letter of Intent period opens September 14, 2026; Application period opens November 16, 2026"],
  ["Naloxone Community Hero Project", "No deadline -- funding opportunities through ARORP are ongoing"],
  ["ARORP General Settlement Application", "No deadline for the General Application (rolling/open); COPE deadline was March 2023 and LCS deadline was April 2024 - both closed"],
  ["State Airport Aid Program", "Not available - source page could not be read"],
  ["Emergency Solutions Grant Program (ESG)", "Not explicitly stated; application documents reference SF-424 Form 11.30.25 -- verify via ADFA Programs Portal"],
  ["Arkansas Unpaved Roads Program (AURP)", "Not extracted -- full program page not available at seed time"],
  ["Rural Health Grant Programs", "Not specified -- full NOFO not yet posted or not included in source text"],
  ["OSD Workforce Training Grants", "Not specified -- rolling application process indicated ('Apply Now' portal); verify with OSD directly"],
  ["Firewise USA Grants", "Not specified – full NOFO not yet confirmed available"],
  ["Certified Local Government (CLG) Grant", "Not specified (CLG grant-specific deadline not provided in source text; Courthouse and Historic Preservation Restoration Grant deadlines listed separately)"],
  ["Community Fire Prevention Grant Program", "Not specified in source text"],
  ["Justice Assistance Grants (JAG): Local Law Enforcement", "Not specified in source text"],
  ["Wildland Fire Suppression Kits / VFA Support", "Not specified in source text – see press release dated August 19, 2026 noting deadline extended for Forestry Cost-Share Programs; confirm live program page for current deadline"],
  ["Business & Technology Accelerator Grant", "Not stated -- no deadline published in source text"],
  ["PSAP Maintenance Reimbursements & Support", "Not stated — no open NOFO or application deadline cited in source text"],
  ["Conservation District Grant Program", "Not stated in source text"],
  ["Act 833 Fire Protection Grant Program", "Not stated in source text — verify via Fire Services Portal at dps.arkansas.gov"],
  ["State Aid City Street Program", "Not stated; requests accepted on a rolling annual basis (one per city per calendar year)"],
  ["Arkansas Community and Economic Development Program (ACEDP) / CDBG", "October 16, 2026 at 4:30 PM (2026 Program Year)"],
  ["Arts on Tour Grant", "Ongoing (rolling deadline)"],
  ["Main Street Arkansas Grants (Public Art + Downtown)", "Public Art Grant: October 15, 2026; Downtown Revitalization Grant: Not stated"],
  ["Curtis H. Sykes Memorial Grant Program", "Quarterly deadlines: January 2, April 2, July 2, October 2 (year not specified -- verify current cycle)"],
  ["Intersection Improvement Program (IIP)", "Rolling"],
  ["Transportation Research & Workforce Development Grants", "Unknown -- full NOFO not yet retrieved"],
  ["Arkansas Port, Intermodal, and Waterway Development", "August 15, 2025, 11:59 PM CST"],
  ["Arkansas Minority Health Commission Mini-Grants", "Friday, April 24, 2026"],
  ["Arkansas Community Assistance Grant Program (CAGP)", "August 15, 2026"],
  ["FUN Park Grants", "August 28, 2026"],
  ["Matching Grants – Outdoor Recreation", "August 28, 2026"],
  ["Main Street Arkansas Public Art Grant Program", "2026-10-15"],
  ["Rural Services Block Grant Program (RSBGP)", "October 16, 2026 (Fiscal Year 2027 cycle)"],
];

const asNullRows = (): BackfillGrantRow[] =>
  AR_CORPUS.map(([title, sd], i) => ({ id: `g${String(i).padStart(3, "0")}`, title, submission_deadline: sd, deadline: null }));

// ---- A minimal chainable fake of the service-role Supabase client ---------------------------------
// Supports the two query shapes the sweep uses:
//   read:   from("grants").select(cols).is("deadline", null).order("id",…).range(f,t)   → { data, error }
//   update: from("grants").update({deadline}).eq("id", id).is("deadline", null).select("id") → { data, error }
// The `is("deadline", null)` guard on the update is honored (a row whose deadline is non-null at write
// time updates ZERO rows), so the optimistic-concurrency / null-clobber guard is actually exercised.
function makeFakeDb(store: BackfillGrantRow[], opts: { failOn?: string } = {}) {
  function makeQuery() {
    const b: any = { _op: null, _isNull: [] as string[], _eqId: null as string | null, _range: null as [number, number] | null, _vals: null as any };
    b.select = (_cols?: string) => { if (b._op !== "update") b._op = "read"; return b; };
    b.is = (col: string, val: unknown) => { if (val === null) b._isNull.push(col); return b; };
    b.eq = (col: string, val: string) => { if (col === "id") b._eqId = val; return b; };
    b.update = (vals: any) => { b._op = "update"; b._vals = vals; return b; };
    b.order = () => b;
    b.range = (from: number, to: number) => { b._range = [from, to]; return b; };
    b.then = (resolve: (r: any) => void, reject: (e: any) => void) => {
      try {
        resolve(run());
      } catch (e) {
        reject(e);
      }
    };
    function run() {
      if (b._op === "read") {
        let rows = store.filter((g) => (b._isNull.includes("deadline") ? g.deadline === null : true));
        rows = rows.slice().sort((a, b2) => a.id.localeCompare(b2.id));
        if (b._range) rows = rows.slice(b._range[0], b._range[1] + 1);
        return { data: rows.map((r) => ({ ...r })), error: null };
      }
      if (b._op === "update") {
        if (opts.failOn && b._eqId === opts.failOn) return { data: null, error: { message: "write failed" } };
        const g = store.find((x) => x.id === b._eqId);
        const guardOk = b._isNull.includes("deadline") ? !!g && g.deadline === null : true;
        if (g && guardOk) {
          g.deadline = b._vals.deadline;
          return { data: [{ id: g.id }], error: null };
        }
        return { data: [], error: null }; // guard failed → zero rows updated (not clobbered)
      }
      return { data: [], error: null };
    }
    return b;
  }
  return { from: () => makeQuery() } as any;
}

afterEach(() => {
  delete process.env.DEADLINE_BACKFILL_ENABLED;
  vi.restoreAllMocks();
});

describe("resolveBackfill — the fill-null classifier over the real AR corpus", () => {
  it("reproduces Phase 1's split: 16 resolve to a date, 24 stay null (never fabricated)", () => {
    const candidates = resolveBackfill(asNullRows(), TODAY);
    expect(candidates).toHaveLength(16);
    // 24 correctly produce NO candidate (the guardrail: a rolling/undated string is never written).
    expect(AR_CORPUS.length - candidates.length).toBe(24);
  });

  it("flags exactly the 6 confirmed already-closed grants as PAST (the fake-match fixes)", () => {
    const past = resolveBackfill(asNullRows(), TODAY)
      .filter((c) => c.past)
      .map((c) => c.title);
    expect(past.sort()).toEqual(
      [
        "Recreational Trails Program (RTP)",
        "Arkansas Port, Intermodal, and Waterway Development",
        "Arkansas Minority Health Commission Mini-Grants",
        "Arkansas Community Assistance Grant Program (CAGP)",
        "FUN Park Grants",
        "Matching Grants – Outdoor Recreation",
      ].sort(),
    );
  });

  it("RTP resolves to its real past date — the exact fake-match root", () => {
    const rtp = resolveBackfill(asNullRows(), TODAY).find((c) => c.title === "Recreational Trails Program (RTP)");
    expect(rtp?.resolved).toBe("2026-04-30");
    expect(rtp?.past).toBe(true);
  });

  it("sorts most-past-first so a capped run clears closed grants before future tidy-writes", () => {
    const cands = resolveBackfill(asNullRows(), TODAY);
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i - 1].resolved.localeCompare(cands[i].resolved)).toBeLessThanOrEqual(0);
    }
  });
});

describe("null-clobber guard — a null result is NEVER a candidate, a non-null deadline is NEVER touched", () => {
  it("a rolling/undated string produces no candidate (cannot overwrite a deadline with null)", () => {
    const rows: BackfillGrantRow[] = [
      { id: "a", title: "rolling", submission_deadline: "Rolling", deadline: null },
      { id: "b", title: "undated", submission_deadline: "Not stated in source text", deadline: null },
    ];
    expect(resolveBackfill(rows, TODAY)).toHaveLength(0);
  });

  it("a row that already has a deadline is skipped even if its text resolves (fill-null only)", () => {
    const rows: BackfillGrantRow[] = [
      { id: "a", title: "already dated", submission_deadline: "December 31, 2099", deadline: "2030-01-01" },
    ];
    expect(resolveBackfill(rows, TODAY)).toHaveLength(0);
  });
});

describe("applyDeadlineBackfill — writes the date, re-asserting the null-guard", () => {
  it("fills deadline for each candidate and counts rows actually written", async () => {
    const store: BackfillGrantRow[] = [
      { id: "a", title: "closed", submission_deadline: "April 30, 2026", deadline: null },
      { id: "b", title: "future", submission_deadline: "December 31, 2099", deadline: null },
    ];
    const db = makeFakeDb(store);
    const candidates = resolveBackfill(store, TODAY);
    const written = await applyDeadlineBackfill(db, candidates);
    expect(written).toBe(2);
    expect(store.find((g) => g.id === "a")?.deadline).toBe("2026-04-30");
    expect(store.find((g) => g.id === "b")?.deadline).toBe("2099-12-31");
  });

  it("a row that gained a deadline between scan and write is NOT overwritten (the guard), counted 0", async () => {
    const store: BackfillGrantRow[] = [{ id: "a", title: "raced", submission_deadline: "April 30, 2026", deadline: null }];
    const candidates = resolveBackfill(store, TODAY); // captured while null
    // Simulate a concurrent ingest writing a real date after the scan:
    store[0].deadline = "2026-04-30";
    const db = makeFakeDb(store);
    const written = await applyDeadlineBackfill(db, candidates);
    expect(written).toBe(0); // guard (is deadline null) matched zero rows
    expect(store[0].deadline).toBe("2026-04-30"); // untouched
  });

  it("honors the write cap (most-past-first), leaving the rest for the next run", async () => {
    const store: BackfillGrantRow[] = [
      { id: "a", title: "p1", submission_deadline: "January 5, 2020", deadline: null },
      { id: "b", title: "p2", submission_deadline: "March 9, 2021", deadline: null },
      { id: "c", title: "f1", submission_deadline: "December 31, 2099", deadline: null },
    ];
    const db = makeFakeDb(store);
    const candidates = resolveBackfill(store, TODAY);
    const written = await applyDeadlineBackfill(db, candidates, { limit: 1 });
    expect(written).toBe(1);
    // The single most-past date (2020-01-05) was written; the other two remain null.
    expect(store.find((g) => g.id === "a")?.deadline).toBe("2020-01-05");
    expect(store.filter((g) => g.deadline === null)).toHaveLength(2);
  });

  it("limit 0 writes nothing (safe zero-cap smoke test)", async () => {
    const store: BackfillGrantRow[] = [{ id: "a", title: "x", submission_deadline: "April 30, 2026", deadline: null }];
    const db = makeFakeDb(store);
    const written = await applyDeadlineBackfill(db, resolveBackfill(store, TODAY), { limit: 0 });
    expect(written).toBe(0);
    expect(store[0].deadline).toBeNull();
  });

  it("propagates a DB error rather than silently miscounting", async () => {
    const store: BackfillGrantRow[] = [{ id: "boom", title: "x", submission_deadline: "April 30, 2026", deadline: null }];
    const db = makeFakeDb(store, { failOn: "boom" });
    await expect(applyDeadlineBackfill(db, resolveBackfill(store, TODAY))).rejects.toThrow("write failed");
  });
});

describe("runDeadlineBackfill — the driver (dry-run vs apply, paging)", () => {
  it("dry-run reports the split and writes nothing", async () => {
    const store = asNullRows();
    const db = makeFakeDb(store);
    const result = await runDeadlineBackfill(db, { apply: false, now: TODAY });
    expect(result.scanned).toBe(40);
    expect(result.resolvable).toBe(16);
    expect(result.staleNull).toBe(24);
    expect(result.byDirection.past).toBe(6);
    expect(result.byDirection.future).toBe(10);
    expect(result.written).toBe(0);
    // Nothing mutated.
    expect(store.every((g) => g.deadline === null)).toBe(true);
  });

  it("apply writes the resolvable subset and leaves the 24 null rows null", async () => {
    const store = asNullRows();
    const db = makeFakeDb(store);
    const result = await runDeadlineBackfill(db, { apply: true, now: TODAY });
    expect(result.written).toBe(16);
    expect(result.remaining).toBe(0);
    expect(store.filter((g) => g.deadline !== null)).toHaveLength(16);
    expect(store.filter((g) => g.deadline === null)).toHaveLength(24);
  });

  it("pages the scan to completeness (a small page size still sees every null row)", async () => {
    const store = asNullRows();
    const db = makeFakeDb(store);
    const result = await runDeadlineBackfill(db, { apply: false, now: TODAY, pageSize: 7 });
    expect(result.scanned).toBe(40); // 6 pages of 7 + a short final page
    expect(result.resolvable).toBe(16);
  });
});

describe("deadlineBackfillEnabled — flag reader", () => {
  it("is false unless DEADLINE_BACKFILL_ENABLED === 'true'", () => {
    expect(deadlineBackfillEnabled()).toBe(false);
    process.env.DEADLINE_BACKFILL_ENABLED = "1";
    expect(deadlineBackfillEnabled()).toBe(false);
    process.env.DEADLINE_BACKFILL_ENABLED = "true";
    expect(deadlineBackfillEnabled()).toBe(true);
  });
});
