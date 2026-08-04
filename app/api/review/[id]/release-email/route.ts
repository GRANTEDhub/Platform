import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendOutreachEmail, isDeliverableEmail } from "@/lib/email/send";
import { appBaseUrl } from "@/lib/site-url";
import { loadAlertContext } from "@/lib/alerts/generate";
import { getOrCreateDraftAlert, assembleOutwardAlertPdf, getDraftAlert, ensureDecisionUrls } from "@/lib/alerts/store";
import {
  decisionTextBlock,
  bodyCarriesDecisionUrls,
  bodyMentionsDecidePath,
  type DecisionUrls,
} from "@/lib/alerts/decide-links";
import { formatDeadline } from "@/lib/grants/format";

// "Send Email" release for an account-managed client: RELEASE the card to the
// client's portal (sme_released_at) and notify them with a CUSTOM, editable
// plain-text email -- no PDF one-pager. The sibling of "Send Alert" (the PDF
// flow); both release, neither approves (the client still makes the pursue call).
// GET returns a default editable draft; POST releases + sends. The release is the
// source of truth (set first, unconditionally, like the existing release button);
// the email is a best-effort notification, gated like every outreach send.
export const runtime = "nodejs";
// The one-pager is generated on demand when the card has no saved draft yet (LLM
// enrichment + a Chromium render), so this route now needs the same headroom the alert
// send path has. A card that already has a draft reuses it and returns in seconds.
export const maxDuration = 300;

type ReleaseCtx = {
  clientId: string | null;
  grantId: string | null;
  cardType: string;
  grantTitle: string | null;
  contactEmail: string | null;
  contactName: string | null;
};

async function adminAndCtx(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
): Promise<{ error: NextResponse } | { userId: string; ctx: ReleaseCtx }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile) return { error: NextResponse.json({ error: "Staff only" }, { status: 403 }) };

  const { data: card } = await supabase
    .from("review_cards")
    .select("client_id, grant_id, card_type, grants(title), clients(primary_contact_email, primary_contact_name)")
    .eq("id", cardId)
    .maybeSingle();
  if (!card) return { error: NextResponse.json({ error: "Card not found" }, { status: 404 }) };
  const grant = Array.isArray(card.grants) ? card.grants[0] : card.grants;
  const client = Array.isArray(card.clients) ? card.clients[0] : card.clients;
  return {
    userId: user.id,
    ctx: {
      clientId: card.client_id,
      grantId: card.grant_id,
      cardType: card.card_type,
      grantTitle: grant?.title ?? null,
      contactEmail: client?.primary_contact_email ?? null,
      contactName: client?.primary_contact_name ?? null,
    },
  };
}

// One definition of the portal deep link, used by the GET draft, the HTML anchor, and
// nothing else. Two copies of this string is how the anchor ends up pointing somewhere the
// text part does not -- and plainTextToHtml matches the URL line VERBATIM, so a drifted
// copy silently produces an email with no link at all.
//
// GRANT ALERTS, NOT THE REPORT DETAIL. This used to point at /portal/grants/[cardId],
// which is the wrong screen twice over for a card we are releasing: the Report LIST
// filters on `interested_at is not null`, so a just-released card is not in the list that
// page belongs to; and that page's decision bar asks the Report-stage question
// (Pursue / Save / Pass) when the client has not answered the alert-stage one yet. The
// deck deep-links to the emailed grant, so they land on the alert we wrote to them about.
function portalUrl(req: NextRequest, cardId: string): string {
  return `${appBaseUrl(req)}/portal/triage?card=${cardId}`;
}

function defaultSubject(title: string | null): string {
  const t = (title ?? "New opportunity").trim();
  return `New grant match ready to review | ${t.length > 50 ? t.slice(0, 50).replace(/\s+\S*$/, "").trim() + "…" : t}`;
}

