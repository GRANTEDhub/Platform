import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { resolveDocumentActor, canReadDocument } from "@/lib/documents/authorize";
import { readApplicationRequirements } from "@/lib/grants/requirements";
import { readDraftContent } from "@/lib/intellengine/content";
import { sanitizeDocument } from "@/lib/sanitize/html";
import { renderArtifactPdf, renderArtifactDocx } from "@/lib/grantbot/artifact-render";
import { signedUrl } from "@/lib/storage";
import {
  assembleSubmissionHtml,
  buildManifest,
  submissionFilename,
  type ExportAttachment,
} from "@/lib/intellengine/export";
import type { Grant } from "@/types/database";

// Step 6 (export MVP): assemble a completed pursuit into a filable submission package.
//
//   ?format=pdf | docx  -> the assembled NARRATIVE document (cover + manifest + scope + the 9
//                          sections + requirements appendix + attachment listing), rendered via the
//                          reused artifact renderers. Returns the bytes as a download.
//   ?format=links       -> JSON for the UI panel: the completeness manifest + one short-lived signed
//                          download URL per attachment the caller may read (files stay separate --
//                          the right shape for Grants.gov's per-slot uploads).
//
// STAFF-ONLY, and NOT a bare profiles-row check for the attachments: this route service-role-reads
// client_documents including ORG-LEVEL firm records (signed contracts, 990s), so it must apply the
// same per-document firewall the RLS it bypasses would -- resolveDocumentActor + canReadDocument
// (lib/documents/authorize.ts). A non-admin contractor may read a pursuit's own uploads but NOT the
// org-level firm records, exactly as app/api/client-documents/[id]/url does. Reused import-only --
// renderArtifactPdf/Docx (multi-page as-is), sanitizeDocument, signedUrl. render.ts not imported.
// No migration, no persistence: render-on-demand.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // Resolve the actor's ROLE, not just existence -- a contractor has a profiles row too, and the
  // attachment read below reaches admin-only org-level documents. 404 (not 403) for a non-staff
  // caller, so the route reads as absent, matching the sibling IntellEngine routes.
  const actor = await resolveDocumentActor();
  if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!actor.isStaff) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const format = req.nextUrl.searchParams.get("format") ?? "pdf";
  if (format !== "pdf" && format !== "docx" && format !== "links") {
    return NextResponse.json({ error: "Unknown format" }, { status: 400 });
  }

  const ctx = await resolveIntellEngineContext(params.id);
  if (!ctx) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const grant = ctx.grant as Grant | null;
  const content = readDraftContent(ctx.draft.content);
  const requirements = readApplicationRequirements(grant?.application_requirements);

  // Attachments: the client_visible client_documents for this pursuit -- both the draft's own uploads
  // (intellengine_draft_id = draftId) and reusable org-level firm records (intellengine_draft_id is
  // null). Read under the service role, scoped to the draft's client (RLS already proved ownership of
  // the draft above).
  const svc = createServiceClient();
  const { data: docRows, error: docsError } = await svc
    .from("client_documents")
    .select("id, title, content_type, size_bytes, storage_bucket, storage_path, intellengine_draft_id")
    .eq("client_id", ctx.draft.client_id)
    .eq("client_visible", true)
    .or(`intellengine_draft_id.eq.${params.id},intellengine_draft_id.is.null`);
  // HONESTY: a failed attachment read must NOT render as "no attachments." A false zero could let
  // staff file an incomplete federal submission believing there were none. Fail loudly instead --
  // the panel shows its "couldn't load" state, never a false-complete package. Guards BOTH the links
  // and the document formats, since both derive their attachment view from this read.
  if (docsError) {
    console.error(`[intellengine-export] attachments read failed draft=${params.id}: ${docsError.message}`);
    return NextResponse.json({ error: "Couldn't load attachments — try again." }, { status: 500 });
  }

  type DocRow = {
    id: string;
    title: string;
    content_type: string | null;
    size_bytes: number | null;
    storage_bucket: string;
    storage_path: string;
    intellengine_draft_id: string | null;
  };
  // THE FIREWALL: this route bypasses RLS (service role), so it applies canReadDocument itself. A
  // non-admin contractor may read a pursuit's own uploads but NOT org-level firm records (990s, signed
  // contracts) -- the same admin bar the sibling /client-documents/[id]/url route enforces. client_id
  // and client_visible are fixed by the query above (all rows are this client's + client_visible), so
  // the only per-row discriminator canReadDocument needs is intellengine_draft_id.
  const docs = ((docRows ?? []) as DocRow[]).filter((d) =>
    canReadDocument(actor, {
      client_id: ctx.draft.client_id,
      client_visible: true,
      intellengine_draft_id: d.intellengine_draft_id,
    }),
  );
  const attachments: ExportAttachment[] = docs.map((d) => ({
    id: d.id,
    title: d.title,
    contentType: d.content_type,
    sizeBytes: d.size_bytes,
    scope: d.intellengine_draft_id ? "draft" : "org",
  }));

  // ── Links mode: manifest + signed URLs for the panel. No render. ──────────────────────────────
  if (format === "links") {
    const manifest = buildManifest(content, requirements, attachments);
    // docs and attachments are index-aligned (same source, same order, no filtering between), so the
    // links map only needs the storage fields ExportAttachment intentionally omits -- from docs[i].
    const links = await Promise.all(
      attachments.map(async (a, i) => ({
        ...a,
        url: await signedUrl(docs[i].storage_bucket, docs[i].storage_path, 600, { download: docs[i].title }),
      })),
    );
    return NextResponse.json({ manifest, attachments: links });
  }

  // ── Document mode: assemble -> sanitize -> render. Refuse only the truly-empty draft. ─────────
  const manifest = buildManifest(content, requirements, attachments);
  if (manifest.empty) {
    return NextResponse.json(
      { error: "Nothing to assemble yet — add a scope of work or draft a section first." },
      { status: 422 },
    );
  }

  const body = assembleSubmissionHtml({
    clientName: ctx.client?.name ?? "Client",
    grantTitle: grant?.title ?? null,
    grantFunder: grant?.funder ?? null,
    content,
    requirements,
    attachments,
    generatedAt: new Date().toISOString().slice(0, 10),
  });
  // Sanitised through the SAME locked engine as the artifact preview -- defense in depth even though
  // the assembly emits only whitelisted tags.
  const sanitized = sanitizeDocument(body);
  const title = grant?.title ? `${grant.title} — submission package` : "Submission package";

  const buffer =
    format === "pdf" ? await renderArtifactPdf(sanitized, title) : await renderArtifactDocx(sanitized, title);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${submissionFilename(grant?.title ?? null, format)}"`,
      "Cache-Control": "no-store",
    },
  });
}
