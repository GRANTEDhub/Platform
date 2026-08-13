import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
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
//                          download URL per client_visible attachment (files stay separate -- the
//                          right shape for Grants.gov's per-slot uploads).
//
// STAFF-ONLY BY THE AUTH GATE, same as the requirements / draft-section routes: a profiles row or
// 404. Reused import-only -- renderArtifactPdf/Docx (multi-page as-is), sanitizeDocument, signedUrl.
// render.ts is not touched or imported here. No migration, no persistence: render-on-demand, and
// attachments are already in the client-uploads bucket.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
  // the draft above). client_visible mirrors what the client is entitled to see (0075).
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
  const docs = (docRows ?? []) as DocRow[];
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
    const links = await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        title: d.title,
        contentType: d.content_type,
        sizeBytes: d.size_bytes,
        scope: d.intellengine_draft_id ? ("draft" as const) : ("org" as const),
        url: await signedUrl(d.storage_bucket, d.storage_path, 600, { download: d.title }),
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
