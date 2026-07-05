"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { addLeadNote } from "./actions";

// Note logger (wraps addLeadNote). Lives in the Outreach & notes accordion.
export function NoteField({ leadId }: { leadId: string }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2 text-sm">
      {error && <p className="text-xs text-destructive">{error}</p>}
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
        onClick={() => {
          setError(null);
          start(async () => {
            try { await addLeadNote(leadId, note); setNote(""); }
            catch (e) { setError(e instanceof Error ? e.message : "Couldn't add note."); }
          });
        }}
      >
        {pending ? "Adding…" : "Add note"}
      </Button>
    </div>
  );
}
