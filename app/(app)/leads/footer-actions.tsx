"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { assignAccountManager, setLeadStage } from "./actions";

// De-emphasized footer controls: reassign owner, archive, reject. Muted by design
// -- the primary path is the Next-step card. Archive requires a reason (enforced
// server-side too). Reject is a terminal side-state. Hidden when already terminal.
export function FooterActions({
  leadId,
  admins,
  accountManagerId,
  isTerminal,
}: {
  leadId: string;
  admins: { id: string; name: string }[];
  accountManagerId: string | null;
  isTerminal: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [am, setAm] = useState(accountManagerId ?? "");
  const [mode, setMode] = useState<null | "archive" | "reject">(null);
  const [reason, setReason] = useState("");

  const run = (fn: () => Promise<void>) => {
    setError(null);
    start(async () => {
      try { await fn(); setMode(null); setReason(""); }
      catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); }
    });
  };

  return (
    <div className="space-y-3 border-t border-brand-navy/[0.08] pt-4 text-sm">
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="uppercase tracking-wide">Manage</span>

        <span className="flex items-center gap-1.5">
          <select
            value={am}
            onChange={(e) => setAm(e.target.value)}
            className="h-8 rounded-md border border-input bg-card px-2 text-xs"
          >
            <option value="">Unassigned</option>
            {admins.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => assignAccountManager(leadId, am || null))}
            className="text-brand-navy hover:underline disabled:opacity-50"
          >
            Reassign
          </button>
        </span>

        {!isTerminal && (
          <>
            <button type="button" onClick={() => setMode(mode === "archive" ? null : "archive")} className="hover:underline">
              Archive
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => setLeadStage(leadId, "rejected"))}
              className="hover:underline disabled:opacity-50"
            >
              Reject
            </button>
          </>
        )}
      </div>

      {mode === "archive" && (
        <div className="flex gap-2">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for archiving (required)"
            className="h-8 text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !reason.trim()}
            onClick={() => run(() => setLeadStage(leadId, "archived", reason))}
          >
            Confirm archive
          </Button>
        </div>
      )}
    </div>
  );
}
