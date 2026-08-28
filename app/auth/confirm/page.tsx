import { verifySetupLink } from "./actions";
import { safeNextPath } from "@/lib/safe-redirect";
import { Button } from "@/components/ui/button";

// The email-link landing page. It deliberately does NOT verify the token on load.
//
// An email security scanner (Safe Links / Proofpoint / Mimecast) prefetches the link with a
// GET/HEAD before the human ever clicks, and Next runs the GET handler for HEAD too — so a
// route that verified on GET had the scanner consume the single-use OTP first, and every real
// click 403'd "expired" (confirmed prod incident, NWACC first-login). Instead this page just
// renders a "Continue" button that POSTs to the verifySetupLink server action, which is the
// ONLY thing that runs verifyOtp. Scanners issue GET/HEAD, never a form POST, so the token
// survives untouched until the person clicks. The token_hash / type / next ride through as
// hidden fields (they arrive in the query string on the emailed link).
//
// Works without client JS (a native form POST to the server action), so it is robust even where
// scripts are blocked. Public route (middleware treats /auth/* as public).
export const dynamic = "force-dynamic";

// Next.js delivers each searchParam as string | string[] | undefined — a DUPLICATED query key
// (?next=/x&next=/x), which a link-rewriting email proxy (the very thing this page defends
// against) can easily produce, yields an array. Take the first value so nothing downstream
// gets an array: safeNextPath() would throw calling .startsWith on an array, and with no
// error.tsx that surfaces as a raw crash page instead of the graceful Continue/routing this
// page exists to provide. (The server action reads single values from formData, so it needs
// no equivalent.)
function firstParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export default function ConfirmPage({
  searchParams,
}: {
  searchParams: { token_hash?: string | string[]; type?: string | string[]; next?: string | string[] };
}) {
  const tokenHash = firstParam(searchParams.token_hash);
  const type = firstParam(searchParams.type);
  const next = safeNextPath(firstParam(searchParams.next));

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-cover bg-center bg-no-repeat px-4"
      style={{ backgroundImage: "url('/login-bg.jpg')" }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/40 bg-white/85 p-8 text-center shadow-2xl backdrop-blur-md">
        <img src="/granted-lockup-light.svg" alt="GRANTED" className="mx-auto mb-4 h-12 w-auto" />
        <p className="mt-1 text-sm text-muted-foreground">
          You&apos;re almost in — confirm to continue setting up your account.
        </p>
        <form action={verifySetupLink} className="mt-6">
          <input type="hidden" name="token_hash" value={tokenHash} />
          <input type="hidden" name="type" value={type} />
          <input type="hidden" name="next" value={next} />
          <Button type="submit" className="w-full">
            Continue
          </Button>
        </form>
      </div>
    </div>
  );
}
