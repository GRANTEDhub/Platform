import { describe, it, expect, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  grantbotStoredNofoEnabled,
  loadStoredNofoRow,
  loadGrantNofoFields,
  formatNofoFields,
  buildStoredNofoFieldsBlock,
  executeStoredNofo,
  STORED_NOFO_INSTRUCTION_BLOCK,
  READ_STORED_NOFO_TOOL,
  READ_STORED_NOFO_TOOL_NAME,
  MAX_STORED_NOFO_CHARS,
  type StoredNofoRow,
} from "./stored-nofo";
import { PASTED_OPEN, PASTED_CLOSE } from "./prompt";

// Deterministic — no model, no network, no real database. The loader takes the db as an injected fake
// (the focus-grant seam), and the formatter / block / executor are pure over an injected row + clock.

// A quote-verified allowable_uses jsonb, as the platform stores it (readAllowableUses parses this).
const ALLOWABLE = {
  items: [
    { line: "Personnel and fringe benefits", quote: "Funds may be used for personnel and fringe.", kind: "allowed" },
    { line: "Equipment under $5,000", quote: "Equipment costing less than $5,000 is allowable.", kind: "allowed" },
    { line: "Construction", quote: "Construction and real property acquisition are not allowed.", kind: "not_allowed", restriction_class: "budget" },
  ],
  reason: null,
};
// A quote-verified application_requirements jsonb (readApplicationRequirements parses this).
const REQUIREMENTS = {
  required_sections: [{ text: "Project narrative, 15 pages maximum", quote: "The project narrative is limited to 15 pages." }],
  page_format_limits: [],
  required_attachments: [{ text: "SF-424 and budget justification", quote: "Submit the SF-424 and a budget justification." }],
  evaluation_criteria: [],
  other_notes: [],
  reason: null,
};

function fullRow(over: Partial<StoredNofoRow> = {}): StoredNofoRow {
  return {
    id: "g-1",
    title: "Feral Swine Eradication",
    funder: "USDA-NRCS",
    cfda: "10.934",
    fon: "USDA-NRCS-NHQ-FSCP-26-NOFO0001453",
    deadline: "2026-05-01",
    shredDepth: "full",
    descriptionBrief: "Funds partnerships that eradicate feral swine in priority watersheds.",
    eligibleEntityTypes: ["Nonprofits", "Local governments"],
    geographicEligibility: "Priority watersheds in 10 states incl. AR",
    ineligibleEntities: "Individuals",
    subawardProhibited: false,
    costShare: "Non-federal match of 25% required",
    awardRangeMin: "$50,000",
    awardRangeMax: "$5,000,000",
    awardRangeIsEstimate: true,
    numAwards: "up to 15",
    allowableUses: ALLOWABLE,
    applicationRequirements: REQUIREMENTS,
    rawText: null,
    ...over,
  };
}

// db.from("grants").select(cols) then either .eq("id",…).maybeSingle() OR .ilike("fon",…).limit(1).
// The fake resolves at whichever terminal the loader calls, from the branch its selector took.
function fakeDb(opts: {
  byId?: Record<string, unknown> | null;
  byFon?: Record<string, unknown>[] | null;
  throwOn?: boolean;
  onIlike?: (value: unknown) => void;
} = {}): SupabaseClient {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    ilike: (_col: unknown, val: unknown) => {
      opts.onIlike?.(val);
      return chain;
    },
    limit: async () => {
      if (opts.throwOn) throw new Error("boom");
      return { data: opts.byFon ?? null };
    },
    maybeSingle: async () => {
      if (opts.throwOn) throw new Error("boom");
      return { data: opts.byId ?? null };
    },
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

// A stored grant ROW as it comes back from Postgres (snake_case, jsonb columns).
function grantRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "g-1",
    title: "Feral Swine Eradication",
    funder: "USDA-NRCS",
    fon: "USDA-NRCS-NHQ-FSCP-26-NOFO0001453",
    assistance_listings: [{ number: "10.934" }],
    submission_deadline: "2026-05-01",
    shred_depth: "full",
    description_brief: "Funds partnerships that eradicate feral swine.",
    eligible_entity_types: ["Nonprofits", "Local governments"],
    geographic_eligibility: "Priority watersheds",
    ineligible_entities: "Individuals",
    subaward_prohibited: false,
    cost_share: "25% match",
    award_range_min: "$50,000",
    award_range_max: "$5,000,000",
    award_range_is_estimate: true,
    num_awards: "up to 15",
    allowable_uses: ALLOWABLE,
    application_requirements: REQUIREMENTS,
    raw_text: "The full parsed NOFO body ...",
    ...over,
  };
}

