import { describe, it, expect } from "vitest";
import { confirmFailureTarget, SET_PASSWORD_PATH } from "./setup-redirect";

// Deterministic — pure routing decision, no model, no network. Locks the fix: a failed OTP on a
// SETUP link (next -> /set-password) returns to the set-password page (self-serve resend lives
// there), never the sign-in page; everything else still falls back to /login?error=auth.

describe("confirmFailureTarget", () => {
  it("routes a setup link back to /set-password", () => {
    expect(confirmFailureTarget("/set-password")).toBe(SET_PASSWORD_PATH);
  });

  it("routes a setup link with a query or subpath back to /set-password", () => {
    expect(confirmFailureTarget("/set-password?foo=1")).toBe(SET_PASSWORD_PATH);
    expect(confirmFailureTarget("/set-password/step")).toBe(SET_PASSWORD_PATH);
  });

  it("falls back to /login for a genuine sign-in link destination", () => {
    expect(confirmFailureTarget("/portal")).toBe("/login?error=auth");
    expect(confirmFailureTarget("/")).toBe("/login?error=auth");
  });

  it("falls back to /login for null/empty/whitespace next", () => {
    expect(confirmFailureTarget(null)).toBe("/login?error=auth");
    expect(confirmFailureTarget(undefined)).toBe("/login?error=auth");
    expect(confirmFailureTarget("")).toBe("/login?error=auth");
    expect(confirmFailureTarget("   ")).toBe("/login?error=auth");
  });

  it("does not match a lookalike prefix", () => {
    expect(confirmFailureTarget("/set-password-elsewhere")).toBe("/login?error=auth");
  });
});
