"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

// Permanent delete for a client / prospect, built for test-data churn.
//
// GUARDRAILS, and deliberately only these two:
//  1. The exact name must be typed. This is not a formality -- it is the check that
//     you are deleting the record you think you are. A plain "Are you sure?" is
//     clicked through reflexively and proves nothing about WHICH row is selected.
//  2. The blast radius is shown as real counts before you commit. A throwaway test
//     record reads as zeros; anything with sent alerts, invoices or portal members is
//     visibly not a test record.
//
// It does NOT block a delete on those counts. The whole point is unblocking test
// churn, and a hard block would just send Shannon back to hand-written SQL -- the
// thing this replaces. The counts inform the decision instead of overriding it.
//
// PRESENTED AS A CENTRED MODAL, portaled to document.body. It used to reveal inline
// below the button, which sits at the very bottom of a long edit page -- so the
// confirmation could open off-screen and read as "the button did nothing". A
// destructive confirmation that can be missed is worse than none, because it trains
// you to expect no prompt.
export function DeleteClient({
  name,
  kindLabel,
  action,
  counts,
}: {
  name: string;
  kindLabel: string;
  action: (formData: FormData) => Promise<{ error: string } | undefined>;
  counts: { label: string; n: number }[];
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const matches = norm(typed) === norm(name) && norm(name) !== "";
  const notable = counts.filter((c) => c.n > 0);

  async function onSubmit(formData: FormData) {
    if (busy) return;
    setBusy(true);
    setError(null);
    // A successful delete redirects, so control never returns here. Anything that
    // comes back is a real failure worth showing.
    const res = await action(formData);
    if (res?.error) {
      setError(res.error);
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          Delete this {kindLabel}
        </Button>
        <span className="text-xs text-muted-foreground">
          Permanent. Removes the record and everything attached to it.
        </span>
      </div>
    );
  }

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-brand-navy/60 p-6">
      <form
        action={onSubmit}
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${name}`}
        className="w-full max-w-lg space-y-3 rounded-xl bg-white p-5 shadow-xl ring-1 ring-red-200"
      >
      <p className="text-sm font-semibold text-red-900">
        Delete {name} permanently?
      </p>

      <div className="text-xs text-red-900/90">
        {notable.length === 0 ? (
          <p>
            Nothing is attached to this {kindLabel} — no matches, alerts, invoices or portal members.
            Safe to remove.
          </p>
        ) : (
          <>
            <p className="font-medium">This also deletes:</p>
            <ul className="mt-1 space-y-0.5">
              {notable.map((c) => (
                <li key={c.label}>
                  · {c.n} {c.label}
                  {c.n === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-2">
          The audit trail of pipeline events is kept. Everything else, including any stored PDFs, is
          gone and cannot be restored.
        </p>
      </div>

      <div>
        <label htmlFor="confirm_name" className="text-xs font-medium text-red-900">
          Type <span className="font-semibold">{name}</span> to confirm
        </label>
        <input
          id="confirm_name"
          name="confirm_name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          className="mt-1 h-10 w-full rounded-md border border-red-300 bg-white px-3 text-sm"
        />
      </div>

      {error && (
        <p role="alert" className="text-xs font-semibold text-red-900">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={!matches || busy}
          aria-busy={busy}
          className="bg-red-700 text-white hover:bg-red-800"
        >
          {busy ? "Deleting…" : `Delete ${kindLabel}`}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setTyped("");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
      </form>
    </div>,
    document.body,
  );
}
