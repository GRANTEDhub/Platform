import { describe, it, expect } from "vitest";
import {
  applyHardConstraints,
  validateConstraint,
  deriveConstraintAction,
  formatConstraintsForPrompt,
  type ClampableMatch,
} from "./constraints";
import type { Client, Grant, HardConstraint } from "@/types/database";

// The do_not_surface_for gate is the FIRST code-set suppression in the engine — every other
// hard "no" is model-produced. It must: suppress on a topic match, record a reason (never a
// silent drop), and no-op when the topic is absent.

const mk = (over: Partial<ClampableMatch> = {}): ClampableMatch => ({
  proposed_role: "Prime",
  recommended_prime: null,
  fit_score: 3,
  before_you_approve: [],
  suppressed: false,
  suppress_reason: null,
  // Positive model fit-narrative — the do_not_surface_for scrub must neutralize all of these on
  // suppress, and must leave them untouched otherwise.
  why_this_org: ["strong programmatic overlap"],
  concept_synopsis: "A concept for pursuing this grant.",
  reasoning_context: { fit_score_derivation: "seated as prime", why_this_org: "genuine fit" },
  factor_scores: { seat_role: { rating: "strong", rationale: "fits the seat" } },
  ...over,
});

const client = (constraints: HardConstraint[]) =>
  ({ name: "Arisa Health", hard_constraints: constraints }) as unknown as Pick<
    Client,
    "hard_constraints" | "name"
  >;

const grant = (over: Partial<Grant> = {}) =>
  ({
    program_type: null,
    title: "",
    focus_areas: [],
    delivery_model: null,
    description: null,
    ...over,
  }) as unknown as Pick<Grant, "program_type" | "title" | "focus_areas" | "delivery_model" | "description">;

const contraindication: HardConstraint = {
  type: "do_not_surface_for",
  value: "crisis, forensic",
  action: "suppress",
  note: "Exiting crisis/forensic service lines by 6/30/26.",
};

describe("do_not_surface_for — deterministic contraindication suppress", () => {
  it("suppresses a matching grant and records a reason (never a silent drop)", () => {
    const m = applyHardConstraints(mk(), client([contraindication]), grant({ title: "Crisis Stabilization Initiative", focus_areas: ["crisis response"] }));
    expect(m.suppressed).toBe(true);
    expect(m.suppress_reason).toContain("crisis");
    expect(m.suppress_reason).toContain("Arisa Health");
    // Visible + overridable: the before_you_approve line states the reason and the override path.
    expect(m.before_you_approve[0]).toContain("SUPPRESSED");
    expect(m.before_you_approve[0]).toContain("Override via manual add");
  });

  it("matches on the second topic term too (forensic)", () => {
    const m = applyHardConstraints(mk(), client([contraindication]), grant({ title: "Forensic Behavioral Health Program" }));
    expect(m.suppressed).toBe(true);
  });

  it("is a no-op when the grant does not match the contraindicated topic", () => {
    const m = applyHardConstraints(mk(), client([contraindication]), grant({ title: "Rural Housing Preservation Grant", focus_areas: ["housing"] }));
    expect(m.suppressed).toBe(false);
    expect(m.suppress_reason).toBeNull();
    expect(m.before_you_approve).toHaveLength(0);
    expect(m.fit_score).toBe(3); // untouched
    // Narrative preserved when the gate does NOT fire — the scrub is suppress-only.
    expect(m.why_this_org).toEqual(["strong programmatic overlap"]);
    expect(m.concept_synopsis).toBe("A concept for pursuing this grant.");
    expect(m.factor_scores).not.toBeNull();
  });

  it("SCRUBS the model's fit-narrative at the source on suppress (every consumer is clean)", () => {
    // The durable confidentiality fix: a suppressed do_not_surface_for match must carry NO
    // positive reasoning to any consumer (check-grant, a force-added card, the portal detail page),
    // because the model produced it unaware of the code suppression and may have echoed the
    // in-prompt confidential note into it.
    const m = applyHardConstraints(mk(), client([contraindication]), grant({ title: "Crisis Stabilization Initiative" }));
    expect(m.suppressed).toBe(true);
    expect(m.why_this_org).toEqual([]);
    expect(m.concept_synopsis).toBeNull();
    expect(m.factor_scores).toBeNull();
    // reasoning_context is replaced with a staff-only marker — no positive fit prose, no note echo.
    expect(m.reasoning_context).toEqual({
      fit_score_derivation: "Suppressed: contraindicated for this client (see before_you_approve).",
    });
    // The confidential note text must not survive in any narrative field the client can reach.
    expect(JSON.stringify({ why: m.why_this_org, concept: m.concept_synopsis, rc: m.reasoning_context, fs: m.factor_scores }))
      .not.toContain("6/30/26");
    // Staff still get the real reason.
    expect(m.suppress_reason).toContain("crisis");
    expect(m.before_you_approve[0]).toContain("SUPPRESSED");
  });

  it("does not touch suppression when the client has no constraints", () => {
    const m = applyHardConstraints(mk(), client([]), grant({ title: "Crisis Stabilization Initiative" }));
    expect(m.suppressed).toBe(false);
  });

  it("matches a MULTI-WORD term only as a phrase — a generic word in it can't over-suppress", () => {
    // The term is one phrase ("crisis intervention services"), NOT three OR'd tokens. A grant that
    // merely contains "services" must not be suppressed (the over-broad failure of whitespace-OR).
    const phrase: HardConstraint = {
      type: "do_not_surface_for",
      value: "crisis intervention services",
      action: "suppress",
      note: "Exiting this line.",
    };
    const unrelated = applyHardConstraints(
      mk(),
      client([phrase]),
      grant({ title: "Rural Transit Services Expansion", focus_areas: ["services"] }),
    );
    expect(unrelated.suppressed).toBe(false); // "services" alone does not fire the phrase
    const real = applyHardConstraints(
      mk(),
      client([phrase]),
      grant({ title: "Crisis Intervention Services Demonstration" }),
    );
    expect(real.suppressed).toBe(true); // the full phrase present → fires
  });

  it("matches on a word boundary — a short term does not fire inside an unrelated word", () => {
    const artExit: HardConstraint = {
      type: "do_not_surface_for",
      value: "art",
      action: "suppress",
      note: "Exiting arts programming.",
    };
    // "art" is a substring of "Department"/"Partnership" but not at a word boundary → no suppress.
    const collision = applyHardConstraints(
      mk(),
      client([artExit]),
      grant({ title: "Rural Broadband Partnership, Department of Commerce" }),
    );
    expect(collision.suppressed).toBe(false);
    // A real arts grant fires — leading \b also catches the "arts" morphological variant.
    const real = applyHardConstraints(mk(), client([artExit]), grant({ title: "Arts Education Access Program" }));
    expect(real.suppressed).toBe(true);
  });

  it("preserves a prior suppress_reason instead of clobbering it (audit trail)", () => {
    // Model set a Phase-0 structural suppression before the clamp ran; the contraindication must
    // append, not erase it — match_attempts.suppress_reason is the sole audit record.
    const m = mk({ suppressed: true, suppress_reason: "National single-award TTA competition." });
    const out = applyHardConstraints(m, client([contraindication]), grant({ title: "Crisis Stabilization Initiative" }));
    expect(out.suppressed).toBe(true);
    expect(out.suppress_reason).toContain("National single-award TTA");
    expect(out.suppress_reason).toContain("Do-not-surface");
  });
});

