import { describe, it, expect } from "vitest";
import {
  extractAnchors,
  normalizeForHash,
  parseRssItems,
  sha256hex,
  stripToText,
  type RawItem,
} from "./parse";
import {
  buildEligibilityPreamble,
  classifyItem,
  externalRef,
  extractDeadlineSignal,
  hasConcreteDeadline,
  itemHash,
} from "./classify";
import { buildScrapedGrantInsert, promoteOpportunity, type PromoteContext } from "./promote";
import { arGrantsCronEnabled, runArGrantsScan, type PromoteFn } from "./run";
import { AR_GRANT_SOURCES, type ArGrantSource, type SourceSeed } from "./sources";
import type { SourceFetchResult } from "./fetch";

// ── A minimal chainable fake Supabase (records writes, serves canned reads) ──────────────────────
type Row = Record<string, unknown>;
class Store {
  tables: Record<string, Row[]> = { ar_grant_sources: [], ar_source_items: [], grants: [], profiles: [] };
  private n = 0;
  id() {
    return `id_${++this.n}`;
  }
}
function pick(r: Row, cols: string): Row {
  if (cols.includes("*")) return { ...r };
  const o: Row = {};
  for (const k of cols.split(",").map((s) => s.trim().split(/\s+/)[0])) o[k] = r[k];
  return o;
}
class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private cols = "*";
  private payload: Row | Row[] | undefined;
  private filters: [string, unknown][] = [];
  private isSingle = false;
  constructor(private store: Store, private table: string) {}
  select(cols = "*") {
    this.cols = cols;
    return this;
  }
  insert(row: Row | Row[]) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(row: Row) {
    this.op = "update";
    this.payload = row;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push([c, v]);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    this.isSingle = true;
    return this;
  }
  single() {
    this.isSingle = true;
    return this;
  }
  private match(r: Row) {
    return this.filters.every(([c, v]) => r[c] === v);
  }
  private exec() {
    const t = (this.store.tables[this.table] ??= []);
    if (this.op === "insert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted = rows.map((r) => ({ id: this.store.id(), ...r }));
      t.push(...inserted);
      const projected = inserted.map((r) => pick(r, this.cols));
      return Promise.resolve({ data: this.isSingle ? projected[0] : projected, error: null });
    }
    if (this.op === "update") {
      for (const r of t) if (this.match(r)) Object.assign(r, this.payload);
      return Promise.resolve({ data: null, error: null });
    }
    let rows = t.filter((r) => this.match(r)).map((r) => pick(r, this.cols));
    return Promise.resolve({ data: this.isSingle ? rows[0] ?? null : rows, error: null });
  }
  then<A, B>(resolve: (v: { data: unknown; error: unknown }) => A, reject?: (e: unknown) => B) {
    return this.exec().then(resolve, reject);
  }
}
class FakeDb {
  store = new Store();
  from(t: string) {
    return new FakeQuery(this.store, t);
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (f: FakeDb) => f as any;

const source = (over: Partial<ArGrantSource> = {}): ArGrantSource => ({
  id: "s1",
  agency: "NWA RPC",
  url: "https://www.nwarpc.org/",
  cluster: "regional_mpo",
  geo_tag: "NWA-region",
  elig_tag: "local_gov",
  funding_type: "grant",
  fetch_mode: "html",
  active: true,
  last_hash: null,
  last_checked: null,
  last_changed: null,
  ...over,
});
const rawItem = (over: Partial<RawItem> = {}): RawItem => ({ title: "Test", url: "https://x.gov/a", context: "", isPdf: false, ...over });

// ── parse.ts ─────────────────────────────────────────────────────────────────────────────────────
describe("parse — content hash tracks visible text, not markup", () => {
  it("ignores cosmetic markup churn but reflects a text change", () => {
    const a = normalizeForHash(`<div class="a"><p>Grant due June 30</p><script>x=1</script></div>`);
    const b = normalizeForHash(`<section id="q"><p>Grant  due June 30</p><style>.z{}</style></section>`);
    const c = normalizeForHash(`<div><p>Grant due July 15</p></div>`);
    expect(sha256hex(a)).toBe(sha256hex(b)); // markup-only diff → same hash
    expect(sha256hex(a)).not.toBe(sha256hex(c)); // text (deadline) diff → different hash
  });
  it("extractAnchors resolves relative URLs, skips nav, flags PDFs", () => {
    const html = `
      <a href="/apply">Water Grant application</a>
      <a href="#top">Home</a>
      <a href="mailto:x@y.gov">email</a>
      <a href="https://x.gov/nofo.pdf">FY26 NOFO</a>`;
    const items = extractAnchors(html, "https://agency.gov/funding/");
    const urls = items.map((i) => i.url);
    expect(urls).toContain("https://agency.gov/apply");
    expect(urls).toContain("https://x.gov/nofo.pdf");
    expect(urls).not.toContain("mailto:x@y.gov");
    expect(items.find((i) => i.url === "https://x.gov/nofo.pdf")?.isPdf).toBe(true);
    expect(items.some((i) => i.title === "Home")).toBe(false); // nav skipped
  });
  it("parseRssItems reads RSS 2.0 items", () => {
    const xml = `<rss><channel><lastBuildDate>now</lastBuildDate>
      <item><title>New TAP Grant</title><link>https://nwarpc.org/tap</link><pubDate>Mon, 01 Jun 2026</pubDate></item>
      <item><title>Notice</title><link>https://nwarpc.org/n</link></item>
      </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("New TAP Grant");
    expect(items[0].url).toBe("https://nwarpc.org/tap");
  });
});

// ── classify.ts — the funding-type gate + keys ───────────────────────────────────────────────────
describe("classify — funding-type gate (decision A) and keys", () => {
  it("classifies SRF/loan language as a LOAN even with grant words present", () => {
    const s = source({ agency: "AR Ag NRD", funding_type: "mixed" });
    const cls = classifyItem(rawItem({ title: "Clean Water State Revolving Fund (CWSRF) loan program", context: "low-interest financing" }), s);
    expect(cls?.docType).toBe("loan");
    expect(cls?.fundingType).toBe("loan");
  });
  it("classifies a grant announcement as a promotable opportunity", () => {
    const cls = classifyItem(rawItem({ title: "Water & Sewer Treatment Facility Grant Program", context: "applications due" }), source({ funding_type: "mixed" }));
    expect(cls?.docType).toBe("opportunity");
    expect(cls?.fundingType).toBe("grant");
  });
  it("flags a PDF regardless of wording", () => {
    const cls = classifyItem(rawItem({ title: "FY26 NOFO", url: "https://x.gov/n.pdf", isPdf: true }), source());
    expect(cls?.docType).toBe("pdf");
  });
  it("returns null for a no-signal nav link (noise)", () => {
    expect(classifyItem(rawItem({ title: "Board Members", context: "our staff" }), source())).toBeNull();
  });
  it("detects a forecasted (not-yet-open) program", () => {
    const cls = classifyItem(rawItem({ title: "Water & Sewer Grant Program", context: "coming soon; applications will open" }), source({ funding_type: "mixed" }));
    expect(cls?.forecasted).toBe(true);
  });
  it("externalRef is URL-based, or a title+deadline hash when there is no URL", () => {
    const s = source({ agency: "DFA" });
    expect(externalRef(rawItem({ url: "https://dfa.gov/x" }), s)).toBe("dfa:https://dfa.gov/x");
    const noUrl = externalRef(rawItem({ url: null, title: "Grant A", context: "due June 30, 2026" }), s);
    expect(noUrl.startsWith("dfa:h:")).toBe(true);
  });
  it("itemHash moves when the deadline moves, not when unrelated text moves", () => {
    const a = itemHash(rawItem({ title: "Grant A", url: "https://x/g", context: "applications due June 30, 2026" }), false);
    const same = itemHash(rawItem({ title: "Grant A", url: "https://x/g", context: "APPLICATIONS due June 30, 2026 — read more here" }), false);
    const moved = itemHash(rawItem({ title: "Grant A", url: "https://x/g", context: "applications due July 31, 2026" }), false);
    expect(a).toBe(same);
    expect(a).not.toBe(moved);
  });
  it("itemHash flips when a program moves from forthcoming to open (decision 5)", () => {
    const it = rawItem({ title: "Water & Sewer Grant", url: "https://x/g", context: "due June 30, 2026" });
    expect(itemHash(it, true)).not.toBe(itemHash(it, false));
  });
  it("extractDeadlineSignal pulls dates and due-phrases", () => {
    expect(extractDeadlineSignal("Applications due June 30, 2026 for the program").length).toBeGreaterThan(0);
    expect(extractDeadlineSignal("A general paragraph with no dates")).toBe("");
  });
  it("hasConcreteDeadline requires a cue ADJACENT to a date, not either alone (the precision date signal)", () => {
    // Real deadline expressions (cue + date, either order):
    expect(hasConcreteDeadline("Deadline: June 30, 2026")).toBe(true);
    expect(hasConcreteDeadline("applications due 6/30/2026")).toBe(true);
    expect(hasConcreteDeadline("submit by 2026-06-30")).toBe(true);
    expect(hasConcreteDeadline("March 3, 2026 is the application deadline")).toBe(true); // date-before-cue
    // NOT deadlines — a stray date, a bare cue, or a cue and date split across sentences:
    expect(hasConcreteDeadline("our meeting is January 15, 2026")).toBe(false); // date, no cue
    expect(hasConcreteDeadline("books are due back soon")).toBe(false); // cue, no date
    expect(hasConcreteDeadline("© 2024 Agency. Updated 03/01/2026.")).toBe(false); // date, no cue in sentence
    expect(hasConcreteDeadline("Deadline is firm. Board meets January 15, 2026.")).toBe(false); // cue + date, different sentences
    // Word boundaries: an OPEN "closes <date>" is a deadline; a PAST-tense "closed <date>" is not; no
    // matching inside "overdue" (Codex/Claude Code Review word-boundary finding).
    expect(hasConcreteDeadline("application window closes March 1, 2026")).toBe(true);
    expect(hasConcreteDeadline("FY25 applications closed March 1, 2025")).toBe(false); // "closed" is not "close/closes"
    expect(hasConcreteDeadline("account is overdue since 01/01/2026")).toBe(false); // "overdue" is not a bare "due"
  });
  it("does NOT promote a bare grant/funding nav link with no application signal (precision fix)", () => {
    // The over-detection fix: a program / nav link carrying "grant"/"funding" but no NOFO/RFP/apply/
    // deadline signal is noise, not a promotable opportunity (this is what flooded AEDC with 16).
    expect(classifyItem(rawItem({ title: "Grant Programs", context: "explore our funding programs and services" }), source())).toBeNull();
    expect(classifyItem(rawItem({ title: "Economic Development Grants", context: "learn about available grants" }), source())).toBeNull();
    expect(classifyItem(rawItem({ title: "Business Incentives", context: "tax credits and workforce funding" }), source())).toBeNull();
  });
  it("DOES promote on a real application signal (NOFO / call for projects / apply-by / deadline)", () => {
    const s = source();
    expect(classifyItem(rawItem({ title: "FY26 NOFO", context: "notice of funding opportunity" }), s)?.docType).toBe("opportunity");
    expect(classifyItem(rawItem({ title: "FFY 2026 Call for Projects", context: "STBGP-A funding; applications due April 3, 2026" }), s)?.docType).toBe("opportunity");
    expect(classifyItem(rawItem({ title: "Matching Grants", context: "apply by August 28, 2026" }), s)?.docType).toBe("opportunity");
    // A grant/funding word paired with a concrete deadline also qualifies (no explicit "apply" word).
    expect(classifyItem(rawItem({ title: "Outdoor Rec Grant", context: "grant program, deadline June 30, 2026" }), s)?.docType).toBe("opportunity");
  });
  it("does NOT treat a STRAY date or a bare 'due' in trailing context as a deadline (Codex P1: precision)", () => {
    // extractAnchors hands ~200 chars of trailing page text as context. A grant/nav link that merely
    // sits near an unrelated event date, a copyright/updated line, or the word "due" (not a real
    // application deadline) must NOT promote — the deadline must be a cue ADJACENT to a date.
    const s = source();
    expect(classifyItem(rawItem({ title: "Grant Programs", context: "our annual meeting is January 15, 2026 in Little Rock" }), s)).toBeNull();
    expect(classifyItem(rawItem({ title: "Economic Development Grants", context: "library books are due back next week" }), s)).toBeNull();
    expect(classifyItem(rawItem({ title: "Funding", context: "© 2024 Agency. Site last updated 03/01/2026." }), s)).toBeNull();
    // But a real deadline expression tied to the grant still promotes.
    expect(classifyItem(rawItem({ title: "Water Grant", context: "grant funds available; deadline June 30, 2026" }), s)?.docType).toBe("opportunity");
  });
  it("admits a grant FORECAST with no application date as a HELD forecasted opportunity (Codex P1: lifecycle)", () => {
    // A 'coming soon' / 'check back' grant has neither application language nor a deadline yet, but it
    // is exactly the hold-and-requeue target (the forthcoming AR Ag Water & Sewer grant). It must be
    // stored as a forecasted opportunity (held, not matched — grant_status='Forecasted') so change
    // detection can flip it when the page opens, not dropped as noise. Restores #529 behaviour for
    // this case while keeping the live-opportunity precision tightening.
    const s = source({ funding_type: "mixed" });
    const soon = classifyItem(rawItem({ title: "Water & Sewer Grant Program", context: "coming soon — check back for details" }), s);
    expect(soon?.docType).toBe("opportunity");
    expect(soon?.forecasted).toBe(true);
    // A NON-grant 'coming soon' item (no funding word) is still noise — the forecast branch needs a grant word.
    expect(classifyItem(rawItem({ title: "New Website", context: "coming soon" }), s)).toBeNull();
  });
  it("does NOT read a CLOSED-program announcement as an application signal (Codex/CCR word-boundary fix)", () => {
    const s = source();
    // "applications are now closed" used to match STRONG_APP_KEYWORDS via the bare `clos` stem
    // (prefix of "closed"), promoting a dead program — the false-positive class this pass removes.
    expect(classifyItem(rawItem({ title: "Workforce Training Program", context: "FY25 applications are now closed for the season" }), s)).toBeNull();
    // But an OPEN "applications close <date>" (deadline approaching) is still a real signal.
    expect(classifyItem(rawItem({ title: "Workforce Training Program", context: "applications close March 15, 2026" }), s)?.docType).toBe("opportunity");
  });
});

// ── the eligibility preamble (decision B) ────────────────────────────────────────────────────────
describe("eligibility preamble — seeds geo + applicant type into the shred input (decision B)", () => {
  it("carries the source's geography and applicant-type context and the source document", () => {
    const s = source({ geo_tag: "NWA-region", elig_tag: "local_gov" });
    const cls = classifyItem(rawItem({ title: "TAP Grant", context: "grant applications open; apply by June 30, 2026" }), s)!;
    const pre = buildEligibilityPreamble(s, cls, "OPPORTUNITY BODY TEXT");
    expect(pre).toMatch(/Northwest Arkansas/i);
    expect(pre).toMatch(/units of local government/i);
    expect(pre).toContain("OPPORTUNITY BODY TEXT");
  });
  it("adds a forthcoming note only when forecasted", () => {
    const s = source({ funding_type: "mixed" });
    const open = classifyItem(rawItem({ title: "Grant", context: "grant applications open; apply now" }), s)!;
    const soon = classifyItem(rawItem({ title: "Grant", context: "grant program coming soon; applications will open" }), s)!;
    expect(buildEligibilityPreamble(s, open, "x")).not.toMatch(/FORTHCOMING/);
    expect(buildEligibilityPreamble(s, soon, "x")).toMatch(/FORTHCOMING/);
  });
});

// ── promote.ts — Seam 2 shape + the preamble reaching the pipeline ───────────────────────────────
describe("promote — Seam 2 insert shape and the pipeline hand-off", () => {
  it("buildScrapedGrantInsert: real URL when present, synthetic key when list-only; Forecasted flag", () => {
    const s = source();
    const withUrl = buildScrapedGrantInsert({ source: s, item: rawItem({ url: "https://x/g" }), cls: classifyItem(rawItem({ title: "Grant", context: "grant applications open; apply by June 30, 2026" }), s)!, itemId: "i1" });
    expect(withUrl.source_url).toBe("https://x/g");
    expect(withUrl.grant_status).toBeNull();
    const listOnly = buildScrapedGrantInsert({ source: s, item: rawItem({ url: null }), cls: classifyItem(rawItem({ title: "Grant", context: "grant program coming soon; applications will open" }), s)!, itemId: "i2" });
    expect(listOnly.source_url).toContain("i2");
    expect(listOnly.grant_status).toBe("Forecasted");
  });

  it("hands the pipeline a rawText that contains the eligibility preamble AND the fetched detail", async () => {
    const db = new FakeDb();
    const s = source({ geo_tag: "NWA-region", elig_tag: "local_gov" });
    const cls = classifyItem(rawItem({ title: "TAP Grant", context: "grant applications open; apply by June 30, 2026" }), s)!;
    const ctx: PromoteContext = { source: s, item: rawItem({ title: "TAP Grant", url: "https://nwarpc.org/tap" }), cls, itemId: "item-1" };
    let seenRawText = "";
    let seenUrlArg: string | undefined = "unset";
    const res = await promoteOpportunity(asDb(db), ctx, {
      fetchDetail: async () => "REAL DETAIL PAGE TEXT",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runPipelineImpl: (async (_id: string, url: string | undefined, rawText: string) => {
        seenRawText = rawText;
        seenUrlArg = url;
      }) as any,
      schedule: () => {},
      now: () => "2026-09-10T00:00:00Z",
    });
    expect(res.action).toBe("inserted");
    expect(res.grantId).toBeTruthy();
    expect(seenUrlArg).toBeUndefined(); // url=undefined → runPipeline uses our seeded text, never re-fetches
    expect(seenRawText).toMatch(/Northwest Arkansas/i); // decision B: geo tag reaches the shred
    expect(seenRawText).toMatch(/units of local government/i); // decision B: elig tag reaches the shred
    expect(seenRawText).toContain("REAL DETAIL PAGE TEXT");
    // the grants row carries the provenance link
    const grant = db.store.tables.grants[0];
    expect(grant.ar_source_item_id).toBe("item-1");
    expect(grant.status).toBe("processing");
  });
});

// ── run.ts — the loan gate holds end to end, dry-run writes nothing ──────────────────────────────
function seedAllSources(db: FakeDb) {
  AR_GRANT_SOURCES.forEach((s: SourceSeed, i) =>
    db.store.tables.ar_grant_sources.push({ id: `s${i}`, active: true, last_hash: null, last_checked: null, last_changed: null, rss_url: s.rss_url ?? null, ...s }),
  );
}
const cannedFetch =
  (byAgency: Record<string, RawItem[]>) =>
  async (src: ArGrantSource): Promise<SourceFetchResult> => ({ ok: true, items: byAgency[src.agency] ?? [], contentHash: sha256hex(src.agency + (byAgency[src.agency]?.length ?? 0)) });

describe("run — the funding-type gate and dry-run safety", () => {
  const items: Record<string, RawItem[]> = {
    "AR Ag NRD": [
      rawItem({ title: "Clean Water State Revolving Fund loan", url: "https://ag.gov/cwsrf", context: "low-interest financing" }),
      rawItem({ title: "Water & Sewer Treatment Facility Grant Program", url: "https://ag.gov/wstf", context: "grant applications" }),
      rawItem({ title: "FY26 Application Package", url: "https://ag.gov/app.pdf", isPdf: true }),
    ],
  };

  it("APPLY: promotes the grant, NEVER the loan; flags the PDF; records provenance", async () => {
    const db = new FakeDb();
    seedAllSources(db);
    const promoteCalls: PromoteContext[] = [];
    const promote: PromoteFn = async (_db, ctx) => {
      promoteCalls.push(ctx);
      return { grantId: "g1", action: "inserted" };
    };
    const report = await runArGrantsScan(asDb(db), { apply: true, promote, fetchSourceImpl: cannedFetch(items) });

    // The ONE thing that must hold: only the grant opportunity was handed to the pipeline.
    expect(promoteCalls).toHaveLength(1);
    expect(promoteCalls[0].item.title).toMatch(/Grant Program/);
    expect(promoteCalls.some((c) => /loan|revolving/i.test(c.item.title))).toBe(false);

    const stored = db.store.tables.ar_source_items;
    const loan = stored.find((r) => /revolving/i.test(String(r.title)));
    const pdf = stored.find((r) => r.doc_type === "pdf");
    const opp = stored.find((r) => /Grant Program/.test(String(r.title)));
    expect(loan?.status).toBe("skipped_loan"); // recorded, traceable, never promoted
    expect(pdf?.status).toBe("flagged_pdf");
    expect(opp?.status).toBe("promoted");
    expect(report.totals.loans).toBe(1);
    expect(report.totals.promoted).toBe(1);
  });

  it("DRY-RUN: writes nothing (no items, no source-hash update, promote never called)", async () => {
    const db = new FakeDb();
    seedAllSources(db);
    let promoteCalled = false;
    const promote: PromoteFn = async () => {
      promoteCalled = true;
      return { grantId: "g", action: "inserted" };
    };
    const report = await runArGrantsScan(asDb(db), { apply: false, promote, fetchSourceImpl: cannedFetch(items) });

    expect(promoteCalled).toBe(false);
    expect(db.store.tables.ar_source_items).toHaveLength(0); // no writes
    expect(db.store.tables.grants).toHaveLength(0);
    expect(db.store.tables.ar_grant_sources.every((r) => r.last_hash === null)).toBe(true); // hash not recorded
    // but the preview still reports what WOULD happen
    expect(report.totals.loans).toBe(1);
    expect(report.totals.opportunities).toBe(1);
    expect(report.apply).toBe(false);
  });

  it("DRY-RUN previews ALL sources even on an empty table (seed fallback — URL check works pre-first-apply)", async () => {
    const db = new FakeDb(); // deliberately NOT seeded — a fresh deploy, table empty
    let promoteCalled = false;
    const promote: PromoteFn = async () => {
      promoteCalled = true;
      return { grantId: "g", action: "inserted" };
    };
    const report = await runArGrantsScan(asDb(db), { apply: false, promote, fetchSourceImpl: cannedFetch(items) });
    expect(promoteCalled).toBe(false);
    expect(report.sources).toHaveLength(AR_GRANT_SOURCES.length); // all 9 previewed, not an empty report
    expect(report.totals.opportunities).toBe(1); // AR Ag's grant is detected in the preview
    expect(db.store.tables.ar_grant_sources).toHaveLength(0); // still zero writes
  });

  it("DRY-RUN overlays the CODE-seed definition onto a stored row (a stale stored fetch_mode can't shadow it)", async () => {
    const db = new FakeDb();
    // AEDC previously seeded with the OLD fetch_mode 'html' (before the headless change) + a runtime hash.
    db.store.tables.ar_grant_sources.push({
      id: "aedc", active: true, last_hash: "OLD_HASH", last_checked: null, last_changed: null,
      url: "https://www.arkansasedc.com/programs-services", agency: "AEDC", cluster: "state_agency",
      geo_tag: "AR-statewide", elig_tag: "any", funding_type: "mixed", fetch_mode: "html", rss_url: null,
    });
    const seen: Record<string, { fetch_mode: string; last_hash: string | null }> = {};
    const recordingFetch = async (src: ArGrantSource): Promise<SourceFetchResult> => {
      seen[src.agency] = { fetch_mode: src.fetch_mode, last_hash: src.last_hash };
      return { ok: true, items: [], contentHash: "h" };
    };
    const promote: PromoteFn = async () => ({ grantId: "g", action: "inserted" });
    await runArGrantsScan(asDb(db), { apply: false, promote, fetchSourceImpl: recordingFetch });
    // The code seed now marks AEDC headless; the overlay must reflect that despite the stored 'html'…
    expect(seen["AEDC"].fetch_mode).toBe("headless");
    // …while PRESERVING the stored runtime state (last_hash drives change detection).
    expect(seen["AEDC"].last_hash).toBe("OLD_HASH");
    // An unseeded source still uses its code seed (DFA is also headless; ADHE stays html).
    expect(seen["DFA"].fetch_mode).toBe("headless");
    expect(seen["ADHE"].fetch_mode).toBe("html");
  });

  it("the 0-result diagnostic note is fetch_mode-aware (headless render vs html JS-check)", async () => {
    const db = new FakeDb();
    // Every source fetches OK but yields nothing → every source hits the 0-result note branch.
    const empty = async (): Promise<SourceFetchResult> => ({ ok: true, items: [], contentHash: "h" });
    const promote: PromoteFn = async () => ({ grantId: "g", action: "inserted" });
    const report = await runArGrantsScan(asDb(db), { apply: false, promote, fetchSourceImpl: empty });
    const aedc = report.sources.find((s) => s.agency === "AEDC")!; // headless
    const adhe = report.sources.find((s) => s.agency === "ADHE")!; // html
    // Headless: render already ran — point at markup/extraction, NOT "check for JS-rendering".
    expect(aedc.note).toMatch(/render succeeded|markup|extract/i);
    expect(aedc.note).not.toMatch(/JavaScript-rendered/i);
    // html: the JS-rendering theory is still the right hint.
    expect(adhe.note).toMatch(/JavaScript-rendered/i);
  });

  it("change detection: a moved deadline re-queues an already-promoted opportunity", async () => {
    const db = new FakeDb();
    seedAllSources(db);
    const arAg = db.store.tables.ar_grant_sources.find((r) => r.agency === "AR Ag NRD")!;
    // Pre-seed the opportunity as previously promoted, with an OLD deadline hash.
    const oppRaw = rawItem({ title: "Water & Sewer Treatment Facility Grant Program", url: "https://ag.gov/wstf", context: "due June 30, 2026" });
    db.store.tables.ar_source_items.push({ id: "prev", source_id: arAg.id, external_ref: externalRef(oppRaw, source({ agency: "AR Ag NRD" })), item_hash: "OLD_HASH", status: "promoted", doc_type: "opportunity" });
    db.store.tables.grants.push({ id: "gPrev", ar_source_item_id: "prev", status: "complete", ingested_at: "2026-01-01" });

    const movedItems: Record<string, RawItem[]> = {
      "AR Ag NRD": [rawItem({ title: "Water & Sewer Treatment Facility Grant Program", url: "https://ag.gov/wstf", context: "grant applications due August 31, 2026" })],
    };
    const promoteCalls: PromoteContext[] = [];
    const promote: PromoteFn = async (_db, ctx) => {
      promoteCalls.push(ctx);
      return { grantId: "gPrev", action: "requeued" };
    };
    const report = await runArGrantsScan(asDb(db), { apply: true, promote, fetchSourceImpl: cannedFetch(movedItems) });

    expect(report.totals.changed).toBe(1);
    expect(promoteCalls).toHaveLength(1); // the change re-queued the existing grant
    expect(db.store.tables.ar_source_items.find((r) => r.id === "prev")?.status).toBe("promoted");
  });

  it("promote cap defers overflow instead of unbounded pipeline hand-offs", async () => {
    const db = new FakeDb();
    seedAllSources(db);
    const many: Record<string, RawItem[]> = {
      DRA: [
        rawItem({ title: "Grant One funding opportunity", url: "https://dra.gov/1" }),
        rawItem({ title: "Grant Two funding opportunity", url: "https://dra.gov/2" }),
        rawItem({ title: "Grant Three funding opportunity", url: "https://dra.gov/3" }),
      ],
    };
    const promote: PromoteFn = async () => ({ grantId: "g", action: "inserted" });
    const report = await runArGrantsScan(asDb(db), { apply: true, promoteMax: 2, promote, fetchSourceImpl: cannedFetch(many) });
    expect(report.totals.promoted).toBe(2);
    expect(report.totals.deferred).toBe(1);
  });

  it("per-source cap stops one source from eating the global cap (the AEDC-starvation fix)", async () => {
    const db = new FakeDb();
    seedAllSources(db);
    const opp = (n: number) => rawItem({ title: `Grant ${n}`, url: `https://aedc/${n}`, context: "grant applications open; apply by June 30, 2026" });
    const many: Record<string, RawItem[]> = { AEDC: [opp(1), opp(2), opp(3), opp(4), opp(5)] };
    const promote: PromoteFn = async () => ({ grantId: "g", action: "inserted" });
    // Global budget 20 is plenty, but a per-source cap of 2 must hold AEDC to 2 so it can't starve
    // later sources (the live dry-run's AR Ag + Metroplan starvation).
    const report = await runArGrantsScan(asDb(db), { apply: true, promoteMax: 20, promoteMaxPerSource: 2, promote, fetchSourceImpl: cannedFetch(many) });
    const aedc = report.sources.find((s) => s.agency === "AEDC")!;
    expect(aedc.promoted).toBe(2); // capped per source
    expect(aedc.deferred).toBe(3); // the rest deferred even though the global budget was untouched
  });

  it("retries an opportunity that was deferred/failed earlier (unchanged hash, not yet promoted)", async () => {
    const db = new FakeDb();
    seedAllSources(db);
    const arAg = db.store.tables.ar_grant_sources.find((r) => r.agency === "AR Ag NRD")!;
    const s = source({ agency: "AR Ag NRD", funding_type: "mixed" });
    const oppRaw = rawItem({ title: "Water & Sewer Treatment Facility Grant Program", url: "https://ag.gov/wstf", context: "grant applications" });
    const cls = classifyItem(oppRaw, s)!;
    // Previously detected but NOT promoted (status 'new'), stored with the CURRENT hash → "unchanged".
    db.store.tables.ar_source_items.push({ id: "def", source_id: arAg.id, external_ref: externalRef(oppRaw, s), item_hash: itemHash(oppRaw, cls.forecasted), status: "new", doc_type: "opportunity" });
    const promoteCalls: PromoteContext[] = [];
    const promote: PromoteFn = async (_db, ctx) => {
      promoteCalls.push(ctx);
      return { grantId: "g", action: "inserted" };
    };
    await runArGrantsScan(asDb(db), { apply: true, promote, fetchSourceImpl: cannedFetch({ "AR Ag NRD": [oppRaw] }) });
    expect(promoteCalls).toHaveLength(1); // retried despite an unchanged hash
    expect(db.store.tables.ar_source_items.find((r) => r.id === "def")?.status).toBe("promoted");
  });

  it("does NOT re-promote an already-promoted, unchanged opportunity", async () => {
    const db = new FakeDb();
    seedAllSources(db);
    const arAg = db.store.tables.ar_grant_sources.find((r) => r.agency === "AR Ag NRD")!;
    const s = source({ agency: "AR Ag NRD", funding_type: "mixed" });
    const oppRaw = rawItem({ title: "Water & Sewer Treatment Facility Grant Program", url: "https://ag.gov/wstf", context: "grant applications" });
    const cls = classifyItem(oppRaw, s)!;
    db.store.tables.ar_source_items.push({ id: "done", source_id: arAg.id, external_ref: externalRef(oppRaw, s), item_hash: itemHash(oppRaw, cls.forecasted), status: "promoted", doc_type: "opportunity" });
    const promoteCalls: PromoteContext[] = [];
    const promote: PromoteFn = async (_db, ctx) => {
      promoteCalls.push(ctx);
      return { grantId: "g", action: "inserted" };
    };
    await runArGrantsScan(asDb(db), { apply: true, promote, fetchSourceImpl: cannedFetch({ "AR Ag NRD": [oppRaw] }) });
    expect(promoteCalls).toHaveLength(0); // no needless re-promote of a stable, already-promoted grant
  });
});

describe("stripToText", () => {
  it("removes scripts/styles and decodes basic entities", () => {
    expect(stripToText("<p>A&nbsp;&amp;&nbsp;B<script>x</script></p>")).toBe("A & B");
  });
});

describe("arGrantsCronEnabled — the automatic cron stays OFF until explicitly enabled", () => {
  it("is false unless AR_GRANTS_CRON_ENABLED is exactly 'true'", () => {
    const prev = process.env.AR_GRANTS_CRON_ENABLED;
    delete process.env.AR_GRANTS_CRON_ENABLED;
    expect(arGrantsCronEnabled()).toBe(false);
    process.env.AR_GRANTS_CRON_ENABLED = "1";
    expect(arGrantsCronEnabled()).toBe(false);
    process.env.AR_GRANTS_CRON_ENABLED = "true";
    expect(arGrantsCronEnabled()).toBe(true);
    if (prev === undefined) delete process.env.AR_GRANTS_CRON_ENABLED;
    else process.env.AR_GRANTS_CRON_ENABLED = prev;
  });
});
