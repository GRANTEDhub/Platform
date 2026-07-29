"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

// Back link + unsaved-changes guard for the client/prospect form, so leaving no
// longer means reaching for the browser's back button and silently losing a
// half-filled profile (which is expensive here -- a crafted profile is an LLM pass
// plus hand edits).
//
// Two layers, because they cover different exits:
//  1. beforeunload -- the browser's own prompt for a tab close / refresh / typed
//     URL. The browser controls that dialog's wording; we can only arm it.
//  2. This component's own Back control -- an in-app confirm, since Next's App
//     Router gives no navigation-blocking hook for client-side <Link> transitions.
//
// "Dirty" is detected from real user input inside the form (input/change events),
// NOT from a diff against initial values: the form mixes uncontrolled inputs with
// self-managed child components (narrative, address, chips), so an event listener on
// the container is the one place that sees every edit. A programmatic prefill (the
// website craft) fires no user event, so a crafted-but-untouched form still counts
// as dirty via `initiallyDirty` -- crafted work is worth confirming before discard.
export function FormExitGuard({
  backHref,
  backLabel,
  formSelector = "form",
  initiallyDirty = false,
}: {
  backHref: string;
  backLabel: string;
  // The form to watch. Defaults to the first <form> on the page.
  formSelector?: string;
  initiallyDirty?: boolean;
}) {
  const router = useRouter();
  const [dirty, setDirty] = useState(initiallyDirty);
  const submittedRef = useRef(false);

  // Track edits + submission on the form element itself.
  useEffect(() => {
    const form = document.querySelector(formSelector);
    if (!form) return;
    const onInput = () => setDirty(true);
    // A submit means the work is being saved, so stop guarding (the redirect that
    // follows must not be interrupted by a confirm).
    const onSubmit = () => {
      submittedRef.current = true;
      setDirty(false);
    };
    form.addEventListener("input", onInput);
    form.addEventListener("change", onInput);
    form.addEventListener("submit", onSubmit);
    return () => {
      form.removeEventListener("input", onInput);
      form.removeEventListener("change", onInput);
      form.removeEventListener("submit", onSubmit);
    };
  }, [formSelector]);

  // Layer 1: browser-level exits (close / refresh / external navigation).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (submittedRef.current) return;
      e.preventDefault();
      // Required for the prompt to appear in some browsers; the message itself is
      // not customizable in any modern browser.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Layer 2: our own Back control.
  function goBack() {
    if (
      dirty &&
      !window.confirm(
        "You have unsaved changes on this profile. Leave without saving?\n\nOK to discard them, or Cancel to go back and save first.",
      )
    ) {
      return;
    }
    router.push(backHref);
  }

  return (
    <button
      type="button"
      onClick={goBack}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
    >
      <ArrowLeft className="h-4 w-4" />
      {backLabel}
    </button>
  );
}
