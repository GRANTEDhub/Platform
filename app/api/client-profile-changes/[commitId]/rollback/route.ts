import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveDocumentActor } from "@/lib/documents/authorize";
import { canAssimilateFor } from "@/lib/documents/assimilate-authorize";
import { rollbackCommit } from "@/lib/documents/commit";

// Undo one commit by re-applying its old values.
//
// A ROLLBACK IS A FORWARD COMMIT. It writes NEW audit rows rather than deleting the
// originals, so "this was changed, then changed back, by these two people" stays readable.
// 0078 gives client_profile_changes no UPDATE or DELETE policy at all, so an erasing
// rollback is not merely discouraged here -- it is unreachable, which is what makes the log
// trustworthy rather than merely conventional.
//
// Authorisation is deliberately the SAME bar as committing. Anyone who could have made the
// change can undo it; requiring more to undo than to do would leave a client able to set a
// value they then need staff to unset.
export async function POST(_req: NextRequest, { params }: { params: { commitId: string } }) {
  const actor = await resolveDocumentActor();
  if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // The commit's own client_id decides who may undo it -- read service-role first, then
  // judge, so a commit belonging to another org is a 403 rather than an indistinguishable
  // 404. Reading one row is enough: rollbackCommit refuses a commit that spans orgs.
  const admin = createServiceClient();
  const { data: row } = await admin
    .from("client_profile_changes")
    .select("client_id")
    .eq("commit_id", params.commitId)
    .limit(1)
    .maybeSingle<{ client_id: string }>();
  if (!row) return NextResponse.json({ error: "That change no longer exists." }, { status: 404 });

  if (!canAssimilateFor(actor, row.client_id)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  const result = await rollbackCommit({
    commitId: params.commitId,
    actor,
    actorEmail: actor.email,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });

  return NextResponse.json({
    ok: true,
    commitId: result.commitId ?? null,
    changed: result.changed ?? [],
    // Empty `changed` with ok:true means the profile already matched the old values -- an
    // honest "nothing to undo" rather than a claimed reversal.
    unchanged: result.unchanged ?? [],
    // Should be empty for a rollback now that intent relaxes the per-field rules, but it is
    // returned rather than assumed: a PARTIAL undo reporting a clean success is the exact
    // failure this route was found to have, and an empty array is a claim worth being able
    // to check.
    rejected: result.rejected ?? [],
  });
}
