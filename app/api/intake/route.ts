import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createServiceClient } from "@/lib/supabase/server";
import { isDeliverableEmail } from "@/lib/email/send";
import { refreshClientUSASpendingById } from "@/lib/grants/usaspending-refresh";
import { verifyTurnstile, rateLimited } from "@/lib/intake/guard";
import { ORG_TYPES, ORG_TYPE_LABELS, PRIORITY_AREAS, REFERRAL_SOURCES, US_STATES } from "@/lib/intake/fields";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// PUBLIC (no auth) inbound-intake endpoint. Mirrors the /go public-write pattern:
// the visitor is never authenticated, so the write runs under the service role
// (bypasses RLS -- no anon policy). Creates an inbound lead at pipeline_stage
// 'new' / status 'lead' (double-gated off the matcher) with needs_review=true,
// then fires USASpending enrichment in the background so the reviewed lead
// arrives with federal history already filled. SAM is left to admin-confirmed
// binding by design (never auto-bound).
type Body = {
  orgName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  orgType?: string;
  city?: string;
  state?: string;
  priorityAreas?: string[];
  fundingNeed?: string;
  additionalInfo?: string;
  referralSource?: string;
  website?: string; // honeypot -- must stay empty
  turnstileToken?: string;
};

function clean(s: unknown, max = 2000): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const body = (await req.json().catch(() => ({}))) as Body;

  // 1) Honeypot: a real user never fills the hidden "website" field. Silently
  // accept (200) so a bot gets no signal, but write nothing.
  if (clean(body.website)) {
    return NextResponse.json({ ok: true });
  }

  // 2) Rate limit (coarse, per-IP).
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many submissions. Please try again shortly." }, { status: 429 });
  }

  // 3) Turnstile (skipped if not configured).
  const captcha = await verifyTurnstile(body.turnstileToken, ip);
  if (!captcha.ok) {
    return NextResponse.json({ error: captcha.reason ?? "Captcha failed." }, { status: 400 });
  }

  // 4) Server-side validation of the required fields.
  const orgName = clean(body.orgName, 300);
  const contactName = clean(body.contactName, 200);
  const email = clean(body.email, 320);
  const orgType = clean(body.orgType, 120);
  const city = clean(body.city, 120);
  const state = clean(body.state, 2).toUpperCase();
  const fundingNeed = clean(body.fundingNeed, 2000);

  const errors: string[] = [];
  if (!orgName) errors.push("Organization name is required.");
  if (!contactName) errors.push("Your name is required.");
  if (!isDeliverableEmail(email)) errors.push("A valid email is required.");
  if (!ORG_TYPE_LABELS.includes(orgType)) errors.push("Please choose an organization type.");
  if (!city) errors.push("City is required.");
  if (!US_STATES.includes(state)) errors.push("A valid state is required.");
  if (!fundingNeed) errors.push("Please tell us what you're looking for.");
  if (errors.length) {
    return NextResponse.json({ error: errors.join(" ") }, { status: 400 });
  }

  // Normalize the optional fields against the known lists (drop anything off-list
  // rather than trust arbitrary input).
  const priorityAreas = Array.isArray(body.priorityAreas)
    ? body.priorityAreas.filter((a) => PRIORITY_AREAS.includes(a))
    : [];
  const referralSource = REFERRAL_SOURCES.includes(clean(body.referralSource))
    ? clean(body.referralSource)
    : null;
  const orgTypeCode = ORG_TYPES.find((t) => t.label === orgType)?.code ?? null;
  const phone = clean(body.phone, 40) || null;
  const additionalInfo = clean(body.additionalInfo, 2000) || null;

  const intakeData = {
    org_type_code: orgTypeCode,
    phone,
    priority_areas: priorityAreas,
    funding_need: fundingNeed,
    additional_info: additionalInfo,
    referral_source: referralSource,
    submitted_at: new Date().toISOString(),
  };

  const db = createServiceClient();
  const { data: lead, error } = await db
    .from("clients")
    .insert({
      name: orgName,
      org_type: orgType,
      primary_contact_name: contactName,
      primary_contact_email: email,
      location_city: city,
      location_state: state,
      // Reconnect the priority-area checkboxes to the column the matcher reads
      // (factor 6, mission alignment). They're also kept in intake_data for
      // provenance. Null when none picked, so the field reads "blank" not "[]".
      primary_funding_needs: priorityAreas.length ? priorityAreas : null,
      status: "lead", // non-active -> matcher never scores it (mirrors isUnconvertedLead)
      pipeline_stage: "discovery_pending", // entry stage; intake is a flag, not a gate
      lead_source: "inbound",
      needs_review: true,
      intake_data: intakeData,
      notes: fundingNeed ? `Seeking funding for: ${fundingNeed}` : null,
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !lead) {
    console.error("Intake insert failed", error?.message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  // Timeline: the lead was born from the public form.
  await db.from("pipeline_events").insert({
    event_type: "lead_created",
    client_id: lead.id,
    subject_snapshot: { name: orgName },
    metadata: { lead_source: "inbound", referral_source: referralSource },
  });

  // Auto-enrich federal history in the background so the reviewed lead arrives
  // already enriched -- no extra question asked of the submitter. Fire-and-forget;
  // a fresh service client because this outlives the request.
  waitUntil(refreshClientUSASpendingById(createServiceClient(), lead.id));

  return NextResponse.json({ ok: true });
}
