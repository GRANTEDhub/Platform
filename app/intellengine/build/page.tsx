import { requireClientOrAdmin } from "@/lib/auth";
import { requirePursuitVisible } from "@/lib/pursuit/access";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { readDraftContent } from "@/lib/intellengine/content";
import IntellEngineBuildClient from "./build-client";

export const dynamic = "force-dynamic";

// Reads the draft's saved sections (0074) and hands them to the builder. This page used to
// resolve nothing at all -- the nine sections were hardcoded in the client component, so
// every visit opened the same example text and nothing a client typed survived the page.
//
// Via resolveIntellEngineContext rather than its own query, so the read goes through the
// same RLS-verified draft the scope step uses: a client can only ever load their own org's
// content, and a staff preview with no draft resolves to null and opens empty.
export default async function IntellEngineBuild({ searchParams }: { searchParams: { draft?: string } }) {
  await requireClientOrAdmin();
  await requirePursuitVisible();
  const ctx = await resolveIntellEngineContext(searchParams.draft);
  const saved = ctx ? readDraftContent(ctx.draft.content).sections : [];
  return <IntellEngineBuildClient draftId={searchParams.draft} saved={saved} />;
}
