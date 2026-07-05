import Stripe from "stripe";

// Server-only Stripe client + the acting-environment gate. NEVER import into a
// client component (would leak STRIPE_SECRET_KEY).

let client: Stripe | null = null;
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!client) client = new Stripe(key); // SDK-pinned API version
  return client;
}

// Acting gate for MUTATING Stripe operations (creating invoices/customers).
// Mirrors the email gate: preview and production share ONE Supabase DB and ONE
// Stripe account, so a MUTATION must run ONLY from production -- a preview deploy
// must never create Stripe objects or write invoice rows into the shared DB.
// Returns {ok,reason}; callers report the reason instead of acting.
export function canActOnPayments(): { ok: boolean; reason: string } {
  if (process.env.VERCEL_ENV !== "production") {
    return { ok: false, reason: `non-production environment (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"})` };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, reason: "STRIPE_SECRET_KEY not configured" };
  }
  return { ok: true, reason: "production, key present" };
}
