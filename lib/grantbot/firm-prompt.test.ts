import { describe, it, expect } from "vitest";
import { buildFirmSystemPrompt } from "./firm-prompt";
import { buildFirmContextPack, type FirmPackClient } from "./firm-context-pack";
import { FIRM_GRANTBOT_INSTRUCTIONS } from "./firm-instructions";
import { GRANTED_ONBOARDING_BRIEF, GRANTED_REVIEW_CARD_SPEC } from "./firm-knowledge";
import type { PromptBlock } from "./prompt";

// Deterministic — no model. Locks the firm prompt's structural invariants:
//   ① the guardrails ARE Shannon's ported IntellEngine instructions, roster-wide + profiles-only.
//   ② his standing knowledge files (onboarding brief + review-card spec) are present, byte-identical.
//   ③ there is NO methodology block — deliberately dropped (his project has no such doc, and it would
//      assert grant-side context a profiles-only roster does not carry). See firm-prompt.ts.
//   ④ the shared (cacheable, client-free) blocks name no specific client.
//   ⑤ two cache breakpoints; the closing restatement is last and uncached.

function mk(over: Partial<FirmPackClient> = {}): FirmPackClient {
  return {
    id: "c1",
    name: "Ozark Health Collaborative",
    org_type: "nonprofit",
    status: "active",
    location_city: "Fayetteville",
    location_county: "Washington",
    location_state: "AR",
    service_area: ["Northwest Arkansas"],
    primary_funding_needs: ["workforce"],
    project_stage: "planning",
    annual_budget: "$1.2M",
    match_cost_share_capacity: "up to 20%",
    client_profile: null,
    client_profile_generated_at: null,
    intake_data: { mission: "We train rural healthcare workers." },
    profile_confirmed_at: null,
    updated_at: "2026-08-20T00:00:00Z",
    ...over,
  };
}

const pack = buildFirmContextPack({
  generatedAt: "2026-09-11T00:00:00Z",
  generatedBy: "shannon@grantedco.com",
  actorRole: "admin",
  clients: [mk(), mk({ id: "c2", name: "Delta Arts Council" })],
});

describe("buildFirmSystemPrompt", () => {
  const prompt = buildFirmSystemPrompt({ pack });
  const byKind = (k: string) => prompt.blocks.find((b) => b.kind === k);
  const allByKind = (k: string) => prompt.blocks.filter((b) => b.kind === k);

  it("uses Shannon's ported IntellEngine instructions as the guardrails (roster-wide, profiles-only)", () => {
    const g = byKind("guardrails")?.text ?? "";
    expect(g).toBe(FIRM_GRANTBOT_INSTRUCTIONS);
    // The first rule — the anti-over-indexing fix — is present verbatim.
    expect(g).toContain("MATCH THE RESPONSE TO THE ASK");
    // It is the generalist-operator frame, NOT the per-client "ONE client at a time" frame.
    expect(g).not.toContain("You work on ONE client at a time");
  });

  it("carries his standing knowledge files (onboarding brief + review-card spec), byte-identical", () => {
    const staff = allByKind("staff").map((b) => b.text);
    expect(staff).toContain(GRANTED_ONBOARDING_BRIEF);
    expect(staff).toContain(GRANTED_REVIEW_CARD_SPEC);
  });

  it("has NO methodology block — it was deliberately dropped for the firm bot", () => {
    expect(byKind("methodology")).toBeUndefined();
  });

  it("keeps the shared cacheable blocks free of any specific client name", () => {
    // isShared is guardrails-only here (methodology is gone). The shared span must not name a client,
    // or the cross-conversation breakpoint stops being reusable.
    const shared = prompt.blocks
      .filter((b) => b.kind === "guardrails")
      .map((b) => b.text)
      .join("\n");
    expect(shared).not.toContain("Ozark Health Collaborative");
    expect(shared).not.toContain("Delta Arts Council");
  });

  it("puts the roster (with client names) in the client-context block", () => {
    const roster = byKind("client-context")?.text ?? "";
    expect(roster).toContain("Ozark Health Collaborative");
    expect(roster).toContain("Delta Arts Council");
    // Framed as an on-demand reference, not standing context to analyze.
    expect(roster).toContain("REFERENCE");
    expect(roster).toContain("USE IT ON DEMAND, NOT BY DEFAULT");
  });

  it("closes with a read-only, match-the-ask restatement naming the client count", () => {
    const closing = byKind("closing")?.text ?? "";
    expect(closing).toContain("Read-only");
    expect(closing).toContain("MATCH THE RESPONSE TO THE ASK");
    expect(closing).toContain("2 active client");
    // Honest about the surface: the two read-only look-back tools are its ONLY tools, and it still
    // can't fetch a NOFO or send email (no fabricated fetch / send).
    expect(closing).toContain("list_firm_conversations");
    expect(closing).toContain("read_firm_conversation");
    expect(closing).toMatch(/still cannot fetch|cannot fetch a page/i);
  });

  it("assembles exactly two cache breakpoints, and the last (closing) block is uncached", () => {
    const withCache = prompt.system.filter((b) => b.cache_control);
    expect(withCache.length).toBe(2);
    expect(prompt.system[prompt.system.length - 1].cache_control).toBeUndefined();
  });

  it("reports client count, versions, and a manifest", () => {
    expect(prompt.clientCount).toBe(2);
    expect(prompt.knowledgeVersion).toBeTruthy();
    expect(prompt.instructionsVersion).toBeTruthy();
    const kinds = prompt.manifest.map((m) => m.kind);
    expect(kinds).toContain("guardrails");
    expect(kinds).toContain("staff");
    expect(kinds).not.toContain("methodology");
    expect(prompt.prefixChars).toBeGreaterThan(0);
  });
});

// The cross-thread tool how-to rides as a TURN BLOCK (firm-turn passes FIRM_CROSS_THREAD_INSTRUCTION_BLOCK).
// A distinct marker stands in for it so this pure test needs no import from the server-only tool module.
describe("buildFirmSystemPrompt — turn blocks (the cross-thread tool instruction)", () => {
  const marker = "ZZ_FIRM_TURN_BLOCK_MARKER";
  const crossThread: PromptBlock = { kind: "cross-thread", source: "test", version: "t", cacheable: false, text: marker };

  it("places a turn block after both breakpoints and before the (last) closing block, adding no breakpoint", () => {
    const prompt = buildFirmSystemPrompt({ pack, turnBlocks: [crossThread] });
    // Turn blocks never add a breakpoint — still exactly two.
    expect(prompt.system.filter((b) => b.cache_control).length).toBe(2);
    const markerIdx = prompt.system.findIndex((b) => b.text.includes(marker));
    expect(markerIdx).toBeGreaterThan(-1);
    // The closing restatement stays LAST; the turn block sits before it.
    expect(markerIdx).toBeLessThan(prompt.system.length - 1);
    expect(prompt.system[prompt.system.length - 1].text).not.toContain(marker);
    expect(prompt.manifest.map((m) => m.kind)).toContain("cross-thread");
  });

  it("rejects a turn block that claims cacheable (would silently make every turn a cache write)", () => {
    expect(() => buildFirmSystemPrompt({ pack, turnBlocks: [{ ...crossThread, cacheable: true }] })).toThrow();
  });

  it("omitting turn blocks is unchanged — no cross-thread block in system or manifest", () => {
    const prompt = buildFirmSystemPrompt({ pack });
    expect(prompt.manifest.map((m) => m.kind)).not.toContain("cross-thread");
    expect(prompt.system.some((b) => b.text.includes(marker))).toBe(false);
  });
});
