"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
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
  const redirectedFrom = searchParams.get("redirectedFrom") || "/";

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // Surfaces /auth/callback's ?error=auth fallback -- previously that redirect
  // landed here with no visible sign anything failed (a silent blank sign-in
  // page for a magic link that didn't complete).
  const [error, setError] = useState<string | null>(
    searchParams.get("error") ? "That sign-in link didn't work — it may have expired. Try sending a new one." : null,
  );
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
      // No self-registration: only provisioned accounts (staff + invited clients)
      // may sign in. shouldCreateUser:false means a non-existent email never gets
      // an account created — closing the "email yourself a link → become staff" hole.
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${origin}/auth/callback?next=${redirectedFrom}`,
      },
    });
    setLoading(false);
    if (error) {
      setError(
        /signups? not allowed|not authorized|not found/i.test(error.message)
          ? "No account found for that email. Ask your GRANTED contact to set you up."
          : error.message,
      );
      return;
    }
    setSent(true);
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-cover bg-center bg-no-repeat px-4"
      style={{ backgroundImage: "url('/login-bg.jpg')" }}
    >
      {/* Single frosted-glass card over the road background. bg-white/85 keeps the
          worst-case (panel over a dark image patch) contrast above WCAG AA 4.5:1
          for the muted secondary text; backdrop-blur frosts the busy photo. */}
      <div className="w-full max-w-sm rounded-2xl border border-white/40 bg-white/85 p-8 shadow-2xl backdrop-blur-md">
        <div className="mb-8 text-center">
          {/* Full lockup, light variant (navy wordmark) for the light frosted card. */}
          <img
            src="/granted-lockup-light.svg"
            alt="GRANTED"
            className="mx-auto mb-4 h-12 w-auto"
          />
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to continue
          </p>
        </div>

        {sent ? (
          <div className="text-center text-sm">
            <p className="font-medium">Check your email</p>
            <p className="mt-1 text-muted-foreground">
              We sent a sign-in link to <span className="font-medium">{email}</span>.
            </p>
          </div>
        ) : (
          <form
            onSubmit={mode === "password" ? handlePassword : handleMagic}
            className="space-y-4"
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
                {/* Show/hide toggle. The input keeps right padding so its own text never runs
                    under the button; the button sits inside a relative wrapper. */}
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    // Not a form control: aria-label names the action, aria-pressed reports the
                    // toggle state, and tabIndex=-1 keeps it out of the Tab path between the field
                    // and the submit button (mouse/AT users still reach it by its label).
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    tabIndex={-1}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-brand-navy focus-visible:outline-none focus-visible:text-brand-navy"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
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
