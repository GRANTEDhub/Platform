import { describe, it, expect } from "vitest";
import { applyHardConstraints, validateConstraint, deriveConstraintAction, type ClampableMatch } from "./constraints";
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
