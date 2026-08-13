import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStaffUser } from "@/lib/pursuit/access";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { readApplicationRequirements } from "@/lib/grants/requirements";
import { PROPOSAL_SECTIONS } from "@/lib/intellengine/sections";
import { readDraftContent } from "@/lib/intellengine/content";
import { generateSectionDraft } from "@/lib/intellengine/draft-section";
import type { Grant } from "@/types/database";

// Step 5b: the per-section assist thread's PREVIEW turn. Given a staff instruction + the section's
// current text, return a grounded REVISION -- and NOTHING is written. The conversation is ephemeral
// (client-side); only when the staffer ACCEPTS does the builder write the section as source:"ai"
// through its normal save path (the same discipline 5a's Regenerate uses). So this route mints no
// rows and persists nothing -- no new store, no schema. Reuses 5a's grounded-generation primitive
// and its input gate: no real step-4 requirements artifact -> refuse and never call the model.
//
// Staff-only via the shared gate. render.ts untouched.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const gate = await requireStaffUser(supabase);
  if (!gate.ok) return gate.response;

  let body: { sectionId?: string; instruction?: string; currentDraft?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const section = PROPOSAL_SECTIONS.find((s) => s.id === body.sectionId);
  if (!section) return NextResponse.json({ error: "Unknown section" }, { status: 400 });
  const instruction = (body.instruction ?? "").trim();
  if (!instruction) return NextResponse.json({ error: "An instruction is required" }, { status: 400 });

  const ctx = await resolveIntellEngineContext(params.id);
  if (!ctx) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const grant = ctx.grant as Grant | null;
  if (!grant) return NextResponse.json({ ok: false, reason: "no_grant" });

  const content = readDraftContent(ctx.draft.content);
  const result = await generateSectionDraft({
    grantTitle: grant.title,
    grantFunder: grant.funder,
    requirements: readApplicationRequirements(grant.application_requirements),
    client: ctx.client,
    scope: content.scope,
    concept: ctx.concept,
    section,
    instruction,
    // The current text to revise: what the composer holds (may be an unaccepted prior revision), or
    // the stored section as a fallback.
    currentDraft: body.currentDraft ?? content.sections.find((s) => s.id === section.id)?.draft ?? "",
  });

  if (!result.ok) {
    const status = result.reason === "generation_failed" ? 503 : result.reason === "too_long" ? 422 : 200;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }
  // PREVIEW ONLY -- the revised text goes back to the thread, not the database.
  return NextResponse.json({ ok: true, draft: result.draft });
}
