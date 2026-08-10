// What a client may upload, and the bounds it must fit (Pursuit step 3b).
//
// PURE and client-safe, so the upload UI (3c/3d) and the routes validate against one list.
//
// DELIBERATELY BROAD. These are categories a client can pick from without hunting, not a
// compliance checklist -- what any given org calls its financial documents varies too much
// for a fine taxonomy to be pickable. The cost lands in step 4: a category cannot answer
// "does this client have the audit THIS NOFO asks for", so per-grant requirements will need
// staff confirmation rather than auto-matching against `kind`. That is recorded as a planned
// property of step 4, not a gap to be discovered there.
//
// `kind` is free text in the schema (0030: "extensible; validated in app"), so this list is
// the validation and changing it needs no migration.

export const CLIENT_UPLOAD_KINDS = [
  "financials",
  "org_docs",
  "proposals",
  "marketing",
  "other",
] as const;

export type ClientUploadKind = (typeof CLIENT_UPLOAD_KINDS)[number];

export const KIND_LABEL: Record<ClientUploadKind, string> = {
  financials: "Financials",
  org_docs: "Org docs",
  proposals: "Proposals / narratives",
  marketing: "Marketing (one-pagers, flyers, decks)",
  other: "Other",
};

// THE SECOND FIREWALL LAYER, and it works by omission. 'signed_contract' is not in the list
// above, so a client cannot declare it on an upload -- meaning a client-uploaded row can
// never impersonate a contract no matter what client_visible ends up saying. The first layer
// is 0075's policy (client_visible defaults false); this one makes the two independent.
export function isClientUploadKind(v: unknown): v is ClientUploadKind {
  return typeof v === "string" && (CLIENT_UPLOAD_KINDS as readonly string[]).includes(v);
}

// ── Upload bounds ─────────────────────────────────────────────────────────────────
//
// THE BUCKET IN 0075 IS THE AUTHORITY. These must mirror its file_size_limit and
// allowed_mime_types, and they exist only so the mint route can refuse a 30MB file or a .exe
// BEFORE the client spends minutes uploading it -- a fast, specific "no" instead of an opaque
// storage rejection at the end. Real enforcement stays where the bytes land, because the
// client PUTs straight to storage and our code never sees them.
//
// If these two ever drift apart, storage wins and the client gets the worse error. Keep them
// in step.
export const UPLOAD_MAX_BYTES = 26_214_400; // 25MB

export const ALLOWED_UPLOAD_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export function isAllowedUploadMime(v: unknown): boolean {
  return typeof v === "string" && (ALLOWED_UPLOAD_MIME as readonly string[]).includes(v);
}

// A human label for the size cap, for error copy. Kept beside the constant so the two cannot
// disagree about what 25MB means.
export const UPLOAD_MAX_LABEL = "25MB";

export const MAX_DOCUMENT_TITLE_CHARS = 200;
