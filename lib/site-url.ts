// Stable public base URL for user-facing ABSOLUTE links we email out (the
// scheduling /go/<token> link, the /sign/<token> contract link, etc.).
//
// Previously these used `new URL(req.url).origin`, which on Vercel is the
// EPHEMERAL per-deploy host (e.g. platform-81rrfm0oq-granted1.vercel.app) rather
// than the stable prod domain -- so emailed links pointed at a preview URL.
// Prefer the configured prod domain (NEXT_PUBLIC_SITE_URL); only fall back to the
// request origin when that env var is unset (local dev / misconfig).
export function appBaseUrl(req?: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (req) {
    try {
      return new URL(req.url).origin;
    } catch {
      /* fall through */
    }
  }
  return "";
}

// The staff console link for a single review card. Points at the redesigned grant
// review page (/clients/<clientId>/roadmap/<cardId>) — the same OverviewCard /
// RationaleCard surface the report uses — NOT the old /review/<id> worklist detail,
// which lacks the redesigned fit-factors section. That page hard-filters on BOTH ids
// (.eq id, .eq client_id), so the client id is required; when it is unknown (should
// not happen for client-card sweeps, but the field is nullable) we fall back to the
// single-id /review/<cardId> route so an admin spot-check link never 404s. The one
// definition both admin sweep/backfill emitters share, so their links can't drift.
export function reviewConsoleLink(base: string, cardId: string, clientId: string | null): string {
  return clientId ? `${base}/clients/${clientId}/roadmap/${cardId}` : `${base}/review/${cardId}`;
}