describe("do_not_surface_for — validation", () => {
  it("is a valid constraint type and derives the suppress action", () => {
    expect(deriveConstraintAction("do_not_surface_for")).toBe("suppress");
    const v = validateConstraint({
      type: "do_not_surface_for",
      value: "crisis, forensic",
      note: "Exiting these lines.",
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.constraint.action).toBe("suppress");
  });

  it("rejects a do_not_surface_for missing its value or note (fails closed)", () => {
    expect(validateConstraint({ type: "do_not_surface_for", value: "", note: "x" }).ok).toBe(false);
    expect(validateConstraint({ type: "do_not_surface_for", value: "crisis", note: "" }).ok).toBe(false);
  });

  it("keeps the confidential note OUT of the model prompt for do_not_surface_for", () => {
    // The note is staff-confidential; the model can echo it. It must not be injected into the
    // prompt — only the topic value + a neutral directive. Other constraint types still emit the
    // note (they are staff-review guidance, not injected into a client-reachable narrative).
    const prompt = formatConstraintsForPrompt(client([contraindication]));
    expect(prompt).not.toContain("6/30/26"); // the confidential note text
    expect(prompt).not.toContain("Exiting");
    expect(prompt).toContain("crisis, forensic"); // the topic value is fine
    expect(prompt.toLowerCase()).toContain("contraindication");
    // A non-confidential type still carries its note through.
    const withScreen = formatConstraintsForPrompt(
      client([{ type: "entity_screen", value: "all-male", action: "flag", note: "Confirm gender-inclusive." }]),
    );
    expect(withScreen).toContain("Confirm gender-inclusive.");
  });

  it("rejects a value whose every term is under 3 chars (a silently dead gate)", () => {
    // "AI"/"EV" tokenize to nothing under topicTerms → would suppress nothing. Fail at save time,
    // the same discipline the role_ceiling enum check applies.
    const dead = validateConstraint({ type: "do_not_surface_for", value: "AI, EV", note: "x" });
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.error).toContain("under 3 characters");
    // A mixed value with at least one usable term still validates.
    expect(validateConstraint({ type: "do_not_surface_for", value: "AI, forensic", note: "x" }).ok).toBe(true);
  });
});
