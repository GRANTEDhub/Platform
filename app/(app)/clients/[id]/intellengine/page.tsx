import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineHub, type HubDraft, type HubCandidate } from "@/components/intellengine/hub";
import type { Client, IntellEngineDraft, PursuitPath } from "@/types/database";

export const dynamic = "force-dynamic";

type GrantEmbed =
  | { title: string | null; funder: string | null }
  | { title: string | null; funder: string | null }[]
  | null;

function grantOf(g: GrantEmbed) {
  if (!g) return null;
  return Array.isArray(g) ? g[0] ?? null : g;
}

// Staff console mirror of the IntellEngine hub, scoped to a specific client
// (params.id). Same component + wizard the client uses, but staff-driven: creating
// a draft here targets THIS client and is DRAFT-ONLY -- it never records the
// client's pursuit decision (that stays an admin action via the pursuit chooser),
// so it never touches the admin-only approval trigger and a contractor can use it.
// Admin AND contractor (requireUser); the 0062 staff RLS scopes the reads/writes.
export default async function StaffIntellEngineHub({
  params,
  searchParams,
}: {
  params: { id: string };
  // ?start=<cardId> arrives from the dashboard's "Scope this one" — see the hub's
  // startCardId prop. An unknown id is harmless: the picker just opens in its normal
  // order, which is what it would have done anyway.
  searchParams?: { start?: string };
}) {
  await requireUser();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", params.id)
    .maybeSingle<Pick<Client, "id" | "name">>();
  if (!client) notFound();

  const { data: draftRows } = await supabase
    .from("intellengine_drafts")
    .select("id, card_id, title, status, content, updated_at")
    .eq("client_id", params.id)
    .order("updated_at", { ascending: false });

  const drafts: HubDraft[] = (
    (draftRows ?? []) as Pick<
      IntellEngineDraft,
      "id" | "card_id" | "title" | "status" | "content" | "updated_at"
    >[]
  ).map((d) => ({ id: d.id, title: d.title, status: d.status, content: d.content, updatedAt: d.updated_at }));

  // Staff picker -- BROADER than the client's own hub (which lists only grants the
  // client marked "Interested"): a grant the team has RELEASED to the client
  // (sme_released_at, account-managed) counts too, so an AM can develop a released
  // grant the client hasn't clicked through -- otherwise the picker is empty for a
  // managed client. Either gate qualifies; still awaiting a pursuit decision. The
  // picker offers the not-yet-routed ones; the count also includes ones already
  // routed to IntellEngine.
  const { data: cardRows } = await supabase
    .from("review_cards")
    .select("id, pursuit_path, decision, grants(title, funder)")
    .eq("client_id", params.id)
    .neq("card_type", "prospect")
    .or("interested_at.not.is.null,sme_released_at.not.is.null");

  type CardRow = { id: string; pursuit_path: PursuitPath | null; decision: string; grants: GrantEmbed };
  const cards = (cardRows ?? []) as CardRow[];
  // Cards that already have a draft. In staff (draft-only) mode we never set
  // pursuit_path, so unlike the client hub a developed card wouldn't drop out of the
  // picker on its own -- exclude it explicitly so it isn't re-offered (it's already
  // under "Your proposals").
  const draftedCardIds = new Set(
    ((draftRows ?? []) as { card_id: string | null }[]).map((d) => d.card_id).filter(Boolean),
  );
  const candidates: HubCandidate[] = cards
    .filter((c) => c.decision !== "passed" && c.pursuit_path === null && !draftedCardIds.has(c.id))
    .map((c) => {
      const g = grantOf(c.grants);
      return { cardId: c.id, title: g?.title || "Untitled opportunity", funder: g?.funder ?? null };
    });
  // Badge total: every non-passed matched grant with a live IntellEngine status --
  // undecided-or-being-drafted (pursuit_path null) OR already routed. Counting the
  // null bucket directly (rather than candidates + drafts) both credits an
  // in-progress staff draft (draft-only mode never sets pursuit_path) and avoids
  // double-counting a routed card that also has a draft.
  const orbitCount = cards.filter(
    (c) => c.decision !== "passed" && (c.pursuit_path === null || c.pursuit_path === "intellengine"),
  ).length;

  return (
    <HubShell variant="texture">
      <IntellEngineHub
        clientName={client.name}
        drafts={drafts}
        candidates={candidates}
        orbitCount={orbitCount}
        clientId={client.id}
        startCardId={searchParams?.start ?? null}
        backHref={`/clients/${client.id}`}
      />
    </HubShell>
  );
}
