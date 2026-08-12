import { notFound } from "next/navigation";
import Link from "next/link";
import { Minimize2 } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { createServiceClient } from "@/lib/supabase/server";
import { gatherContextPack } from "@/lib/grantbot/gather";
import { buildSystemPrompt } from "@/lib/grantbot/prompt";
import { listConversations, loadMessages } from "@/lib/grantbot/store";
import { GrantBotChat } from "@/components/grantbot/grantbot-chat";

export const dynamic = "force-dynamic";

// GrantBot FULL PAGE: a conversation about ONE client, over the same context pack the previous
// brick made readable. Staff only.
//
// NOT THE FRONT DOOR ANY MORE. The corner launcher on the client record is where a question
// normally gets asked; this is the expanded view of that same conversation, reached by the panel's
// expand control (which carries ?c=<conversation>) or by a shared link. Same component in its
// `full` variant, same store, same turn route -- so there is one GrantBot with two amounts of
// room, not two implementations to keep in agreement.
//
// STILL ITS OWN ROUTE, like the pack, and for the same reason: it assembles a few thousand words
// before it can say anything, and the client record is a page staff open constantly. That is also
// why the corner panel does NOT assemble a pack -- see app/api/grantbot/context/route.ts.
//
// WHAT THIS PAGE PROVES BEFORE ANY MESSAGE IS SENT. It reports the assembled prompt's size, its
// two version stamps, and which spans are cached -- so the cost model of every future turn is on
// screen rather than inferred from a bill. The pack's own toggle remains the place to READ the
// prompt; this page is where it gets used.
export default async function GrantBotPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { c?: string };
}) {
  const profile = await requireUser();
  const db = createServiceClient();

  const gathered = await gatherContextPack({
    clientId: params.id,
    generatedBy: profile.email ?? "unknown",
    actorRole: profile.role === "admin" ? "admin" : "contractor",
    generatedAt: new Date().toISOString(),
  });
  if (!gathered) notFound();

  // Built here only for its SIZES and versions -- the turn route assembles its own copy at send
  // time, from the pack as it is then. Rendering a stale prompt into the page and reusing it for
  // the call would make a conversation answer from context that had since changed.
  const prompt = buildSystemPrompt({ pack: gathered.pack });

  const conversations = await listConversations(db, params.id);
  const active = searchParams.c
    ? conversations.find((c) => c.id === searchParams.c) ?? null
    : conversations[0] ?? null;
  const messages = active ? await loadMessages(db, active.id) : [];

  return (
    <div>
      <PageHeader
        title="GrantBot"
        description={`A conversation about ${gathered.clientName}, grounded in the platform's own record. Read-only: it cannot change anything here.`}
      />
      <div className="space-y-6 p-8">
        <div className="flex flex-wrap items-center gap-4">
          {/* COLLAPSE, not just Back: it returns to the client record with the panel reopened on
              this conversation, so expanding and collapsing is one continuous thread rather than
              a trip out and a fresh start. */}
          <Link
            href={`/clients/${params.id}?grantbot=${active?.id ?? "1"}`}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-navy/70 hover:text-brand-navy"
          >
            <Minimize2 className="h-3.5 w-3.5" /> Collapse to {gathered.clientName}
          </Link>
          <Link
            href={`/clients/${params.id}/context-pack`}
            className="text-[13px] font-medium text-brand-navy/70 hover:text-brand-navy"
          >
            Read the context it works from →
          </Link>
        </div>
        <GrantBotChat
          clientId={params.id}
          clientName={gathered.clientName}
          variant="full"
          initial={{
            conversationId: active?.id ?? null,
            conversations: conversations.map((c) => ({
              id: c.id,
              title: c.title,
              lastMessageAt: c.lastMessageAt,
            })),
            messages: messages.map((m) => ({
              id: m.id,
              role: m.role,
              text: m.content.map((c) => c.text).join("\n"),
              error: m.error,
              usage: m.usage,
              instructionsVersion: m.instructionsVersion,
              methodologyVersion: m.methodologyVersion,
            })),
          }}
          promptMeta={{
            prefixChars: prompt.prefixChars,
            sharedChars: prompt.sharedChars,
            instructionsVersion: prompt.instructionsVersion,
            methodologyVersion: prompt.methodologyVersion,
            gaps: gathered.pack.gaps.length,
          }}
        />
      </div>
    </div>
  );
}
