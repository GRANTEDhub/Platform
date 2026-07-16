import "server-only";
import { createServiceClient, type createClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendGrantAlertEmail, isDeliverableEmail } from "@/lib/email/send";
import { loadAlertContext } from "@/lib/alerts/generate";
import {
  getOrCreateDraftAlert,
  getDraftAlert,
  loadAlertPdf,
  claimAlertForSend,
  releaseAlertClaim,
  type GrantAlertRow,
} from "@/lib/alerts/store";
import { getSentAlertsByCards } from "@/lib/alerts/sent-status";
import { recordClientDecision, finalizeClientCardSent } from "@/lib/alerts/send-core";
import { mergeAlertPdfs } from "@/lib/alerts/merge-pdf";
import { buildClientBatchEmail, type BatchGrant } from "@/lib/alerts/compose-batch";
import type { Client, Grant } from "@/types/database";

// Client aggregate (multi-select) send: prepare drafts, then send the selected
// matches as ONE merged-PDF email. Built entirely on the verified send-core leaves
// (recordClientDecision / claimAlertForSend / finalizeClientCardSent /
// releaseAlertClaim) + the Stage-2a merge/compose units, so the per-card state is
// PROVABLY identical to N single-sends -- the only difference is delivery (one
// merged email vs. N). See send-core.ts for the pre-email/post-email split.

type DB = ReturnType<typeof createServiceClient>;
type UserDB = ReturnType<typeof createClient>;

// Soft cap on a single batch: bounds render cost AND the merged PDF's page count
// (a 20+-page attachment is unwieldy for the recipient). The UI blocks selection
// above this; both routes reject it defensively.
export const MAX_BATCH_GRANTS = 20;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type BatchGrantRow = Pick<Grant, "id" | "title" | "funder" | "submission_deadline" | "deadline">;
type BatchCard = { id: string; grant: BatchGrantRow };

// Supabase types a to-one embed as either an object or a 1-element array; normalize.
function grantOf(g: unknown): BatchGrantRow | null {
  if (!g) return null;
  const row = Array.isArray(g) ? g[0] : g;
  return (row ?? null) as BatchGrantRow | null;
}

// Sort key for deadline-ascending order: soonest first, no-deadline / rolling last.
// Uses the parsed ISO `deadline` (null for rolling/undated) -> Infinity sorts last.
// Exported so the ordering is unit-testable in isolation.
export function deadlineSortKey(g: Pick<Grant, "deadline">): number {
  const t = g.deadline ? Date.parse(g.deadline) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}

export function sortByDeadline<T extends { grant: Pick<Grant, "deadline" | "title"> }>(cards: T[]): T[] {
  return cards
    .slice()
    .sort(
      (a, b) =>
        deadlineSortKey(a.grant) - deadlineSortKey(b.grant) ||
        (a.grant.title ?? "").localeCompare(b.grant.title ?? ""),
    );
}

// Load + validate the selected cards: every requested id must exist, belong to THIS
// client, and be a client card. One query; rejects the whole request on any
// mismatch (enforces the single-recipient + homogeneous-card_type invariant) or an
// over-cap selection.
async function loadBatchCards(
  db: DB,
  clientId: string,
  cardIds: string[],
): Promise<{ cards: BatchCard[] } | { error: string; status: number }> {
  if (cardIds.length === 0) return { error: "No grants selected", status: 400 };
  if (cardIds.length > MAX_BATCH_GRANTS) {
    return { error: `Too many grants selected (max ${MAX_BATCH_GRANTS})`, status: 400 };
  }
  const { data } = await db
    .from("review_cards")
    .select("id, client_id, card_type, grant_id, grants(id, title, funder, submission_deadline, deadline)")
    .in("id", cardIds)
    .eq("client_id", clientId)
    .eq("card_type", "client");
  const rows = (data ?? []) as { id: string; grant_id: string | null; grants: unknown }[];
  const found = new Map(rows.map((r) => [r.id, r]));
  const missing = cardIds.filter((id) => !found.has(id));
  if (missing.length) {
    return { error: `Cards not found for this client: ${missing.join(", ")}`, status: 400 };
  }
  const cards: BatchCard[] = [];
  for (const id of cardIds) {
    const row = found.get(id)!;
    const grant = grantOf(row.grants);
    if (!grant) return { error: `Card ${id} has no grant`, status: 400 };
    cards.push({ id, grant });
  }
  return { cards };
}

export type PrepareBatchResult = {
  done: boolean;
  prepared: number;
  remaining: number;
  failed: { id: string; error: string }[];
  // No-progress terminal signal: a round rendered nothing (prepared === 0) yet work
  // remains AND at least one card errored -> every renderable card is failing, so the
  // caller MUST stop looping and surface `failed` rather than spin forever. This is
  // the guard for the exact failure that stalled this route (a swallowed render error
  // turning into a silent infinite loop).
  stuck: boolean;
};

