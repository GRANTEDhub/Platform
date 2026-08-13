import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getArtifactHtmlForClient } from "./artifacts-store";
import { renderArtifactPdf, renderArtifactDocx } from "./artifact-render";
import { artifactExportFilename } from "./artifact-html";
import { sanitizeDocument } from "@/lib/sanitize/html";
import { uploadObject, getObjectInfo, signedUrl } from "@/lib/storage";

// The SHARED export scaffold (Brick 1b): one cache-keyed path that both the PDF and the .docx export
// flow through, so the two rendered formats don't duplicate storage/signing plumbing. The HTML
// download (1a) is served inline from the row and never touches this -- only the two RENDERED formats
// need caching, because rendering is the expensive step.
//
// ── CACHE = PURE FUNCTION OF (artifact, version, format) ──
//
// A rendered export is a pure function of the versioned, sanitised HTML, so it is cached in the
// private grantbot-artifacts bucket under a key that INCLUDES the version. A new version is a new
// key, which means invalidation is automatic: an edit produces v(n+1), whose exports simply miss the
// cache and render fresh, while v(n)'s cached objects are never served again (nothing points at them).
// No explicit purge, no stale render. On a cache HIT we skip rendering entirely and just re-sign.

export const GRANTBOT_ARTIFACTS_BUCKET = "grantbot-artifacts";

export type ExportFormat = "pdf" | "docx";

export function isExportFormat(v: string): v is ExportFormat {
  return v === "pdf" || v === "docx";
}

const CONTENT_TYPE: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const RENDERERS: Record<ExportFormat, (sanitizedHtml: string, title: string) => Promise<Buffer>> = {
  pdf: renderArtifactPdf,
  docx: renderArtifactDocx,
};

// Short-lived: the link is minted per download click and followed immediately by the redirect.
const EXPORT_URL_TTL_SECONDS = 300;

// exports/<artifactId>/v<version>/<format> -- version in the path is what makes the cache
// self-invalidating (see the header).
function exportKey(artifactId: string, version: number, format: ExportFormat): string {
  return `exports/${artifactId}/v${version}/${format}`;
}

// Produce (or reuse) the rendered export for one artifact version and return a short-lived signed URL
// that downloads it as a properly-named file. Returns null when the artifact/version doesn't exist or
// isn't this client's (getArtifactHtmlForClient enforces the client scope) -> the route 404s.
export async function exportArtifact(
  db: SupabaseClient,
  opts: { artifactId: string; clientId: string; version?: number; format: ExportFormat },
): Promise<{ signedUrl: string; filename: string } | null> {
  const got = await getArtifactHtmlForClient(db, {
    artifactId: opts.artifactId,
    clientId: opts.clientId,
    version: opts.version,
  });
  if (!got) return null;

  const key = exportKey(opts.artifactId, got.version, opts.format);
  const filename = artifactExportFilename(got.title, opts.format);

  // Render only on a cache miss. Re-sanitise on the way in (defense in depth, same as the read/HTML
  // routes) so the renderers never see anything but whitelisted structural markup.
  const cached = await getObjectInfo(GRANTBOT_ARTIFACTS_BUCKET, key);
  if (!cached) {
    const sanitized = sanitizeDocument(got.html);
    const bytes = await RENDERERS[opts.format](sanitized, got.title);
    await uploadObject(GRANTBOT_ARTIFACTS_BUCKET, key, bytes, CONTENT_TYPE[opts.format]);
  }

  // By here the object provably exists (cache hit, or just uploaded). signedUrl() swallows a signing
  // failure into null, so a null here means the SIGNING failed, NOT that the artifact is missing --
  // THROW so the route surfaces it as 502 "Export failed" rather than a misleading 404 "not found"
  // (which, because the object is now cached, would otherwise repeat on every retry). `null` is thus
  // reserved strictly for the genuine not-found above.
  const url = await signedUrl(GRANTBOT_ARTIFACTS_BUCKET, key, EXPORT_URL_TTL_SECONDS, { download: filename });
  if (!url) throw new Error(`signing the export URL failed for ${key}`);
  return { signedUrl: url, filename };
}
