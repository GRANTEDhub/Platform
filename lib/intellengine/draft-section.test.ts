import { describe, it, expect } from "vitest";
import { generateSectionDraft, type SectionDraftInput } from "./draft-section";
import { EMPTY_REQUIREMENTS, type ApplicationRequirements, type RequirementsReason } from "@/lib/grants/requirements";
import { PROPOSAL_SECTIONS } from "@/lib/intellengine/sections";
import { EMPTY_SCOPE, SECTION_MAX_CHARS, type DraftScope } from "@/lib/intellengine/content";
import type { Client } from "@/types/database";

// Step 5a drafter. The whole point is the INPUT GATE: with no real step-4 requirements artifact the
// model is never called (grounded-or-refuse), which is what makes step 5 depend on step 4 rather
// than invent a NOFO-tailored section. The model call is an injected seam, so every path is proven
// without a network or a live model.

// A recording seam: captures the prompts it was handed and returns a canned value (or throws).
function seam(behavior: string | null | (() => never)) {
  const calls: { system: string; user: string }[] = [];
  const createDraft = async (args: { system: string; user: string }): Promise<string | null> => {
    calls.push(args);
    if (typeof behavior === "function") return behavior();
    return behavior;
  };
  return { createDraft, calls };
}

function requirementsWith(reason: RequirementsReason | null, hasItem: boolean): ApplicationRequirements {
  return {
    ...EMPTY_REQUIREMENTS,
    required_sections: hasItem ? [{ text: "A project narrative of no more than 10 pages", quote: "" }] : [],
    evaluation_criteria: hasItem ? [{ text: "Need and significance (30 points)", quote: "" }] : [],
    reason,
  };
}

const CLIENT = { name: "Rivertown Community Health" } as unknown as Client;
const SCOPE: DraftScope = { ...EMPTY_SCOPE, scope: "A mobile dental clinic for three rural counties", savedAt: "x" };

function input(overrides: Partial<SectionDraftInput>): SectionDraftInput {
  return {
    grantTitle: "Rural Health Access Program",
    grantFunder: "HRSA",
    requirements: requirementsWith(null, true),
    client: CLIENT,
    scope: SCOPE,
    concept: null,
    section: PROPOSAL_SECTIONS[0], // "Problem Statement"
    ...overrides,
  };
}

describe("generateSectionDraft — input gate (grounded-or-refuse)", () => {
  it("refuses no_requirements when the artifact was never derived (null), and never calls the model", async () => {
    const s = seam("should not be used");
    const r = await generateSectionDraft(input({ requirements: null }), { createDraft: s.createDraft });
    expect(r).toEqual({ ok: false, reason: "no_requirements" });
    expect(s.calls).toHaveLength(0);
  });

  it("refuses no_requirements when the artifact has no items, and never calls the model", async () => {
    const s = seam("should not be used");
    const r = await generateSectionDraft(input({ requirements: requirementsWith("no_requirements_found", false) }), {
      createDraft: s.createDraft,
    });
    expect(r).toEqual({ ok: false, reason: "no_requirements" });
    expect(s.calls).toHaveLength(0);
  });

  it("refuses not_retrievable when step 4 recorded nofo_not_retrievable, and never calls the model", async () => {
    const s = seam("should not be used");
    const r = await generateSectionDraft(input({ requirements: requirementsWith("nofo_not_retrievable", false) }), {
      createDraft: s.createDraft,
    });
    expect(r).toEqual({ ok: false, reason: "not_retrievable" });
    expect(s.calls).toHaveLength(0);
  });
});

