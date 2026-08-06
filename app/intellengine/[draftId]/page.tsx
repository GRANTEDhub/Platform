import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireClient } from "@/lib/auth";
import { requirePursuitVisible } from "@/lib/pursuit/access";
import { createClient } from "@/lib/supabase/server";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { resumeStep } from "@/lib/intellengine/drafts";
import type { IntellEngineDraft } from "@/types/database";

export const dynamic = "force-dynamic";

// Per-proposal landing (migration 0062). Opened from the hub list or straight
// from the Grant Report's "Write with IntellEngine". A matched-grant draft gets
// the grant-aware, two-tone heading ("Ready to draft <grant>?"); a from-scratch
// draft gets generic copy. "Get Started" / "Continue" routes to the flow step the
// draft has reached, carrying the draft id so each step can advance its status.
export default async function IntellEngineDraftLanding({ params }: { params: { draftId: string } }) {
  const { memberships } = await requireClient();
  await requirePursuitVisible();
  const org = memberships[0];
  const supabase = createClient();

  const { data: draft } = await supabase
    .from("intellengine_drafts")
    .select("id, card_id, title, status")
    .eq("id", params.draftId)
    .eq("client_id", org.clientId)
    .maybeSingle<Pick<IntellEngineDraft, "id" | "card_id" | "title" | "status">>();
  if (!draft) notFound();

  const isMatched = draft.card_id !== null;
  const inProgress = draft.status !== "scope";
  const step = resumeStep(draft.status);

  return (
    <HubShell variant="texture">
      <Link
        href="/intellengine"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        IntellEngine
      </Link>

      <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center sm:py-20">
        <IntellEngineLogo size="lg" />
        <h1 className="mt-8 font-serif text-3xl font-semibold leading-tight text-brand-navy sm:text-4xl">
          {isMatched ? (
            <>
              Ready to draft <span className="text-brand-orange">{draft.title}</span>?
            </>
          ) : (
            "Ready to draft your proposal?"
          )}
        </h1>
        <p className="mt-4 text-sm text-muted-foreground">
          IntellEngine is in preview — try it free while we build out proposal drafting. No charges yet.
        </p>
        <Link
          href={`/intellengine/${step}?draft=${draft.id}`}
          className="mt-8 rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep"
        >
          {inProgress ? "Continue where you left off" : "Get Started"}
        </Link>
      </div>
    </HubShell>
  );
}
