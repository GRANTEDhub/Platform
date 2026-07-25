import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { STEP_ORDER, furthestStatus } from "@/lib/intellengine/drafts";
import type { IntellEngineDraft, IntellEngineDraftStatus } from "@/types/database";

// Advance an IntellEngine draft's status (as the client moves scope -> compliance
// -> build -> complete) or rename it. RLS scopes every read/write to the caller's
// own org. Status only ever moves FORWARD -- re-opening an earlier step never
// knocks progress backward (see furthestStatus).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { status?: IntellEngineDraftStatus; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.status && !STEP_ORDER.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Current row (RLS pins it to the caller's org; absent -> not theirs / gone).
  const { data: current } = await supabase
    .from("intellengine_drafts")
    .select("*")
    .eq("id", params.id)
    .maybeSingle<IntellEngineDraft>();
  if (!current) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const update: { status?: IntellEngineDraftStatus; title?: string } = {};
  if (body.status) update.status = furthestStatus(current.status, body.status);
  if (typeof body.title === "string" && body.title.trim()) update.title = body.title.trim().slice(0, 200);
  if (Object.keys(update).length === 0) return NextResponse.json({ draft: current });

  const { data, error } = await supabase
    .from("intellengine_drafts")
    .update(update)
    .eq("id", params.id)
    .select()
    .single<IntellEngineDraft>();
  if (error) return NextResponse.json({ error: "Couldn't save" }, { status: 500 });
  return NextResponse.json({ draft: data });
}
