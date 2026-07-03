import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { draftOutreach } from "@/lib/leads/outreach";
import type { Client } from "@/types/database";

export const maxDuration = 60;

// Admin-only: DRAFT warm outreach for a lead from a grant hook. Generates only --
// nothing sends here. If the lead has multiple hooks the caller may pass hookId;
// otherwise the most recent hook is used.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { hookId?: string };
  const db = createServiceClient();

  const { data: lead } = await db
    .from("clients")
    .select("id, name, org_type, primary_contact_name, primary_contact_email")
    .eq("id", params.id)
    .single<Pick<Client, "id" | "name" | "org_type" | "primary_contact_name" | "primary_contact_email">>();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  let hookQuery = db
    .from("lead_grant_hooks")
    .select("id, grant_id, fit_score, proposed_role, why_snapshot, concept_snapshot, grants(title, funder)")
    .eq("client_id", params.id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (body.hookId) hookQuery = hookQuery.eq("id", body.hookId);
  const { data: hookRows } = await hookQuery;
  const hook = hookRows?.[0] as
    | {
        id: string;
        grant_id: string | null;
        fit_score: number | null;
        proposed_role: string | null;
        why_snapshot: string[] | null;
        concept_snapshot: string | null;
        grants: { title: string | null; funder: string | null } | { title: string | null; funder: string | null }[] | null;
      }
    | undefined;
  if (!hook) {
    return NextResponse.json({ error: "This lead has no grant hook to draft from." }, { status: 400 });
  }
  const grant = Array.isArray(hook.grants) ? hook.grants[0] ?? null : hook.grants;

  let draft;
  try {
    draft = await draftOutreach({
      orgName: lead.name,
      orgType: lead.org_type,
      contactName: lead.primary_contact_name,
      grantTitle: grant?.title ?? null,
      funder: grant?.funder ?? null,
      fitScore: hook.fit_score,
      proposedRole: hook.proposed_role,
      why: hook.why_snapshot,
      concept: hook.concept_snapshot,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Draft failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    subject: draft.subject,
    body: draft.body,
    hookId: hook.id,
    grantId: hook.grant_id,
    grantTitle: grant?.title ?? null,
    to: lead.primary_contact_email ?? "",
  });
}
