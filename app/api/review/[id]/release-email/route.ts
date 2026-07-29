import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendOutreachEmail, isDeliverableEmail } from "@/lib/email/send";
import { appBaseUrl } from "@/lib/site-url";

// "Send Email" release for an account-managed client: RELEASE the card to the
// client's portal (sme_released_at) and notify them with a CUSTOM, editable
// plain-text email -- no PDF one-pager. The sibling of "Send Alert" (the PDF
// flow); both release, neither approves (the client still makes the pursue call).
// GET returns a default editable draft; POST releases + sends. The release is the
// source of truth (set first, unconditionally, like the existing release button);
// the email is a best-effort notification, gated like every outreach send.
export const runtime = "nodejs";

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

function defaultSubject(title: string | null): string {
  const t = (title ?? "New opportunity").trim();
  return `New grant match ready to review | ${t.length > 50 ? t.slice(0, 50).replace(/\s+\S*$/, "").trim() + "…" : t}`;
}

function defaultBody(ctx: ReleaseCtx, url: string): string {
  const greeting = ctx.contactName ? `Hi ${ctx.contactName},` : "Hello,";
  return [
    greeting,
    "",
    `Your GRANTED team flagged a new grant match we think is worth a look: ${ctx.grantTitle?.trim() || "a new opportunity"}.`,
    "",
    "You can review the full details in your portal:",
    url,
    "",
    "Happy to talk it through whenever you're ready.",
    "",
    "— GRANTED",
  ].join("\n");
}

// Default editable draft for the composer.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const r = await adminAndCtx(supabase, params.id);
  if ("error" in r) return r.error;
  const url = `${appBaseUrl(req)}/portal/grants/${params.id}?from=alerts`;
  return NextResponse.json({
    to: r.ctx.contactEmail ?? "",
    subject: defaultSubject(r.ctx.grantTitle),
    body: defaultBody(r.ctx, url),
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
        const result = await sendOutreachEmail({ to, subject, body, contactName: ctx.contactName });
        await supabase
          .from("review_cards")
          .update({ sent_at: new Date().toISOString(), sent_to: result.to })
          .eq("id", params.id);
        sent = true;
        send_status = `released — email sent to ${result.to}`;
      } catch (err) {
        send_status = `released, email NOT sent: ${err instanceof Error ? err.message : String(err)}`;
        reason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return NextResponse.json({ released: true, sent, to: sent ? to : undefined, reason, send_status });
}
