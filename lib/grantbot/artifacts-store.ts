import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The artifact store. I/O only, the same split as grantbot/store.ts over the pure modules: nothing
// here decides what a document SAYS, and the pure sanitiser/tool logic never touches the database.
//
// ── APPEND-ONLY, VIA THE ABSENCE OF A POLICY (0082) ──
//
// grantbot_artifacts / grantbot_artifact_versions have a staff SELECT policy and nothing else, so
// every write below runs on the service-role client (which bypasses RLS) and no API caller can
// rewrite a stored version. What the artifact history says was drafted is what was drafted.
//
// ── ROLLBACK IS A FORWARD WRITE, NEVER A REVERT ──
//
// A version is never mutated or deleted. `rollback` writes a NEW version whose html is a clone of an
// earlier one and bumps the head -- so the whole lineage stays inspectable, the same discipline as
// the transcript. `current_version` always points at the head.
//
// The HTML passed in here is expected to be ALREADY SANITISED (sanitizeDocument, applied in the tool
// handler on write). This module does not sanitise -- it persists what it is given -- so a caller
// that skips sanitisation is the bug, and the one write path (the tool handler) does not.

export interface ArtifactSummary {
  id: string;
  kind: string;
  title: string;
  currentVersion: number;
  updatedAt: string;
}

export interface ArtifactVersionMeta {
  version: number;
  summary: string | null;
  createdAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  html: string; // the CURRENT version's html; "" when current_version = 0
  versions: ArtifactVersionMeta[];
}

