import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mintAccessToken } from "@/lib/tokens";
import { buildContractBody, isTemplateKey, CONTRACT_TEMPLATES } from "@/lib/contracts/template";
import type { Client } from "@/types/database";

export const maxDuration = 30;

// Admin-only: generate a contract for a lead and mint its tokenized signing link.
// Creates the contract with an immutable body_snapshot at status 'sent' and
// returns the /sign/<token> URL once (we store only the token hash). Regenerating
// voids any prior UNSIGNED contract for this lead so there is one active link;
// signed contracts are never touched.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { templateKey?: string; amountCents?: number | null };
  const templateKey = body.templateKey ?? "";
  if (!isTemplateKey(templateKey)) {
    return NextResponse.json({ error: "Unknown contract template." }, { status: 400 });
  }
  const tmpl = CONTRACT_TEMPLATES[templateKey];
  const amountCents =
    typeof body.amountCents === "number" && Number.isFinite(body.amountCents) && body.amountCents >= 0
      ? Math.round(body.amountCents)
      : tmpl.defaultAmountCents;
  if (amountCents == null) {
    return NextResponse.json({ error: "Enter an engagement amount for a custom contract." }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: lead } = await db
    .from("clients")
    .select("id, name, primary_contact_name, primary_contact_email, pipeline_stage")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "primary_contact_name" | "primary_contact_email" | "pipeline_stage">>();
  if (!lead || !lead.pipeline_stage) {
    return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  }

  const dateLabel = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const bodySnapshot = buildContractBody({
    orgName: lead.name,
    repName: lead.primary_contact_name,
    email: lead.primary_contact_email,
    templateKey,
    amountCents,
    dateLabel,
  });

  // One active link per lead: void prior unsigned contracts (keeps signed ones).
  await db
    .from("contracts")
    .update({ status: "void" })
    .eq("client_id", params.id)
    .in("status", ["draft", "sent"]);

  const minted = await mintAccessToken(db, {
    actionType: "lead_sign_contract",
    clientId: params.id,
    createdBy: user.id,
  });
  if (!minted) return NextResponse.json({ error: "Failed to mint signing link." }, { status: 500 });

  const { data: contract, error } = await db
    .from("contracts")
    .insert({
      client_id: params.id,
      token_id: minted.id,
      template_key: templateKey,
      amount_cents: amountCents,
      body_snapshot: bodySnapshot,
      status: "sent",
      created_by: user.id,
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !contract) {
    console.error("Contract insert failed", error?.message);
    return NextResponse.json({ error: "Failed to create the contract." }, { status: 500 });
  }

  await db.from("pipeline_events").insert({
    event_type: "contract_sent",
    client_id: params.id,
    token_id: minted.id,
    subject_snapshot: { name: lead.name },
    metadata: { template_key: templateKey, amount_cents: amountCents, contract_id: contract.id },
  });

  const origin = new URL(req.url).origin;
  return NextResponse.json({ url: `${origin}/sign/${minted.rawToken}`, contractId: contract.id });
}
