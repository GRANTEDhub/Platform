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
export default async function StaffIntellEngineHub({ params }: { params: { id: string } }) {
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
    .select("id, card_id, title, status, updated_at")
    .eq("client_id", params.id)
    .order("updated_at", { ascending: false });

  const drafts: HubDraft[] = (
    (draftRows ?? []) as Pick<IntellEngineDraft, "id" | "card_id" | "title" | "status" | "updated_at">[]
  ).map((d) => ({ id: d.id, title: d.title, status: d.status, updatedAt: d.updated_at }));

  // Same candidate logic as the client hub: matched grants past the Grant Alerts
  // gate (interested), awaiting a pursuit decision -- the picker offers the
  // not-yet-started ones; the count also includes ones already routed to IntellEngine.
  const { data: cardRows } = await supabase
    .from("review_cards")
    .select("id, pursuit_path, decision, grants(title, funder)")
    .eq("client_id", params.id)
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
        clientName={client.name}
        drafts={drafts}
        candidates={candidates}
        orbitCount={orbitCount}
        clientId={client.id}
        backHref={`/clients/${client.id}`}
      />
    </HubShell>
  );
}
