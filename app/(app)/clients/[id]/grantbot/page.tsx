import { notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Sparkles } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { BRAND } from "@/lib/brand";
import { createServiceClient } from "@/lib/supabase/server";
import { gatherContextPack } from "@/lib/grantbot/gather";
import { buildSystemPrompt } from "@/lib/grantbot/prompt";
import { listConversations, loadMessages } from "@/lib/grantbot/store";
import { GrantBotWorkspace } from "@/components/grantbot/grantbot-workspace";
import { GrantBotCollapse } from "@/components/grantbot/grantbot-collapse";
import { grantbotArtifactsEnabled } from "@/lib/grantbot/artifacts";
import { grantbotVisionEnabled } from "@/lib/grantbot/vision";
import { BLANK_CONVERSATION, toGrantBotMsg, toGrantBotThread } from "@/lib/grantbot/wire";

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
  // ?c=new IS AN EXPLICIT BLANK, and it has to be distinguishable from ?c missing. Absent
  // means "no preference, open the most recent thread" -- the front-door case. `new` means
  // the corner panel was sitting on a started-but-unsent conversation when Expand was
  // clicked; that thread has no server id yet, and falling back to conversations[0] there
  // dropped the user into the PREVIOUS conversation, which is the opposite of the
  // expand-keeps-your-place promise.
  const wantsBlank = searchParams.c === BLANK_CONVERSATION;
  const active = wantsBlank
    ? null
    : searchParams.c
      ? conversations.find((c) => c.id === searchParams.c) ?? null
      : conversations[0] ?? null;
  const messages = active ? await loadMessages(db, active.id) : [];

  const gaps = gathered.pack.gaps.length;

  return (
    // h-full + overflow-hidden, and every band below is shrink-0 except the chat. The app shell
    // gives <main> a definite height (flex-1 of an h-screen column), so h-full resolves here and
    // the page itself never scrolls -- which is what lets the transcript own its own scrollbar
    // instead of the document owning one for everything. NOTHING about the shell or the nav is
    // touched to achieve that.
    <div className="flex h-full flex-col overflow-hidden">
      {/* GrantBot's OWN header, in place of the generic PageHeader: this surface is one tool, not
          a page of records, and the mock gives it the ink band the launcher's header echoes. */}
      <header className="relative shrink-0 overflow-hidden bg-brand-navy px-10 pb-[18px] pt-6">
        {/* One drifting bloom, not the mock's two: the second is STAGE.approved's teal, and a
            stage colour means exactly one pipeline stage -- as decoration behind a chat header it
            would make the funnel unreadable everywhere else. Same BRAND.orangeGlow the corner
            panel uses, so the two headers are lit by the same light. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-[110px] left-[180px] h-[320px] w-[320px] rounded-full motion-safe:animate-bloom-drift"
          style={{ background: `radial-gradient(circle, ${BRAND.orangeGlow}, transparent 70%)` }}
        />
        <div className="relative flex flex-wrap items-center justify-between gap-5">
          <div className="flex items-center gap-3.5">
            <div className="relative h-10 w-10 shrink-0">
              <div
                aria-hidden="true"
                className="absolute inset-0 rounded-lg border-[1.5px] border-brand-orange motion-safe:animate-pulse-ring"
              />
              <div
                className="relative flex h-10 w-10 items-center justify-center rounded-lg"
                style={{ background: BRAND.orangeTileOnInk }}
              >
                <Sparkles className="h-5 w-5" style={{ color: BRAND.orange }} />
              </div>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-serif text-[27px] font-bold leading-none tracking-[-0.01em] text-white">
                  GrantBot
                </h1>
                {/* successOnDark, not `success`: green on navy. See lib/brand.ts. */}
                <span className="inline-flex items-center gap-1.5 rounded-pill bg-brand-successOnDark/15 py-[3px] pl-[7px] pr-2.5">
                  <span className="h-[5px] w-[5px] rounded-full bg-brand-successOnDark" />
                  <span className="font-mono text-[10px] font-semibold tracking-[0.02em] text-brand-successOnDark">
                    LIVE · GROUNDED
                  </span>
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] text-white/55">
                {gathered.clientName} <span className="text-white/30">·</span> read-only — it cannot
                edit the profile, run matching, or send anything
              </p>
            </div>
          </div>
          {/* THE VERSION STAMPS AND WHAT THE PREFIX COSTS. The mock keeps the two versions and
              drops the size read-out; the size stays, one chip further along, because
              cache-prefix behaviour is the thing brick 1 made visible on purpose and a figure
              nobody can see is a figure nobody checks. */}
          <div className="flex flex-wrap items-center gap-2.5">
            {[
              { label: "guardrails", value: prompt.instructionsVersion },
              { label: "methodology", value: prompt.methodologyVersion },
              {
                label: "cached prefix",
                value: `${prompt.prefixChars.toLocaleString()} ch · ${prompt.sharedChars.toLocaleString()} shared`,
              },
            ].map((chip) => (
              <span
                key={chip.label}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.14] px-2.5 py-1 font-mono text-[11px] text-white/40"
              >
                {chip.label} <span className="text-white/75">{chip.value}</span>
              </span>
            ))}
          </div>
        </div>
      </header>
      {/* The accent rule. Carries no type, so it is `orange` and not `orangeFill`. */}
      <div className="h-0.5 shrink-0 bg-brand-orange" />

      <div className="flex shrink-0 flex-wrap items-center gap-5 border-b border-hairline-strong bg-white px-10 py-[11px]">
        {/* COLLAPSE, not just Back: it returns to the client record with the panel reopened on
            this conversation, so expanding and collapsing is one continuous thread rather than
            a trip out and a fresh start. A client component because the conversation it must
            name can be created after this page renders -- see its header. */}
        <GrantBotCollapse
          clientId={params.id}
          clientName={gathered.clientName}
          fallbackConversationId={active?.id ?? null}
        />
        <Link
          href={`/clients/${params.id}/context-pack`}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:text-brand-navy"
        >
          Read the context it works from <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        {/* orangeDeep: 11.5px type on white, which brand orange cannot carry. */}
        {gaps > 0 && (
          <span
            className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] font-semibold"
            style={{ color: BRAND.orangeDeep }}
          >
            <AlertTriangle className="h-3 w-3" />
            {gaps} known gap{gaps === 1 ? "" : "s"} in what it knows about {gathered.clientName}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 px-10 pb-6 pt-5">
        {/* Workspace = chat + (flag-gated) document pane. artifactsEnabled off -> just the chat,
            byte-identical to the pre-1a page. */}
        <GrantBotWorkspace
          artifactsEnabled={grantbotArtifactsEnabled()}
          visionEnabled={grantbotVisionEnabled()}
          clientId={params.id}
          clientName={gathered.clientName}
          variant="full"
          initial={{
            conversationId: active?.id ?? null,
            conversations: conversations.map(toGrantBotThread),
            messages: messages.map(toGrantBotMsg),
          }}
          // Version stamps only: the chat tags each answer with them. The prefix size and the
          // gap count are this page's own header chips, above.
          promptMeta={{
            instructionsVersion: prompt.instructionsVersion,
            methodologyVersion: prompt.methodologyVersion,
          }}
        />
      </div>
    </div>
  );
}
