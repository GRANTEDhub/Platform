// ⚠️ TEMPORARY TEST ROUTE — DELETE after the live delivery-pipe test passes.
//
// Verifies the Resend send path end to end (guard -> SDK -> receipt + reply
// threading to support@grantedco.com) WITHOUT touching a real client card.
// No card lookup, no DB recipient, no HTML, no template. Everything is
// hardcoded so removal is a clean `rm` of this file.
//
// Trigger (admin session, from the app's devtools console):
//   fetch("/api/email/test-send", { method: "POST" }).then(r => r.json()).then(console.log)
//
// Respects the same guard as real sends: only fires when VERCEL_ENV=production
// AND EMAIL_SENDING_ENABLED=true AND RESEND_PLATFORM_API is present. Anywhere
// else it returns the guard's refusal reason and sends nothing.

import { NextResponse } from "next/server";
import { Resend } from "resend";
import { getProfile } from "@/lib/auth";
import { canSendEmail } from "@/lib/email/guard";

export async function POST() {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (profile.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const gate = canSendEmail();
  if (!gate.ok) {
    return NextResponse.json({ sent: false, reason: gate.reason });
  }

  const resend = new Resend(process.env.RESEND_PLATFORM_API);
  const { data, error } = await resend.emails.send({
    from: "alerts@send.grantedco.com",
    to: "support@grantedco.com",
    replyTo: "support@grantedco.com",
    subject: "GOH test send",
    text:
      "GOH delivery-pipe test. If you received this, the Resend send path works " +
      "end to end: from alerts@send.grantedco.com, reply-to support@grantedco.com. " +
      "Reply to this message to confirm threading lands in the support inbox.",
  });

  if (error) {
    return NextResponse.json({ sent: false, error: error.message }, { status: 502 });
  }
  return NextResponse.json({ sent: true, id: data?.id ?? null });
}
