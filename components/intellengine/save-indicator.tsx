"use client";

import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { DraftSaver } from "@/components/intellengine/use-draft-save";

// The autosave state, said out loud. Three states that are actually distinguishable, because
// the failure mode this replaces is a page that looked fine and had saved nothing.
//
// "Not saved" is deliberately the loudest of the three and carries a Retry: it is the only
// one where the client has to do something, and a client who cannot tell a failed save from a
// quiet one is exactly where this track started.
//
// The idle state renders NOTHING. Before the first edit there is nothing true to say -- "Not
// saved" would be alarming and wrong (nothing needed saving) and "Saved" would be a lie.
export function SaveIndicator({ saver }: { saver: DraftSaver }) {
  const { state, dirty, retry } = saver;

  if (state.kind === "error") {
    return (
      <p role="alert" className="flex items-center gap-1.5 text-[12px] font-medium text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{state.message}</span>
        <button
          type="button"
          onClick={() => void retry()}
          className="ml-0.5 underline underline-offset-2 hover:no-underline"
        >
          Retry
        </button>
      </p>
    );
  }

  if (state.kind === "saving") {
    return (
      <p aria-live="polite" className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        Saving…
      </p>
    );
  }

  if (state.kind === "saved") {
    // Unsaved edits made SINCE the last successful save outrank the timestamp: showing
    // "Saved 2:31pm" while three sentences sit unsaved in the box is how a client comes to
    // believe work is safe when it is not. The debounce will clear this within ~1.5s.
    if (dirty) {
      return <p className="text-[12px] text-muted-foreground">Unsaved changes…</p>;
    }
    return (
      <p aria-live="polite" className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
        {/* Locale-formatted in the browser only. The idle branch renders nothing, so this
            never appears in server HTML and cannot cause a hydration mismatch. */}
        Saved {state.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </p>
    );
  }

  return null;
}