// "Hello," and NOT "Hi <contact name>,". The stored contact is a full name, so the
// personalised form read "Hi Ryan Cork," -- which is how a mail-merge introduces itself,
// not how someone you already work with does. Matches buildAlertEmailBody (the PDF path),
// so the two client-facing emails now open the same way.
function defaultBody(ctx: ReleaseCtx, url: string, decision: DecisionUrls | null): string {
  return [
    "Hello,",
    "",
    `Your GRANTED team flagged a new grant match we think is worth a look: ${ctx.grantTitle?.trim() || "a new opportunity"}.`,
    "",
    // Attachment FIRST, portal link second, because the attachment is the no-sign-in path
    // and the link is the one we would rather they use. Both are offered; neither is
    // presented as the only way in.
    "The one-page alert is attached, so you can read it without signing in. The full details are in your portal:",
    url,
    // The one-click block, in the TEXT, because the text is the source and the HTML box is
    // derived from it. Editable like the rest of the draft: delete these lines in the
    // composer and the buttons go with them.
    ...(decision ? [decisionTextBlock(decision)] : []),
    "",
    "Happy to talk it through whenever you're ready.",
    "",
    // "Best, / GRANTED", matching buildAlertEmailBody. Was "— GRANTED", which broke the
    // no-em-dashes rule the alert builder documents and the enrichment prompts enforce --
    // and left the firm's two client-facing emails signing off two different ways.
    "Best,",
    "GRANTED",
  ].join("\n");
}

// The anchor text for the portal URL in the HTML part. The grant name reads as the thing
// you are clicking towards; "Click here" reads as an instruction from a system. Falls back
// only when there is no title to use.
function linkLabel(title: string | null): string {
  const t = (title ?? "").trim();
  if (!t) return "View it in your portal";
  // Capped at the same 50 characters as the subject, cut on a word boundary. Federal
  // programme names run past 90 characters and an anchor that long stops looking like a
  // link and starts looking like wrapped body text.
  const short = t.length > 50 ? `${t.slice(0, 50).replace(/\s+\S*$/, "").trim()}…` : t;
  return `View ${short} in your portal`;
}

// Default editable draft for the composer.
//
// Reads the decision URLs off an EXISTING saved draft only (getDraftAlert, a cheap row
// read) -- never generates one. Generating here would run enrichment plus a Chromium
// render inside a composer fetch and hang the panel for a minute. In practice the release
// flow previews the one-pager first, so a draft is normally already there and the composer
// shows the exact block that goes out. When it is not, POST mints and appends before
// sending, so the client still gets the buttons.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const r = await adminAndCtx(supabase, params.id);
  if ("error" in r) return r.error;
  const url = portalUrl(req, params.id);
  const existing = await getDraftAlert(params.id);
  const decision = (existing?.alert_data as { decisionUrls?: DecisionUrls | null } | undefined)?.decisionUrls ?? null;
  return NextResponse.json({
    to: r.ctx.contactEmail ?? "",
    subject: defaultSubject(r.ctx.grantTitle),
    body: defaultBody(r.ctx, url, decision),
  });
}

