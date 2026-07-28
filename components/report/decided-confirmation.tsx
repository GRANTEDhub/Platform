"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check } from "lucide-react";

// Brief "decision recorded" transition shown after a client passes or saves a grant on
// the Grant Report detail (#18c), then auto-returns to the Grant Report so they can keep
// reviewing. Client-only surface (routed to from DecisionBar when `tier` is set).
const MESSAGES: Record<string, { title: string; sub: string }> = {
  passed: {
    title: "Decision recorded",
    sub: "Noted — you're passing on this one. It won't resurface in your Grant Report.",
  },
  pending: {
    title: "Saved for later",
    sub: "It stays in your Grant Report, waiting whenever you're ready to decide.",
  },
  approved: { title: "Decision recorded", sub: "We've logged your decision." },
};

export function DecidedConfirmation({ outcome }: { outcome: string }) {
  const router = useRouter();
  const msg = MESSAGES[outcome] ?? MESSAGES.approved;

  useEffect(() => {
    const t = setTimeout(() => router.push("/portal/grants"), 1900);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-navy/[0.06]">
        <Check className="h-7 w-7 text-brand-orange" strokeWidth={3} />
      </div>
      <h1 className="mt-5 font-serif text-2xl font-semibold text-brand-navy">{msg.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{msg.sub}</p>
      <p className="mt-1 text-xs text-muted-foreground">Taking you back to your Grant Report…</p>
      <Link
        href="/portal/grants"
        className="mt-6 inline-block rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-navyDeep"
      >
        Back to Grant Report
      </Link>
    </div>
  );
}
