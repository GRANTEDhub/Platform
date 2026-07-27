// Display-only credibility snapshot for a discovered prospect ("just so we know").
//
// This is a READ-TIME annotation for the reviewer, NOT a ranking input. Capacity /
// size deliberately does NOT influence prospect selection or the fit score (a
// well-staffed org is both a better payer and less likely to need us; a scrappy one
// needs us most and can afford us -- the signal points both ways, so it's shown, not
// scored). The matcher has already run by the time this renders; nothing here feeds
// back into it.
//
// Everything is derived from data ALREADY persisted at discovery time:
//   - source_url deterministically identifies which source found the org
//       (usaspending.gov = a proven past-awardee; propublica.org = an IRS-registered
//        directory org with no federal history; anything else = a web skim hit).
//   - capability_summary is the machine-written one-liner the source already produced
//       (see awardeeCapabilitySummary / directoryCapabilitySummary), reused verbatim as
//       the supporting detail so a later human edit degrades gracefully to just the pill.

export type CredibilityTier = "proven" | "emerging" | "surfaced";

export interface CredibilitySnapshot {
  tier: CredibilityTier;
  label: string; // short pill text
  blurb: string; // one-line "legit because…" / "green because…" reason
  detail: string | null; // the fuller capability_summary, when present
}

export function prospectCredibility(input: {
  source_url: string | null;
  capability_summary: string | null;
}): CredibilitySnapshot {
  const url = (input.source_url ?? "").toLowerCase();
  const detail = (input.capability_summary ?? "").trim() || null;

  if (url.includes("usaspending.gov")) {
    return {
      tier: "proven",
      label: "Proven",
      blurb:
        "Has won federal grants under this program before — an established, eligible applicant with a track record.",
      detail,
    };
  }
  if (url.includes("propublica.org")) {
    return {
      tier: "emerging",
      label: "Emerging",
      blurb:
        "IRS-registered nonprofit in this grant's field with no federal award history on record — typically a smaller or newer org. Capability not yet verified.",
      detail,
    };
  }
  return {
    tier: "surfaced",
    label: "Web-surfaced",
    blurb:
      "Found in public web results; federal history and capacity have not been independently verified.",
    detail,
  };
}
