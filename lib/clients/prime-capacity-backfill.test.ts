import { describe, it, expect } from "vitest";
import { runPrimeCapacityBackfill, isFalseBucket, type Redistill } from "./prime-capacity-backfill";
import type { Client, ClientProfile } from "@/types/database";

// Deterministic plumbing tests: the re-distill seam is INJECTED, so no model call / no network. These prove
// bucket selection (only can_prime===false), dry-run-writes-nothing, apply-writes, flip accounting, the cap +
// resume, name filtering, and per-row error isolation. The distiller's classification quality is the eval.

const mkProfile = (canPrime: boolean | null): ClientProfile =>
  ({
    summary: "",
    mission: "",
    core_capabilities: [],
    program_areas: [],
    populations_served: [],
    geographic_scope: { footprint: "", scale: "regional", states: [] },
    prime_capacity: { can_prime: canPrime, rationale: "r" },
    supporting_roles: [],
    partnerships: [],
    funding_priorities: [],
    federal_history: { self_reported: "" },
    inferred: [],
    gaps: [],
  }) as ClientProfile;

const mkClient = (id: string, name: string, canPrime: boolean | null | "no-profile"): Client =>
  ({
    id,
    name,
    org_type: "nonprofit",
    client_profile: canPrime === "no-profile" ? null : mkProfile(canPrime),
  }) as unknown as Client;

// The injected re-distiller: deterministic per client NAME so a test can assert each flip direction.
const redistill: Redistill = async (client) => {
  if (client.name.includes("Funder")) return mkProfile(false); // genuine funder -> stays CANNOT
  if (client.name.includes("County")) return mkProfile(null); // implementer -> heals to UNKNOWN
  if (client.name.includes("Operator")) return mkProfile(true); // proven prime -> heals to CAN
  if (client.name.includes("Boom")) throw new Error("distill failed"); // error isolation
  return mkProfile(null);
};

// Minimal fake supabase client. Like supabase-js, the query builder is BOTH chainable and thenable: every
// builder method returns the chain, and awaiting it (`then`) executes. This matters because the module chains
// `.ilike` AFTER `.range` (PostgREST filter order is irrelevant), so `.range` must NOT be a terminal promise.
// Read chain: .select.not.order.range(.ilike?); write chain: .update.eq.eq.select. `select` starts a read only
// when op is still null (a write's terminal .select is a no-op because update() already set op="write").
function makeDb(clients: Client[]) {
  const writes: { id: string; profile: ClientProfile }[] = [];
  const profiled = clients.filter((c) => c.client_profile != null);
  const db = {
    from() {
      const s: {
        op: null | "read" | "write";
        nameLike?: string;
        from: number;
        to: number;
        updateVals?: { client_profile: ClientProfile };
        eqs: [string, string][];
      } = { op: null, from: 0, to: Number.MAX_SAFE_INTEGER, eqs: [] };
      const chain: Record<string, unknown> = {
        select(_c: string) {
          if (s.op === null) s.op = "read"; // read start; a write's .select terminal leaves op="write"
          return chain;
        },
        not: () => chain,
        ilike: (_c: string, v: string) => {
          s.nameLike = v;
          return chain;
        },
        order: () => chain,
        range: (f: number, t: number) => {
          s.from = f;
          s.to = t;
          return chain;
        },
        update: (v: { client_profile: ClientProfile }) => {
          s.op = "write";
          s.updateVals = v;
          return chain;
        },
        eq: (c: string, v: string) => {
          s.eqs.push([c, v]);
          return chain;
        },
        // Thenable terminal: awaiting the chain executes the read or the write.
        then(resolve: (r: { data: unknown; error: null }) => void, reject: (e: unknown) => void) {
          try {
            if (s.op === "write") {
              const id = s.eqs.find((e) => e[0] === "id")?.[1];
              const target = clients.find((c) => c.id === id);
              if (target && s.updateVals) writes.push({ id: id as string, profile: s.updateVals.client_profile });
              resolve({ data: target ? [{ id }] : [], error: null });
            } else {
              let rows = profiled;
              if (s.nameLike) {
                const needle = s.nameLike.replace(/%/g, "").toLowerCase();
                rows = rows.filter((c) => c.name.toLowerCase().includes(needle));
              }
              resolve({ data: rows.slice(s.from, s.to + 1), error: null });
            }
          } catch (e) {
            reject(e);
          }
        },
      };
      return chain;
    },
    __writes: writes,
  };
  return db;
}

