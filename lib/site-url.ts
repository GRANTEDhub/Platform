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
