import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { readApplicationRequirements } from "@/lib/grants/requirements";
import { PROPOSAL_SECTIONS } from "@/lib/intellengine/sections";
import {
  CONTENT_MAX_BYTES,
  normalizeSectionsForSave,
  readDraftContent,
  type DraftSection,
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

  // Persist source:"ai" with OPTIMISTIC CONCURRENCY. The bug this closes: draft-section is a second,
  // uncoordinated writer of the whole `content` column, outside the builder's useDraftSave chain that
  // serialises the client's own PATCH saves. Re-reading current content just before the write (rather
  // than merging into the pre-LLM snapshot) already stops the multi-second clobber -- but the read →
  // merge → write is still not atomic, so a client autosave landing in that tiny window would be lost
  // silently (regenerateSection skips touch(), so nothing re-saves it). We compare-and-swap on
  // updated_at (a real column with a before-update bump trigger, 0062): the write only lands if the
  // row has not changed since we read it; if a concurrent save moved it, we re-read, RE-MERGE this one
  // section onto the newer content, and retry. So a racing edit is rebased onto, never overwritten.
  let savedSection: DraftSection | undefined;
  let committed = false;
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
    const { data: fresh } = await supabase
      .from("intellengine_drafts")
      .select("content, updated_at")
      .eq("id", params.id)
      .maybeSingle<{ content: unknown; updated_at: string }>();
    // Deleted mid-generation (the delete route cascades documents): nothing to write back to.
    if (!fresh) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    const current = readDraftContent(fresh.content);

    const now = new Date().toISOString();
    const others = current.sections.filter((s) => s.id !== section.id);
    const norm = normalizeSectionsForSave(
      [...others, { id: section.id, draft: result.draft, source: "ai", updatedAt: now }],
      now,
    );
    if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });

    const merged = { ...current, sections: norm.value };
    if (JSON.stringify(merged).length > CONTENT_MAX_BYTES) {
      return NextResponse.json(
        { error: "This draft is too large to save. Shorten a section and try again." },
        { status: 413 },
      );
    }

    // CAS: only update the row we read. eq("updated_at", ...) fails to match (0 rows) if another
    // write bumped it between our read and this write.
    const { data: rows, error } = await supabase
      .from("intellengine_drafts")
      .update({ content: merged })
      .eq("id", params.id)
      .eq("updated_at", fresh.updated_at)
      .select("id");
    if (error) return NextResponse.json({ error: "Couldn't save the draft" }, { status: 500 });
    if (rows && rows.length > 0) {
      savedSection = norm.value.find((s) => s.id === section.id);
      committed = true;
      break;
    }
    // Lost the CAS: a concurrent save landed. Re-read and re-merge (no LLM call, so this is cheap).
  }

  // Only when a fast typist keeps committing through every retry. The section was generated fine; the
  // client can regenerate again once their edits settle.
  if (!committed) {
    return NextResponse.json(
      { ok: false, reason: "conflict", error: "Your draft was changing while this generated — try again in a moment." },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, section: savedSection });
}

// Bounded re-merge attempts under the optimistic-concurrency CAS. Each retry is a cheap re-read +
// re-merge (no model call); the bound stops a client editing without pause from holding the request
// open. In practice one pass succeeds -- a second write racing the exact read/write gap is rare.
const MAX_MERGE_ATTEMPTS = 4;
