import { mintAccessToken, hashToken } from "@/lib/tokens";
import type { createServiceClient } from "@/lib/supabase/server";

// One-click decision links for an account-managed client's grant alert.
//
// The client already receives the grant as an email + a one-page PDF. Answering it
// used to mean signing in and swiping the same summary a second time, so these two
// links let them answer from the inbox: Interested moves it into their Grant
// Report, "Not for us" passes. The portal stays the place to read the detail; the
// email stops being a read-only notice.
//
// ONE TOKEN, TWO URLS -- the action is in the PATH, not the token. Both values are
// decisions the client is entitled to make, so a token per action would buy no
// security (editing the URL only lets them do a thing they may already do) while
// doubling the mint and making "here is the reverse" on the landing page awkward.
//
// TTL FOLLOWS THE DEADLINE. A decision link is only meaningful while the grant can
// still be pursued, so it dies with the opportunity rather than 45 days after the
// send. Clamped at both ends: a floor so a nearly-due grant still gets a usable
// link, a ceiling so a rolling / undated program does not mint a year-long one.
type DB = ReturnType<typeof createServiceClient>;

export const DECISION_ACTION = "client_alert_decision";

const TTL_MIN_DAYS = 7;
const TTL_MAX_DAYS = 60;

export interface DecisionUrls {
  interested: string;
  pass: string;
}

function ttlDaysFor(deadline: string | null | undefined): number {
  const raw = (deadline ?? "").trim();
  if (!raw) return TTL_MAX_DAYS;
  const at = new Date(raw).getTime();
  if (Number.isNaN(at)) return TTL_MAX_DAYS;
  // +1 so a link minted on the deadline itself is still live that day.
  const days = Math.ceil((at - Date.now()) / 86_400_000) + 1;
  return Math.min(TTL_MAX_DAYS, Math.max(TTL_MIN_DAYS, days));
}

export async function mintDecisionUrls(
  db: DB,
  opts: {
    clientId: string;
    grantId: string;
    origin: string;
    createdBy?: string | null;
    deadline?: string | null;
  },
): Promise<DecisionUrls | null> {
  const minted = await mintAccessToken(db, {
    actionType: DECISION_ACTION,
    clientId: opts.clientId,
    grantId: opts.grantId,
    createdBy: opts.createdBy ?? null,
    ttlDays: ttlDaysFor(opts.deadline),
  });
  if (!minted) return null;
  const base = `${opts.origin.replace(/\/+$/, "")}/decide/${minted.rawToken}`;
  return { interested: `${base}/interested`, pass: `${base}/pass` };
}

// The plain-text block that carries the decision URLs.
//
// THE TEXT IS THE SOURCE, so these URLs go in the text part and the HTML box is
// derived from them -- see plainTextToHtml. That is also what makes the block
// EDITABLE: an admin who deletes these lines from the preview removes the buttons
// from both parts, because the HTML renderer only draws the box when it finds both
// URLs on their own lines in the text it was handed.
//
// ONE PARAGRAPH, single newlines throughout, and that is load-bearing rather than a
// formatting preference: plainTextToHtml splits on blank lines and swaps THE BLOCK
// CONTAINING THESE URLS for the rendered box. Internal blank lines would split it
// across several blocks, so only the first would become the box and the rest would
// render as stray bare URLs underneath it. Callers supply the blank line BEFORE it
// (see insertDecisionBlock) -- baking one in here would merge this block with
// whatever line precedes it and the box would swallow that line too.
export function decisionTextBlock(urls: DecisionUrls): string {
  return [
    "You can answer straight from this email.",
    "Interested — move it into your Grant Report:",
    urls.interested,
    "Not for us:",
    urls.pass,
  ].join("\n");
}

// The block's non-URL lines, so a previously-written block can be found and removed
// wherever it sits. Kept beside decisionTextBlock deliberately -- if that copy changes,
// this list is the thing that has to change with it.
const BLOCK_LABELS = [
  "You can answer straight from this email.",
  "Interested — move it into your Grant Report:",
  "Not for us:",
];

// Remove a decision block already written into a body, wherever it is. Needed because
// drafts written before the position fix have the block AFTER the sign-off, and the HTML
// box now renders wherever the text block sits -- so without this, an existing draft would
// keep showing the buttons below "Best, / GRANTED" forever.
//
// Matches on whole lines only, so prose that happens to contain one of these phrases mid
// sentence is untouched.
export function stripDecisionBlock(body: string): string {
  const dropped = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (BLOCK_LABELS.includes(t)) return false;
      return !/^https?:\/\/\S*\/decide\/[A-Za-z0-9_-]+\/(interested|pass)$/.test(t);
    })
    .join("\n");
  // Removing interior lines leaves runs of blank lines that would otherwise show up as
  // extra paragraph gaps in both parts.
  return dropped.replace(/\n{3,}/g, "\n\n").trimEnd();
}

// Put the block in its canonical place: stripped from wherever it was, then reinserted
// before the sign-off. Idempotent, so a body already correct comes back unchanged and the
// caller can skip the write.
export function normalizeDecisionBlock(body: string, urls: DecisionUrls): string {
  return insertDecisionBlock(stripDecisionBlock(body), urls);
}

// Put the block BEFORE THE SIGN-OFF rather than at the end of the body. Appending put
// the decision after "Best, / GRANTED", which reads as a postscript to a finished
// letter -- and in the HTML part the box then landed outside the note entirely. The
// decision belongs where the reader is asked for it: after the last thing we tell them
// and before we sign our name.
//
// Anchored on the LAST "Best," line so a body that happens to use the word earlier is
// unaffected. No sign-off (a hand-edited note that dropped it) falls back to appending,
// which is the previous behaviour and never loses the buttons.
export function insertDecisionBlock(body: string, urls: DecisionUrls): string {
  const block = decisionTextBlock(urls);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Best,\s*$/.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at === -1) return `${body.trimEnd()}\n\n${block}\n`;
  const head = lines.slice(0, at).join("\n").trimEnd();
  const tail = lines.slice(at).join("\n");
  return `${head}\n\n${block}\n\n${tail}`;
}

// Do both URLs still appear, each alone on its own line, in the body being sent?
// The guard for rendering the box: if the sender edited or removed the lines, the
// HTML must not keep offering buttons the text no longer mentions.
export function bodyCarriesDecisionUrls(body: string, urls: DecisionUrls): boolean {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  return lines.includes(urls.interested.trim()) && lines.includes(urls.pass.trim());
}

// Hash for the RPC. Re-exported here so the landing page imports one module and
// cannot accidentally send the raw token to Postgres -- record_card_decision_by_token
// takes the hash, exactly as resolveToken reads it.
export function decisionTokenHash(rawToken: string): string {
  return hashToken(rawToken);
}
