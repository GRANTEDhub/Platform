import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendClientBatch } from "@/lib/alerts/batch-send";

// Send the selected client matches as ONE merged-PDF email. Assumes drafts are
// already prepared (prepare-batch); it never renders inline. Built on the verified
// send-core leaves so each grant's resulting state is identical to a single send --
// only delivery differs (one merged email). Admin-gated: it can send outreach.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const input = (await req.json().catch(() => ({}))) as { cardIds?: unknown; subject?: unknown; body?: unknown };
  const cardIds = Array.isArray(input.cardIds) ? input.cardIds.filter((x): x is string => typeof x === "string") : [];
  const subject = typeof input.subject === "string" ? input.subject : undefined;
  const body = typeof input.body === "string" ? input.body : undefined;

  const { result, status } = await sendClientBatch(supabase, {
    clientId: params.id,
    cardIds,
    subject,
    body,
    userId: user.id,
  });
  return NextResponse.json(result, { status });
}
