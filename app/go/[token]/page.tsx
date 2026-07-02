import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveToken, recordPipelineEvent } from "@/lib/tokens";
import { interTight, sourceSerif } from "@/lib/fonts";

export const dynamic = "force-dynamic";

// Public (unauthenticated) outbound-door landing. A prospect clicks the tokenized
// link in our grant-forward email and lands here. We RECORD the engagement
// (this prospect + this grant + clicked-to-schedule -> pipeline event, deduped)
// and then forward to our Google Appointment Schedules booking page. Runs via the
// service role since the visitor is not logged in. Brand-styled; functional now,
// design polish later.
const WRAP = "flex min-h-screen flex-col items-center justify-center bg-brand-cream px-6 text-center";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${interTight.variable} ${sourceSerif.variable} font-tight`}>
      <div className={WRAP}>
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-[0_2px_8px_rgba(11,30,58,0.06),0_16px_38px_-18px_rgba(11,30,58,0.20)]">
          <p className="font-serif text-xl font-semibold tracking-tight text-brand-navy">GRANTED</p>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

export default async function ScheduleLandingPage({ params }: { params: { token: string } }) {
  const db = createServiceClient();
  const token = await resolveToken(db, params.token, "prospect_schedule_call");

  if (!token) {
    return (
      <Shell>
        <h1 className="font-serif text-2xl font-semibold text-brand-navy">This link isn&apos;t valid</h1>
        <p className="mt-3 text-sm text-neutral-600">
          It may have expired or already been used. Reach out to your GRANTED contact and we&apos;ll
          send a fresh scheduling link.
        </p>
      </Shell>
    );
  }

  let prospectName: string | null = null;
  if (token.prospect_id) {
    const { data } = await db.from("prospects").select("name").eq("id", token.prospect_id).maybeSingle();
    prospectName = (data as { name: string } | null)?.name ?? null;
  }
  let grantTitle: string | null = null;
  if (token.grant_id) {
    const { data } = await db.from("grants").select("title").eq("id", token.grant_id).maybeSingle();
    grantTitle = (data as { title: string | null } | null)?.title ?? null;
  }

  // Record the engagement (the click is the pipeline signal). Deduped in the
  // helper so an email scanner's prefetch and the human's click count once.
  const h = headers();
  await recordPipelineEvent(db, {
    token,
    eventType: "clicked_schedule_call",
    subjectSnapshot: { name: prospectName },
    metadata: {
      user_agent: h.get("user-agent"),
      ip: h.get("x-forwarded-for"),
      referer: h.get("referer"),
    },
  });

  const bookingUrl = process.env.NEXT_PUBLIC_BOOKING_URL;

  return (
    <Shell>
      <h1 className="font-serif text-2xl font-semibold text-brand-navy">Let&apos;s find a time</h1>
      <p className="mt-3 text-sm text-neutral-600">
        {grantTitle
          ? `Book a quick call to talk through "${grantTitle}" and how GRANTED can help you pursue it.`
          : "Book a quick call to talk through this opportunity and how GRANTED can help."}
      </p>
      {bookingUrl ? (
        <a
          href={bookingUrl}
          className="mt-6 inline-block rounded-full bg-brand-orange px-6 py-3 text-sm font-medium text-brand-cream transition-opacity hover:opacity-90"
        >
          Book your call →
        </a>
      ) : (
        // Booking URL not yet configured (NEXT_PUBLIC_BOOKING_URL). We still
        // recorded the engagement above, so the pipeline signal is not lost.
        <p className="mt-6 text-sm text-neutral-600">
          Thanks — we&apos;ve noted your interest and your GRANTED contact will follow up to schedule.
        </p>
      )}
    </Shell>
  );
}
