import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// The post-login router. Middleware sends signed-in users here (and unauthenticated
// ones to /login). We split by identity: STAFF (has a profiles row) → /clients;
// an activated CLIENT member → /portal. An authenticated user who is neither gets a
// no-access screen (rendered, NOT redirected — redirecting to /login would loop,
// since middleware bounces a signed-in user off /login back here).
export default async function Home() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile) redirect("/clients");

  const { data: membership } = await supabase
    .from("client_members")
    .select("id")
    .eq("user_id", user.id)
    .not("activated_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (membership) redirect("/portal");

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-cream px-4">
      <div className="w-full max-w-md rounded-2xl border border-brand-navy/[0.06] bg-white p-8 text-center shadow-soft">
        <h1 className="text-[20px] font-semibold text-brand-navy">No access yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You&apos;re signed in as <span className="font-medium text-brand-navy">{user.email}</span>,
          but this account isn&apos;t set up with access. Contact your GRANTED
          administrator.
        </p>
        <form action="/auth/signout" method="post" className="mt-6">
          <button
            type="submit"
            className="rounded-full bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-navyDeep"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
