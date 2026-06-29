// Group match cards by the organization they belong to.
//
// Today the org is always an active client (card.clients). The grouping is
// written against a small "org" abstraction so a future Sales / prospect
// surface can reuse it by supplying prospect-backed cards, without changing
// this logic. Prospecting is intentionally out of scope right now -- this only
// groups client cards; nothing here surfaces prospects.

import type { ReviewCard, Client, Grant } from "@/types/database";

export type MatchCard = ReviewCard & {
  clients: Pick<Client, "id" | "name" | "org_type" | "engagement_tier"> | null;
  grants: Pick<
    Grant,
    "id" | "title" | "funder" | "submission_deadline" | "deadline"
  > | null;
};

export interface OrgMatchGroup {
  orgId: string;
  orgName: string;
  orgSubtitle: string | null;
  newCount: number; // pending (un-triaged) cards
  totalCount: number;
  cards: MatchCard[];
}

export function groupCardsByOrg(cards: MatchCard[]): OrgMatchGroup[] {
  const map = new Map<string, OrgMatchGroup>();

  for (const card of cards) {
    const org = card.clients;
    if (!org) continue; // unlinked card -- skip until it has an org

    let group = map.get(org.id);
    if (!group) {
      group = {
        orgId: org.id,
        orgName: org.name,
        orgSubtitle:
          org.engagement_tier || org.org_type?.replace(/_/g, " ") || null,
        newCount: 0,
        totalCount: 0,
        cards: [],
      };
      map.set(org.id, group);
    }

    group.cards.push(card);
    group.totalCount += 1;
    if (card.decision === "pending") group.newCount += 1;
  }

  // Most new matches first (where the day's attention goes), then alphabetical.
  return [...map.values()].sort(
    (a, b) => b.newCount - a.newCount || a.orgName.localeCompare(b.orgName),
  );
}
