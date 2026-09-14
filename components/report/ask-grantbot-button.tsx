"use client";

import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { askStarters, stashAskDraft, askOpenHref } from "@/lib/grantbot/ask-intent";

// "Ask GrantBot about this grant" — a staff-only entry point on the grant review screen. Each chip
// seeds a grant-specific question into the client's GrantBot composer and opens the corner, so the
// staffer never retypes who the client is or which grant. All of the "how it opens/seeds" lives in
// lib/grantbot/ask-intent.ts (proven stash + deep-link); this is just the affordance.
//
// It renders as a page-level SIBLING of GrantReviewConsole (not inside the shared frame), so it
// touches neither the console nor the client portal — the portal never mounts this. Visual language
// matches the launcher (navy + orange sparkle) so "the thing you click" and "the thing that opens"
// read as one object.
export function AskGrantBotButton({
  clientId,
  clientName,
  grantTitle,
}: {
  clientId: string;
  clientName: string;
  grantTitle: string;
}) {
  const router = useRouter();
  const starters = askStarters(clientName, grantTitle);

  function ask(question: string) {
    // Seed first, then open: takeDraft reads the stash once on the corner chat's mount.
    stashAskDraft(clientId, question);
    router.push(askOpenHref(clientId));
  }

  return (
    <div className="bg-ground px-[30px] pb-8">
      <div className="rounded-2xl border border-edge bg-white px-5 py-[18px] shadow-card">
        <div className="mb-3 flex items-center gap-2.5">
          <span
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
            style={{ background: BRAND.orangeTile }}
          >
            <Sparkles className="h-4 w-4" style={{ color: BRAND.orange }} />
          </span>
          <div className="min-w-0">
            <p className="font-serif text-[15px] font-bold text-brand-navy">Ask GrantBot about this grant</p>
            <p className="text-[12px] text-muted-foreground">
              Opens GrantBot for {clientName || "this client"} with your question ready to send.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {starters.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => ask(s.question)}
              // The full seeded question on hover/assistive tech, so the short chip is not the only
              // signal of what it will ask.
              title={s.question}
              className="inline-flex items-center rounded-pill border border-edge bg-white px-3.5 py-1.5 text-[13px] font-medium text-brand-navy transition-colors hover:border-brand-navy/40 hover:bg-brand-navy/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/50 focus-visible:ring-offset-1"
            >
              {s.chip}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
