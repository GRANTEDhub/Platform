// IRS exempt-organization directory (Track 2 prospecting, #208b) via the ProPublica
// Nonprofit Explorer API. The ENUMERATION source the web skim and USASpending
// past-awardees miss: real Arkansas nonprofits in a grant's field that have little or
// no federal history (so they're absent from USASpending) and are too small to surface
// in a topical web search -- exactly the "capable-but-under-resourced, hasn't-won-big"
// ideal client. Live query, no key, no migration, no cron. Graceful: every call
// degrades to [] on failure so discovery falls back to the other sources.
//
// Deliberately NO revenue gate: the search endpoint returns all exempt orgs regardless
// of size, including brand-new / zero-revenue startups, which we want. Size stratifies
// by SAMPLING across the result set (stride sample) rather than taking the top slice,
// so the slate isn't dominated by whatever ProPublica ranks first. (The search endpoint
// carries no financials; per-org revenue would need the detail endpoint -- a possible
// v2 enrichment for the carded survivors, noted in #208.)

import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import type { Grant } from "@/types/database";

const PP_BASE = "https://projects.propublica.org/nonprofits/api/v2";

// ProPublica's ntee[id] filter uses 10 NTEE major-group buckets (1-10).
export const NTEE_GROUPS: Record<number, string> = {
  1: "Arts, Culture & Humanities",
  2: "Education",
  3: "Environment & Animals",
  4: "Health",
  5: "Human Services",
  6: "International & Foreign Affairs",
  7: "Public & Societal Benefit",
  8: "Religion-Related",
  9: "Mutual / Membership Benefit",
  10: "Unknown / Unclassified",
};

// Standard NTEE letter -> major-group label (for a human-readable classification on
// each org, since org.ntee_code is a letter+number like "X20", not a group id).
function nteeLetterLabel(code: string | null): string | null {
  const letter = (code ?? "").trim().charAt(0).toUpperCase();
  if (!letter) return null;
  if (letter === "A") return NTEE_GROUPS[1];
  if (letter === "B") return NTEE_GROUPS[2];
  if ("CD".includes(letter)) return NTEE_GROUPS[3];
  if ("EFGH".includes(letter)) return NTEE_GROUPS[4];
  if ("IJKLMNOP".includes(letter)) return NTEE_GROUPS[5];
  if (letter === "Q") return NTEE_GROUPS[6];
  if ("RSTUVW".includes(letter)) return NTEE_GROUPS[7];
  if (letter === "X") return NTEE_GROUPS[8];
  if (letter === "Y") return NTEE_GROUPS[9];
  return NTEE_GROUPS[10];
}