describe("generateSectionDraft — generation + validation", () => {
  it("returns the trimmed draft as source:ai on a grounded call", async () => {
    const s = seam("  Rivertown faces a shortage of dental providers.  ");
    const r = await generateSectionDraft(input({}), { createDraft: s.createDraft });
    expect(r).toEqual({ ok: true, draft: "Rivertown faces a shortage of dental providers.", source: "ai" });
    expect(s.calls).toHaveLength(1);
  });

  it("fails generation_failed on an empty or null model return", async () => {
    for (const behavior of [null, "", "   "] as (string | null)[]) {
      const s = seam(behavior);
      const r = await generateSectionDraft(input({}), { createDraft: s.createDraft });
      expect(r).toEqual({ ok: false, reason: "generation_failed" });
    }
  });

  it("fails generation_failed when the model call throws", async () => {
    const s = seam(() => {
      throw new Error("api down");
    });
    const r = await generateSectionDraft(input({}), { createDraft: s.createDraft });
    expect(r).toEqual({ ok: false, reason: "generation_failed" });
  });

  it("fails too_long when the draft exceeds SECTION_MAX_CHARS", async () => {
    const s = seam("x".repeat(SECTION_MAX_CHARS + 1));
    const r = await generateSectionDraft(input({}), { createDraft: s.createDraft });
    expect(r).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("generateSectionDraft — revise mode (5b)", () => {
  it("still refuses without a real requirements artifact, even with an instruction", async () => {
    const s = seam("should not be used");
    const r = await generateSectionDraft(input({ requirements: null, instruction: "make it assertive", currentDraft: "x" }), {
      createDraft: s.createDraft,
    });
    expect(r).toEqual({ ok: false, reason: "no_requirements" });
    expect(s.calls).toHaveLength(0);
  });

  it("hands the model the current draft and the staff instruction to revise", async () => {
    const s = seam("A more assertive problem statement.");
    const r = await generateSectionDraft(
      input({ instruction: "make this more assertive", currentDraft: "Rivertown has some needs." }),
      { createDraft: s.createDraft },
    );
    expect(r).toEqual({ ok: true, draft: "A more assertive problem statement.", source: "ai" });
    const { user } = s.calls[0];
    expect(user).toContain("STAFF INSTRUCTION");
    expect(user).toContain("make this more assertive");
    expect(user).toContain("CURRENT DRAFT");
    expect(user).toContain("Rivertown has some needs.");
  });
});

describe("generateSectionDraft — grounding", () => {
  it("grounds the prompt in the section, the funder's requirements, the client, and the scope", async () => {
    const s = seam("ok");
    await generateSectionDraft(input({}), { createDraft: s.createDraft });
    const { system, user } = s.calls[0];
    // The section being drafted.
    expect(user).toContain("Problem Statement");
    // The step-4 requirements scaffold (an actual item from the artifact).
    expect(user).toContain("A project narrative of no more than 10 pages");
    expect(user).toContain("Need and significance (30 points)");
    // The substance: this client and their own scope.
    expect(user).toContain("Rivertown Community Health");
    expect(user).toContain("A mobile dental clinic for three rural counties");
    // The never-fabricate discipline is in the system prompt.
    expect(system).toMatch(/DO NOT FABRICATE/);
    expect(system).toMatch(/placeholder/i);
  });

  it("leads the client block with the distilled client_profile when present", async () => {
    const s = seam("ok");
    const client = {
      name: "Rivertown Community Health",
      client_profile: { summary: "A rural FQHC serving three tri-county service areas" },
    } as unknown as Client;
    await generateSectionDraft(input({ client }), { createDraft: s.createDraft });
    // The distilled profile's narrative signal reaches the model (via formatClientProfileForEnrichment).
    expect(s.calls[0].user).toContain("A rural FQHC serving three tri-county service areas");
  });

  it("falls back to structured fields when no distilled profile is on file", async () => {
    const s = seam("ok");
    await generateSectionDraft(input({}), { createDraft: s.createDraft }); // CLIENT has no client_profile
    expect(s.calls[0].user).toContain("No distilled client profile on file yet");
    expect(s.calls[0].user).toContain("Rivertown Community Health"); // still grounded on the name
  });

  it("includes the concept proposal grounding only when present", async () => {
    const withConcept = seam("ok");
    await generateSectionDraft(
      input({
        concept: {
          scope: "Deploy a mobile unit across the tri-county area",
          role: "prime",
          total_project_amount: "$1.2M (estimate)",
          estimated_match: null,
          project_term: "3 years",
          partners: [],
          hook: null,
        },
      }),
      { createDraft: withConcept.createDraft },
    );
    expect(withConcept.calls[0].user).toContain("Deploy a mobile unit across the tri-county area");

    const without = seam("ok");
    await generateSectionDraft(input({ concept: null }), { createDraft: without.createDraft });
    expect(without.calls[0].user).not.toContain("GRANTED-PREPARED CONCEPT");
  });
});
