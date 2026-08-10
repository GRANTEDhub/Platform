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
// by a new route. Only a real edit, or an explicit Continue, can start a save.
//
// PRESSING CONTINUE IS AN EXPLICIT ACT, and flush({force:true}) is how the scope step treats
// it as endorsement of a prefill. That is not the mount case: opening a page says nothing,
// whereas reading a scope the GRANTED team wrote and choosing to proceed is a decision. The
// distinction is deliberate -- mount is silent, Continue is not.
//
// ── A KEYSTROKE THAT LANDS MID-FLIGHT IS NOT SAVED BY THE SAVE ALREADY IN FLIGHT ─────────
//
// Found in review on #326, and it was this hook's own failure mode. `save()` cleared `dirty`
// unconditionally on a successful PATCH, so:
//
//   1. the debounce fires and a save of V1 goes out
//   2. the client types V2; the effect reschedules its timer (T2)
//   3. V1's save resolves and clears dirty
//   4. the effect re-runs on that change, its cleanup cancels T2, and `if (!dirty) return`
//      declines to schedule anything
//   5. the indicator reads "Saved 2:31pm" and flush() returns true, so Continue navigates
//
// V2 survived only while the client kept typing; the last keystroke before they walked away
// was dropped under a "Saved" label. Exactly the silent drop this step was built to remove.
//
// Fixed with a REVISION COUNTER rather than a mid-flight lock on edits: touch() bumps it, a
// save captures it before the request, and dirty is cleared only if it has not moved since.
// If it has, the save that returned was of stale text, dirty stays set, no state change
// disturbs the pending timer, and the newer value goes out next.
//
// Saves are also SERIALISED. Two PATCHes in flight against one row both read-merge-write
// server-side, so an older one landing second would overwrite the newer -- the same
// last-write-wins hazard, moved into the database. The chain below makes that unreachable.

const DEBOUNCE_MS = 1_500;

// How many times flush() will re-send when an edit keeps landing mid-save. One extra pass is
// the normal case; the bound stops a fast typist from holding navigation open indefinitely.
const FLUSH_MAX_PASSES = 3;

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

// ok    -- persisted, and what was persisted is current
// stale -- persisted, but an edit landed while it was in flight, so there is newer text
// error -- not persisted
type SaveOutcome = "ok" | "stale" | "error";

export interface DraftSaver {
  state: SaveState;
  // Call from every onChange. Marks the editor dirty and (re)starts the debounce.
  touch: () => void;
  // Persist everything outstanding and report whether it worked. Callers that navigate MUST
  // await this and must not proceed on false.
  //
  // force writes even when nothing was edited. The scope step passes it so pressing Continue
  // ENDORSES a prefill: the editor opens filled from the released concept proposal, and a
  // client who reads it, agrees, and moves on has made a decision worth recording. Without
  // it that draft stores nothing and the hub reads "Not started" for a scope the client has
  // actually settled. The builder does not pass it -- its placeholders are never values, so
  // there is nothing there to endorse and forcing would write nine empty sections.
  flush: (opts?: { force?: boolean }) => Promise<boolean>;
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

  // Bumped by every edit. The only thing that can tell "this save covered the current text"
  // from "this save covered text the client has since changed".
  const revRef = useRef(0);
  // Mirrors `dirty` so flush() can read it synchronously between passes; React state would
  // still hold the pre-await value inside the loop.
  const dirtyRef = useRef(false);
  // Serialises saves. Never rejects: a failed link must not poison every later save.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  const doSave = useCallback(async (): Promise<SaveOutcome> => {
    // No draft in context: a staff preview hitting a step URL directly. There is nothing to
    // save to, and reporting an error for that would be noise -- but it must not report
    // "Saved" either, so the indicator stays idle.
    if (!draftId) return "ok";

    const rev = revRef.current;
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
        return "error";
      }

      // Only now is it safe to say the editor is clean, and only if nothing was typed while
      // the request was out. On stale, dirty deliberately stays set AND no state is changed,
      // which is what leaves the already-scheduled debounce timer alive to send the newer
      // text -- clearing it here is what dropped the keystroke before.
      if (revRef.current !== rev) {
        setState({ kind: "saved", at: new Date() });
        return "stale";
      }
      dirtyRef.current = false;
      setDirty(false);
      setState({ kind: "saved", at: new Date() });
      return "ok";
    } catch {
      setState({ kind: "error", message: "Couldn't reach the server. Your changes are not saved." });
      return "error";
    }
  }, [draftId, key]);

  // Every save goes through the chain, so two are never in flight against the same row.
  const runSave = useCallback((): Promise<SaveOutcome> => {
    const next = chainRef.current.then(() => doSave());
    chainRef.current = next.catch(() => undefined);
    return next;
  }, [doSave]);

  // Debounce. Re-runs on every keystroke because `value` is a dependency, so the timer is
  // cleared and reset while the client is still typing. `dirty` gates it, which is what
  // keeps mount (and a failed save the client has walked away from) out of it.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void runSave(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [dirty, value, runSave]);

  const touch = useCallback(() => {
    revRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
  }, []);

  const flush = useCallback(async ({ force = false }: { force?: boolean } = {}): Promise<boolean> => {
    for (let pass = 0; pass < FLUSH_MAX_PASSES; pass++) {
      // Nothing outstanding: report success rather than firing a redundant write, so Continue
      // on an untouched page is instant. `force` overrides that for endorsement -- and only
      // on the FIRST pass, so a forced save does not loop once it has written.
      if (!dirtyRef.current && !(force && pass === 0)) return true;
      const outcome = await runSave();
      if (outcome === "error") return false;
      if (outcome === "ok") return true;
      // "stale": an edit landed mid-save, so go round again with the newer text.
    }
    // Out of passes. Report the truth rather than assuming either way.
    return !dirtyRef.current;
  }, [runSave]);

  const retry = useCallback(async () => (await runSave()) !== "error", [runSave]);

  return { state, touch, flush, retry, dirty };
}
