import { describe, it, expect } from "vitest";
import type { ProspectFeedItem } from "@/lib/grants/gate";
import {
  isExpiredFeedItem,
  isActionableFeedItem,
  deadlineRank,
  sortProspectFeed,
  prepareProspectFeed,
} from "./prospect-sort";

// Dates far from any run instant so the live/passed sign is deterministic whenever the test
// runs: a year-2999 deadline is always future, a year-2000 deadline always past.
const FUTURE_FAR = "2999-12-31";
const FUTURE_SOON = "2999-01-01"; // still future, but earlier than FUTURE_FAR
const PAST = "2000-01-01";

// Minimal ProspectFeedItem — only the fields the filter/sort read matter.
function item(
  id: string,
  opts: {
    deadline?: string | null;
    prospects?: number;
    clients?: number;
  } = {},
): ProspectFeedItem {
  const { deadline = null, prospects = 0, clients = 0 } = opts;
  return {
    grant: { id, title: id, funder: null, submission_deadline: deadline },
    prospectable: true,
    status: "released",
    clientMatches: Array.from({ length: clients }, (_, i) => ({ name: `c${i}`, decision: "pending" as const })),
    prospectCards: Array.from({ length: prospects }, (_, i) => ({
      id: `${id}-p${i}`,
      fit_score: 2,
      proposed_role: null,
      decision: "pending" as const,
      prospect: { name: `p${i}`, org_type: null, source_url: "https://x" },
    })),
  } as ProspectFeedItem;
}

const ids = (feed: ProspectFeedItem[]) => feed.map((f) => f.grant.id);

describe("isExpiredFeedItem", () => {
  it("is expired ONLY for a genuinely-passed date (deadlineDaysLeft < 0)", () => {
    expect(isExpiredFeedItem(item("passed", { deadline: PAST }))).toBe(true);
    expect(isExpiredFeedItem(item("live", { deadline: FUTURE_SOON }))).toBe(false);
  });

  it("NEVER expires a rolling / undated / unparseable deadline (null) — the AR guard", () => {
    // These must stay in the feed. A large share of the AR state repository is rolling/always-open;
    // filtering any of these would nuke it.
    expect(isExpiredFeedItem(item("null", { deadline: null }))).toBe(false);
    expect(isExpiredFeedItem(item("rolling", { deadline: "Rolling" }))).toBe(false);
    expect(isExpiredFeedItem(item("open", { deadline: "Always open" }))).toBe(false);
    expect(isExpiredFeedItem(item("empty", { deadline: "" }))).toBe(false);
    expect(isExpiredFeedItem(item("tbd", { deadline: "TBD" }))).toBe(false);
  });
});

describe("isActionableFeedItem", () => {
  it("is actionable with a surfaced prospect OR a client match, not otherwise", () => {
    expect(isActionableFeedItem(item("a", { prospects: 1 }))).toBe(true);
    expect(isActionableFeedItem(item("b", { clients: 1 }))).toBe(true);
    expect(isActionableFeedItem(item("c", { prospects: 2, clients: 3 }))).toBe(true);
    expect(isActionableFeedItem(item("d"))).toBe(false);
  });
});

describe("deadlineRank", () => {
  it("buckets live-dated (0) < rolling/undated (1) < passed (2)", () => {
    expect(deadlineRank(item("live", { deadline: FUTURE_SOON })).bucket).toBe(0);
    expect(deadlineRank(item("rolling", { deadline: null })).bucket).toBe(1);
    expect(deadlineRank(item("rolling-text", { deadline: "Rolling" })).bucket).toBe(1);
    expect(deadlineRank(item("passed", { deadline: PAST })).bucket).toBe(2);
  });

  it("only live grants carry a nonzero day count; rolling and passed hold days=0", () => {
    expect(deadlineRank(item("live", { deadline: FUTURE_SOON })).days).toBeGreaterThan(0);
    expect(deadlineRank(item("rolling", { deadline: null })).days).toBe(0);
    expect(deadlineRank(item("passed", { deadline: PAST })).days).toBe(0);
  });
});

