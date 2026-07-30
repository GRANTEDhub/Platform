"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

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

// The invite is a DELIBERATE per-completion choice, surfaced as a confirm step rather
// than a checkbox buried in the form. These records are usually built for clients who
// already work with us, and a surprise "welcome, set up your account" email is the
// kind of mistake you cannot take back. Default off.
// Fields are PREFILLED from the record, not left blank. This page is reachable by
// URL, not only from the intake flow -- and completing it writes the engagement
// columns unconditionally. Blank defaults would therefore let a revisit on an
// established client silently wipe a real tier, retainer and contract dates. Same
// class of mistake the edit form's hidden passthroughs exist to prevent: never let a
// partial form null a stored value.
export function CompleteProfile({
  clientId,
  clientName,
  contactEmail,
  action,
  current,
}: {
  clientId: string;
  clientName: string;
  contactEmail: string | null;
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
  const [confirming, setConfirming] = useState(false);
  const [sendInvite, setSendInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CompleteProfileState | null>(null);

  const hasEmail = !!contactEmail;

  async function onSubmit(formData: FormData) {
    if (busy) return;
    setBusy(true);
    setError(null);
    formData.set("send_invite", sendInvite ? "true" : "false");
    const res = await action(formData);
    if (!res.ok) {
      setError(res.error ?? "Couldn't complete the profile.");
      setBusy(false);
      setConfirming(false);
      return;
    }
    // The completion screen appears AFTER the work, reporting what actually happened,
    // then dwells so it can be read before moving on. It is a receipt, not a progress
    // bar -- nothing is being narrated while it is up.
    setDone(res);
    setTimeout(() => router.push(`/clients/${clientId}`), 3000);
  }

  if (done) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-brand-navy px-6 text-center"
      >
        <CheckCircle2 className="h-14 w-14 text-emerald-400" aria-hidden="true" />
        <h2 className="mt-6 font-serif text-2xl font-semibold text-white">Profile completed</h2>
        <p className="mt-2 max-w-md text-sm text-white/70">
          {!done.invited
            ? `${clientName} is set up. No account invitation was sent.`
            : done.emailed
              ? `Account invitation sent to ${done.recipient}.`
              : `${clientName}'s portal account was created, but the invitation email was not sent — ${done.emailSkippedReason ?? "sending is disabled here"}.`}
        </p>
        {done.error && <p className="mt-2 max-w-md text-sm text-amber-300">{done.error}</p>}
        <p className="mt-6 text-xs text-white/50">Taking you to the dashboard…</p>
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-8">
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

      {!confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => setConfirming(true)}>
            Complete profile
          </Button>
          <span className="text-xs text-muted-foreground">Last step.</span>
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-input bg-muted/40 p-4">
          <p className="text-sm font-semibold text-brand-navy">Complete {clientName}&apos;s profile?</p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={sendInvite}
              disabled={!hasEmail}
              onChange={(e) => setSendInvite(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Email an account invitation to the client</span>
              <span className="block text-xs text-muted-foreground">
                {hasEmail
                  ? `Sends a "set up your account" email to ${contactEmail}. Leave unchecked for a record you're building on an existing client's behalf — their portal login can be created later from Edit.`
                  : "No primary contact email on file, so there's nobody to invite. Add one on the edit page if you want to send this later."}
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {busy ? "Completing…" : sendInvite ? "Complete and send invitation" : "Complete profile"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
