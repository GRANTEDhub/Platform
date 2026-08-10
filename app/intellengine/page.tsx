import { requireClient } from "@/lib/auth";
import { requirePursuitVisible } from "@/lib/pursuit/access";
import { createClient } from "@/lib/supabase/server";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineHub, type HubDraft, type HubCandidate } from "@/components/intellengine/hub";
import type { IntellEngineDraft, PursuitPath } from "@/types/database";

export const dynamic = "force-dynamic";

type GrantEmbed = { title: string | null; funder: string | null } | { title: string | null; funder: string | null }[] | null;

function grantOf(g: GrantEmbed) {
  if (!g) return null;
  return Array.isArray(g) ? g[0] ?? null : g;
}

// IntellEngine hub -- the client's self-serve proposal workspace (migration 0062).
// Replaces the old static "Ready to draft?" landing: lists every proposal in
// flight (matched OR from scratch) with its status, plus the two entry points
// (develop a matched grant / start from scratch). Client-scoped: requireClient
// gives us the org, and everything reads under the caller's RLS. Staff previewing
// the mocked flow reach the individual steps directly; the hub itself is a
// client surface (it needs a client's real drafts + matches).
export default async function IntellEngineHubPage() {
  const { memberships } = await requireClient();
  await requirePursuitVisible();
  const org = memberships[0];
  const supabase = createClient();

  const { data: draftRows } = await supabase
    .from("intellengine_drafts")
    .select("id, card_id, title, status, content, updated_at")
    .eq("client_id", org.clientId)
    .order("updated_at", { ascending: false });

  const drafts: HubDraft[] = ((draftRows ?? []) as Pick<
    IntellEngineDraft,
    "id" | "card_id" | "title" | "status" | "content" | "updated_at"
  >[]).map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    content: d.content,
    updatedAt: d.updated_at,
  }));

  // Matched grants in the client's Report, past the Grant Alerts gate. Chip A's
  // count (per Shannon) = grants still awaiting a pursuit decision PLUS grants
  // already routed to IntellEngine; its picker offers the not-yet-started ones.
  const { data: cardRows } = await supabase
    .from("review_cards")
    .select("id, pursuit_path, decision, grants(title, funder)")
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect")
    .not("interested_at", "is", null);

  type CardRow = { id: string; pursuit_path: PursuitPath | null; decision: string; grants: GrantEmbed };
  const cards = (cardRows ?? []) as CardRow[];

  const candidates: HubCandidate[] = cards
    .filter((c) => c.decision !== "passed" && c.pursuit_path === null)
    .map((c) => {
      const g = grantOf(c.grants);
      return { cardId: c.id, title: g?.title || "Untitled opportunity", funder: g?.funder ?? null };
    });
  const routedCount = cards.filter((c) => c.pursuit_path === "intellengine").length;
  const orbitCount = candidates.length + routedCount;

  return (
    <HubShell variant="texture">
      <IntellEngineHub
        clientName={org.clientName}
        drafts={drafts}
        candidates={candidates}
        orbitCount={orbitCount}
      />
    </HubShell>
  );
}
