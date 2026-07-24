"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SectionTitle, Tag } from "./primitives";
import type { ConceptProposal, ConceptProposalPartner, ConceptProposalRow } from "@/types/database";

// Staff-only display of the auto-generated concept proposal (migration 0060),
// mounted on the account-manager grant detail view. Read-only in this pass -- the
// editable slide-over pane is a follow-up. While a proposal is generating it polls
// until the background job flips it ready/error; an error offers a retry. Never
// rendered on the client portal (the parent gates it to account-managed clients).

const SOURCE_TAG: Record<ConceptProposalPartner["source"], { label: string; suggested: boolean }> = {
  client_cited: { label: "From client", suggested: false },
  prospect: { label: "GRANTED network", suggested: false },
  suggested: { label: "Suggested — verify", suggested: true },
};

function optimisticGeneratingRow(cardId: string): ConceptProposalRow {
  return {
    id: "",
    card_id: cardId,
    grant_id: null,
    client_id: null,
    status: "generating",
    proposal_data: null,
    model: null,
    error: null,
    generated_at: null,
    generated_by: null,
    edited_at: null,
    edited_by: null,
    created_at: "",
  };
}

export function ConceptProposalPanel({
  cardId,
  initial,
}: {
  cardId: string;
  initial: ConceptProposalRow | null;
}) {
  const [row, setRow] = useState<ConceptProposalRow | null>(initial);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/concept/${cardId}`, { cache: "no-store" });
    if (res.ok) {
      const { proposal } = (await res.json()) as { proposal: ConceptProposalRow | null };
      setRow(proposal);
    }
  }, [cardId]);

  // Poll while generating; stop as soon as it settles.
  useEffect(() => {
    if (row?.status !== "generating") return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [row?.status, refresh]);

  const generate = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    // Immediate feedback: flip to the generating state before the round-trip so
    // the click is never a silent no-op.
    setRow((prev) => ({ ...(prev ?? optimisticGeneratingRow(cardId)), status: "generating", error: null }));
    try {
      const res = await fetch(`/api/concept/${cardId}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setActionError(body.error || "Couldn't start generation. Try again.");
        await refresh(); // reconcile back to the real (pre-click) state
        return;
      }
      await refresh();
    } catch {
      setActionError("Couldn't reach the server. Try again.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [cardId, refresh]);

  const status = row?.status;
  const proposal = row?.proposal_data ?? null;

  return (
    <Card elevation="grounded" className="p-6 sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>Concept proposal</SectionTitle>
        {status === "ready" && (
          <button
            onClick={generate}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-orange hover:underline disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
            Regenerate
          </button>
        )}
      </div>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Internal draft of how this client would pursue the grant. Review before releasing to the client.
      </p>

      <div className="mt-4">
        {!row && <EmptyState busy={busy} onGenerate={generate} />}
        {status === "generating" && <GeneratingState />}
        {status === "error" && <ErrorState error={row?.error ?? null} busy={busy} onRetry={generate} />}
        {status === "ready" && proposal && <ProposalBody proposal={proposal} />}
        {status === "ready" && !proposal && (
          <ErrorState error="The proposal generated but came back empty." busy={busy} onRetry={generate} />
        )}
        {actionError && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">{actionError}</p>
        )}
      </div>
    </Card>
  );
}

function EmptyState({ busy, onGenerate }: { busy: boolean; onGenerate: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-brand-navy/15 p-5 text-center">
      <p className="text-sm text-muted-foreground">
        No concept proposal yet. One generates automatically when you mark this grant interested, or generate it now.
      </p>
      <button
        onClick={onGenerate}
        disabled={busy}
        className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-navyDeep disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {busy ? "Starting…" : "Generate concept proposal"}
      </button>
    </div>
  );
}

function GeneratingState() {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-brand-navy/[0.04] p-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin text-brand-orange" />
      Generating concept proposal&hellip; this takes a few seconds.
    </div>
  );
}

function ErrorState({ error, busy, onRetry }: { error: string | null; busy: boolean; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div>
          <p className="text-sm font-semibold text-amber-900">Generation failed</p>
          {error && <p className="mt-0.5 text-[12.5px] text-amber-800">{error}</p>}
          <button
            onClick={onRetry}
            disabled={busy}
            className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-900 hover:underline disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

function Amount({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-brand-navy">{value}</p>
    </div>
  );
}

function ProposalBody({ proposal }: { proposal: ConceptProposal }) {
  const roleLabel = proposal.role === "prime" ? "Prime applicant" : "Partner / sub";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag>{roleLabel}</Tag>
      </div>

      {proposal.scope && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Project scope</p>
          <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-foreground">{proposal.scope}</p>
        </div>
      )}

      <div className="grid gap-x-8 gap-y-4 border-t border-brand-navy/[0.06] pt-4 sm:grid-cols-3">
        {proposal.total_project_amount && (
          <Amount label="Total project (est.)" value={proposal.total_project_amount} />
        )}
        <Amount label="Estimated match" value={proposal.estimated_match ?? "None required"} />
        {proposal.project_term && <Amount label="Project term" value={proposal.project_term} />}
      </div>

      {proposal.partners.length > 0 && (
        <div className="border-t border-brand-navy/[0.06] pt-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Recommended partners
          </p>
          <ul className="mt-3 space-y-3">
            {proposal.partners.map((p, i) => (
              <PartnerRow key={i} partner={p} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PartnerRow({ partner }: { partner: ConceptProposalPartner }) {
  const identity = partner.name || partner.org_type_label || "Partner";
  const tag = SOURCE_TAG[partner.source];
  return (
    <li className="rounded-xl border border-brand-navy/[0.06] bg-white p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-brand-navy">{identity}</span>
        {partner.role && <span className="text-[12.5px] text-muted-foreground">&middot; {partner.role}</span>}
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            tag.suggested ? "bg-amber-100 text-amber-800" : "bg-brand-navy/[0.06] text-brand-navy"
          }`}
        >
          {tag.label}
        </span>
      </div>
      {partner.description && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-foreground">{partner.description}</p>
      )}
    </li>
  );
}
