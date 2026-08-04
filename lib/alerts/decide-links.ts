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

// The plain-text block appended to the saved draft body.
//
// THE TEXT IS THE SOURCE, so these URLs go in the text part and the HTML box is
// derived from them -- see plainTextToHtml. That is also what makes the block
// EDITABLE: an admin who deletes these lines from the preview removes the buttons
// from both parts, because the HTML renderer only draws the box when it finds both
// URLs on their own lines in the text it was handed.
export function decisionTextBlock(urls: DecisionUrls): string {
  return [
    "",
    "You can answer straight from this email.",
    "",
    "Interested — move it into your Grant Report:",
    urls.interested,
    "",
    "Not for us:",
    urls.pass,
  ].join("\n");
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
