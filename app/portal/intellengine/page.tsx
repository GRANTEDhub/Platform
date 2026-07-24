import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireClient } from "@/lib/auth";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";

export const dynamic = "force-dynamic";

// IntellEngine landing -- the entry point into the self-serve AI proposal-
// drafting flow (Get Started -> scope -> compliance -> build). UI shell only:
// every step in this flow is static/mocked content for now. The real
// generation pipeline (NOFO cross-referencing, past-awardee analysis, client
// profile grounding) is a separate, not-yet-scoped piece -- this just builds
// the surface it'll eventually plug into, matching the source Figma design.
export default async function IntellEngineLanding() {
  await requireClient();

  return (
    <HubShell variant="texture">
      <Link
        href="/portal"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Dashboard
      </Link>

      <div className="mx-auto flex max-w-xl flex-col items-center py-20 text-center">
        <IntellEngineLogo size="lg" />
        <h1 className="mt-8 font-serif text-3xl font-semibold leading-tight text-brand-navy sm:text-4xl">
          Ready to draft your next proposal?
        </h1>
        <p className="mt-4 text-sm text-muted-foreground">
          Pay per proposal with IntellEngine Proposal Drafting. You will be billed on your next
          monthly cycle based on credit use.
        </p>
        <Link
          href="/portal/intellengine/scope"
          className="mt-8 rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep"
        >
          Get Started
        </Link>
      </div>
    </HubShell>
  );
}
