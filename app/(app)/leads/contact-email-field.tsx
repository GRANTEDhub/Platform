"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { setLeadContactEmail } from "./actions";

// Inline editable contact email (quick fact). Wraps setLeadContactEmail. Stays
// reachable for leads that didn't arrive via intake (no email on file).
export function ContactEmailField({ leadId, currentEmail }: { leadId: string; currentEmail: string | null }) {
  const [email, setEmail] = useState(currentEmail ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = email.trim() !== (currentEmail ?? "");

  return (
    <div className="space-y-1.5">
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setSaved(false); }}
          placeholder="name@org.org"
          className="h-9 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || !dirty}
          onClick={() => {
            setError(null);
            start(async () => {
              try { await setLeadContactEmail(leadId, email); setSaved(true); }
              catch (e) { setError(e instanceof Error ? e.message : "Couldn't save."); }
            });
          }}
        >
          {pending ? "Saving…" : saved && !dirty ? "Saved" : "Save"}
        </Button>
      </div>
    </div>
  );
}