const ROSTER = () => [
  mkClient("c1", "Funder Foundation", false), // bucket -> stay_cannot
  mkClient("c2", "Benton County", false), // bucket -> to_unknown
  mkClient("c3", "Acme Operator", false), // bucket -> to_can
  mkClient("c4", "Already Unknown", null), // NOT bucket
  mkClient("c5", "Proven Prime", true), // NOT bucket
  mkClient("c6", "No Profile Org", "no-profile"), // NOT profiled (excluded from read)
  mkClient("c7", "Boom Corp", false), // bucket -> error
];

describe("prime-capacity backfill", () => {
  it("isFalseBucket is STRICT === false (excludes null/true/no-profile)", () => {
    expect(isFalseBucket(mkClient("x", "x", false))).toBe(true);
    expect(isFalseBucket(mkClient("x", "x", null))).toBe(false);
    expect(isFalseBucket(mkClient("x", "x", true))).toBe(false);
    expect(isFalseBucket(mkClient("x", "x", "no-profile"))).toBe(false);
  });

  it("DRY-RUN: selects only the false bucket, writes nothing, and reports the flip split", async () => {
    const db = makeDb(ROSTER());
    const res = await runPrimeCapacityBackfill(db as never, { apply: false }, { redistill });
    expect(res.scanned).toBe(6); // profiled clients (c6 has no profile -> excluded)
    expect(res.falseBucket).toBe(4); // c1, c2, c3, c7
    expect(res.processed).toBe(4);
    expect(res.written).toBe(0); // dry run
    expect(db.__writes).toHaveLength(0);
    expect(res.flips).toEqual({ toUnknown: 1, toCan: 1, stayCannot: 1, errors: 1 });
  });

  it("APPLY: writes the healed profile for each non-erroring bucket client", async () => {
    const db = makeDb(ROSTER());
    const res = await runPrimeCapacityBackfill(db as never, { apply: true }, { redistill });
    expect(res.written).toBe(3); // c1, c2, c3 written; c7 errored -> not written
    expect(db.__writes.map((w) => w.id).sort()).toEqual(["c1", "c2", "c3"]);
    // The county's healed profile carries can_prime = null (UNKNOWN), not the old false.
    expect(db.__writes.find((w) => w.id === "c2")?.profile.prime_capacity.can_prime).toBeNull();
    // The genuine funder stays false (CANNOT) -- the funder guardrail holds through the backfill.
    expect(db.__writes.find((w) => w.id === "c1")?.profile.prime_capacity.can_prime).toBe(false);
  });

  it("CAP + resume: limit bounds the run and reports the remainder", async () => {
    const db = makeDb(ROSTER());
    const res = await runPrimeCapacityBackfill(db as never, { apply: true, limit: 2 }, { redistill });
    expect(res.processed).toBe(2); // c1, c2 (id order)
    expect(res.written).toBe(2);
    expect(res.remaining).toBe(2); // c3, c7 wait for the next run
  });

  it("error isolation: one failed distill is recorded, not written, and never aborts the batch", async () => {
    const db = makeDb(ROSTER());
    const res = await runPrimeCapacityBackfill(db as never, { apply: true }, { redistill });
    const boom = res.results.find((r) => r.name === "Boom Corp");
    expect(boom?.kind).toBe("error");
    expect(boom?.written).toBe(false);
    expect(boom?.error).toContain("distill failed");
    expect(res.flips.errors).toBe(1);
  });

  it("name filter narrows the bucket to matching clients", async () => {
    const db = makeDb(ROSTER());
    const res = await runPrimeCapacityBackfill(db as never, { apply: false, nameLike: "%county%" }, { redistill });
    expect(res.falseBucket).toBe(1); // only Benton County
    expect(res.results[0].kind).toBe("to_unknown");
  });

  it("pages the client scan to completeness (a short page is the last page)", async () => {
    const db = makeDb(ROSTER());
    const res = await runPrimeCapacityBackfill(db as never, { apply: false, pageSize: 2 }, { redistill });
    expect(res.scanned).toBe(6); // all profiled clients read across 3 pages, not just the first 2
    expect(res.falseBucket).toBe(4);
  });
});
