"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import { PriorEmailGate } from "@/components/alerts/prior-email-gate";
import { MAX_BATCH_GRANTS, deadlineSortKey } from "@/lib/alerts/batch-shared";
import { buildClientBatchEmail, buildLeadBatchEmail } from "@/lib/alerts/compose-batch";
import type { CardDecision } from "@/types/database";
import type { ReOutreach } from "@/lib/alerts/send-core";

// The interactive grant-activity table for a client: multi-select the pending /
// approved-not-sent matches and send them as ONE merged-PDF aggregate alert. Wraps
// the (server-fetched) card list so the server page stays a server component; all
// selection + modal state lives here. Wires the verified prepare-batch / send-batch
// routes; sort + compose come from the SHARED module so what this shows == what the
// server merges and sends.

export type BatchUiCard = {
  id: string;
  title: string | null;
  funder: string | null;
  deadline: string | null;
  submission_deadline: string | null;
  fitScore: 1 | 2 | 3;
  decision: CardDecision;
};

type Phase = "idle" | "preparing" | "ready" | "sending" | "done" | "stuck";

function sortByDeadlineUi(cards: BatchUiCard[]): BatchUiCard[] {
  return cards
    .slice()
    .sort((a, b) => deadlineSortKey(a) - deadlineSortKey(b) || (a.title ?? "").localeCompare(b.title ?? ""));
}

function composeFor(cards: BatchUiCard[], isLead: boolean, senderName: string | null, followUp = false) {
  const grants = sortByDeadlineUi(cards).map((c) => ({ title: c.title, funder: c.funder, submission_deadline: c.submission_deadline }));
  // A lead (Tara-build manual prospect) gets the COLD multi-grant pitch; a client gets
  // the warm alert. Same sort/order both ways so the displayed body matches the merged
  // PDF page order (and what the server sends). `followUp` (lead only) drops the first-
  // contact intro + credential for a re-contact we've emailed before.
  return isLead ? buildLeadBatchEmail(grants, senderName, followUp) : buildClientBatchEmail(grants);
}

