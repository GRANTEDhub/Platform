import { createHash, randomBytes } from "crypto";
import type { createServiceClient } from "@/lib/supabase/server";

// Access-token helpers for the portal-foundation token layer. The raw token is
// unguessable (256 bits) and is returned ONLY at mint time -- we persist just
// its sha256, so the raw value lives solely in the URL we hand out.
type DB = ReturnType<typeof createServiceClient>;

const DEFAULT_TTL_DAYS = 45; // outreach links live long enough for a prospect to act
const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // collapse scanner-prefetch + human click

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type AccessTokenRow = {
  id: string;
  action_type: string;
  prospect_id: string | null;
  client_id: string | null;
  grant_id: string | null;
  expires_at: string;
};

export async function mintAccessToken(
  db: DB,
  opts: {
    actionType: string;
    prospectId?: string | null;
    clientId?: string | null;
    grantId?: string | null;
    createdBy?: string | null;
    ttlDays?: number;
  },
): Promise<{ rawToken: string; id: string } | null> {
  const rawToken = generateToken();
  const expiresAt = new Date(
    Date.now() + (opts.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000,
  ).toISOString();

  const { data, error } = await db
    .from("access_tokens")
    .insert({
      token_hash: hashToken(rawToken),
      action_type: opts.actionType,
      prospect_id: opts.prospectId ?? null,
      client_id: opts.clientId ?? null,
      grant_id: opts.grantId ?? null,
      created_by: opts.createdBy ?? null,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("Failed to mint access token:", error);
    return null;
  }
  return { rawToken, id: data.id };
}

// Look up a raw token by its hash and enforce expiry + (optional) action match.
// Returns null for unknown / expired / wrong-action tokens.
export async function resolveToken(
  db: DB,
  rawToken: string,
  expectedAction?: string,
): Promise<AccessTokenRow | null> {
  const { data } = await db
    .from("access_tokens")
    .select("id, action_type, prospect_id, client_id, grant_id, expires_at")
    .eq("token_hash", hashToken(rawToken))
    .maybeSingle();

  const token = data as AccessTokenRow | null;
  if (!token) return null;
  if (new Date(token.expires_at).getTime() <= Date.now()) return null;
  if (expectedAction && token.action_type !== expectedAction) return null;
  return token;
}

// Append a pipeline event for a token, deduped within a short window so an email
// scanner prefetch + the human's real click don't double-count. Records the same
// subject the token points at; the raw click is the pipeline signal.
export async function recordPipelineEvent(
  db: DB,
  opts: {
    token: AccessTokenRow;
    eventType: string;
    subjectSnapshot?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const { data: recent } = await db
    .from("pipeline_events")
    .select("id")
    .eq("token_id", opts.token.id)
    .eq("event_type", opts.eventType)
    .gte("occurred_at", since)
    .limit(1);
  if (recent && recent.length > 0) return; // deduped

  const { error } = await db.from("pipeline_events").insert({
    event_type: opts.eventType,
    prospect_id: opts.token.prospect_id,
    client_id: opts.token.client_id,
    grant_id: opts.token.grant_id,
    token_id: opts.token.id,
    subject_snapshot: opts.subjectSnapshot ?? null,
    metadata: opts.metadata ?? null,
  });
  if (error) console.error("Failed to record pipeline event:", error);
}