// One budgeted round of draft preparation: render + save a draft for each selected
// card that lacks one, SEQUENTIALLY (one Chromium at a time -- memory-safe), until
// the time budget elapses. Reuse-existing-untouched (getOrCreateDraftAlert skips a
// card that already has a draft), so a re-POST only renders what's still missing ->
// monotonic progress -> resumable. NEVER a synchronous N-render (the caller loops
// this bounded round), and NOT coupled to the scoring drain.
export async function prepareClientBatch(opts: {
  clientId: string;
  cardIds: string[];
  userId: string;
  origin: string;
  budgetMs: number;
}): Promise<{ result: PrepareBatchResult | { error: string }; status: number }> {
  const db = createServiceClient();
  const loaded = await loadBatchCards(db, opts.clientId, opts.cardIds);
  if ("error" in loaded) return { result: { error: loaded.error }, status: loaded.status };

  const deadlineMs = Date.now() + opts.budgetMs;
  let prepared = 0;
  const failed: { id: string; error: string }[] = [];
  for (const c of loaded.cards) {
    if (Date.now() >= deadlineMs) break; // budget spent; caller re-POSTs for the rest
    if (await getDraftAlert(c.id)) continue; // already drafted -> reuse untouched
    try {
      const ctx = await loadAlertContext(c.id);
      if (!ctx) {
        failed.push({ id: c.id, error: "alert context not found" });
        continue;
      }
      await getOrCreateDraftAlert(ctx, opts.userId, opts.origin); // enrich + render + persist
      prepared++;
    } catch (err) {
      // RECORD the failure so the caller can see it. A swallowed render error that
      // silently stalled the loop was the bug here; the round stays non-fatal (other
      // cards proceed), but `stuck` below turns a wholly-failing round into a
      // terminating, reported error instead of an infinite retry.
      console.error(`[prepare-batch] draft render failed for card ${c.id}:`, err);
      failed.push({ id: c.id, error: errMsg(err) });
    }
  }
  let remaining = 0;
  for (const c of loaded.cards) if (!(await getDraftAlert(c.id))) remaining++;
  // No progress + work remains + something errored => every renderable card is
  // failing. STOP: report `failed` so the caller surfaces it, never spins.
  const stuck = prepared === 0 && failed.length > 0 && remaining > 0;
  return { result: { done: remaining === 0, prepared, remaining, failed, stuck }, status: 200 };
}

export type SendBatchResult =
  | { sent: true; to: string; count: number; finalized: string[]; finalizeFailed: { id: string; error: string }[] }
  | { sent: false; alreadySent?: true; reason?: string; send_status?: string; error?: string; missing?: string[] };

