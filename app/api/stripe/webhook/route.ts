import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // constructEvent needs Node crypto + the raw body

// PUBLIC Stripe webhook. Hardened for the shared preview/prod DB + single Stripe
// endpoint. Order matters:
//   1. FAIL CLOSED if STRIPE_WEBHOOK_SECRET is unset (never process unverified).
//   2. Require the stripe-signature header.
//   3. Verify the signature against the RAW body via constructEvent (FAIL CLOSED
//      on any mismatch) -- this is what proves the event really came from Stripe.
//   4. ONLY-PROD-ACTS guard: a non-production deploy acknowledges (200) but makes
//      NO DB writes, so a stray/replayed call to a preview URL can't mutate the
//      shared DB. (Verification still runs first, so forged calls are rejected in
//      every environment.)
//   5. IDEMPOTENT: skip if we've already recorded this event id; the handler is
//      itself idempotent (marks paid only if not already paid); record the event
//      id AFTER processing so a crash-then-retry reprocesses safely rather than
//      being skipped.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfiguration must not become an open door.
    console.error("Stripe webhook: STRIPE_WEBHOOK_SECRET is not set — rejecting.");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  const raw = await req.text(); // RAW body, before any JSON parse
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error("Stripe webhook: signature verification failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Only production acts on the shared DB. Preview/dev verify (above) but no-op.
  if (process.env.VERCEL_ENV !== "production") {
    return NextResponse.json({ received: true, skipped: "non-production" });
  }

  const db = createServiceClient();

  // Idempotency fast-path: already processed?
  const { data: seen } = await db.from("stripe_events").select("id").eq("id", event.id).maybeSingle();
  if (seen) return NextResponse.json({ received: true, duplicate: true });

  try {
    await handleEvent(db, event);
  } catch (err) {
    // Do NOT record the event id -> Stripe will retry and we reprocess (handler is
    // idempotent). Return 500 so Stripe schedules the retry.
    console.error("Stripe webhook: handler failed for", event.id, event.type, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  // Record only after successful processing. Ignore a unique-violation race
  // (concurrent duplicate delivery) -- the handler already ran idempotently.
  await db.from("stripe_events").insert({ id: event.id, type: event.type });

  return NextResponse.json({ received: true });
}

async function handleEvent(db: ReturnType<typeof createServiceClient>, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const inv = event.data.object as Stripe.Invoice;
      if (!inv.id) return;

      // Find OUR invoice row by the Stripe invoice id. Ignore invoices we didn't
      // create (no matching row) -- never invent state from an unknown invoice.
      const { data: row } = await db
        .from("invoices")
        .select("id, client_id, status")
        .eq("stripe_invoice_id", inv.id)
        .maybeSingle<{ id: string; client_id: string; status: string }>();
      if (!row || row.status === "paid") return; // unknown or already paid -> idempotent no-op

      const paidAt = inv.status_transitions?.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);

      // Flip to paid ONLY if not already paid, and capture whether THIS call made
      // the transition. Stripe emits both invoice.paid and invoice.payment_succeeded
      // (distinct event ids -> the event-id ledger doesn't dedupe them against each
      // other), and deliveries can run concurrently on separate lambdas; the row
      // UPDATE serializes, so exactly one call gets a row back. Gating the timeline
      // insert on that makes the whole side effect (status + event) fire exactly once.
      const { data: transitioned } = await db
        .from("invoices")
        .update({ status: "paid", paid_date: paidAt })
        .eq("id", row.id)
        .neq("status", "paid")
        .select("id");
      if (!transitioned || transitioned.length === 0) return; // already marked paid by another delivery

      // Timeline: payment received (once). Lights the invoice_paid derived stage
      // (invoiceSignals reads invoices.status='paid').
      await db.from("pipeline_events").insert({
        event_type: "invoice_paid",
        client_id: row.client_id,
        metadata: { stripe_invoice_id: inv.id, amount_cents: inv.amount_paid ?? inv.amount_due ?? null, paid_date: paidAt },
      });
      return;
    }
    default:
      return; // ignore unhandled event types
  }
}
