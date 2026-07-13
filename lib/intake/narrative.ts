// Single source of truth for the intake NARRATIVE capture -- the rich, refiner-
// facing free-text that both the public intake form and the admin client form
// collect into clients.intake_data. The shape, the (transport-agnostic) parser,
// and the strategicDump formatter all live here so route.ts, clients/actions.ts,
// and buildClientProfileInput never drift.
//
// This is the ENRICHMENT signal (post-#140): it feeds the profile refiner's
// priority bucket, NOT the occupancy scorer. Client-safe module (only imports the
// client-safe fields list) so the shared editor component can import it too.

import { PRIORITY_AREAS } from "@/lib/intake/fields";

export type NarrativeProgram = {
  name: string;
  description: string;
  serves: string; // who it serves / target demographics
  status: "existing" | "prospective";
};

export type NarrativeIntake = {
  funding_need: string;
  priority_areas: string[];
  mission: string;
  programs: NarrativeProgram[];
  partnerships: string;
  additional_info: string;
};

export const EMPTY_NARRATIVE: NarrativeIntake = {
  funding_need: "",
  priority_areas: [],
  mission: "",
  programs: [],
  partnerships: "",
  additional_info: "",
};

const cap = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

// Lenient, defensive parse for BOTH transports: the public JSON body (an object,
// or a stringified object) and the admin FormData hidden input (a JSON string).
// NEVER throws -- a malformed narrative must not block a client save, it degrades
// to EMPTY. Caps every string (the public endpoint is untrusted input) and filters
// priority_areas to the known list.
export function parseNarrative(input: unknown): NarrativeIntake {
  let obj: Record<string, unknown> = {};
  if (typeof input === "string") {
    if (input.trim()) {
      try {
        const p: unknown = JSON.parse(input);
        if (p && typeof p === "object") obj = p as Record<string, unknown>;
      } catch {
        return { ...EMPTY_NARRATIVE, programs: [], priority_areas: [] };
      }
    }
  } else if (input && typeof input === "object") {
    obj = input as Record<string, unknown>;
  }

  const priority_areas = Array.isArray(obj.priority_areas)
    ? obj.priority_areas.filter(
        (a): a is string => typeof a === "string" && PRIORITY_AREAS.includes(a),
      )
    : [];

  const programs: NarrativeProgram[] = Array.isArray(obj.programs)
    ? obj.programs
        .slice(0, 20) // bound the public endpoint
        .map((p) => {
          const r = (p ?? {}) as Record<string, unknown>;
          return {
            name: cap(r.name, 200),
            description: cap(r.description, 1000),
            serves: cap(r.serves, 300),
            status: r.status === "prospective" ? "prospective" : "existing",
          } as NarrativeProgram;
        })
        .filter((p) => p.name || p.description || p.serves)
    : [];

  return {
    funding_need: cap(obj.funding_need, 2000),
    priority_areas,
    mission: cap(obj.mission, 2000),
    programs,
    partnerships: cap(obj.partnerships, 2000),
    additional_info: cap(obj.additional_info, 2000),
  };
}

// The subset of keys written into clients.intake_data. Flat + stable so the
// refiner reads them directly and an admin edit MERGES them without clobbering
// non-narrative keys (phone, org_type_code, referral_source, submitted_at).
export function narrativeToIntakeData(n: NarrativeIntake): Record<string, unknown> {
  return {
    funding_need: n.funding_need || null,
    priority_areas: n.priority_areas,
    mission: n.mission || null,
    programs: n.programs,
    partnerships: n.partnerships || null,
    additional_info: n.additional_info || null,
  };
}

// Render the programs list for the refiner's strategicDump priority bucket.
// Reads the raw stored value (unknown) defensively so it is safe over any row.
export function formatProgramsForDump(programs: unknown): string | null {
  if (!Array.isArray(programs) || programs.length === 0) return null;
  const lines = programs
    .map((p) => {
      const r = (p ?? {}) as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const desc = typeof r.description === "string" ? r.description.trim() : "";
      const serves = typeof r.serves === "string" ? r.serves.trim() : "";
      const status = r.status === "prospective" ? "prospective" : "existing";
      if (!name && !desc && !serves) return null;
      const head = name || "(unnamed program)";
      const body = [desc, serves ? `serves: ${serves}` : ""].filter(Boolean).join("; ");
      return `  - [${status}] ${head}${body ? ` -- ${body}` : ""}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

// Build the editor's default value from a stored client row (admin edit prefill).
// priority_areas falls back to the primary_funding_needs column for clients
// created before intake_data existed (all current admin-created clients); values
// not in PRIORITY_AREAS cannot map to a checkbox and are dropped on next save.
export function narrativeFromClient(client: {
  intake_data: Record<string, unknown> | null;
  primary_funding_needs: string[] | null;
}): NarrativeIntake {
  const base = parseNarrative(client.intake_data ?? {});
  if (base.priority_areas.length === 0 && Array.isArray(client.primary_funding_needs)) {
    base.priority_areas = client.primary_funding_needs.filter((a) => PRIORITY_AREAS.includes(a));
  }
  return base;
}
