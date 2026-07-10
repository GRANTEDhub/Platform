// Server-only gate for the in-app user-management panel (MVP).
//
// A restricted subset of admins may create logins; other admins cannot. There is
// no role above "admin" today, so the simplest safe gate is an env allowlist of
// emails -- mirroring the OUTREACH_SEND_ALLOWLIST pattern. No schema change, no
// new role tier, reversible from Vercel, and it never touches the existing auth
// path or the role model. Graduate to a DB flag in v2 if we outgrow it.
//
// This module holds NO secrets and does not touch auth; it only reads an env
// allowlist and answers a boolean.

/** The user-admin allowlist (lowercased emails), from USER_ADMIN_ALLOWLIST. */
export function userAdminAllowlist(): string[] {
  return (process.env.USER_ADMIN_ALLOWLIST ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True only when `email` is on the allowlist. Case-insensitive; false on empty. */
export function canManageUsers(email: string | null | undefined): boolean {
  const e = email?.trim().toLowerCase();
  if (!e) return false;
  return userAdminAllowlist().includes(e);
}
