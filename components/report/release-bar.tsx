"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FileText, Mail } from "lucide-react";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { ReleaseEmailPanel } from "./release-email-panel";

// Staff's OWN Gate-2 control for an account-managed client (0059) -- shown INSTEAD
// of the normal DecisionBar on the staff roadmap detail, since the call here is
// "release to the client", not a pursue decision (the client makes that later, on
// their own copy of this page). Release is now a dropdown with two ways to notify:
//   - Send alert -- the branded one-page PDF (the existing AlertSend flow).
//   - Send email -- a custom, editable plain-text note, no PDF.
// BOTH set sme_released_at (the card moves to the client's Grant Alerts) and NEITHER
// approves -- the client still decides pursuit. Reject is terminal (decision='passed').
export function ReleaseToClientBar({
  cardId,
  released,
  backHref,
}: {
  cardId: string;
  released: boolean;
  // Where to land after a release/reject -- the card leaves this queue either way,
  // so staying on the now-stale detail page isn't useful.
  backHref: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<null | "alert" | "email">(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Outside-click + Escape close for the menu (mirrors the notification bell).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "passed" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that");
      router.push(backHref);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  if (released) {
    return (
      <div className="mt-6 border-t border-brand-navy/[0.06] pt-6">
        <p className="text-[13px] text-muted-foreground">
          Released to the client — they now see this in their own Grant Alerts.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 border-t border-brand-navy/[0.06] pt-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Account-managed — your review
      </p>
      <p className="mt-1.5 text-[13px] text-muted-foreground">
        Release this match to the client&apos;s Grant Alerts — as the one-page alert PDF or a custom note — or reject to
        archive it now.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div ref={wrapRef} className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={busy}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex items-center gap-2 rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep disabled:opacity-50"
          >
            Release to client
            <ChevronDown className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute left-0 z-50 mt-2 w-64 overflow-hidden rounded-2xl border border-brand-navy/10 bg-white shadow-overlay"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setMode("alert");
                }}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-brand-navy/[0.04]"
              >
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-brand-orange" />
                <span>
                  <span className="block text-sm font-semibold text-brand-navy">Send alert</span>
                  <span className="block text-[12px] text-muted-foreground">The branded one-page PDF.</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setMode("email");
                }}
                className="flex w-full items-start gap-3 border-t border-brand-navy/[0.06] px-4 py-3 text-left transition hover:bg-brand-navy/[0.04]"
              >
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-brand-orange" />
                <span>
                  <span className="block text-sm font-semibold text-brand-navy">Send email</span>
                  <span className="block text-[12px] text-muted-foreground">A custom note, no PDF.</span>
                </span>
              </button>
            </div>
          )}
        </div>
        <button
          disabled={busy}
          onClick={reject}
          className="px-3 py-2 text-sm font-medium text-destructive/80 transition hover:text-destructive hover:underline disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {/* Both drivers open their own modal on mount; onClose resets the dropdown. */}
      {mode === "alert" && <AlertSend cardId={cardId} autoOpen onClose={() => setMode(null)} />}
      {mode === "email" && <ReleaseEmailPanel cardId={cardId} backHref={backHref} onClose={() => setMode(null)} />}
    </div>
  );
}
