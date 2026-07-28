"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setPhase(data.user ? "ready" : "nosession"));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
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
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    // Into the portal. (Phase B / #16 will redirect first-timers to a profile
    // review; for now the dashboard is the landing.)
    router.push("/portal");
    router.refresh();
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

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Saving…" : "Set password & continue"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
