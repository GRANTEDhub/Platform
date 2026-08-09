"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { SpinningMark } from "@/components/ui/spinning-mark";

// Where a client lands from their Welcome-email setup link: /auth/confirm has
// already verified the one-time (recovery) token and set the session by the time
// they arrive here, so this page just sets a password on the existing session
// (supabase.auth.updateUser) and sends them into the portal. Gated on a live
// session only -- NOT requireClient -- and if there's no session (expired/reused
// link) it says so instead of silently bouncing to /login.
export default function SetPasswordPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"checking" | "ready" | "nosession">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  // Distinct from `loading`: the password is saved and we are now waiting on the
  // navigation. Both show the overlay; only this one is allowed to say "Password set".
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setPhase(data.user ? "ready" : "nosession"));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Belt to the overlay's braces: an Enter keypress can re-fire submit in the tick
    // before the overlay paints, and updateUser twice is a doubled attempt.
    if (loading || saved) return;
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setLoading(false);
      setError(error.message);
      return;
    }
    // DO NOT clear the busy state here. router.push below is a server round trip --
    // /portal runs requireClient, then the layout's first-login gate redirects to
    // /welcome, which is force-dynamic -- so several seconds can pass before the
    // screen changes. Clearing it handed the client back a live "Set password &
    // continue" button with no sign anything was happening, and re-clicking it
    // doubled the attempt. The overlay stays up until the new page replaces us.
    setSaved(true);
    // Into the portal. The portal layout redirects first-time clients (whose
    // profile isn't confirmed yet) to /welcome for the profile review (#16);
    // returning clients land straight on the dashboard.
    router.push("/portal");
    router.refresh();
  }

  // Full-screen, and rendered INSTEAD of the card rather than over it: the card's
  // `backdrop-blur-md` makes it a containing block for fixed-position descendants,
  // so a `fixed inset-0` overlay nested inside would size to the card, not the
  // viewport. Replacing the tree sidesteps that entirely and also guarantees the
  // submit button is gone from the DOM, not merely disabled.
  if (loading || saved) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-white px-6 text-center"
      >
        <h2 className="font-serif text-2xl font-semibold text-brand-navy">
          {saved ? "Password set" : "Setting your password"}
        </h2>
        <SpinningMark />
        <p className="text-sm text-muted-foreground">
          {saved ? "Taking you to your account" : "One moment…"}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-cover bg-center bg-no-repeat px-4"
      style={{ backgroundImage: "url('/login-bg.jpg')" }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/40 bg-white/85 p-8 shadow-2xl backdrop-blur-md">
        <div className="mb-8 text-center">
          <img src="/granted-lockup-light.svg" alt="GRANTED" className="mx-auto mb-4 h-12 w-auto" />
          <p className="mt-1 text-sm text-muted-foreground">Welcome — set a password to finish setting up.</p>
        </div>

        {phase === "checking" ? (
          <p className="text-center text-sm text-muted-foreground">Loading…</p>
        ) : phase === "nosession" ? (
          <div className="text-center text-sm">
            <p className="font-medium">This setup link has expired</p>
            <p className="mt-1 text-muted-foreground">
              Ask your GRANTED contact to resend your welcome email, or{" "}
              <a href="/login" className="font-medium text-brand-navy hover:underline">
                sign in
              </a>{" "}
              if you already have a password.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {/* No disabled/"Saving…" state needed: the overlay above returns early for
                the whole in-flight window, so this button only ever renders idle. */}
            <Button type="submit" className="w-full">
              Set password &amp; continue
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
