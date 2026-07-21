import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Supabase client for Server Components, Route Handlers, and Server Actions.
 * Reads/writes the auth session via cookies and enforces RLS as the signed-in
 * user. Query results are cast to the interfaces in types/database.ts.
 */
export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — cookies are read-only here.
            // The middleware refreshes the session, so this is safe to ignore.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. Bypasses RLS entirely — use ONLY in trusted server code
 * (ingest jobs, webhooks, admin tasks). Never import this into client code.
 */
export function createServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: { getAll: () => [], setAll: () => {} },
      auth: { persistSession: false, autoRefreshToken: false },
      // Force every query off this client to bypass Next.js's fetch Data Cache.
      // supabase-js issues SELECTs as plain GET fetches; on Next 14 App Router a
      // STABLE-URL GET can be stored in the Data Cache and served stale. The
      // scheduled match/watchdog crons hit exactly this: their constant-URL
      // `status=eq.queued` SELECT was cached EMPTY (from when the queue was empty)
      // and served ever since — so drainMatchQueue read queueEmpty:true while 372
      // grants sat queued (a browser hit to the same deployment read the DB fresh
      // and saw 372). Route-level `force-dynamic` did not reliably propagate
      // no-store to the library fetch in this version, so pin it on the client.
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
    },
  );
}