// Create a new artifact at version 1. Three ordered writes (artifact, version, head-bump); a partial
// failure leaves current_version = 0, which the read path treats as "no content yet" -- inspectable,
// never corrupting. Returns the new id + version.
export async function createArtifact(
  db: SupabaseClient,
  opts: {
    clientId: string;
    originConversationId: string | null;
    kind: string;
    title: string;
    html: string; // pre-sanitised
    createdBy?: string | null;
  },
): Promise<{ artifactId: string; version: number }> {
  const ins = await db
    .from("grantbot_artifacts")
    .insert({
      client_id: opts.clientId,
      origin_conversation_id: opts.originConversationId,
      kind: opts.kind,
      title: opts.title,
      current_version: 0,
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) throw new Error(`artifact insert failed: ${ins.error?.message ?? "no row"}`);
  const artifactId = ins.data.id as string;

  await insertVersion(db, { artifactId, version: 1, html: opts.html, summary: null, createdBy: opts.createdBy });
  await bumpHead(db, artifactId, 1);
  return { artifactId, version: 1 };
}

// Append a new version to an existing artifact and move the head to it. Verifies the artifact belongs
// to the given client (the tool handler only ever passes its own conversation's client) so a bad id
// cannot cross clients.
//
// The next version is derived from MAX(version) in the append-only versions table, NOT from the
// artifact row's `current_version`. The two normally agree, but the create/edit writes are three
// ordered statements (version insert, then head bump) with no transaction, so a bump that fails
// after its insert leaves `current_version` one behind the real head. Deriving `next` from the
// versions table self-heals that: it always lands one past the highest version that actually exists,
// so a retried edit can never collide with the unique(artifact_id, version) index and brick the
// document. (bumpHead is idempotent-safe here -- re-bumping to the same head is a no-op update.)
export async function editArtifact(
  db: SupabaseClient,
  opts: { artifactId: string; clientId: string; html: string; summary: string | null; createdBy?: string | null },
): Promise<{ artifactId: string; version: number }> {
  const cur = await db
    .from("grantbot_artifacts")
    .select("id, client_id")
    .eq("id", opts.artifactId)
    .maybeSingle();
  if (cur.error) throw new Error(`artifact read failed: ${cur.error.message}`);
  if (!cur.data || cur.data.client_id !== opts.clientId) {
    throw new Error("artifact not found for this client");
  }
  const next = (await maxVersion(db, opts.artifactId)) + 1;
  await insertVersion(db, { artifactId: opts.artifactId, version: next, html: opts.html, summary: opts.summary, createdBy: opts.createdBy });
  await bumpHead(db, opts.artifactId, next);
  return { artifactId: opts.artifactId, version: next };
}

// Roll back = a FORWARD write cloning an earlier version's html. Never a revert.
export async function rollbackArtifact(
  db: SupabaseClient,
  opts: { artifactId: string; clientId: string; toVersion: number; createdBy?: string | null },
): Promise<{ artifactId: string; version: number }> {
  const html = await getVersionHtml(db, opts.artifactId, opts.toVersion);
  if (html == null) throw new Error(`version ${opts.toVersion} not found`);
  return editArtifact(db, {
    artifactId: opts.artifactId,
    clientId: opts.clientId,
    html,
    summary: `Rolled back to version ${opts.toVersion}`,
    createdBy: opts.createdBy,
  });
}

async function insertVersion(
  db: SupabaseClient,
  opts: { artifactId: string; version: number; html: string; summary: string | null; createdBy?: string | null },
): Promise<void> {
  const { error } = await db.from("grantbot_artifact_versions").insert({
    artifact_id: opts.artifactId,
    version: opts.version,
    html: opts.html,
    summary: opts.summary,
    created_by: opts.createdBy ?? null,
  });
  if (error) throw new Error(`artifact version insert failed: ${error.message}`);
}

// Highest version that actually exists in the append-only versions table, or 0 if none. The source
// of truth for "what is the next version" -- see editArtifact for why this is not read off the
// artifact row's current_version.
async function maxVersion(db: SupabaseClient, artifactId: string): Promise<number> {
  const { data, error } = await db
    .from("grantbot_artifact_versions")
    .select("version")
    .eq("artifact_id", artifactId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`artifact max-version read failed: ${error.message}`);
  return data ? (data.version as number) : 0;
}

async function bumpHead(db: SupabaseClient, artifactId: string, version: number): Promise<void> {
  const { error } = await db
    .from("grantbot_artifacts")
    .update({ current_version: version, updated_at: new Date().toISOString() })
    .eq("id", artifactId);
  if (error) throw new Error(`artifact head bump failed: ${error.message}`);
}

// ── Reads (the panel + export routes). Run on the service client behind a route-level is_staff gate,
// mirroring the grantbot context route; RLS also restricts these to staff. ──

export async function listArtifacts(db: SupabaseClient, clientId: string): Promise<ArtifactSummary[]> {
  const { data, error } = await db
    .from("grantbot_artifacts")
    .select("id, kind, title, current_version, updated_at")
    .eq("client_id", clientId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`artifact list failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    title: r.title as string,
    currentVersion: r.current_version as number,
    updatedAt: r.updated_at as string,
  }));
}

export async function getArtifact(db: SupabaseClient, artifactId: string, clientId?: string): Promise<ArtifactDetail | null> {
  const { data: a, error } = await db
    .from("grantbot_artifacts")
    .select("id, client_id, kind, title, current_version, updated_at")
    .eq("id", artifactId)
    .maybeSingle();
  if (error) throw new Error(`artifact read failed: ${error.message}`);
  if (!a) return null;
  // Cross-client guard: staff can read any client's artifacts, but rendering one under the wrong
  // client's panel is a mislabel (the same concern the context route guards). Scope to the caller's
  // client when one is given.
  if (clientId && a.client_id !== clientId) return null;

  const { data: vs, error: vErr } = await db
    .from("grantbot_artifact_versions")
    .select("version, summary, created_at, html")
    .eq("artifact_id", artifactId)
    .order("version", { ascending: false });
  if (vErr) throw new Error(`artifact versions read failed: ${vErr.message}`);

  const currentVersion = a.current_version as number;
  const head = (vs ?? []).find((v) => (v.version as number) === currentVersion);
  return {
    id: a.id as string,
    kind: a.kind as string,
    title: a.title as string,
    currentVersion,
    updatedAt: a.updated_at as string,
    html: (head?.html as string | undefined) ?? "",
    versions: (vs ?? []).map((v) => ({
      version: v.version as number,
      summary: (v.summary as string | null) ?? null,
      createdAt: v.created_at as string,
    })),
  };
}

// Client-scoped fetch of one version's html (for exports). Returns null if absent or cross-client.
export async function getArtifactHtmlForClient(
  db: SupabaseClient,
  opts: { artifactId: string; clientId: string; version?: number },
): Promise<{ title: string; kind: string; version: number; html: string } | null> {
  const { data: a, error } = await db
    .from("grantbot_artifacts")
    .select("client_id, kind, title, current_version")
    .eq("id", opts.artifactId)
    .maybeSingle();
  if (error) throw new Error(`artifact read failed: ${error.message}`);
  if (!a || a.client_id !== opts.clientId) return null;
  const version = opts.version ?? (a.current_version as number);
  if (!version) return null;
  const html = await getVersionHtml(db, opts.artifactId, version);
  if (html == null) return null;
  return { title: a.title as string, kind: a.kind as string, version, html };
}

async function getVersionHtml(db: SupabaseClient, artifactId: string, version: number): Promise<string | null> {
  const { data, error } = await db
    .from("grantbot_artifact_versions")
    .select("html")
    .eq("artifact_id", artifactId)
    .eq("version", version)
    .maybeSingle();
  if (error) throw new Error(`artifact version read failed: ${error.message}`);
  return data ? (data.html as string) : null;
}
