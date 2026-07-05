import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveToken } from "@/lib/tokens";
import { generateAndDeliverContract } from "@/lib/contracts/deliver";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// PUBLIC (no auth) contract-signing action. Gated by possession of a valid
// 'lead_sign_contract' token, not by RLS -- runs under the service role like the
// /go and /intake write paths. Fails closed on any invalid/expired/wrong-action
// token (generic 404, no info leak). Captures the typed name + consent + server
// timestamp + IP/UA, flips the contract to 'signed', mirrors contract_status /
// contract_signed_at onto the lead (advances effectiveStage -> contracting), and
// logs a contract_signed pipeline event. Idempotent: a second submit on an
// already-signed contract returns ok without rewriting.
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const db = createServiceClient();
  const token = await resolveToken(db, params.token, "lead_sign_contract");
  if (!token || !token.client_id) {
    return NextResponse.json({ error: "This signing link isn't valid." }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { signerName?: string; consent?: boolean };
  const signerName = (body.signerName ?? "").trim().slice(0, 200);
  if (!signerName) return NextResponse.json({ error: "Type your full name to sign." }, { status: 400 });
  if (body.consent !== true) {
    return NextResponse.json({ error: "You must check the consent box to sign." }, { status: 400 });
  }

  // The token is bound to exactly one contract via token_id.
  const { data: contract } = await db
    .from("contracts")
    .select("id, status, client_id")
    .eq("token_id", token.id)
    .maybeSingle<{ id: string; status: string; client_id: string }>();
  if (!contract) {
    return NextResponse.json({ error: "This signing link isn't valid." }, { status: 404 });
  }
  if (contract.status === "signed") {
    return NextResponse.json({ signed: true, alreadySigned: true });
  }
  if (contract.status !== "sent" && contract.status !== "draft") {
    // voided/replaced link
    return NextResponse.json({ error: "This signing link is no longer active." }, { status: 409 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;
  const signedAt = new Date().toISOString();

  const { error: upErr } = await db
    .from("contracts")
    .update({
      status: "signed",
      signer_name: signerName,
      signer_ip: ip,
      signer_user_agent: userAgent,
      signed_at: signedAt,
    })
    .eq("id", contract.id)
    .in("status", ["draft", "sent"]); // guard against a double-submit race
  if (upErr) {
    console.error("Contract sign update failed", upErr.message);
    return NextResponse.json({ error: "Could not record your signature. Please try again." }, { status: 500 });
  }

  // Mirror onto the lead: contract_signed_at + contract_status drive the derived
  // stage -> contracting (lib/leads/stage.ts contractSigned signal).
  await db
    .from("clients")
    .update({ contract_status: "signed", contract_signed_at: signedAt })
    .eq("id", contract.client_id);

  await db.from("pipeline_events").insert({
    event_type: "contract_signed",
    client_id: contract.client_id,
    token_id: token.id,
    subject_snapshot: { name: signerName },
    metadata: { contract_id: contract.id, signed_at: signedAt },
  });

  // Background: render the branded PDF, store it privately, file it in the client
  // document repository, and email the client their copy (gated). The signature is
  // already recorded, so a failure here never invalidates it -- pdf_url just stays
  // null and is retryable.
  waitUntil(generateAndDeliverContract(contract.id));

  return NextResponse.json({ signed: true });
}
