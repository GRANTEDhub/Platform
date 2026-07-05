import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStripe, canActOnPayments } from "@/lib/stripe";
import type { Client } from "@/types/database";

export const runtime = "nodejs";
export const maxDuration = 30;

// Admin-only: issue a Stripe invoice for a lead's signed contract. NO auto-send --
// we finalize the invoice (which does NOT email the client) and return the hosted
// payment URL for gated/manual send. Amount defaults to the signed contract's
// amount_cents, with an optional admin override. Gated to production (shared DB +
// single Stripe account) via canActOnPayments().
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  // Gate first: on preview / when unconfigured, do NOT touch Stripe or the DB.
  const gate = canActOnPayments();
  if (!gate.ok) return NextResponse.json({ created: false, reason: gate.reason });

  const body = (await req.json().catch(() => ({}))) as { amountCents?: number | null };

  const db = createServiceClient();
  const { data: lead } = await db
    .from("clients")
    .select("id, name, primary_contact_email, primary_contact_name, stripe_customer_id, pipeline_stage")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "primary_contact_email" | "primary_contact_name" | "stripe_customer_id" | "pipeline_stage">>();
  if (!lead || !lead.pipeline_stage) return NextResponse.json({ error: "Lead not found." }, { status: 404 });

  // Require a signed contract to bill against; amount comes from it (override allowed).
  const { data: signed } = await db
    .from("contracts")
    .select("id, amount_cents, template_key")
    .eq("client_id", params.id)
    .eq("status", "signed")
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; amount_cents: number | null; template_key: string }>();
  if (!signed) {
    return NextResponse.json({ error: "No signed contract to invoice. Get the contract signed first." }, { status: 400 });
  }

  const override =
    typeof body.amountCents === "number" && Number.isFinite(body.amountCents) && body.amountCents > 0
      ? Math.round(body.amountCents)
      : null;
  const amountCents = override ?? signed.amount_cents;
  if (!amountCents || amountCents <= 0) {
    return NextResponse.json({ error: "No amount to invoice." }, { status: 400 });
  }

  // A Stripe 'send_invoice' invoice requires the customer to have an email, and
  // grant-matched leads (promoted from prospects) often have none. Fail with a
  // clean, actionable message BEFORE touching Stripe -- otherwise Stripe throws a
  // raw "Missing email" error that crashes the JSON response.
  const email = (lead.primary_contact_email ?? "").trim();
  if (!email) {
    return NextResponse.json(
      { error: "This lead has no email on file — add one before issuing an invoice." },
      { status: 400 },
    );
  }

  // Reuse an existing open (sent, unpaid) invoice rather than double-billing.
  const { data: existing } = await db
    .from("invoices")
    .select("id, hosted_invoice_url, stripe_invoice_id")
    .eq("client_id", params.id)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; hosted_invoice_url: string | null; stripe_invoice_id: string | null }>();
  if (existing?.hosted_invoice_url) {
    return NextResponse.json({ created: true, reused: true, hostedInvoiceUrl: existing.hosted_invoice_url });
  }

  const stripe = getStripe();

  // All Stripe calls wrapped: a raw Stripe exception must become a clean JSON
  // error, never an unhandled throw (which surfaces to the client as
  // "Unexpected end of JSON input").
  let finalized;
  try {
    // Reuse or create the Stripe customer (email guaranteed present above).
    let customerId = lead.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ name: lead.name, email });
      customerId = customer.id;
      await db.from("clients").update({ stripe_customer_id: customerId }).eq("id", params.id);
    }

    // One line item + a NON-auto-advancing invoice, then finalize (generates the
    // hosted URL + PDF WITHOUT emailing the client -- Stripe only emails on sendInvoice).
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: amountCents,
      currency: "usd",
      description: `GRANTED ${signed.template_key.replace(/_/g, " ")} engagement`,
    });
    const draft = await stripe.invoices.create({
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: 14,
      auto_advance: false,
      pending_invoice_items_behavior: "include",
      metadata: { client_id: params.id, contract_id: signed.id },
    });
    finalized = await stripe.invoices.finalizeInvoice(draft.id, { auto_advance: false });
  } catch (err) {
    console.error("Stripe invoice creation failed", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: `Could not create the invoice in Stripe: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 502 },
    );
  }

  const { error: insErr } = await db.from("invoices").insert({
    client_id: params.id,
    contract_id: signed.id,
    amount_cents: amountCents,
    currency: "usd",
    status: "sent",
    issued_date: new Date().toISOString().slice(0, 10),
    stripe_invoice_id: finalized.id,
    hosted_invoice_url: finalized.hosted_invoice_url ?? null,
    created_by: user.id,
  });
  if (insErr) {
    console.error("Invoice row insert failed", insErr.message);
    return NextResponse.json({ error: "Invoice created in Stripe but failed to record. Check Stripe." }, { status: 500 });
  }

  await db.from("pipeline_events").insert({
    event_type: "invoice_sent",
    client_id: params.id,
    metadata: { stripe_invoice_id: finalized.id, amount_cents: amountCents },
  });

  return NextResponse.json({ created: true, hostedInvoiceUrl: finalized.hosted_invoice_url ?? null });
}
