"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

type Mode = "password" | "magic";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectedFrom = searchParams.get("redirectedFrom") || "/dashboard";

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push(redirectedFrom);
    router.refresh();
  }

  async function handleMagic(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const origin =
      process.env.NEXT_PUBLIC_SITE_URL ||
      (typeof window !== "undefined" ? window.location.origin : "");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback?next=${redirectedFrom}` },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/g-mark.png" alt="GRANTED" width={48} height={48} className="mx-auto mb-3 h-12 w-12" />
          <h1 className="text-xl font-semibold tracking-tight">GRANTED Platform</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to continue
          </p>
        </div>

        {sent ? (
          <div className="rounded-lg border bg-card p-6 text-center text-sm">
            <p className="font-medium">Check your email</p>
            <p className="mt-1 text-muted-foreground">
              We sent a sign-in link to <span className="font-medium">{email}</span>.
            </p>
          </div>
        ) : (
          <form
            onSubmit={mode === "password" ? handlePassword : handleMagic}
            className="space-y-4 rounded-lg border bg-card p-6 shadow-sm"
          >
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@grantedco.com"
              />
            </div>

            {mode === "password" && (
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? "Working…"
                : mode === "password"
                  ? "Sign in"
                  : "Send magic link"}
            </Button>

            <button
              type="button"
              onClick={() => {
                setMode(mode === "password" ? "magic" : "password");
                setError(null);
              }}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
            >
              {mode === "password"
                ? "Email me a magic link instead"
                : "Use a password instead"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