describe("grantbotStoredNofoEnabled — the flag", () => {
  const prev = process.env.GRANTBOT_STORED_NOFO_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_STORED_NOFO_ENABLED;
    else process.env.GRANTBOT_STORED_NOFO_ENABLED = prev;
  });
  it("off unless exactly 'true'", () => {
    delete process.env.GRANTBOT_STORED_NOFO_ENABLED;
    expect(grantbotStoredNofoEnabled()).toBe(false);
    process.env.GRANTBOT_STORED_NOFO_ENABLED = "1";
    expect(grantbotStoredNofoEnabled()).toBe(false);
    process.env.GRANTBOT_STORED_NOFO_ENABLED = "true";
    expect(grantbotStoredNofoEnabled()).toBe(true);
  });
});

describe("formatNofoFields — the shared structured-field renderer", () => {
  it("renders every present field and its quote-verified provenance", () => {
    const t = formatNofoFields(fullRow());
    expect(t).toContain("What it funds:");
    expect(t).toContain("Eligible entity types: Nonprofits, Local governments");
    expect(t).toContain("Geographic eligibility:");
    expect(t).toContain("Ineligible: Individuals");
    expect(t).toContain("Award range: $50,000–$5,000,000 (estimate)");
    expect(t).toContain("Expected awards: up to 15");
    expect(t).toContain("Cost share / match:");
    // Both allowable-use lists, labelled and quote-verified.
    expect(t).toMatch(/Allowable uses of funds \(quote-verified/);
    expect(t).toContain("Personnel and fringe benefits");
    expect(t).toMatch(/NOT allowed \/ restricted \(quote-verified/);
    expect(t).toContain("Construction");
    expect(t).toMatch(/Application requirements \(quote-verified/);
    expect(t).toContain("Project narrative, 15 pages maximum");
  });

  it("marks subawards prohibited only when true", () => {
    expect(formatNofoFields(fullRow({ subawardProhibited: true }))).toContain("Subawards are prohibited");
    expect(formatNofoFields(fullRow({ subawardProhibited: false }))).not.toContain("Subawards are prohibited");
  });

  it("drops absent fields rather than printing empty headings", () => {
    const bare = fullRow({
      descriptionBrief: null,
      eligibleEntityTypes: null,
      geographicEligibility: null,
      ineligibleEntities: null,
      subawardProhibited: null,
      costShare: null,
      awardRangeMin: null,
      awardRangeMax: null,
      numAwards: null,
      allowableUses: null,
      applicationRequirements: null,
    });
    expect(formatNofoFields(bare)).toBe("");
  });

  it("labels a single-value award and honours the non-estimate case", () => {
    expect(formatNofoFields(fullRow({ awardRangeMax: null, awardRangeIsEstimate: false }))).toContain("Award range: $50,000");
    expect(formatNofoFields(fullRow({ awardRangeMax: null, awardRangeIsEstimate: false }))).not.toContain("(estimate)");
  });
});

describe("buildStoredNofoFieldsBlock — the Layer-1 grounding block", () => {
  it("is a cacheable:false focus-grant block sourced to stored-nofo.ts", () => {
    const b = buildStoredNofoFieldsBlock(fullRow());
    expect(b.cacheable).toBe(false);
    expect(b.kind).toBe("focus-grant");
    expect(b.source).toBe("lib/grantbot/stored-nofo.ts");
  });
  it("says the platform already parsed the NOFO and points at the tool for the full text", () => {
    const t = buildStoredNofoFieldsBlock(fullRow()).text;
    expect(t).toMatch(/already ingested and parsed/i);
    expect(t).toContain(READ_STORED_NOFO_TOOL_NAME);
    expect(t).toContain("Personnel and fringe benefits");
    expect(t).toMatch(/do NOT fetch/i);
  });
});

describe("loadStoredNofoRow / loadGrantNofoFields", () => {
  it("maps a row by id and includes raw_text only when withRawText", async () => {
    const row = await loadStoredNofoRow(fakeDb({ byId: grantRow() }), { grantId: "g-1" }, { withRawText: true });
    expect(row?.cfda).toBe("10.934");
    expect(row?.rawText).toContain("full parsed NOFO body");
  });
  it("resolves by opportunity number (fon) via the array-returning limit(1) branch", async () => {
    // withRawText not set → the real SELECT omits the raw_text column, so the row comes back without it.
    // Simulate that here (the fake cannot model column selection) by dropping raw_text from the fixture.
    const { raw_text: _omit, ...noRaw } = grantRow();
    const row = await loadStoredNofoRow(fakeDb({ byFon: [noRaw] }), { fon: "USDA-NRCS-NHQ-FSCP-26-NOFO0001453" });
    expect(row?.fon).toBe("USDA-NRCS-NHQ-FSCP-26-NOFO0001453");
    expect(row?.cfda).toBe("10.934");
    expect(row?.rawText).toBeNull();
  });
  it("escapes LIKE metacharacters in the FON so `_`/`%` cannot wildcard-match a sibling grant (Claude Code Review)", async () => {
    let passed: unknown;
    await loadStoredNofoRow(fakeDb({ byFon: [grantRow({ fon: "HHS_2026_ACF_0001" })], onIlike: (v) => (passed = v) }), {
      fon: "HHS_2026_ACF_0001",
    });
    // The value handed to ilike has every `_` backslash-escaped → matched literally, not as a wildcard.
    expect(passed).toBe("HHS\\_2026\\_ACF\\_0001");
  });
  it("BACKSTOPS with a case-insensitive exact match — a returned row whose FON differs is rejected", async () => {
    // Even if a wildcard slipped through, the row's own fon must equal the requested fon or it is dropped
    // (→ not_found → the model fetches), never presented as the requested grant's NOFO.
    const row = await loadStoredNofoRow(fakeDb({ byFon: [grantRow({ fon: "SOME-OTHER-GRANT-999" })] }), {
      fon: "USDA-NRCS-NHQ-FSCP-26-NOFO0001453",
    });
    expect(row).toBeNull();
  });
  it("accepts a case-differing FON (ilike stays for case-insensitivity)", async () => {
    const row = await loadStoredNofoRow(fakeDb({ byFon: [grantRow({ fon: "USDA-NRCS-NHQ-FSCP-26-NOFO0001453" })] }), {
      fon: "usda-nrcs-nhq-fscp-26-nofo0001453",
    });
    expect(row?.fon).toBe("USDA-NRCS-NHQ-FSCP-26-NOFO0001453");
  });
  it("fails soft to null on a thrown read (never propagates — the user-row-orphan window)", async () => {
    expect(await loadStoredNofoRow(fakeDb({ throwOn: true }), { grantId: "g-1" })).toBeNull();
  });
  it("loadGrantNofoFields returns null for a husk with no structured detail (→ no Layer-1 block)", async () => {
    const husk = grantRow({
      description_brief: null,
      eligible_entity_types: null,
      geographic_eligibility: null,
      ineligible_entities: null,
      cost_share: null,
      award_range_min: null,
      award_range_max: null,
      num_awards: null,
      allowable_uses: null,
      application_requirements: null,
    });
    expect(await loadGrantNofoFields(fakeDb({ byId: husk }), "g-1")).toBeNull();
  });
  it("loadGrantNofoFields returns the row when there is structured detail", async () => {
    expect(await loadGrantNofoFields(fakeDb({ byId: grantRow() }), "g-1")).not.toBeNull();
  });
  it("loadGrantNofoFields returns null for a SUMMARY shred even with detail (no Layer-1 block; Codex #586)", async () => {
    // A summary shred's fields come from the API summary, and its raw_text is API JSON — Layer 1 rides a
    // full shred only, so it never claims to have "parsed the NOFO" for a summary grant.
    expect(await loadGrantNofoFields(fakeDb({ byId: grantRow({ shred_depth: "summary" }) }), "g-1")).toBeNull();
  });
});

describe("executeStoredNofo — the Layer-2 tool", () => {
  const now = () => "2026-09-17T00:00:00.000Z";

  it("no opportunity number AND no anchor → typed 'no grant specified', never a guess", async () => {
    const r = await executeStoredNofo({ input: {} }, { db: fakeDb(), focusGrantId: null, now });
    expect(r.audit.ok).toBe(false);
    expect(r.audit.reason).toBe("no_grant_specified");
    expect(r.resultText).toMatch(/No grant was specified/i);
  });

  it("reads the ANCHORED grant (no arg) and frames the stored text as untrusted evidence", async () => {
    const r = await executeStoredNofo(
      { input: {} },
      { db: fakeDb({ byId: grantRow() }), focusGrantId: "g-1", now },
    );
    expect(r.audit.ok).toBe(true);
    expect(r.audit.hasRawText).toBe(true);
    expect(r.audit.query).toBe("anchored:g-1");
    expect(r.resultText).toContain("STORED NOFO — Feral Swine Eradication");
    expect(r.resultText).toMatch(/do NOT need to fetch/i);
    // The raw text rides the SAME untrusted paste frame as a fetched page.
    expect(r.resultText).toContain(PASTED_OPEN);
    expect(r.resultText).toContain(PASTED_CLOSE);
    expect(r.resultText).toContain("full parsed NOFO body");
  });

  it("resolves a NAMED grant by opportunity number", async () => {
    const r = await executeStoredNofo(
      { input: { opportunity_number: "USDA-NRCS-NHQ-FSCP-26-NOFO0001453" } },
      { db: fakeDb({ byFon: [grantRow()] }), focusGrantId: null, now },
    );
    expect(r.audit.ok).toBe(true);
    expect(r.audit.query).toBe("USDA-NRCS-NHQ-FSCP-26-NOFO0001453");
  });

  it("grant in the platform but NO stored text → fail OPEN toward fetching, never invent NOFO language", async () => {
    const r = await executeStoredNofo(
      { input: {} },
      { db: fakeDb({ byId: grantRow({ raw_text: null, shred_depth: "summary" }) }), focusGrantId: "g-1", now },
    );
    expect(r.audit.ok).toBe(true);
    expect(r.audit.hasRawText).toBe(false);
    expect(r.resultText).toMatch(/NO parsed full NOFO text/i);
    expect(r.resultText).toMatch(/fetch the official \.gov source/i);
    // Structured fields still ride even without raw text.
    expect(r.resultText).toContain("Award range:");
  });

  it("a SUMMARY shred's raw_text (API JSON, not the NOFO) is NEVER served as full NOFO text (Codex #586)", async () => {
    // pipeline.ts stores the Simpler API JSON in raw_text on a summary shred. It must route to the
    // no-full-text fallback, never be framed as "the NOFO" with a do-not-fetch instruction.
    const r = await executeStoredNofo(
      { input: {} },
      {
        db: fakeDb({ byId: grantRow({ shred_depth: "summary", raw_text: '{"opportunity":"api json not a nofo"}' }) }),
        focusGrantId: "g-1",
        now,
      },
    );
    expect(r.audit.ok).toBe(true);
    expect(r.audit.hasRawText).toBe(false);
    expect(r.resultText).toMatch(/NO parsed full NOFO text/i);
    expect(r.resultText).toMatch(/API summary/i);
    expect(r.resultText).not.toContain("api json not a nofo"); // the JSON never reaches the model as NOFO
    expect(r.resultText).toMatch(/fetch the official \.gov source/i);
  });

  it("grant NOT in the platform → typed not_found that routes to fetch, never a reconstruction", async () => {
    const r = await executeStoredNofo(
      { input: { opportunity_number: "NOT-A-REAL-FON" } },
      { db: fakeDb({ byFon: [] }), focusGrantId: null, now },
    );
    expect(r.audit.ok).toBe(false);
    expect(r.audit.reason).toBe("not_found");
    expect(r.resultText).toMatch(/no record of it|fetch that instead/i);
    expect(r.resultText).toMatch(/do NOT reconstruct/i);
  });

  it("truncates an over-long stored NOFO and says so", async () => {
    const big = "A".repeat(MAX_STORED_NOFO_CHARS + 5000);
    const r = await executeStoredNofo(
      { input: {} },
      { db: fakeDb({ byId: grantRow({ raw_text: big }) }), focusGrantId: "g-1", now },
    );
    expect(r.resultText).toMatch(/was longer than the window and was truncated/i);
  });
});

describe("READ_STORED_NOFO_TOOL + STORED_NOFO_INSTRUCTION_BLOCK", () => {
  it("the tool is read-only-shaped with an optional opportunity_number", () => {
    expect(READ_STORED_NOFO_TOOL.name).toBe(READ_STORED_NOFO_TOOL_NAME);
    // No `required` key at all → the tool is callable with no args (reads the anchored grant).
    expect("required" in READ_STORED_NOFO_TOOL.input_schema).toBe(false);
    expect(READ_STORED_NOFO_TOOL.description).toMatch(/instead of fetching/i);
  });
  it("the instruction block prefers stored over fetch AND forbids claiming an unread source", () => {
    const t = STORED_NOFO_INSTRUCTION_BLOCK.text;
    expect(STORED_NOFO_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(t).toMatch(/PREFER IT OVER FETCHING/i);
    expect(t).toMatch(/NEVER CLAIM A SOURCE YOU DID NOT READ THIS TURN/i);
    expect(t).toContain("I have the full NOFO");
    expect(t).toMatch(/fabrication/i);
  });
});
