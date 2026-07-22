import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Bare portal landing (Slice 3b). Its job is to PROVE the locks end-to-end: it
// reads review_cards under RLS as the logged-in client (NOT the service role), so
// the count can only ever reflect THIS client's own grants. If isolation were
// broken, a client would see the whole firm's count; with the 0055 policies they
// see only their own. The real client pages (dashboard, grant report) come in
// Phase 4.
export default async function PortalHome() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { count } = await supabase
    .from("review_cards")
    .select("id", { count: "exact", head: true })
    .eq("client_id", org.clientId)
    .eq("decision", "approved")
    .neq("card_type", "prospect");

  const active = count ?? 0;

  return (
    <div>
      <h1 className="text-[30px] font-semibold tracking-tight text-brand-navy">
        Welcome, {org.clientName}
      </h1>
      <p className="mt-2 text-[15px] text-muted-foreground">
        Your GRANTED portal. Your grant report and pipeline will live here.
      </p>

      <div className="mt-8 rounded-2xl border border-brand-navy/[0.05] bg-white p-8 shadow-soft">
        <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Active grant opportunities
        </p>
        <p className="mt-3 text-[44px] font-semibold leading-none text-brand-orange">{active}</p>
        <p className="mt-3 text-sm text-muted-foreground">
          Opportunities your GRANTED team is actively pursuing for you. A full
          breakdown is coming to this portal soon.
        </p>
      </div>
    </div>
  );
}
