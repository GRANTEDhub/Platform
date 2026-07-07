import { createServiceClient } from "@/lib/supabase/server";

// Supabase Storage helpers for private legal/document artifacts. The 'contracts'
// bucket is PRIVATE (migration 0030) -- all access is via the service role, and
// admin UIs receive short-lived signed URLs generated server-side. Never expose a
// bucket object as a public URL.

export const CONTRACTS_BUCKET = "contracts";

// Upload (upsert) a PDF buffer to a bucket path. Service-role, bypasses storage RLS.
export async function uploadPdf(bucket: string, objectPath: string, data: Buffer): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.storage.from(bucket).upload(objectPath, data, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}

// Download a private object as a Buffer (service-role). Used to re-attach a saved
// PDF to an email / stream it, without re-rendering.
export async function downloadPdf(bucket: string, objectPath: string): Promise<Buffer> {
  const db = createServiceClient();
  const { data, error } = await db.storage.from(bucket).download(objectPath);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message ?? "object not found"}`);
  return Buffer.from(await data.arrayBuffer());
}

// Remove objects from a bucket (service-role). Best-effort: a failure to delete a
// stale object shouldn't block replacing an alert draft.
export async function removeObjects(bucket: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const db = createServiceClient();
  await db.storage.from(bucket).remove(paths);
}

// Create a short-lived signed URL for an admin to download a private object.
// Returns null on failure so a missing file degrades to "no link" rather than
// throwing in a page render.
export async function signedUrl(
  bucket: string,
  objectPath: string,
  expiresInSeconds = 600,
): Promise<string | null> {
  const db = createServiceClient();
  const { data, error } = await db.storage.from(bucket).createSignedUrl(objectPath, expiresInSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}
