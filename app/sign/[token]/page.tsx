import { createServiceClient } from "@/lib/supabase/server";
import { resolveToken } from "@/lib/tokens";
import { SignForm } from "./sign-form";

export const dynamic = "force-dynamic";

// Public (unauthenticated) contract-signing landing. Made public via the
// middleware allowlist. Resolves the tokenized link (fail closed: generic message
// on any invalid/expired/wrong-action token), renders the exact agreed terms, and
// presents the sign action. All reads run under the service role since the signer
// is not logged in.
const WRAP = "flex min-h-screen flex-col items-center bg-brand-cream px-6 py-12";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={WRAP}>
      <div className="w-full max-w-2xl rounded-2xl bg-white p-8 shadow-[0_2px_8px_rgba(11,30,58,0.06),0_16px_38px_-18px_rgba(11,30,58,0.20)]">
        <p className="font-serif text-xl font-semibold tracking-tight text-brand-navy">GRANTED</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function Invalid() {
  return (
    <Shell>
      <h1 className="font-serif text-2xl font-semibold text-brand-navy">This link isn&apos;t valid</h1>
      <p className="mt-3 text-sm text-neutral-600">
        It may have expired or been replaced. Reach out to your GRANTED contact and we&apos;ll send a
        fresh signing link.
      </p>
    </Shell>
  );
}

export default async function SignPage({ params }: { params: { token: string } }) {
  const db = createServiceClient();
  const token = await resolveToken(db, params.token, "lead_sign_contract");
  if (!token || !token.client_id) return <Invalid />;

  const { data: contract } = await db
    .from("contracts")
    .select("id, status, body_snapshot, signer_name, signed_at")
    .eq("token_id", token.id)
    .maybeSingle<{
      id: string;
      status: string;
      body_snapshot: string;
      signer_name: string | null;
      signed_at: string | null;
    }>();

  if (!contract || contract.status === "void") return <Invalid />;

  if (contract.status === "signed") {
    return (
      <Shell>
        <h1 className="font-serif text-2xl font-semibold text-brand-navy">Already signed</h1>
        <p className="mt-3 text-sm text-neutral-600">
          This agreement was signed{contract.signer_name ? ` by ${contract.signer_name}` : ""}. Thank you —
          your GRANTED contact will follow up on next steps.
        </p>
        <ContractBody text={contract.body_snapshot} />
      </Shell>
    );
  }

  // draft | sent -> signable
  return (
    <Shell>
      <h1 className="font-serif text-2xl font-semibold text-brand-navy">Review &amp; sign your agreement</h1>
      <p className="mt-3 text-sm text-neutral-600">
        Please review the agreement below. To sign, type your full name, confirm consent, and click Sign.
      </p>
      <ContractBody text={contract.body_snapshot} />
      <SignForm token={params.token} />
    </Shell>
  );
}

function ContractBody({ text }: { text: string }) {
  return (
    <pre className="mt-6 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-neutral-200 bg-neutral-50 p-4 font-sans text-[13px] leading-relaxed text-neutral-800">
      {text}
    </pre>
  );
}
