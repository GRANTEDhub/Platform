// Server-side spam guards for the public intake endpoint. Three cheap layers:
// a honeypot field, a Cloudflare Turnstile verification, and a coarse in-memory
// per-IP rate limit. None is authoritative alone; together they stop the bulk of
// drive-by bot submissions without a paid vendor.

// ── Cloudflare Turnstile ──────────────────────────────────────────────────
// Verifies the widget token server-side. MANDATORY in production -- Turnstile is
// the real anti-bot gate, so it FAILS CLOSED there: a missing secret key, a
// missing token, a failed challenge, or a verification network error all reject
// the submission. Outside production (local/preview) it degrades gracefully:
// with no secret key configured, verification is skipped so the form still works
// for development. Set TURNSTILE_SECRET_KEY (+ NEXT_PUBLIC_TURNSTILE_SITE_KEY on
// the client) to run it.
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token: string | null | undefined, ip: string | null): Promise<{ ok: boolean; reason?: string }> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const isProd = process.env.VERCEL_ENV === "production";

  if (!secret) {
    // Not configured. In production this is a misconfiguration -> fail closed so
    // the form is never left ungated. In local/preview, skip (staged rollout).
    return isProd ? { ok: false, reason: "Captcha unavailable." } : { ok: true };
  }
  if (!token) return { ok: false, reason: "Captcha missing." };

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    const data = (await res.json()) as { success?: boolean };
    return data.success ? { ok: true } : { ok: false, reason: "Captcha failed." };
  } catch {
    // Verification network error. In production, fail CLOSED -- a Turnstile
    // outage must not become an open door for bots. Fail open only in non-prod.
    return isProd ? { ok: false, reason: "Captcha verification error." } : { ok: true };
  }
}

// ── Coarse in-memory per-IP rate limit ───────────────────────────────────────
// Per-instance (Vercel serverless resets on cold start) and not shared across
// instances -- deliberately light, matching the request. Enough to blunt a
// single-source flood; not a substitute for Turnstile.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

export function rateLimited(ip: string | null): boolean {
  const key = ip || "unknown";
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > MAX_PER_WINDOW;
}
