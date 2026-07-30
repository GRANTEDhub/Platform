"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SpinningMark } from "@/components/ui/spinning-mark";

// Step 7 of intake: engagement terms, then the explicit finish.
//
// Mirrors the server action's result shape (a "use server" module may only export
// async functions, so it cannot be imported).
type CompleteProfileState = {
  ok: boolean;
  error?: string;
  invited?: boolean;
  emailed?: boolean;
  emailSkippedReason?: string;
  recipient?: string;
};

const CLIENT_STATUSES = ["active", "paused", "closed"];

// Full-screen overlay, PORTALED to document.body. The app shell's root div carries
// padding and its own stacking context, so a `fixed inset-0` overlay rendered inside
// <main> aligned to that padding box rather than the viewport -- leaving a strip of
// nav and page backdrop showing along the top. A portal escapes every ancestor
// containing block, which fixes it without depending on which property caused it.
function FullScreen({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-white px-6 text-center"
    >
      {children}
    </div>,
    document.body,
  );
}

// THIS SCREEN NEVER INVITES. It used to offer an "email an account invitation"
// checkbox, which contradicted the onboarding sequence: the invite is step 3 of that
// sequence and must wait until the grants have been reviewed, because it is what
// releases them to the client. Two paths meant the earlier one could fire first, which
// is exactly what happened in testing. The dashboard's "Invite client to portal" button
// is now the only way a client is invited.
// Fields are PREFILLED from the record, not left blank. This page is reachable by
// URL, not only from the intake flow -- and completing it writes the engagement
// columns unconditionally. Blank defaults would therefore let a revisit on an
// established client silently wipe a real tier, retainer and contract dates. Same
// class of mistake the edit form's hidden passthroughs exist to prevent: never let a
// partial form null a stored value.
export function CompleteProfile({
  clientId,
  clientName,
  action,
  current,
}: {
  clientId: string;
  clientName: string;
  action: (formData: FormData) => Promise<CompleteProfileState>;
  current: {
    status: string | null;
    engagement_tier: string | null;
    retainer_hours: number | null;
    contract_start: string | null;
    contract_end: string | null;
    account_managed: boolean;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CompleteProfileState | null>(null);
  // Intent is carried in a REF, not in FormData, and set only by a real click on
  // "Save and finish later". Encoding it as that button's name/value made it the
  // form's implicit-submit target -- so Enter in any engagement field saved and left,
  // skipping the confirmation entirely. A ref cannot be triggered by implicit
  // submission, and is read synchronously (unlike state) right when the action runs.
  const finishLaterRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function onSubmit(formData: FormData) {
    if (busy) return;
    // "Save and finish later" writes the engagement fields and leaves. It never
    // invites and never shows the completion receipt, because nothing has been
    // completed -- the point is to stop without losing what you typed. The record
    // itself was already created at step 5, so there is nothing else at risk.
    const laterOnly = finishLaterRef.current;
    finishLaterRef.current = false;

    setBusy(true);
    setError(null);
    const res = await action(formData);
    if (!res.ok) {
      setError(res.error ?? "Couldn't complete the profile.");
      setBusy(false);
      return;
    }
    // The completion screen appears AFTER the work, reporting what actually happened,
    // then dwells so it can be read before moving on. It is a receipt, not a progress
    // bar -- nothing is being narrated while it is up.
    if (laterOnly) {
      router.push(`/clients/${clientId}`);
      return;
    }
    setDone(res);
    setTimeout(() => router.push(`/clients/${clientId}`), 3000);
  }

  if (done) {
    // Solid white, one centred flex column, three stacked elements: label, spinning
    // logomark, redirect note. See components/ui/spinning-mark for why the mark is
    // rendered in a square box.
    return (
      <FullScreen>
        <h2 className="font-serif text-2xl font-semibold text-brand-navy">Profile Created</h2>

        <SpinningMark />

        <p className="text-sm text-muted-foreground">Redirecting to Dashboard</p>

        {done.error && <p className="max-w-md text-xs font-medium text-amber-700">{done.error}</p>}
      </FullScreen>
    );
  }

  return (
    <form ref={formRef} action={onSubmit} className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Engagement <span className="font-normal normal-case">(optional)</span>
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              name="status"
              defaultValue={
                current.status && CLIENT_STATUSES.includes(current.status) ? current.status : "active"
              }
              className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            >
              {CLIENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="engagement_tier">Engagement tier</Label>
            <Input id="engagement_tier" name="engagement_tier" defaultValue={current.engagement_tier ?? undefined} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="retainer_hours">Retainer hours</Label>
            <Input id="retainer_hours" name="retainer_hours" type="number" defaultValue={current.retainer_hours ?? undefined} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contract_start">Contract start</Label>
            <Input id="contract_start" name="contract_start" type="date" defaultValue={current.contract_start ?? undefined} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contract_end">Contract end</Label>
            <Input id="contract_end" name="contract_end" type="date" defaultValue={current.contract_end ?? undefined} />
          </div>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-input bg-muted/30 px-3 py-2.5 text-sm">
          <input type="checkbox" name="account_managed" value="true" defaultChecked={current.account_managed} className="mt-0.5" />
          <span>
            <span className="font-medium">Account-managed (premium)</span>
            <span className="block text-xs text-muted-foreground">
              An account manager reviews and releases each match before the client sees it. Off by
              default — the client goes straight to their own Grant Alerts / Grant Report.
            </span>
          </span>
        </label>
      </section>

      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800 ring-1 ring-red-200">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* A plain submit, and FIRST in the form, so an implicit submit (Enter in a
            field) performs the primary action rather than something surprising. */}
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {busy ? "Completing…" : "Complete profile"}
        </Button>
        {/* An explicit way OUT that keeps your work. Leaving via the nav used to
            silently discard whatever was typed here, with no hint that the client
            record itself was already safe. type="button" + requestSubmit so it is
            never the implicit-submit target. */}
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            finishLaterRef.current = true;
            formRef.current?.requestSubmit();
          }}
        >
          {busy ? "Saving…" : "Save and finish later"}
        </Button>
        <span className="text-xs text-muted-foreground">
          The client is already created — this step is the engagement terms. You&apos;ll invite them
          from the dashboard once their grants are reviewed.
        </span>
      </div>
    </form>
  );
}
