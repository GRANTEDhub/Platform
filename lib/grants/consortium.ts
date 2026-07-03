import type { IdealApplicantProfile } from "@/types/database";

// Feature A: detect when two+ roster clients occupy COMPLEMENTARY seats on the
// same grant (one primes, another supports) so they can be surfaced as a
// potential joint pursuit. Pure read-time aggregation over data the matcher
// already produced -- no scoring here.
//
// seat_ref encodes the archetype: P{i} = prime under archetype i, S{i}_{j} =
// supporting seat j under archetype i (built in engine.ts buildSeatMenu).
// Complementarity is ONLY within the SAME archetype index: a P0 prime pairs with
// an S0_x supporter, NEVER S1_x -- different archetypes are different consortium
// shapes, not partners.

export interface SeatedClient {
  clientId: string;
  clientName: string | null;
  fitScore: number | null;
  proposedRole: string | null;
  seatRef: string;
}

export interface ConsortiumPairing {
  archetypeIndex: number;
  archetypeLabel: string | null;
  primes: SeatedClient[];
  supporting: SeatedClient[];
}

const PRIME_RE = /^P(\d+)$/;
const SUPPORTING_RE = /^S(\d+)_\d+$/;

function parseSeat(seatRef: string): { kind: "prime" | "supporting"; arch: number } | null {
  const p = PRIME_RE.exec(seatRef);
  if (p) return { kind: "prime", arch: Number(p[1]) };
  const s = SUPPORTING_RE.exec(seatRef);
  if (s) return { kind: "supporting", arch: Number(s[1]) };
  return null; // NONE / unparseable -> not seated, cannot pair
}

// A pairing exists for an archetype only when at least one client occupies its
// PRIME seat AND at least one other occupies a SUPPORTING seat under the SAME
// archetype. 3+ clients across multiple archetypes yield one pairing per
// qualifying archetype (an archetype with only primes, or only supporters, is
// not a pairing -- there is no complement). Deterministic; sorted by archetype.
export function computeConsortiumPairings(
  seated: SeatedClient[],
  profile: IdealApplicantProfile | null,
): ConsortiumPairing[] {
  const byArch = new Map<number, { primes: SeatedClient[]; supporting: SeatedClient[] }>();
  for (const c of seated) {
    const parsed = parseSeat(c.seatRef);
    if (!parsed) continue;
    let bucket = byArch.get(parsed.arch);
    if (!bucket) {
      bucket = { primes: [], supporting: [] };
      byArch.set(parsed.arch, bucket);
    }
    (parsed.kind === "prime" ? bucket.primes : bucket.supporting).push(c);
  }

  const archetypes = profile?.archetypes ?? [];
  const pairings: ConsortiumPairing[] = [];
  for (const [arch, bucket] of [...byArch.entries()].sort((a, b) => a[0] - b[0])) {
    if (bucket.primes.length > 0 && bucket.supporting.length > 0) {
      pairings.push({
        archetypeIndex: arch,
        archetypeLabel: archetypes[arch]?.label ?? null,
        primes: bucket.primes,
        supporting: bucket.supporting,
      });
    }
  }
  return pairings;
}
