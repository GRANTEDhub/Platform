import type { Metadata } from "next";
import { interTight, sourceSerif } from "@/lib/fonts";
import { IntakeForm } from "./intake-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Get started with GRANTED",
  description: "Tell us about your organization and we'll follow up within one business day.",
  robots: { index: false }, // the marketing site links here; don't index the app route
};

// Public (unauthenticated) intake landing. Made public via the middleware
// allowlist. The form posts to /api/intake, which creates an inbound lead.
const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null;

export default function IntakePage() {
  return (
    <div className={`${interTight.variable} ${sourceSerif.variable} font-tight min-h-screen bg-brand-cream`}>
      <div className="mx-auto max-w-2xl px-6 py-14">
        <p className="font-serif text-xl font-semibold tracking-tight text-brand-navy">GRANTED</p>
        <h1 className="mt-6 font-serif text-3xl font-semibold text-brand-navy">Tell us about your organization</h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-600">
          A few basics so we can prepare. We look up your federal grant history and registration
          ourselves, so we only ask what you uniquely know. We&apos;ll follow up within one business day
          to schedule your discovery call.
        </p>
        <div className="mt-8">
          <IntakeForm turnstileSiteKey={siteKey} />
        </div>
      </div>
    </div>
  );
}
