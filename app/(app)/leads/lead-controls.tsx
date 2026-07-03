"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { SETTABLE_STAGES } from "@/lib/leads/events";
import { setLeadStage, addLeadNote, assignAccountManager } from "./actions";

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm";

// Admin controls on the lead detail page: stage transition (archive needs a
// reason), account-manager assignment, and a note. Calls the server actions;
// each logs a pipeline_event so the timeline reflects the change on refresh.
export function LeadControls({
  leadId,
  currentStage,
  accountManagerId,
  admins,
}: {
  leadId: string;
  currentStage: string | null;
  accountManagerId: string | null;
  admins: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [stage, setStage] = useState(currentStage ?? "outbound_new");
  const [reason, setReason] = useState("");
  const [am, setAm] = useState(accountManagerId ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>, after?: () => void) => {
    setError(null);
    start(async () => {
      try {
        await fn();
        after?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  };

  return (
    <div className="space-y-6 text-sm">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Stage */}
      <div className="space-y-2">
        <Label>Stage</Label>
        <select value={stage} onChange={(e) => setStage(e.target.value)} className={SELECT_CLASS}>
          {SETTABLE_STAGES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {stage === "archived" && (
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for archiving (required)"
          />
        )}
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => run(() => setLeadStage(leadId, stage, reason || null))}
        >
          Update stage
        </Button>
      </div>

      {/* Account manager */}
      <div className="space-y-2">
        <Label>Account manager</Label>
        <select value={am} onChange={(e) => setAm(e.target.value)} className={SELECT_CLASS}>
          <option value="">Unassigned</option>
          {admins.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => assignAccountManager(leadId, am || null))}
        >
          Assign
        </Button>
      </div>

      {/* Note */}
      <div className="space-y-2">
        <Label>Add a note</Label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          placeholder="Log a call, an email, context…"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || !note.trim()}
          onClick={() => run(() => addLeadNote(leadId, note), () => setNote(""))}
        >
          Add note
        </Button>
      </div>
    </div>
  );
}