describe("sortProspectFeed (standalone sort)", () => {
  it("puts actionable grants ahead of non-actionable ones", () => {
    const feed = [item("idle", {}), item("worked", { prospects: 1 })];
    expect(ids(sortProspectFeed(feed))).toEqual(["worked", "idle"]);
  });

  it("within a bucket, orders live deadlines soonest-first, then rolling, then (fallback) passed", () => {
    // All non-actionable so only the deadline pass decides order. A passed grant reaching the
    // standalone sort unfiltered sinks to the bottom (the defensive fallback) rather than floating.
    const feed = [
      item("passed", { deadline: PAST }),
      item("rolling", { deadline: null }),
      item("far", { deadline: FUTURE_FAR }),
      item("soon", { deadline: FUTURE_SOON }),
    ];
    expect(ids(sortProspectFeed(feed))).toEqual(["soon", "far", "rolling", "passed"]);
  });

  it("is stable within an equal key (preserves the incoming ingested_at-desc order)", () => {
    const feed = [item("r1", { deadline: null }), item("r2", { deadline: null }), item("r3", { deadline: null })];
    expect(ids(sortProspectFeed(feed))).toEqual(["r1", "r2", "r3"]);
  });

  it("does not mutate the input array", () => {
    const feed = [item("idle", {}), item("worked", { prospects: 1 })];
    const before = ids(feed);
    sortProspectFeed(feed);
    expect(ids(feed)).toEqual(before);
  });
});

describe("prepareProspectFeed (filter expired, then sort)", () => {
  it("DROPS genuinely-passed grants but KEEPS rolling/undated ones", () => {
    const feed = [
      item("passed", { deadline: PAST }),
      item("rolling", { deadline: null }),
      item("live", { deadline: FUTURE_SOON }),
    ];
    const out = ids(prepareProspectFeed(feed));
    expect(out).not.toContain("passed");
    expect(out).toContain("rolling");
    expect(out).toContain("live");
  });

  it("keeps a whole rolling batch — the AR repository is not nuked", () => {
    const feed = [
      item("ar1", { deadline: null }),
      item("ar2", { deadline: "Rolling" }),
      item("ar3", { deadline: "Always open" }),
      item("expired", { deadline: PAST }),
    ];
    const out = ids(prepareProspectFeed(feed));
    expect(out).toEqual(expect.arrayContaining(["ar1", "ar2", "ar3"]));
    expect(out).not.toContain("expired");
    expect(out).toHaveLength(3);
  });

  it("even a WORKED (actionable) expired grant is dropped — expired is noise regardless", () => {
    const feed = [item("worked-expired", { deadline: PAST, prospects: 3, clients: 2 }), item("live", { deadline: FUTURE_SOON })];
    expect(ids(prepareProspectFeed(feed))).toEqual(["live"]);
  });

  it("orders survivors by option B: actionable first, then soonest deadline, then rolling", () => {
    const feed = [
      item("passed", { deadline: PAST }), // dropped
      item("idle-rolling", { deadline: null }),
      item("idle-far", { deadline: FUTURE_FAR }),
      item("idle-soon", { deadline: FUTURE_SOON }),
      item("worked", { deadline: FUTURE_FAR, prospects: 1 }),
    ];
    expect(ids(prepareProspectFeed(feed))).toEqual(["worked", "idle-soon", "idle-far", "idle-rolling"]);
  });

  it("breaks the same-timestamp wall: a live grant leads a rolling batch that arrived together", () => {
    const feed = [
      item("ar1", { deadline: null }),
      item("ar2", { deadline: null }),
      item("ar3", { deadline: null }),
      item("live", { deadline: FUTURE_SOON }),
    ];
    expect(ids(prepareProspectFeed(feed))[0]).toBe("live");
  });

  it("does not mutate the input array", () => {
    const feed = [item("passed", { deadline: PAST }), item("live", { deadline: FUTURE_SOON })];
    const before = ids(feed);
    prepareProspectFeed(feed);
    expect(ids(feed)).toEqual(before);
  });
});
