"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { convertLead } from "./actions";

// Terminal lead action: convert to an active client (signed + paid). Enabled only
// when the derived stage is invoice_paid; the server action re-checks the gate
// regardless. On success, hand off to the client dashboard. If the row is already
// converted, show the handoff link instead of the button.
export function ConvertButton({
  leadId,
  canConvert,
  alreadyConverted,
}: {
  leadId: string;
  canConvert: boolean;
  alreadyConverted: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (alreadyConverted) {
    return (
      <div className="space-y-2 text-sm">
        <div className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
          Converted
        </div>
        <p>
          <Link href={`/clients/${leadId}`} className="text-sm font-medium text-primary hover:underline">
            View client dashboard →
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>
      )}
      <Button
        type="button"
        size="sm"
        disabled={!canConvert || pending}
        onClick={() => {
          setError(null);
          start(async () => {
            try {
              await convertLead(leadId);
              router.push(`/clients/${leadId}`);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Convert failed.");
            }
          });
        }}
      >
        {pending ? "Converting…" : "Convert to client"}
      </Button>
      {!canConvert && (
        <p className="text-xs text-muted-foreground">
          Unlocks once the contract is signed and the invoice is paid.
        </p>
      )}
    </div>
  );
}