// Release + send the custom email.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const r = await adminAndCtx(supabase, params.id);
  if ("error" in r) return r.error;
  const { userId, ctx } = r;

  const input = (await req.json().catch(() => ({}))) as { to?: string; subject?: string; body?: string };
  const to = (input.to ?? ctx.contactEmail ?? "").trim();
  const subject = (input.subject ?? "").trim() || defaultSubject(ctx.grantTitle);
  const body = (input.body ?? "").trim();
  if (!body) return NextResponse.json({ error: "Empty email body" }, { status: 400 });

  // Release first -- the portal-visibility flag is the source of truth and must
  // land even if the email is gated off (preview) or fails. Staff-scoped write
  // (RLS); sme_released_at isn't the approval trigger, so no admin gate fires here.
  const { error: relErr } = await supabase
    .from("review_cards")
    .update({ sme_released_at: new Date().toISOString(), sme_released_by: userId })
    .eq("id", params.id);
  if (relErr) return NextResponse.json({ error: "Failed to release card" }, { status: 500 });

  let sent = false;
  let send_status: string;
  let reason: string | undefined;
  if (!isDeliverableEmail(to)) {
    send_status = "released — no deliverable email, notice not sent";
    reason = "no deliverable email on file";
  } else {
    const gate = canSendOutreach(to);
    if (!gate.ok) {
      send_status = `released, notice not sent (${gate.reason})`;
      reason = gate.reason;
    } else {
      try {
        // The one-pager, attached. Best-effort: a client who cannot open the portal is
        // exactly who the attachment is for, but a PDF that fails to render must not cost
        // them the notice entirely -- so a failure here sends the email without it and
        // says so in the returned status rather than throwing the whole send away.
        let pdf: Buffer | null = null;
        let pdfNote: string | null = null;
        let decisionUrls: DecisionUrls | null = null;
        let deadline: string | null = null;
        try {
          const alertCtx = await loadAlertContext(params.id);
          if (!alertCtx) throw new Error("alert context unavailable");
          // Save-once: reuses the saved draft when one exists, so this email attaches the
          // SAME PDF a later "Send grant alert" would -- the client never receives two
          // different one-pagers for one grant. withHorizon matches the single-send path.
          const alert = await getOrCreateDraftAlert(alertCtx, userId, appBaseUrl(req), {
            withHorizon: true,
          });
          pdf = await assembleOutwardAlertPdf(alert);
          // The SAME pair the alert path uses (idempotent, stored on the draft), so the
          // two send paths can never hand a client two different sets of decision links.
          decisionUrls = (await ensureDecisionUrls(alertCtx, alert, userId, appBaseUrl(req))).urls;
          deadline = alertCtx.grant.submission_deadline ?? null;
        } catch (err) {
          pdfNote = err instanceof Error ? err.message : String(err);
          console.error(`[release-email] one-pager unavailable for card ${params.id}:`, err);
        }

        // The composer may not have had the URLs when it loaded the draft body (see GET),
        // so append them if the sender's body does not carry them. NOT unconditional: if
        // they are already in there, appending would duplicate the block, and if the sender
        // deliberately deleted them, re-adding would override a decision they made.
        const alreadyIn = decisionUrls ? bodyCarriesDecisionUrls(body, decisionUrls) : false;
        const finalBody =
          decisionUrls && !alreadyIn && !bodyMentionsDecidePath(body)
            ? `${body.trimEnd()}\n${decisionTextBlock(decisionUrls)}\n`
            : body;
        const decision =
          decisionUrls && bodyCarriesDecisionUrls(finalBody, decisionUrls)
            ? {
                grantTitle: ctx.grantTitle || "New grant opportunity",
                deadline: deadline ? formatDeadline(deadline) : null,
                interestedUrl: decisionUrls.interested,
                passUrl: decisionUrls.pass,
                portalUrl: portalUrl(req, params.id),
              }
            : null;

        const result = await sendOutreachEmail({
          to,
          subject,
          body: finalBody,
          contactName: ctx.contactName,
          // Multipart: the HTML part turns the bare portal URL into a real anchor. The
          // text part is unchanged, so a text-only client still gets the readable URL.
          htmlLink: { url: portalUrl(req, params.id), label: linkLabel(ctx.grantTitle) },
          decision,
          attachments: pdf ? [{ filename: "GRANTED-Grant-Alert.pdf", content: pdf }] : undefined,
        });
        await supabase
          .from("review_cards")
          .update({ sent_at: new Date().toISOString(), sent_to: result.to })
          .eq("id", params.id);
        sent = true;
        send_status = pdfNote
          ? `released — email sent to ${result.to}, but the one-pager could not be attached (${pdfNote})`
          : `released — email sent to ${result.to} with the one-page alert attached`;
      } catch (err) {
        send_status = `released, email NOT sent: ${err instanceof Error ? err.message : String(err)}`;
        reason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return NextResponse.json({ released: true, sent, to: sent ? to : undefined, reason, send_status });
}
