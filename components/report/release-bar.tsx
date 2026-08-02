"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FileText, Mail } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { ReleaseEmailPanel } from "./release-email-panel";

// "Your decision" — staff's Gate-2 control for an account-managed client (0059), and the
// terminal act of the grant review screen. The call here is "release to the client", not
// a pursue decision: the client makes that later, on their own copy of this page.
//
// A SPLIT BUTTON, not two peers. Releasing is what happens on most grants, and the two
// ways to do it differ only in what lands in the inbox; making them equal-weight siblings
// asked the reviewer to decide the format before deciding the answer. Reject sits below
// as a full-width secondary — routine and reversible, so it is bordered rather than
// filled, and it is not the shadcn destructive red (see BRAND.reject).
//
// Two ways to notify:
//   - Send alert -- the branded one-page PDF (the existing AlertSend flow).
//   - Send email -- a custom, editable plain-text note, no PDF.
// BOTH set sme_released_at (the card moves to the client's Grant Alerts) and NEITHER
// approves -- the client still decides pursuit. Reject is terminal (decision='passed').
export function ReleaseToClientBar({
  cardId,
  released,
  backHref,
  returnNote,
}: {
  cardId: string;
  released: boolean;
  // Where to land after a release/reject -- the card leaves this queue either way,
  // so staying on the now-stale detail page isn't useful.
  backHref: string;
  // "Either way you'll go back to the Grant Report — 9 left." The caller owns the count.
  returnNote: string;
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
      <section className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]">
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
        <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
          Released — the client now sees this in their own Grant Alerts.
        </p>
      </section>
    );
  }

  return (
    <section
      className="shrink-0 rounded-sharp border border-edge bg-white px-[19px] pb-4 pt-[15px]"
      style={{ borderTopWidth: "3px", borderTopColor: BRAND.orange }}
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Your decision</p>
      <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
        Release to the client&apos;s Grant Alerts as a one-page PDF or a custom note — or reject to archive it now.
      </p>

      <div ref={wrapRef} className="relative mt-[13px] flex items-stretch gap-[2px]">
        <button
          type="button"
          disabled={busy}
          onClick={() => setMode("alert")}
          className="inline-flex h-[42px] flex-1 items-center justify-center gap-2 rounded-sharp bg-brand-orange text-[14px] font-semibold text-white transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          Release to client
        </button>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Choose how to release"
          disabled={busy}
          onClick={() => setMenuOpen((v) => !v)}
          className="inline-flex h-[42px] w-[38px] shrink-0 items-center justify-center rounded-sharp bg-brand-orange text-white transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-sharp border border-edge bg-white shadow-overlay"
          >
            <MenuItem
              icon={<FileText className="mt-0.5 h-4 w-4 shrink-0" style={{ color: BRAND.orangeDeep }} />}
              title="Send alert"
              sub="The branded one-page PDF."
              onClick={() => {
                setMenuOpen(false);
                setMode("alert");
              }}
            />
            <MenuItem
              bordered
              icon={<Mail className="mt-0.5 h-4 w-4 shrink-0" style={{ color: BRAND.orangeDeep }} />}
              title="Send email"
              sub="A custom note, no PDF."
              onClick={() => {
                setMenuOpen(false);
                setMode("email");
              }}
            />
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={reject}
        className="mt-[9px] inline-flex h-[38px] w-full items-center justify-center rounded-sharp border text-[13px] font-semibold transition-colors duration-[120ms] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        style={{ borderColor: "rgba(180,70,47,0.3)", color: BRAND.reject }}
      >
        {busy ? "Saving…" : "Reject"}
      </button>

      <p className="mt-[11px] text-[11px] leading-[1.45] text-ink-muted">{returnNote}</p>
      {error && <p className="mt-2 text-[12px]" style={{ color: BRAND.reject }}>{error}</p>}

      {/* Both drivers open their own modal on mount; onClose resets the dropdown. */}
      {mode === "alert" && <AlertSend cardId={cardId} autoOpen onClose={() => setMode(null)} />}
      {mode === "email" && <ReleaseEmailPanel cardId={cardId} backHref={backHref} onClose={() => setMode(null)} />}
    </section>
  );
}

function MenuItem({
  icon,
  title,
  sub,
  onClick,
  bordered,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
  bordered?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-brand-navy/[0.04] ${bordered ? "border-t border-hairline" : ""}`}
    >
      {icon}
      <span>
        <span className="block text-[13px] font-semibold text-brand-navy">{title}</span>
        <span className="block text-[12px] text-ink-muted">{sub}</span>
      </span>
    </button>
  );
}
