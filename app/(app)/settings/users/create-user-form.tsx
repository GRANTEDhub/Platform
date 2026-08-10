"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

// Create-user form. Posts to /api/admin/users, which performs the real create
// server-side (service key never reaches the browser). On success it refreshes
// the server component so the "Existing users" list updates.
export function CreateUserForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"contractor" | "admin">("contractor");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create user");
      // A warning means the account exists but something after it didn't -- a role that
      // wouldn't set, or an email that wouldn't send. It outranks the success line
      // because it is the half the admin has to act on.
      setMsg({
        ok: true,
        text:
          data.warning ||
          `Created ${data.email} as ${data.role}${data.emailed ? " and emailed them their login." : "."}`,
      });
      setEmail("");
      // The password field is NOT cleared on a warning: it is the fallback for a send
      // that failed, and clearing it would destroy the only copy on screen. Cleared only
      // when the invite actually went out.
      if (!data.warning) setPassword("");
      setRole("contractor");
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed to create user" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="new-email">Email</Label>
        <Input
          id="new-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@grantedco.com"
          autoComplete="off"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-password">Temp password</Label>
        <Input
          id="new-password"
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="at least 8 characters"
          autoComplete="off"
          minLength={8}
          required
        />
        {/* The old copy said "they can sign in immediately and change it later". The
            first half was true; the second was not. There is no staff password-reset
            in the app -- /set-password is the CLIENT flow (it ends in /portal behind
            requireClient) and there is no forgot-password page -- so this password
            stands until an admin rotates it in Supabase. Saying so is the point. */}
        <p className="text-xs text-muted-foreground">
          Emailed to them with a link to sign in. They can&apos;t change it themselves — rotate it
          in Supabase if it needs changing.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-role">Role</Label>
        <select
          id="new-role"
          value={role}
          onChange={(e) => setRole(e.target.value as "contractor" | "admin")}
          className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="contractor">Contractor — grant work only</option>
          <option value="admin">Admin — full access</option>
        </select>
      </div>
      <Button type="submit" disabled={busy || !email || password.length < 8}>
        {busy ? "Creating…" : "Create user"}
      </Button>
      {msg && (
        <p className={`text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</p>
      )}
    </form>
  );
}
