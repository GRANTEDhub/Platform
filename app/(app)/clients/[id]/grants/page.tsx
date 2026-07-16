import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/ui/stat";
import { ClientGrantsBatch, type BatchUiCard } from "@/components/clients/client-grants-batch";
import { getSentAlertsByCards } from "@/lib/alerts/sent-status";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { senderFirstName } from "@/lib/alerts/sender";
import type { MatchCard } from "@/lib/grants/grouping";
import type { Client, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

// Surface the client's most actionable matches first: new (pending), then
// held, then decided.
const STATUS_ORDER: Record<string, number> = { pending: 0, hold: 1, approved: 2, passed: 3 };

// Supabase types a to-one embed as object or 1-element array; normalize.
function grantOf(g: MatchCard["grants"]): Pick<Grant, "title" | "funder" | "submission_deadline" | "deadline"> | null {
  if (!g) return null;
  return (Array.isArray(g) ? g[0] : g) ?? null;
}

export default async function ClientGrantsPage({
  params,
}: {
  params: { id: string };
}) {
  const profile = await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, org_type, engagement_tier, primary_contact_email, pipeline_stage")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "org_type" | "engagement_tier" | "primary_contact_email" | "pipeline_stage">>();
  if (!client) notFound();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "*, clients(id, name, org_type, engagement_tier), grants(id, title, funder, submission_deadline, deadline)",
    )
    .eq("client_id", params.id)
    .order("created_at", { ascending: false });

  const cards = ((data ?? []) as MatchCard[]).sort(
    (a, b) =>
      (STATUS_ORDER[a.decision] ?? 9) - (STATUS_ORDER[b.decision] ?? 9) ||
      b.fit_score - a.fit_score,
  );

  const count = (d: string) => cards.filter((c) => c.decision === d).length;

  // "Alerted" state per card (a sent grant_alerts row with a recipient), derived in
  // one batched query -- drives which rows show the alerted badge vs. a checkbox.
  const alerted = await getSentAlertsByCards(cards.map((c) => c.id));
  const alertedCardIds = [...alerted.keys()];

  const uiCards: BatchUiCard[] = cards.map((c) => {
    const g = grantOf(c.grants);
    return {
      id: c.id,
      title: g?.title ?? null,
      funder: g?.funder ?? null,
      deadline: g?.deadline ?? null,
      submission_deadline: g?.submission_deadline ?? null,
      fitScore: c.fit_score,
      decision: c.decision,
    };
  });

  return (
    <div>
      <PageHeader
        title={client.name}
        description="Grant activity — every match for this client and where it stands. Select pending matches to send as one aggregate alert."
        action={
          <Link href={`/clients/${client.id}`}>
            <Button variant="outline">Client profile</Button>
          </Link>
        }
      />
      <div className="space-y-6 p-8">
        <div className="grid grid-cols-3 gap-4">
          <Stat label="New" value={String(count("pending"))} hint="awaiting review" />
          <Stat label="Approved" value={String(count("approved"))} hint="cleared to send" />
          <Stat label="Rejected" value={String(count("passed"))} hint="passed" />
        </div>

        <ClientGrantsBatch
          clientId={client.id}
          clientName={client.name}
          recipient={client.primary_contact_email ?? ""}
          cards={uiCards}
          alertedCardIds={alertedCardIds}
          isLead={isUnconvertedLead(client.pipeline_stage)}
          senderName={senderFirstName({ full_name: profile.full_name, email: profile.email })}
        />
      </div>
    </div>
  );
}
