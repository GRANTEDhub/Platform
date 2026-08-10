import { requireClientOrAdmin } from "@/lib/auth";
import { requirePursuitVisible } from "@/lib/pursuit/access";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { scopeSeedFrom } from "@/lib/intellengine/prepopulate";
import { readDraftContent } from "@/lib/intellengine/content";
import IntellEngineScopeClient from "./scope-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineScope({
  searchParams,
}: {
  searchParams: { draft?: string; from?: string };
}) {
  await requireClientOrAdmin();
  await requirePursuitVisible();
  // Seed from the client's OWN saved scope (0074) -> the released concept proposal (premium)
  // -> grant hints -> blank. Resolves null for a staff preview (no client draft under RLS),
  // which lands on a blank canvas.
  const ctx = await resolveIntellEngineContext(searchParams.draft);
  const saved = ctx ? readDraftContent(ctx.draft.content).scope : null;
  const seed = scopeSeedFrom(ctx?.concept ?? null, ctx?.grant ?? null, saved);
  // Staff-aware back target (passed by the console hub). Accept ONLY a clean
  // internal path so the value can't smuggle an off-origin target into an <a href>.
  const backHref = safeInternalPath(searchParams.from);
  return <IntellEngineScopeClient draftId={searchParams.draft} seed={seed} backHref={backHref} />;
}

// A safe same-origin path only. Must start with a single "/" and contain only
// ordinary path characters. This rejects a protocol-relative "//host", a
// backslash-smuggled "/\host" (WHATWG resolves it like "//host" for http(s), so a
// naive prefix check is bypassable), control characters, and anything else that
// could resolve off-origin when rendered as an <a href>.
function safeInternalPath(v: string | undefined): string | undefined {
  if (!v || v.startsWith("//")) return undefined;
  return /^\/[A-Za-z0-9\-._~/]+$/.test(v) ? v : undefined;
}
