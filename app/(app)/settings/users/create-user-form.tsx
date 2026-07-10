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
      setMsg({ ok: true, text: data.warning || `Created ${data.email} as ${data.role}.` });
      setEmail("");
      setPassword("");
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
        <p className="text-xs text-muted-foreground">
          Share it with them — they can sign in immediately and change it later.
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