// Send the selected client matches as ONE merged-PDF email. Sequence (mirrors the
// single-send per-card order -- decision -> gate -> claim -> [email] -> finalize --
// fanned across the batch):
//   1. resolve + validate the set; drop already-sent; require prepared drafts
//   2. record decisions on ALL candidates (pre-email; stands even if blocked)
//   3. gate ONCE on the single recipient
//   4. claim-all -> the FINAL set (a lost claim is dropped: a concurrent send owns it)
//   5. merge the claimed set's saved PDFs (deadline-sorted)
//   6. resolve the send subject/body (request-provided, else composed over claimed)
//   7. send ONCE
//   8. email threw -> release ALL claims (decisions stand); else finalize each
//      best-effort (the pre-email claim already flipped every draft to 'sent', so a
//      finalize failure can never cause a double-send -- worst case a missing stamp)
export async function sendClientBatch(
  userClient: UserDB,
  opts: { clientId: string; cardIds: string[]; subject?: string; body?: string; userId: string },
): Promise<{ result: SendBatchResult; status: number }> {
  const db = createServiceClient();

  // ── 1. resolve + validate ────────────────────────────────────────────────
  const loaded = await loadBatchCards(db, opts.clientId, opts.cardIds);
  if ("error" in loaded) return { result: { sent: false, error: loaded.error }, status: loaded.status };

  const { data: client } = await db
    .from("clients")
    .select("id, primary_contact_email")
    .eq("id", opts.clientId)
    .single<Pick<Client, "id" | "primary_contact_email">>();
  if (!client) return { result: { sent: false, error: "Client not found" }, status: 404 };
  const recipient = (client.primary_contact_email ?? "").trim();

  // Drop already-sent cards (batch form of Guard 1) BEFORE anything else.
  const sentMap = await getSentAlertsByCards(opts.cardIds);
  let candidates = loaded.cards.filter((c) => !sentMap.has(c.id));

  // Require a prepared draft for every remaining card -- NEVER render inline here.
  const drafts = new Map<string, GrantAlertRow>();
  const missing: string[] = [];
  for (const c of candidates) {
    const d = await getDraftAlert(c.id);
    if (d) drafts.set(c.id, d);
    else missing.push(c.id);
  }
  if (missing.length) {
    return { result: { sent: false, error: "Drafts not prepared for all selected grants", missing }, status: 409 };
  }

  candidates = sortByDeadline(candidates); // soonest deadline first (== PDF page order)
  if (candidates.length === 0) {
    return {
      result: { sent: false, alreadySent: true, send_status: "All selected grants were already sent." },
      status: 200,
    };
  }

  // Body/subject for the DECISION write: request-provided (the modal composed/edited
  // it), else a default composed over the candidate set. The email itself is
  // (re)resolved over the claimed set at step 6.
  const reqSubject = opts.subject?.trim() || "";
  const reqBody = opts.body?.trim() || "";
  const candidateGrants: BatchGrant[] = candidates.map((c) => c.grant);
  const decisionSubject = reqSubject || buildClientBatchEmail(candidateGrants).subject;
  const decisionBody = reqBody || buildClientBatchEmail(candidateGrants).body;

  // ── 2. record decisions on all candidates (pre-email; stands even if blocked) ─
  for (const c of candidates) {
    const decision = await recordClientDecision(userClient, c.id, opts.userId, decisionBody);
    if (!decision.ok) {
      const forbidden = decision.reason === "approval_forbidden";
      return {
        result: { sent: false, error: forbidden ? "Only admins can approve a match for client delivery" : "Failed to record decision" },
        status: forbidden ? 403 : 500,
      };
    }
  }

  // ── 3. gate ONCE on the recipient (decisions already stand) ──────────────────
  if (!isDeliverableEmail(recipient)) {
    return {
      result: { sent: false, reason: "no deliverable email on file", send_status: "approved — no deliverable email, alert not sent" },
      status: 200,
    };
  }
  const gate = canSendOutreach(recipient);
  if (!gate.ok) {
    return { result: { sent: false, reason: gate.reason, send_status: `approved, alert not sent (${gate.reason})` }, status: 200 };
  }

  // ── 4. claim-all -> the FINAL set (order preserved from the deadline sort) ────
  const claimResults = await Promise.all(
    candidates.map(async (c) => ({ c, ok: await claimAlertForSend(drafts.get(c.id)!.id, recipient) })),
  );
  const claimed = claimResults.filter((r) => r.ok).map((r) => r.c);
  if (claimed.length === 0) {
    return {
      result: { sent: false, alreadySent: true, send_status: "Already sent — a concurrent send delivered these alerts." },
      status: 200,
    };
  }

  // ── 5. merge the claimed set's saved PDFs (deadline-sorted) ──────────────────
  let merged: Buffer;
  try {
    const pdfs = await Promise.all(claimed.map((c) => loadAlertPdf(drafts.get(c.id)!)));
    merged = await mergeAlertPdfs(pdfs);
  } catch (err) {
    await Promise.all(claimed.map((c) => releaseAlertClaim(drafts.get(c.id)!.id)));
    return {
      result: { sent: false, error: `Merge failed: ${errMsg(err)}`, send_status: `approved, alert NOT sent: ${errMsg(err)}` },
      status: 502,
    };
  }

  // ── 6. resolve send subject/body over the CLAIMED set (honest count) ─────────
  const claimedGrants: BatchGrant[] = claimed.map((c) => c.grant);
  const sendSubject = reqSubject || buildClientBatchEmail(claimedGrants).subject;
  const sendBody = reqBody || buildClientBatchEmail(claimedGrants).body;

  // ── 7. send ONCE ─────────────────────────────────────────────────────────────
  let result: Awaited<ReturnType<typeof sendGrantAlertEmail>>;
  try {
    result = await sendGrantAlertEmail({ to: recipient, subject: sendSubject, body: sendBody, pdf: merged });
  } catch (err) {
    // ── 8a. email failed -> release ALL claims; decisions stand, re-run re-sends ─
    await Promise.all(claimed.map((c) => releaseAlertClaim(drafts.get(c.id)!.id)));
    return {
      result: { sent: false, error: `Send failed: ${errMsg(err)}`, send_status: `approved, alert NOT sent: ${errMsg(err)}` },
      status: 502,
    };
  }

  // ── 8b. email delivered -> finalize each best-effort (never double-sends) ─────
  const finalized: string[] = [];
  const finalizeFailed: { id: string; error: string }[] = [];
  for (const c of claimed) {
    try {
      await finalizeClientCardSent(userClient, c.id, drafts.get(c.id)!.id, result.to, sendSubject, sendBody);
      finalized.push(c.id);
    } catch (err) {
      // The claim already flipped this draft to 'sent' (step 4, pre-email), so it is
      // already excluded from any re-send; a failed finalize leaves only a missing
      // review_cards stamp (cosmetic). Loud log + report; never abort the rest.
      console.error(`[send-batch] finalize failed for card ${c.id} (email already delivered; draft is 'sent'):`, err);
      finalizeFailed.push({ id: c.id, error: errMsg(err) });
    }
  }
  return { result: { sent: true, to: result.to, count: claimed.length, finalized, finalizeFailed }, status: 200 };
}
