"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, FileText, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { STATUS_LABEL, resumeStep } from "@/lib/intellengine/drafts";
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
  clientId,
  backHref = "/portal",
}: {
  clientName: string;
  drafts: HubDraft[];
  candidates: HubCandidate[];
  orbitCount: number;
  // Staff mode (driven from the console client view): the target client is passed
  // explicitly, so drafting acts on THAT client. In staff mode, developing a grant
  // is DRAFT-ONLY -- it never routes/approves the card (that stays an admin action
  // via the pursuit chooser) -- and navigation skips the client-only per-draft
  // landing, going straight to the wizard step.
  clientId?: string;
  backHref?: string;
}) {
  const router = useRouter();
  const staffMode = !!clientId;
  // Where a draft opens: staff go straight to the resume step (the /intellengine/
  // [draftId] landing is a client-only route); clients use the landing.
  const draftHref = (id: string, status: IntellEngineDraftStatus) =>
    staffMode ? `/intellengine/${resumeStep(status)}?draft=${id}` : `/intellengine/${id}`;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-draft delete: confirmId is the row showing its inline "Delete?" confirm;
  // deleting is the row whose delete request is in flight.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setDeleting(id);
    setError(null);
    try {
      const res = await fetch(`/api/intellengine/drafts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Couldn't delete that proposal");
      }
      setConfirmId(null);
      setDeleting(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that proposal");
      setDeleting(null);
    }
  }

  async function startMatched(cardId: string) {
    setBusy(cardId);
    setError(null);
    try {
      // Client mode: routing the card to IntellEngine records the client's pursuit
      // (sets pursuit_path + approval + attribution) via the same endpoint the Grant
      // Report chooser uses. Staff mode: DRAFT-ONLY -- skip this, so drafting on a
      // client's behalf never approves their pursuit (and never hits the admin-only
      // approval trigger, so contractors work).
      if (!staffMode) {
        await fetch(`/api/review/${cardId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pursuit_path: "intellengine" }),
        });
      }
      const res = await fetch("/api/intellengine/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_id: cardId, ...(clientId ? { client_id: clientId } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.draft?.id) {
        router.push(draftHref(data.draft.id, data.draft.status));
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
        body: JSON.stringify(clientId ? { client_id: clientId } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.draft?.id) {
        router.push(draftHref(data.draft.id, data.draft.status));
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
        href={backHref}
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        {staffMode ? `Back to ${clientName}` : "Dashboard"}
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
              <div
                key={d.id}
                className="flex items-center gap-2 rounded-2xl border border-brand-navy/[0.08] bg-white p-4 shadow-grounded transition hover:border-brand-navy/25"
              >
                <Link href={draftHref(d.id, d.status)} className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-navy/[0.06] text-brand-navy">
                    <FileText className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-brand-navy">{d.title}</span>
                    <span className="block text-xs text-muted-foreground">{STATUS_LABEL[d.status]}</span>
                  </span>
                </Link>
                {confirmId === d.id ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="hidden text-xs text-muted-foreground sm:inline">Delete?</span>
                    <button
                      type="button"
                      onClick={() => handleDelete(d.id)}
                      disabled={deleting === d.id}
                      className="flex items-center justify-center rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-700 disabled:opacity-60"
                    >
                      {deleting === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Delete"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      disabled={deleting === d.id}
                      className="rounded-full border border-brand-navy/15 px-3 py-1 text-xs font-medium text-muted-foreground transition hover:text-brand-navy disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setConfirmId(d.id);
                    }}
                    aria-label={`Delete ${d.title}`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
