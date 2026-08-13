import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { readApplicationRequirements } from "@/lib/grants/requirements";
import { PROPOSAL_SECTIONS } from "@/lib/intellengine/sections";
import {
  CONTENT_MAX_BYTES,
  normalizeSectionsForSave,
  readDraftContent,
} from "@/lib/intellengine/content";
import { generateSectionDraft } from "@/lib/intellengine/draft-section";
import type { Grant } from "@/types/database";

// Step 5a: draft one proposal section, grounded in the grant's step-4 application requirements, and
// write it into the draft's content.sections as source:"ai".
//
// STAFF-ONLY FOR THE MVP, BY THE AUTH GATE, NOT A FLAG -- identical to the requirements route it sits
// beside. This is a user-reachable LLM call; while PURSUIT_CLIENT_ACCESS_ENABLED is off only staff
// reach the build step, so requiring a profiles row converts it to "reachable from a staff request"
// and bounds the request rate. A non-staff caller gets 404 (route reads as absent), never 403. When
// the un-gate flips this open to clients, it inherits the same client-visibility consideration the
// requirements route flagged for APPLICATION_REQUIREMENTS_CLIENT_VISIBLE -- out of 5a scope.
//
// GROUNDED-OR-REFUSE. The drafter refuses without a model call when the step-4 requirements artifact
// is not real (never derived / not retrievable / empty); those come back as a typed reason the UI
// surfaces honestly ("derive requirements on the compliance step first"), never as an invented
// section. That is what makes step 5 depend on step 4 rather than wing it.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Staff = a profiles row (admin or contractor); a client portal member has none. 404 so the route
  // reads as absent to a non-staff caller rather than advertising a forbidden endpoint -- same gate
  // and reasoning as the requirements route.
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { sectionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const section = PROPOSAL_SECTIONS.find((s) => s.id === body.sectionId);
  if (!section) return NextResponse.json({ error: "Unknown section" }, { status: 400 });

  // Ownership + grant/client/concept resolution in one: the draft is read under the caller's RLS
  // (staff have full access via is_staff()) and the related rows are service-roled. A draft the
  // caller cannot see resolves to null -> 404.
  const ctx = await resolveIntellEngineContext(params.id);
  if (!ctx) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  // A from-scratch draft (no matched grant) has no NOFO to ground against. Honest refusal, not an
  // error -- there is simply nothing to draft from.
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
  });

  if (!result.ok) {
    // generation_failed is transient (retry); too_long can be retried; not_retrievable / no_requirements
    // are terminal-for-now and reported as an honest "can't ground this yet" at 200 so the UI shows the
    // message rather than an error toast.
    const status = result.reason === "generation_failed" ? 503 : result.reason === "too_long" ? 422 : 200;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }

  // Persist source:"ai" using the PATCH route's merge discipline: replace this one section, keep the
  // others (with their own source), normalize + bound, write under the caller's RLS. normalizeSections
  // ForSave re-reads through the tolerant reader (so a stored section is always shape-valid) and stamps
  // updatedAt server-side.
  const now = new Date().toISOString();
  const others = content.sections.filter((s) => s.id !== section.id);
  const norm = normalizeSectionsForSave(
    [...others, { id: section.id, draft: result.draft, source: "ai", updatedAt: now }],
    now,
  );
  if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });

  const merged = { ...content, sections: norm.value };
  if (JSON.stringify(merged).length > CONTENT_MAX_BYTES) {
    return NextResponse.json(
      { error: "This draft is too large to save. Shorten a section and try again." },
      { status: 413 },
    );
  }

  const { error } = await supabase.from("intellengine_drafts").update({ content: merged }).eq("id", params.id);
  if (error) return NextResponse.json({ error: "Couldn't save the draft" }, { status: 500 });

  const saved = norm.value.find((s) => s.id === section.id);
  return NextResponse.json({ ok: true, section: saved });
}
