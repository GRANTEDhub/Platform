import { createServiceClient } from "@/lib/supabase/server";
import { renderSignedContractPdf } from "@/lib/contracts/pdf";
import { uploadPdf, CONTRACTS_BUCKET } from "@/lib/storage";
import { canSendEmail } from "@/lib/email/guard";
import { sendContractCopyEmail, isDeliverableEmail } from "@/lib/email/send";

// Background (waitUntil) generate-and-deliver, run AFTER the signature is already
// recorded. Renders the branded PDF, stores it in the private contracts bucket,
// fills contracts.pdf_url, files it in the client_documents repository, then emails
// the client their copy. The signature is the source of truth -- any failure here
// leaves it intact and simply means pdf_url stays null (retryable later). Never
// throws to the caller.
export async function generateAndDeliverContract(contractId: string): Promise<void> {
  const db = createServiceClient();
  try {
    const { data: c } = await db
      .from("contracts")
      .select("id, client_id, template_key, amount_cents, signer_name, signer_ip, signer_user_agent, signed_at, created_at, status")
      .eq("id", contractId)
      .maybeSingle<{
        id: string;
        client_id: string;
        template_key: string;
        amount_cents: number | null;
        signer_name: string | null;
        signer_ip: string | null;
        signer_user_agent: string | null;
        signed_at: string | null;
        created_at: string;
        status: string;
      }>();
    if (!c || c.status !== "signed") return;

    const { data: client } = await db
      .from("clients")
      .select("id, name, primary_contact_name, primary_contact_email")
      .eq("id", c.client_id)
      .maybeSingle<{ id: string; name: string; primary_contact_name: string | null; primary_contact_email: string | null }>();
    if (!client) return;

    const fmt = (iso: string | null) =>
      iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" }) : "—";

    const pdf = await renderSignedContractPdf({
      orgName: client.name,
      repName: client.primary_contact_name,
      email: client.primary_contact_email,
      templateKey: c.template_key,
      amountCents: c.amount_cents,
      dateLabel: new Date(c.created_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
      signerName: c.signer_name || "—",
      signedAtLabel: fmt(c.signed_at),
      signerIp: c.signer_ip,
      signerUserAgent: c.signer_user_agent,
    });

    const objectPath = `${c.client_id}/${c.id}.pdf`;
    await uploadPdf(CONTRACTS_BUCKET, objectPath, pdf);

    await db.from("contracts").update({ pdf_url: objectPath }).eq("id", c.id);

    // File it in the reusable repository (idempotent-ish: one row per contract).
    const { data: existing } = await db
      .from("client_documents")
      .select("id")
      .eq("source_contract_id", c.id)
      .maybeSingle<{ id: string }>();
    if (!existing) {
      await db.from("client_documents").insert({
        client_id: c.client_id,
        kind: "signed_contract",
        title: "Signed engagement agreement",
        storage_bucket: CONTRACTS_BUCKET,
        storage_path: objectPath,
        content_type: "application/pdf",
        size_bytes: pdf.length,
        source_contract_id: c.id,
      });
    }

    // Email the client their copy -- gated. On preview / disabled sending, or a
    // recipient not on the testing allowlist, this is skipped with NO send. The
    // PDF is already stored and repository-filed regardless.
    const to = (client.primary_contact_email ?? "").trim();
    const gate = canSendEmail();
    if (gate.ok && isDeliverableEmail(to)) {
      try {
        await sendContractCopyEmail({
          to,
          orgName: client.name,
          contactName: client.primary_contact_name,
          pdf,
          filename: "GRANTED-Agreement.pdf",
        });
      } catch (err) {
        // Allowlist backstop or send failure -- expected during testing for a real
        // client address. Do not fail delivery; the PDF is stored.
        console.error("Contract copy email skipped/failed:", err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("generateAndDeliverContract failed for", contractId, err instanceof Error ? err.message : err);
  }
}
