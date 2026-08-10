"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Autosave for the Pursuit editors (step 2 of docs/pursuit-state-audit-2026-08.md §5).
//
// WHY AUTOSAVE AND NOT SAVE-ON-CONTINUE. The complaint this whole track exists to answer is
// "I typed a scope, navigated, and lost it". Saving only when Continue is pressed leaves the
// closed-tab and browser-back versions of that fully intact, and the builder has nine fields
// a client will edit across more than one sitting.
//
// WHY IT MUST BE ABLE TO SAY IT FAILED. A silent autosave failure is a worse lie than no
// autosave: the client has no Save button to distrust, so quiet is indistinguishable from
// saved. This is the same swallow-the-error shape step-nav.tsx used for its status PATCH
// ("Non-fatal: keep moving even if the status write hiccups") applied to the client's actual
// work, which is why the state below has an explicit `error` and why flush() returns a
// boolean the caller is expected to honour rather than ignore.
//
// IT NEVER SAVES ON MOUNT, and that is load-bearing rather than an optimisation. The scope
// editor opens prefilled from the released concept proposal; a save on mount would persist
// that seed as the client's own work, stamp savedAt, and make the hub read "Scope captured"
// for a draft nobody touched -- the same green-check-a-lie the gate was raised for, arriving
// by a new route. Only a real edit (touch()) can start a save.

const DEBOUNCE_MS = 1_500;

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

export interface DraftSaver {
  state: SaveState;
  // Call from every onChange. Marks the editor dirty and (re)starts the debounce.
  touch: () => void;
  // Persist now and report whether it worked. Callers that navigate MUST await this and
  // must not proceed on false.
  flush: () => Promise<boolean>;
  // Same write, for the indicator's Retry affordance.
  retry: () => Promise<boolean>;
  dirty: boolean;
}

export function useDraftSave(
  draftId: string | undefined,
  key: "scope" | "sections",
  // The current editor value. Read through a ref at save time so a save always sends the
  // latest keystroke rather than whatever was current when the timer was set.
  value: unknown,
): DraftSaver {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [dirty, setDirty] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const save = useCallback(async (): Promise<boolean> => {
    // No draft in context: a staff preview hitting a step URL directly. There is nothing to
    // save to, and reporting an error for that would be noise -- but it must not report
    // "Saved" either, so the indicator stays idle.
    if (!draftId) return true;

    setState({ kind: "saving" });
    try {
      const res = await fetch(`/api/intellengine/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { [key]: valueRef.current } }),
      });
      if (!res.ok) {
        // The route's own message when it has one (a length breach names the field), so the
        // client is told what to shorten instead of "something went wrong".
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setState({ kind: "error", message: body?.error ?? `Couldn't save (${res.status}).` });
        return false;
      }
      setState({ kind: "saved", at: new Date() });
      setDirty(false);
      return true;
    } catch {
      setState({ kind: "error", message: "Couldn't reach the server. Your changes are not saved." });
      return false;
    }
  }, [draftId, key]);

  // Debounce. Re-runs on every keystroke because `value` is a dependency, so the timer is
  // cleared and reset while the client is still typing. `dirty` gates it, which is what
  // keeps mount (and a failed save the client has walked away from) out of it.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [dirty, value, save]);

  const touch = useCallback(() => setDirty(true), []);

  const flush = useCallback(async () => {
    // Nothing outstanding: report success rather than firing a redundant write, so Continue
    // on an untouched page is instant.
    if (!dirty) return true;
    return save();
  }, [dirty, save]);

  return { state, touch, flush, retry: save, dirty };
}
