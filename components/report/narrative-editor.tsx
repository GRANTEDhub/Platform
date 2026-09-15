"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, RotateCcw, X } from "lucide-react";

// Staff-only inline editor for the fit-analysis narrative — the client-facing "why this client fits"
// paragraph (the Grant Intelligence / IntellEngine Intel box). Passed into GrantReviewConsole as an
// optional prop and rendered in the RationaleCard header; the client portal passes nothing, so the edit
// affordance is staff-only by construction (the shared server component never forks on actor).
//
// A save PUTs /api/review/[id]/fit-narrative, which sets fit_narrative_edited=true (the drain stops
// regenerating this paragraph — migration 0100) and invalidates any saved alert draft so the next
// composer open re-renders the PDF with the edit. The admin-only "Revert to auto-generated" regenerates
// via the model (clearing the lock) — so an edit is never a dead end.
//
// A right-side slide-over (the concept-proposal-editor pattern): portaled to <body> so the fixed overlay
// anchors to the viewport, not a transformed ancestor. router.refresh() re-reads the server component so
// the edited paragraph shows immediately.

const MAX_CHARS = 2000;

export function NarrativeEditor({
  cardId,
  initialValue,
  canRevert,
}: {
  cardId: string;
  initialValue: string;
  canRevert: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-navy/70 hover:text-brand-navy"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        Edit
      </button>
      {editing && (
        <NarrativeDrawer
          cardId={cardId}
          initialValue={initialValue}
          canRevert={canRevert}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

function NarrativeDrawer({
  cardId,
  initialValue,
  canRevert,
  onClose,
}: {
  cardId: string;
  initialValue: string;
  canRevert: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(true); // slide-in after mount
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && handleClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = saving || reverting;
  const trimmed = value.trim();
  const overLimit = trimmed.length > MAX_CHARS;

  function handleClose() {
    setOpen(false);
    setTimeout(onClose, 200); // let the slide-out play
  }

  async function save() {
    if (!trimmed || overLimit || busy) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}/fit-narrative`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrative: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error || "Couldn't save. Try again.");
        return;
      }
      router.refresh();
      handleClose();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  // Admin-only unlock: regenerate the paragraph from the model (clears fit_narrative_edited). Slow (an
  // Opus call), so it shows its own busy state; on success the drawer closes and the fresh paragraph shows.
  async function revert() {
    if (busy) return;
    setReverting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/fit-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId }),
      });
      const body = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
      if (!res.ok) {
        setError(body.error || "Couldn't regenerate. Try again.");
        return;
      }
      // The admin route returns 200 for EVERY outcome; only "generated"/"cleared" actually regenerated the
      // paragraph and cleared the lock. "skipped"/"closed"/"failed" left the edit (and its lock) in place, so
      // surfacing them as success would tell the staffer they reverted when they didn't (Claude Code Review
      // #569).
      if (body.outcome !== "generated" && body.outcome !== "cleared") {
        setError(
          body.outcome === "closed"
            ? "Couldn't revert — the grant's deadline has passed."
            : body.outcome === "failed"
              ? "Couldn't regenerate — try again."
              : "Couldn't revert — this card is no longer eligible for an auto-generated narrative (it may have been decided, released, or re-scored).",
        );
        return;
      }
      router.refresh();
      handleClose();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setReverting(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-brand-navy/30 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={handleClose}
      />
      <div
        className={`absolute right-0 top-0 flex h-full w-full max-w-xl flex-col bg-white shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-brand-navy/[0.08] px-6 py-4">
          <div>
            <h2 className="font-serif text-lg font-semibold text-brand-navy">Edit Grant Intelligence</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              The client-facing “why this fits” paragraph. Your edit is locked from auto-regeneration and
              rides the next alert.
            </p>
          </div>
          <button onClick={handleClose} aria-label="Close" className="text-muted-foreground hover:text-brand-navy">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={12}
            autoFocus
            placeholder="Write the fit rationale the client will read…"
            className="w-full rounded-xl border border-brand-navy/15 bg-white px-3.5 py-2.5 text-sm leading-[1.6] outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
          <p className={`mt-1 text-right text-[11px] ${overLimit ? "font-medium text-destructive" : "text-muted-foreground"}`}>
            {trimmed.length} / {MAX_CHARS} characters
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-brand-navy/[0.08] px-6 py-4">
          {error && <span className="mr-auto text-[12.5px] text-destructive">{error}</span>}
          {canRevert && (
            <button
              onClick={revert}
              disabled={busy}
              className="mr-auto inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-brand-navy disabled:opacity-60"
              title="Discard the edit and regenerate the paragraph from the model"
            >
              {reverting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {reverting ? "Regenerating…" : "Revert to auto"}
            </button>
          )}
          <button onClick={handleClose} className="rounded-full px-4 py-2 text-sm font-medium text-muted-foreground hover:text-brand-navy">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !trimmed || overLimit}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-6 py-2 text-sm font-semibold text-white transition hover:bg-brand-navyDeep disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
