"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronRight, FileText, Loader2, Plus, Sparkles } from "lucide-react";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { STATUS_LABEL } from "@/lib/intellengine/drafts";
import type { IntellEngineDraftStatus } from "@/types/database";

export interface HubDraft {
  id: string;
  title: string;
  status: IntellEngineDraftStatus;
  updatedAt: string;
}

export interface HubCandidate {
  cardId: string;
  title: string;
  funder: string | null;
}

// The IntellEngine hub body (migration 0062). Lists the client's in-flight
// proposals and offers the two entry points: develop a matched grant (opens a
// picker of grants awaiting a pursuit decision) or start one from scratch. Both
// entries create/resume a draft server-side, then open it.
export function IntellEngineHub({
  clientName,
  drafts,
  candidates,
  orbitCount,
}: {
  clientName: string;
  drafts: HubDraft[];
  candidates: HubCandidate[];
  orbitCount: number;
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startMatched(cardId: string) {
    setBusy(cardId);
    setError(null);
    try {
      // Route the card to IntellEngine (sets pursuit_path + approval + attribution)
      // via the same endpoint the Grant Report's chooser uses, then open its draft.
      await fetch(`/api/review/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pursuit_path: "intellengine" }),
      });
      const res = await fetch("/api/intellengine/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_id: cardId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.draft?.id) {
        router.push(`/intellengine/${data.draft.id}`);
        return;
      }
      throw new Error(data.error || "Couldn't open that proposal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open that proposal");
      setBusy(null);
    }
  }

  async function startScratch() {
    setBusy("scratch");
    setError(null);
    try {
      const res = await fetch("/api/intellengine/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.draft?.id) {
        router.push(`/intellengine/${data.draft.id}`);
        return;
      }
      throw new Error(data.error || "Couldn't start a proposal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start a proposal");
      setBusy(null);
    }
  }

  return (
    <>
      <Link
        href="/portal"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Dashboard
      </Link>

      <div className="flex flex-col items-center text-center">
        <IntellEngineLogo size="lg" />
        <p className="mt-4 max-w-xl text-sm text-muted-foreground">
          Draft proposals with GRANTED&apos;s AI. Pick up a matched grant or start from scratch — IntellEngine
          is in preview, so it&apos;s free while we build out drafting.
        </p>
      </div>

      {/* Entry points */}
      <div className="mx-auto mt-10 grid max-w-3xl gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          disabled={busy !== null || candidates.length === 0}
          className="flex flex-col items-start gap-2 rounded-2xl border border-brand-navy/[0.1] bg-white p-5 text-left shadow-grounded transition hover:border-brand-navy/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-navy/[0.06] text-brand-navy">
            <Sparkles className="h-5 w-5" />
          </span>
          <span className="mt-1 flex items-center gap-2 text-[15px] font-semibold text-brand-navy">
            Develop a matched grant
            {orbitCount > 0 && (
              <span className="rounded-full bg-brand-orange/12 px-2 py-0.5 text-[11px] font-semibold text-brand-orange">
                {orbitCount}
              </span>
            )}
          </span>
          <span className="text-[12.5px] leading-relaxed text-muted-foreground">
            {candidates.length > 0
              ? "Turn a grant from your Report into a proposal."
              : "No grants are waiting on a pursuit decision right now."}
          </span>
        </button>

        <button
          type="button"
          onClick={startScratch}
          disabled={busy !== null}
          className="flex flex-col items-start gap-2 rounded-2xl border border-brand-navy/[0.1] bg-white p-5 text-left shadow-grounded transition hover:border-brand-navy/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-navy/[0.06] text-brand-navy">
            {busy === "scratch" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
          </span>
          <span className="mt-1 text-[15px] font-semibold text-brand-navy">Start from scratch</span>
          <span className="text-[12.5px] leading-relaxed text-muted-foreground">
            Jump straight into writing — no matched grant needed.
          </span>
        </button>
      </div>

      {/* Matched-grant picker (Chip A) */}
      {pickerOpen && candidates.length > 0 && (
        <div className="mx-auto mt-4 max-w-3xl rounded-2xl border border-brand-navy/[0.1] bg-white p-4 shadow-grounded">
          <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Pick a grant to develop
          </p>
          <div className="space-y-2">
            {candidates.map((c) => (
              <button
                key={c.cardId}
                type="button"
                onClick={() => startMatched(c.cardId)}
                disabled={busy !== null}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-brand-navy/[0.08] bg-brand-cream/40 px-4 py-3 text-left transition hover:border-brand-navy/25 disabled:opacity-60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-brand-navy">{c.title}</span>
                  {c.funder && <span className="block truncate text-xs text-muted-foreground">{c.funder}</span>}
                </span>
                {busy === c.cardId ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-navy" />
                ) : (
                  <ArrowRight className="h-4 w-4 shrink-0 text-brand-navy" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="mx-auto mt-4 max-w-3xl rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">{error}</p>
      )}

      {/* In-flight proposals */}
      <div className="mx-auto mt-10 max-w-3xl">
        <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Your proposals</h2>
        {drafts.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-brand-navy/15 bg-white/60 p-6 text-center text-sm text-muted-foreground">
            Nothing in progress yet. Start one above and it&apos;ll show up here.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {drafts.map((d) => (
              <Link
                key={d.id}
                href={`/intellengine/${d.id}`}
                className="flex items-center justify-between gap-3 rounded-2xl border border-brand-navy/[0.08] bg-white p-4 shadow-grounded transition hover:border-brand-navy/25"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-navy/[0.06] text-brand-navy">
                    <FileText className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-brand-navy">{d.title}</span>
                    <span className="block text-xs text-muted-foreground">{STATUS_LABEL[d.status]}</span>
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