export interface DirectoryOrg {
  ein: number;
  name: string;
  city: string | null;
  state: string | null;
  ntee_code: string | null;
  subseccd: number | null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// One ProPublica search page (25 orgs) for a state + NTEE major group. Bare filter,
// no query term, so results are the directory's own ordering -- we stride-sample the
// page rather than trust that ordering to be size-neutral. Graceful [] on any failure.
async function fetchDirectoryPage(nteeId: number, state?: string): Promise<DirectoryOrg[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const params = new URLSearchParams();
    if (state) params.set("state[id]", state);
    params.set("ntee[id]", String(nteeId));
    const res = await fetch(`${PP_BASE}/search.json?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const orgs: Record<string, unknown>[] = data.organizations ?? [];
    return orgs
      .map((o) => ({
        ein: Number(o.ein),
        name: String(o.name ?? "").trim(),
        city: (o.city as string) ?? null,
        state: (o.state as string) ?? null,
        ntee_code: ((o.ntee_code as string) || (o.raw_ntee_code as string)) ?? null,
        subseccd: typeof o.subseccd === "number" ? o.subseccd : null,
      }))
      .filter((o) => o.ein && o.name);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// Enumerate directory orgs for the given NTEE major groups in one state. One page per
// group, stride-sampled to `sample` orgs each (spread across the page, not the top
// slice), deduped by EIN across groups. Returns [] if nothing resolves.
export async function findDirectoryOrgs(
  nteeIds: number[],
  opts: { state?: string; sample?: number } = {},
): Promise<DirectoryOrg[]> {
  const ids = Array.from(new Set(nteeIds.filter((n) => Number.isInteger(n) && n >= 1 && n <= 10)));
  if (ids.length === 0) return [];
  const sample = opts.sample ?? 8;

  const pages = await Promise.all(ids.map((id) => fetchDirectoryPage(id, opts.state)));
  const seenEin = new Set<number>();
  const out: DirectoryOrg[] = [];
  for (const page of pages) {
    if (page.length === 0) continue;
    const stride = Math.max(1, Math.floor(page.length / sample));
    let picked = 0;
    for (let i = 0; i < page.length && picked < sample; i += stride) {
      const o = page[i];
      if (seenEin.has(o.ein)) continue;
      seenEin.add(o.ein);
      out.push(o);
      picked += 1;
    }
  }
  return out;
}

export function directorySourceUrl(o: DirectoryOrg): string {
  return `https://projects.propublica.org/nonprofits/organizations/${o.ein}`;
}

export function directoryOrgType(o: DirectoryOrg): string {
  if (o.subseccd === 3) return "501(c)(3) nonprofit";
  if (o.subseccd) return `501(c)(${o.subseccd}) organization`;
  return "Tax-exempt organization";
}

// Honest one-line summary for the scorer: what the directory actually tells us (name,
// locality, IRS classification) and, explicitly, what it does NOT (program capability
// unverified). Flags the verification gap so a directory lead is never mistaken for a
// web-confirmed profile.
export function directoryCapabilitySummary(o: DirectoryOrg): string {
  const where = o.city ? `${titleCase(o.city)}, AR` : "Arkansas";
  const sub = o.subseccd === 3 ? "501(c)(3)" : o.subseccd ? `501(c)(${o.subseccd})` : "tax-exempt";
  const label = nteeLetterLabel(o.ntee_code);
  const cls = o.ntee_code
    ? `IRS classification ${o.ntee_code}${label ? ` (${label})` : ""}`
    : "IRS-registered exempt organization";
  return `Arkansas-based ${sub} nonprofit in ${where}. ${cls}. Surfaced from the IRS exempt-organization directory (ProPublica Nonprofit Explorer) as a locally based candidate in this grant's field; program capability not yet independently verified.`;
}

const NTEE_SYSTEM = `You map a U.S. federal grant to the NTEE major-group categories of the NONPROFIT ORGANIZATIONS that would APPLY for it (the applicant type, not the funding agency).

The 10 NTEE major groups:
1. Arts, Culture & Humanities
2. Education
3. Environment & Animals
4. Health
5. Human Services
6. International & Foreign Affairs
7. Public & Societal Benefit (community/economic development, public safety, civil rights, philanthropy)
8. Religion-Related (churches, faith-based ministries and their nonprofits)
9. Mutual / Membership Benefit
10. Unknown / Unclassified

Pick the 1-3 groups whose nonprofits are the most likely eligible applicants. Prefer 1-2; use 3 only when the grant genuinely spans distinct sectors. Return them via the submit_ntee tool, most-likely first.`;

// Derive NTEE major-group ids (1-10) for a grant via a small LLM call. Used only to
// aim the ProPublica query at the right slice of the directory. Graceful: returns []
// on any failure so discovery proceeds with its other sources.
export async function deriveNteeGroups(grant: Grant): Promise<number[]> {
  try {
    const profile = grant.ideal_applicant_profile;
    const summary = [
      `Title: ${grant.title ?? "Untitled"}`,
      grant.funder ? `Funder: ${grant.funder}` : "",
      (grant.focus_areas || []).length ? `Focus areas: ${(grant.focus_areas || []).join(", ")}` : "",
      (grant.eligible_entity_types || []).length
        ? `Eligible entity types: ${(grant.eligible_entity_types || []).join(", ")}`
        : "",
      profile?.core_funded_role ? `Core funded role: ${profile.core_funded_role}` : "",
      profile?.summary ? `Applicant profile: ${profile.summary}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      temperature: 0,
      system: NTEE_SYSTEM,
      tools: [
        {
          name: "submit_ntee",
          description: "Return the 1-3 best-fit NTEE major-group ids. Call exactly once.",
          input_schema: {
            type: "object",
            properties: {
              group_ids: { type: "array", items: { type: "integer", minimum: 1, maximum: 10 } },
            },
            required: ["group_ids"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_ntee" },
      messages: [{ role: "user", content: summary }],
    });
    const toolUse = resp.content.find((b) => b.type === "tool_use");
    const ids =
      toolUse && toolUse.type === "tool_use"
        ? ((toolUse.input as { group_ids?: number[] }).group_ids ?? [])
        : [];
    return Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n >= 1 && n <= 10))).slice(0, 3);
  } catch (err) {
    console.error("[deriveNteeGroups] failed:", err);
    return [];
  }
}
