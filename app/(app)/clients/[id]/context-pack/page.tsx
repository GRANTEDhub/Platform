import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { gatherContextPack } from "@/lib/grantbot/gather";
import { renderMarkdown } from "@/lib/grantbot/context-pack";
import { buildSystemPrompt } from "@/lib/grantbot/prompt";
import PackClient from "./pack-client";

export const dynamic = "force-dynamic";

// The client context pack (GrantBot brick 0): everything the platform knows about one client,
// as markdown to copy or download.
//
// ITS OWN ROUTE, NOT A PANEL ON THE CLIENT PAGE. The pack runs seven queries and renders a few
// thousand words; inlining it would put that cost on every visit to a page staff open
// constantly. A separate route keeps that page unchanged, gives the pack a URL worth
// re-opening, and means a slow pack can never slow the client record down.
//
// requireUser, not requireAdmin: this reads what a staffer can already read. Documents and
// their commit history come through the CALLER's RLS inside gatherContextPack, so a
// contractor's pack contains a contractor's documents. Commercial and billing columns are not
// selected at all, for anyone.
//
// NO LLM RUNS HERE. The pack is assembly and rendering; the only judgement in it is which
// facts to include and how to label their age.
export default async function ContextPackPage({ params }: { params: { id: string } }) {
  const profile = await requireUser();

  // Generated once, server-side, and stamped into the document. The pack's dates are absolute
  // for exactly this reason: it will be read later than it was written, and a relative age
  // ("checked 7 days ago") frozen into a file goes false while still looking precise.
  const generatedAt = new Date().toISOString();

  const result = await gatherContextPack({
    clientId: params.id,
    generatedBy: profile.email ?? "unknown",
    actorRole: profile.role === "admin" ? "admin" : "contractor",
    generatedAt,
  });
  if (!result) notFound();

  const markdown = renderMarkdown(result.pack);
  // THE SECOND RENDERER, on the same page and over the same items, because that is the claim
  // worth being able to check: the document a human reads and the prompt GrantBot reads are two
  // views of one assembly, not two pipelines that could drift.
  //
  // Viewable before interactive, on purpose -- the same reason the pack shipped before any chat
  // machinery. A prompt you can read is a prompt you can correct; a prompt you can only infer
  // from answers is one you argue about.
  const systemPrompt = buildSystemPrompt({ pack: result.pack });
  const { stats, gaps } = result.pack;

  return (
    <div>
      <PageHeader
        title="Context pack"
        description={`Everything the platform knows about ${result.clientName}, with a source and a date on every line — as a document, or as the system prompt GrantBot would read.`}
      />
      <div className="space-y-6 p-8">
        <Link
          href={`/clients/${params.id}`}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-navy/70 hover:text-brand-navy"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to {result.clientName}
        </Link>
        <PackClient
          markdown={markdown}
          systemPrompt={systemPrompt.text}
          promptMeta={{
            instructionsVersion: systemPrompt.instructionsVersion,
            prefixChars: systemPrompt.prefixChars,
          }}
          clientName={result.clientName}
          generatedAt={generatedAt}
          counts={{
            documents: stats.documents,
            matches: stats.matches,
            detailedMatches: stats.detailedMatches,
            concepts: stats.concepts,
            drafts: stats.drafts,
            changes: stats.changes,
            gaps: gaps.length,
            words: markdown.split(/\s+/).filter(Boolean).length,
          }}
          dropped={stats.dropped}
        />
      </div>
    </div>
  );
}
