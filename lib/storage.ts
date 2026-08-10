import { createServiceClient } from "@/lib/supabase/server";

// Supabase Storage helpers for private legal/document artifacts. The 'contracts'
// bucket is PRIVATE (migration 0030) -- all access is via the service role, and
// admin UIs receive short-lived signed URLs generated server-side. Never expose a
// bucket object as a public URL.

export const CONTRACTS_BUCKET = "contracts";

// Client-uploaded documents (migration 0075). Private, like every bucket here, but with
// its own size and mime limits set ON THE BUCKET -- uploads arrive on a signed URL and go
// straight to storage, so our code never sees the bytes and storage is the only layer that
// can enforce anything about them.
export const CLIENT_UPLOADS_BUCKET = "client-uploads";

// Upload (upsert) bytes to a bucket path with an explicit content type. Service-role,
// bypasses storage RLS.
export async function uploadObject(
  bucket: string,
  objectPath: string,
  data: Buffer,
  contentType: string,
): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.storage.from(bucket).upload(objectPath, data, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}

// PDF upload, unchanged in behaviour and signature. Kept as its own function rather than
// folded into uploadObject's callers: the contract and alert paths are live, and 3a has no
// business editing them to add an argument they would always pass the same value for.
export async function uploadPdf(bucket: string, objectPath: string, data: Buffer): Promise<void> {
  return uploadObject(bucket, objectPath, data, "application/pdf");
}

// Mint a short-lived URL the CLIENT can PUT a file to directly.
//
// This is the transport for client uploads, and the reason is size: posting a file through
// a route would put it through a serverless function body (~4.5MB on Vercel), which a
// scanned 990 or audit exceeds routinely. Minting here keeps the membership check on the
// server -- 3b's route decides whether to mint at all -- while the bytes bypass us
// entirely, so no storage RLS is needed and no body limit applies.
//
// The returned token is a capability for exactly this one object path. It expires, and it
// is created only after the caller has been authorised, so it must never be minted for a
// path the requester has not been checked against.
export async function createSignedUploadUrl(
  bucket: string,
  objectPath: string,
): Promise<{ signedUrl: string; token: string }> {
  const db = createServiceClient();
  const { data, error } = await db.storage.from(bucket).createSignedUploadUrl(objectPath);
  if (error || !data) throw new Error(`Signed upload URL failed: ${error?.message ?? "no data"}`);
  return { signedUrl: data.signedUrl, token: data.token };
}

// The object's REAL size and content type, read back from storage.
//
// 3b's confirm step needs this because the client declared both in the mint request and a
// declaration is not evidence. The row is written from what storage actually holds, so a
// document's recorded size and type describe the object rather than the claim -- and the
// absence of an object is how confirm knows not to write a row at all.
//
// Returns null when the object is not there, which is the answer confirm acts on rather
// than an error to swallow.
export async function getObjectInfo(
  bucket: string,
  objectPath: string,
): Promise<{ size: number | null; contentType: string | null } | null> {
  const db = createServiceClient();
  const { data, error } = await db.storage.from(bucket).info(objectPath);
  if (error || !data) return null;
  // info() returns camelCased fields (Camelize<FileObjectV2>), and both are optional --
  // hence the narrowing rather than a cast.
  return {
    size: typeof data.size === "number" ? data.size : null,
    contentType: typeof data.contentType === "string" ? data.contentType : null,
  };
}

// Where a client's uploads live. CLIENT ID FIRST, on purpose: it makes every one of a
// client's objects removable by prefix (the cleanup in clients/actions.ts works off stored
// paths today, but a prefix delete is the fallback if a row is ever lost), and it is the
// segment a future storage policy would have to key on if direct-to-storage reads are ever
// wanted. `org` rather than a draft id marks the org-level documents, mirroring the null
// intellengine_draft_id that distinguishes them in the table.
export function clientUploadPath(opts: {
  clientId: string;
  draftId?: string | null;
  fileName: string;
}): string {
  const scope = opts.draftId ? `draft-${opts.draftId}` : "org";
  // A client-supplied filename reaches a storage path, so anything that could traverse or
  // confuse it is replaced rather than escaped: no separators, no leading dots, one dash
  // per run of anything unexpected. The uuid prefix keeps two uploads of "audit.pdf"
  // distinct without depending on the sanitised name being unique.
  const safe = opts.fileName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 120);
  return `${opts.clientId}/${scope}/${crypto.randomUUID()}-${safe || "file"}`;
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

// Remove a flat list of pointers that may span BUCKETS, grouping per bucket because
// removeObjects takes one bucket at a time. Extracted after review on #330 noted the draft
// cascade and the client cascade had each hand-rolled the same Map-and-loop.
//
// Best-effort like removeObjects itself: callers use this after the rows are already gone, so
// a stranded object is invisible rather than a failure worth reporting.
export async function removeObjectsGrouped(
  objects: { storage_bucket: string | null; storage_path: string | null }[],
): Promise<void> {
  const byBucket = new Map<string, string[]>();
  for (const o of objects) {
    if (!o.storage_bucket || !o.storage_path) continue;
    const list = byBucket.get(o.storage_bucket);
    if (list) list.push(o.storage_path);
    else byBucket.set(o.storage_bucket, [o.storage_path]);
  }
  for (const [bucket, paths] of byBucket) {
    await removeObjects(bucket, paths);
  }
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
