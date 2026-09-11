import { describe, it, expect } from "vitest";
import { buildFirmSystemPrompt } from "./firm-prompt";
import { buildFirmContextPack, type FirmPackClient } from "./firm-context-pack";
import { GRANTBOT_METHODOLOGY } from "./methodology";
import { FIRM_GRANTBOT_INSTRUCTIONS } from "./firm-instructions";

// Deterministic — no model. Locks the firm prompt's structural invariants:
//   ① methodology is reused BYTE-IDENTICAL from the per-client bot (reasoning cannot drift).
//   ② the ONLY fork is scope — firm guardrails, roster-wide + profiles-only.
//   ③ the shared (cacheable, client-free) blocks name no specific client.
//   ④ two cache breakpoints; the closing restatement is last and uncached.

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

  it("reuses the methodology BYTE-IDENTICAL from the per-client bot", () => {
    expect(byKind("methodology")?.text).toBe(GRANTBOT_METHODOLOGY);
  });

  it("uses the firm guardrails, and they are the roster-wide + profiles-only fork", () => {
    const g = byKind("guardrails")?.text ?? "";
    expect(g).toBe(FIRM_GRANTBOT_INSTRUCTIONS);
    expect(g).toContain("ACROSS GRANTED's active client roster");
    expect(g).toContain("PROFILES ONLY");
    // The fork must NOT carry the per-client "ONE client at a time" frame.
    expect(g).not.toContain("You work on ONE client at a time");
  });

  it("keeps the shared cacheable blocks free of any specific client name", () => {
    const shared = prompt.blocks
      .filter((b) => b.kind === "guardrails" || b.kind === "methodology")
      .map((b) => b.text)
      .join("\n");
    expect(shared).not.toContain("Ozark Health Collaborative");
    expect(shared).not.toContain("Delta Arts Council");
  });

  it("puts the roster (with client names) in the client-context block", () => {
    const roster = byKind("client-context")?.text ?? "";
    expect(roster).toContain("Ozark Health Collaborative");
    expect(roster).toContain("Delta Arts Council");
  });

  it("closes with a read-only, profiles-only restatement naming the client count", () => {
    const closing = byKind("closing")?.text ?? "";
    expect(closing).toContain("Read-only");
    expect(closing).toContain("PROFILES ONLY");
    expect(closing).toContain("2 client");
  });

  it("assembles exactly two cache breakpoints, and the last (closing) block is uncached", () => {
    const withCache = prompt.system.filter((b) => b.cache_control);
    expect(withCache.length).toBe(2);
    expect(prompt.system[prompt.system.length - 1].cache_control).toBeUndefined();
  });

  it("reports client count and a manifest", () => {
    expect(prompt.clientCount).toBe(2);
    expect(prompt.manifest.map((m) => m.kind)).toContain("methodology");
    expect(prompt.prefixChars).toBeGreaterThan(0);
  });
});