export function ClientGrantsBatch({
  clientId,
  clientName,
  recipient,
  cards,
  alertedCardIds,
  isLead,
  senderName,
  priorEmailedAt,
  priorCardId,
}: {
  clientId: string;
  clientName: string;
  recipient: string;
  cards: BatchUiCard[];
  alertedCardIds: string[];
  // A lead (Tara-build manual prospect) sends a COLD multi-grant pitch; a client sends
  // the warm alert. senderName names the cold intro. When isLead=false the behavior is
  // identical to before (warm composer, "Alerted" confirmation).
  isLead: boolean;
  senderName: string | null;
  // Cold re-contact gate: set (lead only) when we've emailed this contact before ->
  // Send is locked until a choice. Null for a warm client batch (no gate, unchanged).
  priorEmailedAt: string | null;
  priorCardId: string | null;
}) {
  const router = useRouter();
  const alerted = useMemo(() => new Set(alertedCardIds), [alertedCardIds]);
  const isSelectable = (c: BatchUiCard) => !alerted.has(c.id) && (c.decision === "pending" || c.decision === "approved");
  const selectableCards = useMemo(() => cards.filter(isSelectable), [cards, alerted]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const atCap = selected.size >= MAX_BATCH_GRANTS;

  // Modal state
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [activeIds, setActiveIds] = useState<string[]>([]); // the set being prepared/sent (sorted)
  const [total, setTotal] = useState(0);
  const [ready, setReady] = useState(0); // drafts prepared so far (= total - remaining)
  const [to, setTo] = useState(recipient);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [failed, setFailed] = useState<{ id: string; error: string }[]>([]);
  const [notReadyIds, setNotReadyIds] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null); // blocked / not-sent banner
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number; finalizeFailed: number } | null>(null);
  const [reoutreach, setReoutreach] = useState<ReOutreach | null>(null); // cold re-contact choice
  const loopingRef = useRef(false);
  const cancelledRef = useRef(false);

  const titleOf = (id: string) => cards.find((c) => c.id === id)?.title ?? "Untitled opportunity";
  // A cold re-contact (lead batch to a known address) must pick a path before Send.
  const coldReContact = !!priorEmailedAt;

  // The gate choice unlocks Send and recomposes the body over the active set: the
  // cold multi-grant pitch, or the follow-up variant (drops intro + credential).
  function chooseReoutreach(v: ReOutreach) {
    setReoutreach(v);
    const c = composeFor(cards.filter((x) => activeIds.includes(x.id)), isLead, senderName, v === "follow_up");
    setSubject(c.subject);
    setBody(c.body);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BATCH_GRANTS) next.add(id);
      return next;
    });
  }
  function selectAllPending() {
    // First MAX by the page's deadline order; if fewer selectable, take them all.
    const ids = sortByDeadlineUi(selectableCards).slice(0, MAX_BATCH_GRANTS).map((c) => c.id);
    setSelected(new Set(ids));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  const previewHref = `/api/clients/${clientId}/preview-batch-pdf?cardIds=${activeIds.join(",")}`;

  // Drive the prepare loop over `ids` until the routes report done or stuck. The
  // count increments per round (each ~25s round renders a draft or two), so the user
  // always sees forward motion -- never a static spinner.
  async function prepareLoop(ids: string[]) {
    if (loopingRef.current) return;
    loopingRef.current = true;
    cancelledRef.current = false;
    setPhase("preparing");
    setActiveIds(ids);
    setTotal(ids.length);
    setReady(0);
    setFailed([]);
    setError(null);
    setStatus(null);
    try {
      const MAX_ROUNDS = 60; // backstop; ids is capped at MAX_BATCH_GRANTS
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (cancelledRef.current) return;
        const res = await fetch(`/api/clients/${clientId}/prepare-batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardIds: ids }),
        });
        const d = await res.json();
        if (cancelledRef.current) return;
        if (!res.ok) throw new Error(d.error || "Preparation failed");
        setReady(ids.length - (d.remaining ?? ids.length));
        if (d.done) {
          const c = composeFor(cards.filter((x) => ids.includes(x.id)), isLead, senderName);
          setSubject(c.subject);
          setBody(c.body);
          setPhase("ready");
          return;
        }
        if (d.stuck) {
          setFailed(d.failed ?? []);
          setNotReadyIds(d.remainingIds ?? []);
          setPhase("stuck");
          return;
        }
        await new Promise((r) => setTimeout(r, 400)); // brief yield between rounds
      }
      throw new Error("Preparation is taking longer than expected — try again.");
    } catch (e) {
      if (!cancelledRef.current) {
        setError(e instanceof Error ? e.message : "Preparation failed");
        setPhase("stuck");
      }
    } finally {
      loopingRef.current = false;
    }
  }

  function openModal() {
    if (selected.size === 0) return;
    const ids = sortByDeadlineUi(cards.filter((c) => selected.has(c.id))).map((c) => c.id);
    setTo(recipient);
    setResult(null);
    setReoutreach(null); // fresh gate choice per send
    setOpen(true);
    void prepareLoop(ids);
  }

  function sendReadySubset() {
    // Proceed with only the cards that DID prepare (selected minus the not-ready set).
    const readyIds = activeIds.filter((id) => !notReadyIds.includes(id));
    if (readyIds.length === 0) {
      setError("None of the selected alerts could be prepared.");
      return;
    }
    const c = composeFor(cards.filter((x) => readyIds.includes(x.id)), isLead, senderName);
    setSubject(c.subject);
    setBody(c.body);
    setActiveIds(readyIds);
    setTotal(readyIds.length);
    setPhase("ready");
  }

  async function send() {
    setPhase("sending");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/send-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardIds: activeIds, subject, body, to, reOutreach: reoutreach ?? undefined }),
      });
      const d = await res.json();
      if (!res.ok && !d.send_status) throw new Error(d.error || "Send failed");
      if (d.sent) {
        setResult({ count: d.count ?? activeIds.length, finalizeFailed: (d.finalizeFailed ?? []).length });
        setPhase("done");
        return;
      }
      // Not sent (blocked / no deliverable / already sent): stay in review with a
      // status banner. Decisions were still recorded (approved) on a gate block.
      setStatus(d.send_status || d.reason || "Not sent.");
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
      setPhase("ready");
    }
  }

  function closeModal() {
    cancelledRef.current = true;
    setOpen(false);
    setPhase("idle");
    if (result) {
      clearSelection();
      router.refresh(); // sent cards now render as "alerted" and drop out of the list
    }
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all pending"
                  checked={selected.size > 0 && selected.size === Math.min(selectableCards.length, MAX_BATCH_GRANTS)}
                  ref={(el) => {
                    if (el) el.indeterminate = selected.size > 0 && selected.size < Math.min(selectableCards.length, MAX_BATCH_GRANTS);
                  }}
                  onChange={(e) => (e.target.checked ? selectAllPending() : clearSelection())}
                  disabled={selectableCards.length === 0}
                />
              </th>
              <th className="px-4 py-3 font-medium">Opportunity</th>
              <th className="px-4 py-3 font-medium">Fit</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Deadline</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => {
              const sel = isSelectable(c);
              const checked = selected.has(c.id);
              return (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 align-top">
                    {alerted.has(c.id) ? (
                      <span title="Already alerted" className="text-emerald-600" aria-label="alerted">✓</span>
                    ) : sel ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.title ?? "grant"}`}
                        checked={checked}
                        disabled={!checked && atCap}
                        onChange={() => toggle(c.id)}
                      />
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <a href={`/review/${c.id}`} className="block truncate font-medium hover:underline">
                      {c.title || "Untitled opportunity"}
                    </a>
                    <p className="truncate text-xs text-muted-foreground">{c.funder}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3"><ScoreBadge score={c.fitScore} /></td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {alerted.has(c.id) ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">alerted</span>
                    ) : (
                      <DecisionBadge decision={c.decision} />
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-muted-foreground">
                    {c.submission_deadline || "—"}
                  </td>
                </tr>
              );
            })}
            {cards.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                  No matches yet for this client. They appear here as grants are ingested and scored.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Floating action bar — appears when at least one grant is selected. */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4">
          <div className="flex w-full max-w-2xl items-center justify-between gap-4 rounded-xl border bg-card px-5 py-3 shadow-xl">
            <div className="text-sm">
              <span className="font-semibold text-brand-navy">{selected.size}</span> selected
              <span className="text-muted-foreground"> · {selected.size} of {MAX_BATCH_GRANTS} max</span>
              {atCap && <span className="ml-2 text-xs text-brand-orange">cap reached</span>}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={clearSelection}>Clear</Button>
              <Button size="sm" onClick={openModal}>Send grant alert · {selected.size} {selected.size === 1 ? "grant" : "grants"}</Button>
            </div>
          </div>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => phase !== "sending" && phase !== "preparing" && closeModal()}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-serif text-lg font-semibold text-brand-navy">Send grant alert · {total} {total === 1 ? "grant" : "grants"}</h2>

            {phase === "preparing" && (
              <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-orange border-t-transparent" />
                <span>Preparing {ready} of {total} alerts…</span>
              </div>
            )}

            {phase === "stuck" && (
              <div className="mt-4 space-y-3">
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {error ? error : `Couldn't prepare ${notReadyIds.length} of ${total} alert(s).`}
                  {failed.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-xs">
                      {failed.map((f) => <li key={f.id} title={f.error}>{titleOf(f.id)}</li>)}
                    </ul>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={closeModal}>Cancel</Button>
                  {activeIds.length - notReadyIds.length > 0 && (
                    <Button onClick={sendReadySubset}>
                      Send the {activeIds.length - notReadyIds.length} ready, skip {notReadyIds.length}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {(phase === "ready" || phase === "sending") && (
              <div className="mt-4 space-y-3">
                <p className="text-xs text-muted-foreground">
                  One email to {clientName} with a {total}-page PDF (one page per grant). Review below, then send.
                </p>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
                  <input type="email" value={to} onChange={(e) => setTo(e.target.value)} disabled={phase === "sending"}
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm" />
                </label>
                {/* Cold re-contact gate (lead batch to a known address). Self-hides for
                    a warm client batch (priorEmailedAt null). Recomposes the body on
                    choice; Send stays locked until one is picked. */}
                <PriorEmailGate
                  priorEmailedAt={priorEmailedAt}
                  priorCardId={priorCardId}
                  value={reoutreach}
                  onChange={chooseReoutreach}
                />
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subject</span>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={phase === "sending"}
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm" />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Note</span>
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} disabled={phase === "sending"}
                    className="flex w-full rounded-md border border-input bg-card px-3 py-2 font-sans text-sm" />
                </label>
                <a href={previewHref} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-orange hover:underline">
                  📎 grant-alerts.pdf ({total} {total === 1 ? "page" : "pages"}) — preview attachment ↗
                </a>
                {status && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{status}</p>}
                {error && <p className="text-sm text-destructive">{error}</p>}
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="ghost" onClick={closeModal} disabled={phase === "sending"}>Cancel</Button>
                  <Button
                    onClick={send}
                    disabled={phase === "sending" || !to.trim() || !body.trim() || (coldReContact && !reoutreach)}
                    title={coldReContact && !reoutreach ? "Choose how to proceed with this re-contact first" : undefined}
                  >
                    {phase === "sending" ? "Sending…" : `Send to ${clientName}`}
                  </Button>
                </div>
              </div>
            )}

            {phase === "done" && result && (
              <div className="mt-6 space-y-3 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-2xl text-emerald-600">✓</div>
                <h3 className="text-base font-semibold text-neutral-900">
                  {isLead ? "Sent to" : "Alerted"} {clientName} {isLead ? "·" : "on"} {result.count} {result.count === 1 ? "grant" : "grants"}
                </h3>
                {result.finalizeFailed > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Delivered. {result.finalizeFailed} {result.finalizeFailed === 1 ? "grant's" : "grants'"} status didn&apos;t finish updating (cosmetic — the alerts were sent).
                  </p>
                )}
                <Button onClick={closeModal}>Done</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
